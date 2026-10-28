#!/usr/bin/env node
/**
 * release.mjs — одна команда релиза: typecheck → test:api → сборка web →
 * миграции → deploy → /health.
 * Порядок важен: деплой НЕ выполняется при неприменённых миграциях, а
 * apps/web собирается ДО wrangler deploy — иначе assets уедут устаревшие.
 * Флаги: --dry-run (только план), --skip-checks.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { deriveWorkerUrl, parseWorkerName } from './setup-utils.mjs';
import { maskUrl, redact } from './webhook-utils.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'apps', 'api');
// wrangler может быть поднят npm в корневой node_modules (workspaces hoist) —
// резолвим от package.json воркера, а не фиксированным путём.
const wranglerBin = path.join(
  path.dirname(createRequire(path.join(apiDir, 'package.json')).resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const SKIP = args.includes('--skip-checks');
const secrets = [];

const p = (s = '') => console.log(s);
const die = (m) => { console.error(`\n⛔ ${redact(m, secrets)}`); process.exit(1); };
const npm = (argv, cwd = root) => {
  const cli = process.env.npm_execpath;
  const opts = { cwd, encoding: 'utf8', stdio: 'pipe' };
  if (cli && /\.[cm]?js$/.test(cli)) return execFileSync(process.execPath, [cli, ...argv], opts);
  return execFileSync('npm', argv, { ...opts, shell: process.platform === 'win32' });
};
const wrangler = (argv, opts = {}) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [wranglerBin, ...argv], { cwd: apiDir, encoding: 'utf8', stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'pipe', ...(opts.input !== undefined ? { input: opts.input } : {}) }) ?? '' };
  } catch (e) {
    return { ok: false, out: redact([e.stdout, e.stderr, e.message].filter(Boolean).join('\n'), secrets) };
  }
};

/** Классификация ошибок wrangler для понятных русских сообщений. */
export function classifyReleaseError(output) {
  if (/error.*7403|ERR_VALIDATION.*7403|7403/.test(output)) return 'auth7403';
  if (/not logged in|unauthorized|401/i.test(output)) return 'unauth';
  if (/database_id|d1/i.test(output) && /migrations/i.test(output)) return 'd1';
  return 'generic';
}

function main() {
  p('Релиз budget-companion-api' + (DRY ? ' (--dry-run: только план)' : ''));
  if (DRY) {
    p('\nПлан:\n[1] typecheck + test:api' + (SKIP ? ' (пропущены)' : '') + '\n[2] wrangler whoami\n[3] сборка Mini App (npm run build -w apps/web) — assets воркера\n[4] d1 migrations apply DB --remote (при провале — АБОРТ, деплой не выполняется)\n[5] wrangler deploy\n[6] GET /health\n');
    process.exit(0);
  }
  if (!SKIP) {
    p('[1/6] Проверки');
    try { npm(['run', 'typecheck']); npm(['run', 'test:api']); p('   ✓ typecheck и тесты зелёные'); }
    catch (e) { die(`проверки упали — релиз отменён\n${String(e.stdout ?? e.message).slice(-2000)}`); }
  } else p('[1/6] Проверки пропущены (--skip-checks)');
  p('[2/6] Авторизация Cloudflare');
  const who = wrangler(['whoami']);
  if (!who.ok) {
    if (classifyReleaseError(who.out) === 'auth7403')
      die('токен Cloudflare протух (code: 7403) — выполните: npm run wrangler -- logout, затем npm run wrangler -- login, и повторите релиз.');
    die(`wrangler не авторизован: ${who.out}\nВыполните: npm run wrangler -- login`);
  }
  p('   ✓ вошли');
  p('[3/6] Сборка Mini App (apps/web → dist для [assets] воркера)');
  try { npm(['run', 'build', '-w', 'apps/web']); p('   ✓ apps/web/dist собран'); }
  catch (e) { die(`сборка web упала — релиз отменён\n${String(e.stdout ?? e.message).slice(-2000)}`); }
  p('[4/6] Миграции D1 (remote)');
  const mig = wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  if (!mig.ok) die(`миграции не применены — ДЕПЛОЙ ОТМЕНЁН\n${mig.out}`);
  p('   ✓ миграции применены');
  p('[5/6] Деплой воркера (+ статика Mini App из apps/web/dist)');
  const dep = wrangler(['deploy']);
  if (!dep.ok) die(`deploy: ${dep.out}`);
  const url = deriveWorkerUrl({ deployOutput: dep.out, workerName: parseWorkerName(fs.readFileSync(path.join(apiDir, 'wrangler.toml'), 'utf8')), subdomain: null });
  p(`   ✓ задеплоен${url ? ` (${maskUrl(url)})` : ''}`);
  p('[6/6] Проверка /health');
  if (url) {
    fetch(`${url}/health`).then((r) => r.json()).then((h) => {
      p(h?.ok ? '\n✅ Релиз завершён — /health отвечает.' : '\n⚠️ Задеплоено, но /health ответил не ok — проверьте wrangler tail.');
    }).catch(() => p('\n⚠️ Задеплоено, но /health недоступен — проверьте wrangler tail.'));
  } else p('\n⚠️ URL воркера не определён — проверьте /health вручную.');
}
main();
