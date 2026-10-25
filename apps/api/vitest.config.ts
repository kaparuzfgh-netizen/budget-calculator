import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Тесты исполняются в workerd с локальной D1 (miniflare); миграции — настоящие .sql.
export default defineConfig(async () => ({
  test: { testTimeout: 20_000 }, // workerd cold-start первого изолята медленнее 5с
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) },
      },
    }),
  ],
}));
