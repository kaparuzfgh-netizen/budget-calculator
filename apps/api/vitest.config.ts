import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, 'migrations');

// wrangler.toml [assets] → ../web/dist: miniflare не создаёт биндинг ASSETS,
// если каталога нет (свежий checkout до `npm run build:web`). Тогда SPA-
// fallback воркера нечего отдавать — подкладываем минимальный index.html.
const assetsDir = path.join(here, '..', 'web', 'dist');
const assetsIndex = path.join(assetsDir, 'index.html');
if (!fs.existsSync(assetsIndex)) {
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(
    assetsIndex,
    '<!doctype html><html lang="ru"><body><main id="app"></main></body></html>\n',
  );
}

// Тесты исполняются в workerd с локальной D1 (miniflare); миграции — настоящие .sql.
export default defineConfig(async () => ({
  test: { testTimeout: 20_000, setupFiles: ['./test/setup.ts'] }, // workerd cold-start первого изолята медленнее 5с
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
          // Тестовый мастер-ключ шифрования (32 нулевых байта base64).
          DATA_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          // Тесты не ходят в сеть: биржа выключена (в тестах MOEX подставляется фейком через deps.moex).
          MOEX_PRICES: 'off',
        },
      },
    }),
  ],
}));
