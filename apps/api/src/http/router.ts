import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { verifyWebhookSecret } from './security';
import { accessRepo } from '../db/repo';
import { handleCallback, handleMessage } from '../services/access';
import { createFrankfurter } from '../fx/frankfurter';
import { createTelegramClient, sanitizeTelegramError, type TelegramClient } from '../telegram/client';

const APP_VERSION = '0.1.0';

// Минимальная схема: только поля, нужные контуру доступа (S12).
const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      text: z.string().optional(),
      chat: z.object({ id: z.number(), type: z.string() }),
      from: z.object({ id: z.number(), first_name: z.string().optional(), username: z.string().optional() }).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().max(64).optional(),
      from: z.object({ id: z.number(), first_name: z.string().optional(), username: z.string().optional() }).optional(),
      message: z.object({ chat: z.object({ id: z.number(), type: z.string() }) }).optional(),
    })
    .optional(),
});

export interface RouterDeps {
  /** Подмена клиента Telegram в тестах. */
  telegram?: TelegramClient;
  /** Подмена FX-провайдера в тестах. */
  fx?: import('../fx/provider').FxProvider;
}

/** HTTP-роутер воркера. Маршруты добавляются шагами миграции (ADR-0001). */
export function createRouter(deps: RouterDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      app: 'budget-companion-api',
      version: APP_VERSION,
      time: new Date().toISOString(),
    }),
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
    try {
      if (cb && cb.message?.chat.type === 'private' && cb.from) {
        await handleCallback(
          {
            id: cb.id,
            chatId: cb.message.chat.id,
            fromId: cb.from.id,
            firstName: cb.from.first_name ?? null,
            data: cb.data ?? '',
          },
          {
            db: c.env.DB,
            telegram,
            ownerTelegramId: c.env.OWNER_TELEGRAM_ID,
            botUsername: c.env.TELEGRAM_BOT_USERNAME,
            fx: deps.fx ?? createFrankfurter(),
          },
        );
        return c.json({ ok: true });
      }
      await handleMessage(
        {
          chatId: msg!.chat.id,
          fromId: msg!.from!.id,
          firstName: msg!.from!.first_name ?? null,
          text: msg!.text ?? '',
          updateId: update.update_id,
        },
        {
          db: c.env.DB,
          telegram,
          ownerTelegramId: c.env.OWNER_TELEGRAM_ID,
          botUsername: c.env.TELEGRAM_BOT_USERNAME,
          fx: deps.fx ?? createFrankfurter(),
        },
      );
    } catch (e) {
      // Никогда не логируем тело/текст/токены — update_id + код и
      // короткое санитизированное описание (для TelegramError — error_code).
      console.error(`webhook: update ${update.update_id} не обработан (${sanitizeTelegramError(e)})`);
    }
    return c.json({ ok: true });
  });

  return app;
}
