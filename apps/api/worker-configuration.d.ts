/**
 * Декларация-мердж глобальных типов Workers:
 *  - Cloudflare.Env — биндинги воркера (env.DB, секреты) + тестовый биндинг
 *    TEST_MIGRATIONS, который существует только внутри vitest (см. vitest.config.ts);
 *  - Cloudflare.GlobalProps.mainModule — чтобы `exports` из 'cloudflare:workers'
 *    знал тип default-экспорта (интеграционные тесты).
 */
import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from './src/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import('./src/index');
    }
  }
}

export {};
