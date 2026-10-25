import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { verifyWebhookSecret } from './security';
import { accessRepo } from '../db/repo';
import { handleMessage } from '../services/access';
import { createTelegramClient, type TelegramClient } from '../telegram/client';

const APP_VERSION = '0.1.0';

// Минимальная схема: только поля, нужные контуру доступа (S12).
const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      text: z.string().optional(),
      chat: z.object({ id: z.number(), type: z.string() }),
      from: z
        .object({ id: z.number(), first_name: z.string().optional(), username: z.string().optional() })
        .optional(),
    })
    .optional(),
});

export interface RouterDeps {
  /** Подмена клиента Telegram в тестах. */
  telegram?: TelegramClient;
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
    if (!msg || msg.chat.type !== 'private' || !msg.from) {
      return c.json({ ok: true });
    }

    const repo = accessRepo(c.env.DB);
    if (!(await repo.markUpdateProcessed(update.update_id))) {
      return c.json({ ok: true }); // дубликат — уже обработан
    }

    const telegram = deps.telegram ?? createTelegramClient({ token: c.env.TELEGRAM_BOT_TOKEN });
    try {
      await handleMessage(
        {
          chatId: msg.chat.id,
          fromId: msg.from.id,
          firstName: msg.from.first_name ?? null,
          text: msg.text ?? '',
        },
        {
          db: c.env.DB,
          telegram,
          ownerTelegramId: c.env.OWNER_TELEGRAM_ID,
          botUsername: c.env.TELEGRAM_BOT_USERNAME,
        },
      );
    } catch (e) {
      // Никогда не логируем тело/текст/токены — только update_id и класс ошибки.
      const code = e instanceof Error ? `${e.name}` : 'unknown';
      console.error(`webhook: update ${update.update_id} не обработан (${code})`);
    }
    return c.json({ ok: true });
  });

  return app;
}
