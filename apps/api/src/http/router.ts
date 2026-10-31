import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { verifyWebhookSecret } from './security';
import { accessRepo, scoped, type UserRow } from '../db/repo';
import { configureDataKey, hasDataKey } from '../db/crypto';
import { handleCallback, handleMessage } from '../services/access';
import { createFrankfurter } from '../fx/frankfurter';
import { FxUnavailable } from '../fx/provider';
import { getFxRates } from '../fx/service';
import { createTelegramClient, sanitizeTelegramError, type TelegramClient } from '../telegram/client';
import { signJwt, TMA_JWT_TTL_SEC, verifyInitData, verifyJwt } from '../tma/auth';

// P2-6: rate-limit SQL живёт в accessRepo.bumpAuthRateLimit; здесь — только ключ.
const sha256HexStr = async (s: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
import { buildOverview } from '../tma/overview';
import { registerTmaApi } from '../tma/api';
import { registerTmaDebts } from '../tma/debts';
import { registerTmaFx } from '../tma/fx';
import { registerTmaVision } from '../tma/vision';

const APP_VERSION = '0.1.0';

// Тело POST /api/tma/auth — только initData (S12).
const tmaAuthSchema = z.object({ initData: z.string().min(1).max(8192) });

// Минимальная схема: только поля, нужные контуру доступа (S12).
const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      text: z.string().optional(),
      // шаг 7 (vision): фото — массив размеров по возрастанию (берём последний,
      // самый крупный); документ-картинка — file_id + mime.
      photo: z.array(z.object({ file_id: z.string(), file_size: z.number().optional() })).optional(),
      document: z
        .object({
          file_id: z.string(),
          mime_type: z.string().optional(),
          file_size: z.number().optional(),
        })
        .optional(),
      chat: z.object({ id: z.number(), type: z.string() }),
      from: z.object({ id: z.number(), first_name: z.string().optional(), username: z.string().optional() }).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().max(64).optional(),
      from: z.object({ id: z.number(), first_name: z.string().optional(), username: z.string().optional() }).optional(),
      message: z
        .object({ message_id: z.number().optional(), chat: z.object({ id: z.number(), type: z.string() }) })
        .optional(),
    })
    .optional(),
});

export interface RouterDeps {
  /** Подмена клиента Telegram в тестах. */
  telegram?: TelegramClient;
  /** Подмена FX-провайдера в тестах. */
  fx?: import('../fx/provider').FxProvider;
  /**
   * Подмена vision-провайдеров (шаг 7): ключи + fetch для Gemini/Groq.
   * Если не задано — собирается из env (GEMINI_API_KEY, GROQ_API_KEY, GROQ_MODEL).
   */
  vision?: import('../services/vision').VisionProviders;
}

interface TmaVariables {
  /** Пользователь, аутентифицированный Bearer-JWT (middleware /api/tma/*). */
  tmaUser: UserRow;
}

