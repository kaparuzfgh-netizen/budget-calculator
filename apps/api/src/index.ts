import { createRouter } from './http/router';
import type { Env } from './env';

const app = createRouter();

export default {
  fetch: app.fetch,

  /** Cron-триггеры (шаг 4 миграции). Раскомментировать вместе с [triggers]. */
  // async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {},
} satisfies ExportedHandler<Env>;
