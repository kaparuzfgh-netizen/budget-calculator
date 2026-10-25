import { Hono } from 'hono';
import type { Env } from '../env';

const APP_VERSION = '0.1.0';

/** HTTP-роутер воркера. Маршруты добавляются шагами миграции (ADR-0001). */
export function createRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      app: 'budget-companion-api',
      version: APP_VERSION,
      time: new Date().toISOString(),
    }),
  );

  return app;
}