/** HTTP-роутер воркера. Маршруты добавляются шагами миграции (ADR-0001). */
export function createRouter(deps: RouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: TmaVariables }>();

  // DATA_KEY (шифрование at rest): fail-closed как webhook-секрет — без ключа
  // контуры данных (вебхук, TMA API) не работают, plaintext не пишется никогда.
  app.use('*', async (c, next) => {
    try {
      configureDataKey(c.env.DATA_KEY);
    } catch {
      console.error('data key: невалидный DATA_KEY — отказ (fail-closed)');
    }
    if (!hasDataKey()) {
      const p = new URL(c.req.url).pathname;
      if (p.startsWith('/telegram/') || p.startsWith('/api/tma/')) {
        return c.json({ ok: false, error: 'data key not configured' }, 503);
      }
    }
    return next();
  });

  // Заголовки безопасности на все ответы; CSP — на HTML/SPA (Mini App
  // открывается во фрейме Telegram → X-Frame-Options НЕ ставим).
  app.use('*', async (c, next) => {
    await next();
    const res = c.res;
    res.headers.set('X-Content-Type-Options', 'nosniff');
    res.headers.set('Referrer-Policy', 'no-referrer');
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/telegram/')) {
      res.headers.set('Cache-Control', 'no-store');
    } else if (res.headers.get('content-type')?.includes('text/html')) {
      res.headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors https://web.telegram.org https://*.telegram.org",
      );
    }
  });

  app.get('/health', (c) =>
    c.json({
      ok: true,
      app: 'budget-companion-api',
      version: APP_VERSION,
      time: new Date().toISOString(),
    }),
  );

  // ── Mini App API (шаг 5) ─────────────────────────────────────
  // Вход: POST /api/tma/auth {initData} → JWT (12ч). Дальше Bearer.
  app.post('/api/tma/auth', async (c) => {
    if (!c.env.JWT_SECRET) {
      console.error('tma/auth: JWT_SECRET не задан — отказ (fail-closed)');
      return c.json({ ok: false, error: 'auth not configured' }, 503);
    }
    let body: z.infer<typeof tmaAuthSchema>;
    try {
      body = tmaAuthSchema.parse(await c.req.json());
    } catch {
      return c.json({ ok: false, error: 'bad request' }, 400);
    }
    const ipKey = await sha256HexStr(c.req.header('CF-Connecting-IP') ?? 'unknown');
    const attempts = await accessRepo(c.env.DB).bumpAuthRateLimit(ipKey, new Date().toISOString());
    if (attempts > 20) {
      console.warn('tma/auth: rate-limit сработал');
      c.header('Retry-After', '600');
      return c.json({ ok: false, error: 'too many attempts' }, 429);
    }
    const v = await verifyInitData(body.initData, c.env.TELEGRAM_BOT_TOKEN);
    if (!v.ok) {
      console.error(`tma/auth: initData отклонён (${v.reason})`);
      return c.json({ ok: false, error: 'invalid initData' }, 401);
    }
    const user = await accessRepo(c.env.DB).findUserByTelegramId(v.user.id);
    // одинаковый текст: не раскрываем «нет пользователя» vs «не онбоарден»
    if (!user) return c.json({ ok: false, error: 'forbidden' }, 403);
    const profile = await scoped(c.env.DB, user.id).getProfile();
    if (!profile?.onboarded_at) return c.json({ ok: false, error: 'forbidden' }, 403);
    const token = await signJwt({ tg_id: user.telegram_id }, c.env.JWT_SECRET, TMA_JWT_TTL_SEC);
    return c.json({ ok: true, token, user: { name: user.display_name ?? v.user.first_name ?? null } });
  });

  /** Bearer-JWT → tmaUser в контексте. Любой запрос без валидного JWT → 401. */
  const tmaAuth = async (
    c: import('hono').Context<{ Bindings: Env; Variables: TmaVariables }>,
    next: () => Promise<void>,
  ) => {
    const m = /^Bearer\s+(.+)$/.exec(c.req.header('Authorization') ?? '');
    const claims = m && c.env.JWT_SECRET ? await verifyJwt(m[1]!, c.env.JWT_SECRET) : null;
    if (!claims) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const user = await accessRepo(c.env.DB).findUserByTelegramId(claims.tg_id);
    if (!user) return c.json({ ok: false, error: 'forbidden' }, 403);
    c.set('tmaUser', user);
    await next();
  };

  // Данные — только scoped(tmaUser.id): чужие tg_id не раскрываются.
  app.get('/api/tma/overview', tmaAuth, async (c) => {
    const user = c.get('tmaUser');
    const repo = scoped(c.env.DB, user.id);
    const fx = deps.fx ?? createFrankfurter();
    try {
      const overview = await buildOverview(repo, (ccys) => getFxRates(c.env.DB, fx, ccys, new Date()));
      if (!overview) return c.json({ ok: false, error: 'not onboarded' }, 403);
      return c.json(overview);
    } catch (e) {
      if (e instanceof FxUnavailable) return c.json({ ok: false, error: 'fx unavailable' }, 503);
      throw e;
    }
  });

  // REST API Mini App — паритет бота (веха E) + кредиты/займы (H3).
  const fxProvider = deps.fx ?? createFrankfurter();
  registerTmaApi(app, tmaAuth, fxProvider);
  registerTmaDebts(app, tmaAuth, fxProvider);
  registerTmaFx(app, tmaAuth, fxProvider);
  // Скриншот банка из Mini App — те же ключи/фетч, что и у бота
  // (deps.vision в тестах, env-секреты в проде; резолвится на запрос).
  registerTmaVision(app, tmaAuth, (c) =>
    deps.vision ?? {
      geminiKey: c.env.GEMINI_API_KEY,
      geminiModel: c.env.GEMINI_MODEL,
      groqKey: c.env.GROQ_API_KEY,
      groqModel: c.env.GROQ_MODEL,
    },
  );

  app.post('/telegram/webhook', async (c) => {
    const auth = await verifyWebhookSecret(
      c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? null,
      c.env.TELEGRAM_WEBHOOK_SECRET,
    );
    if (auth === 'unset') {
      console.error('webhook: TELEGRAM_WEBHOOK_SECRET не задан — отказ (fail-closed)');
      return c.json({ ok: false, error: 'webhook not configured' }, 503);
    }
    if (auth !== 'ok') {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    // Невалидное тело → 200: Telegram ретраит не-2xx и спамил бы апдейтами.
    let update: z.infer<typeof updateSchema>;
    try {
      update = updateSchema.parse(await c.req.json());
    } catch {
      return c.json({ ok: true });
    }
    const msg = update.message;
    const cb = update.callback_query;
    if (
      (!msg || msg.chat.type !== 'private' || !msg.from) &&
      (!cb || cb.message?.chat.type !== 'private' || !cb.from)
    ) {
      return c.json({ ok: true });
    }

    const repo = accessRepo(c.env.DB);
    if (!(await repo.markUpdateProcessed(update.update_id))) {
      return c.json({ ok: true }); // дубликат — уже обработан
    }

    const telegram = deps.telegram ?? createTelegramClient({ token: c.env.TELEGRAM_BOT_TOKEN });
    // vision-провайдеры: из deps (тесты) или из env-секретов (шаг 7)
    const vision: import('../services/vision').VisionProviders = deps.vision ?? {
      geminiKey: c.env.GEMINI_API_KEY,
      geminiModel: c.env.GEMINI_MODEL,
      groqKey: c.env.GROQ_API_KEY,
      groqModel: c.env.GROQ_MODEL,
    };
    const accessDeps = {
      db: c.env.DB,
      telegram,
      ownerTelegramId: c.env.OWNER_TELEGRAM_ID,
      botUsername: c.env.TELEGRAM_BOT_USERNAME,
      fx: deps.fx ?? createFrankfurter(),
      vision,
    };
    try {
      if (cb && cb.message?.chat.type === 'private' && cb.from) {
        await handleCallback(
          {
            id: cb.id,
            chatId: cb.message.chat.id,
            fromId: cb.from.id,
            firstName: cb.from.first_name ?? null,
            data: cb.data ?? '',
            updateId: update.update_id,
            messageId: cb.message.message_id, // опционально в схеме; без него — fallback на sendMessage
          },
          accessDeps,
        );
        return c.json({ ok: true });
      }
      // Фото: самый крупный размер — последний элемент массива; документ —
      // только изображения (image/*). Подпись к фото игнорируем.
      const photoFileId =
        msg!.photo?.at(-1)?.file_id ??
        (msg!.document?.mime_type?.startsWith('image/') ? msg!.document.file_id : undefined);
      const photoMime = msg!.document?.mime_type?.startsWith('image/') ? msg!.document.mime_type : 'image/jpeg';
      await handleMessage(
        {
          chatId: msg!.chat.id,
          fromId: msg!.from!.id,
          firstName: msg!.from!.first_name ?? null,
          text: msg!.text ?? '',
          updateId: update.update_id,
          ...(photoFileId ? { photoFileId, photoMime } : {}),
        },
        accessDeps,
      );
    } catch (e) {
      // Никогда не логируем тело/текст/токены — update_id + код и
      // короткое санитизированное описание (для TelegramError — error_code).
      console.error(`webhook: update ${update.update_id} не обработан (${sanitizeTelegramError(e)})`);
      // R8: пользователь получает честный ответ, а не тишину (best-effort).
      try {
        const chatId = cb?.message?.chat.type === 'private' ? cb.message.chat.id : msg?.chat.id;
        if (cb) await telegram.answerCallbackQuery(cb.id, 'Что-то пошло не так.');
        if (chatId) {
          await telegram.sendMessage(chatId, 'Что-то пошло не так. Попробуйте ещё раз или откройте меню.', {
            replyMarkup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'nv:home' }]] },
          });
        }
      } catch {
        /* фолбэк тоже может упасть — глотаем */
      }
    }
    return c.json({ ok: true });
  });

  /**
   * SPA-fallback (Workers Static Assets): не-API GET/HEAD запросы, не нашедшие
   * маршрута в воркере, делегируются ассетам — там index.html (SPA) или 404.
   * API-пути никогда в SPA не проваливаются — честный JSON-404.
   */
  app.notFound(async (c) => {
    const path = new URL(c.req.url).pathname;
    const isApi = path.startsWith('/api/') || path.startsWith('/telegram/') || path === '/health';
    if (isApi || (c.req.method !== 'GET' && c.req.method !== 'HEAD') || !c.env.ASSETS) {
      return c.json({ ok: false, error: 'not found' }, 404);
    }
    // ASSETS-ответ иммутабелен — клонируем, чтобы middleware мог ставить заголовки
    const assetRes = await c.env.ASSETS.fetch(c.req.raw);
    return new Response(assetRes.body, assetRes);
  });

  return app;
}
