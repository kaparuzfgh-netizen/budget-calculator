import { createRouter } from './http/router';
import { runReminders } from './services/reminders';
import type { Env } from './env';

const app = createRouter();

export default {
  fetch: app.fetch,

  /** Cron: ежечасно — напоминания по локальному времени пользователей. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReminders(env, new Date()));
  },
} satisfies ExportedHandler<Env>;
