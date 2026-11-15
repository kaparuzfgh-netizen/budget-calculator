import { createRouter } from './http/router';
import { configureDataKey, hasDataKey } from './db/crypto';
import { runEncryptionBackfill } from './services/encryption';
import { notifyOwner, runReminders } from './services/reminders';
import { sanitizeTelegramError } from './telegram/client';
import type { Env } from './env';

const app = createRouter();

// Backfill завершён — в стабильном состоянии нечего шифровать, пропускаем
// скан (12 SELECT/тик). Модульный флаг живёт на срок изолята: холодный
// старт прогонит backfill ещё раз (идемпотентно, убытка нет).
let backfillSettled = false;

export default {
  fetch: app.fetch,

  /** Cron: ежечасно — backfill шифрования + напоминания по локальному времени. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    configureDataKey(env.DATA_KEY);
    if (!hasDataKey()) {
      console.error('scheduled: DATA_KEY не задан — пропуск тика (fail-closed)');
      return;
    }
    // Backfill до напоминаний; ошибка не должна блокировать напоминания.
    if (!backfillSettled) {
      ctx.waitUntil(
        runEncryptionBackfill(env.DB)
          .then((n) => {
            if (n === 0) backfillSettled = true;
          })
          .catch((e) => console.error('encryptBackfill:', e)),
      );
    }
    // A2-2: тик целиком упал (до/вне по-пользовательского catch) —
    // без алерта поломку видно только в tail. Сообщаем владельцу.
    ctx.waitUntil(
      runReminders(env, new Date()).catch((e) =>
        notifyOwner(env, undefined, `⚠️ Cron-тик напоминаний упал (${sanitizeTelegramError(e)})`),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
