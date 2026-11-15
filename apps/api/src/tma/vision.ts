/**
 * tma/vision.ts — POST /api/tma/vision/analyze: банковский скриншот из Mini App.
 *
 * Те же правила, что у бота (services/vision.handleVisionPhoto):
 *   opt-in profile.vision_enabled → {error:{code:'disabled'}};
 *   дневной лимит 20 — клеймы claimReminder('vision', '<today>:<n>') в
 *   reminder_log (бюджет ОБЩИЙ с ботом: одни и те же слоты);
 *   ключи провайдеров — только из env (прод) / deps.vision (тесты);
 *   файл ≤10 МБ, mime — image/jpeg|png|webp (octet-stream — снифаем сигнатуру).
 * Ответ: {ok:true, result: VisionResult (+transactions)}; провайдер упал →
 * 'provider_fail' с безопасной короткой причиной (provider/HTTP-статус).
 *
 * Приватность: байты изображения, тела ответов провайдеров и ключи в логи
 * не пишутся никогда — только код/короткая причина ошибки (S10).
 */
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { UserRow } from '../db/repo';
import { todayInTz } from '../bot/parse';
import type { VisionProviders } from '../services/vision';
import { parseScreenshot, toBase64, VisionError } from '../vision';
import { bad, err, notOnboarded, okJson, profile, repoOf, type TmaContext as C } from './common';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // как у бота (services/vision)
const VISION_DAILY_LIMIT = 20; // общие слоты с ботом — вид и ключ те же

/** Принимаемые Content-Type (octet-stream — на случай голого ArrayBuffer). */
const MIME_OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']);

/** Mime для провайдера: по сигнатуре файла, иначе — заявленный (jpeg по умолчанию). */
const sniffMime = (b: Uint8Array, declared: string): string => {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  )
    return 'image/webp';
  return MIME_OK.has(declared) && declared !== 'application/octet-stream' ? declared : 'image/jpeg';
};

export function registerTmaVision(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
  /** Ключи/модели/fetch провайдеров: deps.vision в тестах, env — в проде. */
  visionOf: (c: C) => VisionProviders,
): void {
  app.post('/api/tma/vision/analyze', tmaAuth, async (c) => {
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    // согласие — фича opt-in: без флага байты наружу не уходят (как в боте)
    if (p.vision_enabled !== 1) {
      return c.json(
        err('disabled', 'Распознавание скриншотов выключено — включите в профиле', 403).body,
        403,
      );
    }
    const declared = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!MIME_OK.has(declared)) return c.json(bad('ожидается изображение (jpeg/png/webp)').body, 400);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) return c.json(bad('пустой файл').body, 400);
    if (bytes.length > MAX_IMAGE_BYTES) {
      return c.json(err('too_big', 'Файл больше 10 МБ — пришлите скриншот поменьше', 413).body, 413);
    }
    const v = visionOf(c);
    if (!v.geminiKey && !v.groqKey) {
      return c.json(err('not_configured', 'Распознавание не настроено на сервере', 503).body, 503);
    }
    // дневной лимит — тот же claim-бакет, что у бота ('vision', '<today>:<n>')
    const today = todayInTz(p.timezone, new Date());
    if (!(await repo.claimVisionSlot(today, VISION_DAILY_LIMIT))) {
      return c.json(err('limit', 'Лимит: 20 скриншотов в день — попробуйте завтра', 429).body, 429);
    }
    try {
      const result = await parseScreenshot(toBase64(bytes), sniffMime(bytes, declared), {
        geminiKey: v.geminiKey,
        geminiModel: v.geminiModel,
        groqKey: v.groqKey,
        groqModel: v.groqModel,
        fallbackCcy: p.living_currency,
        currencies: [...new Set([p.income_currency, p.living_currency])],
        fetchImpl: v.fetchImpl,
      });
      return okJson(c, { ok: true, result });
    } catch (e) {
      // В лог — только provider/status (VisionError безопасен по контракту);
      // байты, тела и ключи — никогда (как webhook в services/vision).
      const reason =
        e instanceof VisionError ? (e.provider === 'vision' ? e.message : `${e.provider}: ${e.message}`) : null;
      console.error(`tma/vision: ${reason ?? 'unexpected'}`);
      return c.json(err('provider_fail', reason ?? 'сервис распознавания недоступен', 502).body, 502);
    }
  });
}
