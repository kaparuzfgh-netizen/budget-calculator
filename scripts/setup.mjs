#!/usr/bin/env node
/**
 * setup.mjs — мастер первичной настройки бота v2 (одна команда `npm run setup`).
 *
 * Владельцу нужно вставить токен @BotFather ОДИН раз — всё остальное
 * автоматизировано. Повторный запуск безопасен (идемпотентно; при этом
 * TELEGRAM_WEBHOOK_SECRET генерируется заново — его нельзя прочитать обратно).
 *
 * Флаги: --dry-run (план без вызовов), --skip-deploy, --rotate (JWT_SECRET тоже).
 */
import './env.mjs'; // корневой .env → process.env (только недостающие ключи)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { askHidden } from './ask-hidden.mjs';
import { buildSetWebhookPayload, maskUrl, redact } from './webhook-utils.mjs';
import {
  deriveWorkerUrl,
  getTomlVar,
  isValidBotToken,
  parseDatabaseId,
  parseSecretList,
  parseWorkerName,
  pickPrivateSender,
  setTomlVar,
} from './setup-utils.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'apps', 'api');
const tomlPath = path.join(apiDir, 'wrangler.toml');
// wrangler может быть поднят npm в корневой node_modules (workspaces hoist) —
// резолвим от package.json воркера, а не фиксированным путём.
const wranglerBin = path.join(
  path.dirname(createRequire(path.join(apiDir, 'package.json')).resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const SKIP_DEPLOY = args.includes('--skip-deploy');
const ROTATE = args.includes('--rotate');

let step = 0;
const TOTAL = 9;
const secretsToRedact = [];
const p = (s = '') => console.log(s);
const stepLog = (msg) => p(`\n[${++step}/${TOTAL}] ${msg}`);
const die = (msg, code = 1) => {
  console.error(`\n⛔ ${redact(msg, secretsToRedact)}`);
  process.exit(code);
};
const hide = (s) => redact(s, secretsToRedact);

// ── ввод ──
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── wrangler (без шелла, argv-массивом) ──
function wrangler(argv, { input, capture = true } = {}) {
  try {
    const out = execFileSync(process.execPath, [wranglerBin, ...argv], {
      cwd: apiDir,
      encoding: 'utf8',
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : capture ? 'pipe' : 'inherit',
      ...(input !== undefined ? { input } : {}),
    });
    return { ok: true, out: out ?? '' };
  } catch (e) {
    const text = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
    return { ok: false, out: hide(text) };
  }
}

// ── Telegram API ──
async function tg(token, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.ok) {
    const d = j?.description ?? `HTTP ${res.status}`;
    const err = new Error(`Telegram ${method}: ${d}`);
    err.status = res.status;
    throw err;
  }
  return j.result;
}

// ── секреты через stdin, никогда через argv ──
function secretPut(name, value) {
  const r = wrangler(['secret', 'put', name], { input: value });
  if (!r.ok) die(`wrangler secret put ${name}: ${r.out}`);
  p(`   ✓ секрет ${name} загружен`);
}

// ── Ctrl+C: оставляем понятное состояние ──
let webhookState = 'не настроен';
process.on('SIGINT', () => {
  console.log(`\n\n⛔ Прервано (Ctrl+C). Состояние webhook: ${webhookState}.`);
  process.exit(130);
});

async function main() {
  p('Мастер настройки бота v2 · budget-companion-api' + (DRY ? '  (--dry-run: только план)' : ''));

  if (DRY) {
    p(`
План (${TOTAL} шагов):
[1] Проверки: Node ≥20, wrangler whoami, database_id в wrangler.toml
[2] Токен @BotFather (скрытый ввод или env TELEGRAM_BOT_TOKEN) → getMe
[3] TELEGRAM_BOT_USERNAME → wrangler.toml [vars]
[4] wrangler d1 migrations apply DB --remote + wrangler deploy${SKIP_DEPLOY ? ' (пропущено)' : ''}
[5] Секреты: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (новый каждый раз), JWT_SECRET${ROTATE ? ' (перегенерация)' : ' (если отсутствует)'}, DATA_KEY (если отсутствует; --rotate НЕ трогает)
[6] Поиск владельца: deleteWebhook → getUpdates → подтверждение → OWNER_TELEGRAM_ID
[7] setWebhook (secret_token, allowed_updates=["message"]) → getWebhookInfo
[8] GET /health → сводка. Секреты не печатаются и не сохраняются (исключение — новый DATA_KEY: показывается один раз для бэкапа).`);
    process.exit(0);
  }

  // ── 1. Предусловия ──
  stepLog('Предусловия');
  if (NODE_MAJOR < 20) die(`Node ${process.versions.node} — нужен ≥20 (см. .nvmrc).`);
  if (!fs.existsSync(wranglerBin)) die('wrangler не найден. Выполните: npm ci');
  const who = wrangler(['whoami']);
  if (!who.ok) die('wrangler не авторизован. Выполните: npm run wrangler -- login');
  p(`   ✓ Cloudflare: вошли (${who.out.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? 'аккаунт ок'})`);
  const toml = fs.readFileSync(tomlPath, 'utf8');
  if ((parseDatabaseId(toml) ?? 'PLACEHOLDER') === 'PLACEHOLDER_SET_BY_OWNER') {
    die(
      'wrangler.toml: database_id = PLACEHOLDER_SET_BY_OWNER.\n' +
        '   Создайте БД: npm run wrangler -- d1 create budget-companion\n' +
        '   и впишите выданный database_id в apps/api/wrangler.toml.',
    );
  }
  p('   ✓ database_id задан');

  // ── 2. Токен ──
  stepLog('Токен бота');
  let token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (!token) {
    token = await askHidden('Токен из @BotFather (скрытый ввод): ');
    p(`   принято: ${token.length} символов`); // только длина, никогда значение
  }
  secretsToRedact.push(token);
  if (!isValidBotToken(token)) die('Формат токена не похож на BotFather-токен (<digits>:<secret>).');
  let me;
  try {
    me = await tg(token, 'getMe');
  } catch (e) {
    if (e.status === 401 || e.status === 404) {
      die('Токен неверный — скопируйте заново из @BotFather → /mybots → API Token.');
    }
    throw e;
  }
  p(`   ✓ Бот: ${me.first_name} (@${me.username})`);

  // ── 3. wrangler.toml ──
  stepLog('Username бота в wrangler.toml');
  fs.writeFileSync(tomlPath, setTomlVar(toml, 'TELEGRAM_BOT_USERNAME', me.username));
  p(`   ✓ TELEGRAM_BOT_USERNAME = "${me.username}"`);

  // ── 4. Миграции + деплой ──
  stepLog('Миграции D1 и деплой');
  const mig = wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  if (!mig.ok) die(`миграции: ${mig.out}`);
  p('   ✓ миграции применены');
  let deployOut = '';
  if (SKIP_DEPLOY) {
    p('   ⊘ деплой пропущен (--skip-deploy)');
  } else {
    const dep = wrangler(['deploy']);
    if (!dep.ok) die(`deploy: ${dep.out}`);
    deployOut = dep.out;
    p('   ✓ воркер задеплоен');
  }

  // ── 5. Секреты ──
  stepLog('Секреты воркера');
  const listR = wrangler(['secret', 'list']);
  const existing = listR.ok ? parseSecretList(listR.out) : new Set();
  const webhookSecret = crypto.randomBytes(32).toString('hex');
  secretsToRedact.push(webhookSecret);
  secretPut('TELEGRAM_BOT_TOKEN', token);
  secretPut('TELEGRAM_WEBHOOK_SECRET', webhookSecret); // новый каждый запуск
  if (!existing.has('JWT_SECRET') || ROTATE) {
    const jwt = crypto.randomBytes(32).toString('hex');
    secretsToRedact.push(jwt);
    secretPut('JWT_SECRET', jwt);
    p(ROTATE ? '   ✓ JWT_SECRET перегенерирован (--rotate)' : '   ✓ JWT_SECRET создан');
  } else {
    p('   ⊘ JWT_SECRET уже задан — пропущено');
  }
  // DATA_KEY — ключ шифрования данных; НИКОГДА не перегенерируем (потеря = данные не расшифровать).
  if (!existing.has('DATA_KEY')) {
    const dk = crypto.randomBytes(32).toString('base64');
    secretPut('DATA_KEY', dk);
    p('   ✓ DATA_KEY создан');
    p('   ⚠️⚠️  DATA_KEY (сохраните ОДИН РАЗ в менеджер паролей — потеря = данные не расшифровать):');
    p('       ' + dk);
  } else {
    p('   ⊘ DATA_KEY уже задан — пропущено (не перегенерируем никогда)');
  }

  // ── 6. Владелец ──
  stepLog('Владелец (OWNER_TELEGRAM_ID)');
  let needDiscovery = !existing.has('OWNER_TELEGRAM_ID');
  if (!needDiscovery) {
    const keep = (await ask('   OWNER_TELEGRAM_ID уже задан. Оставить? [Y/n] ')).toLowerCase();
    if (keep === '' || keep === 'y' || keep === 'д') {
      p('   ⊘ оставлен существующий');
    } else {
      needDiscovery = true;
    }
  }
  if (needDiscovery) {
    // discovery через getUpdates (вебхук должен быть выключен)
    await tg(token, 'deleteWebhook', { drop_pending_updates: false });
    webhookState = 'удалён (для поиска владельца)';
    p('   Откройте бота в Telegram и отправьте ему любое сообщение.');
    p('   Жду до 2 минут (Ctrl+C — выход)…');
    const deadline = Date.now() + 120_000;
    let offset = 0;
    let owner = null;
    while (Date.now() < deadline && !owner) {
      let updates = [];
      try {
        updates = await tg(token, 'getUpdates', { timeout: 25, offset, allowed_updates: ['message'] });
      } catch {
        /* сеть моргнула — продолжаем поллинг */
      }
      const hit = pickPrivateSender(updates, offset - 1);
      if (hit) {
        const ans = (await ask(`   Найден: ${hit.firstName || '?'} (id ${hit.tgId}). Это вы? [y/N] `)).toLowerCase();
        if (ans === 'y' || ans === 'д') {
          owner = hit;
        } else {
          offset = hit.updateId + 1; // не тот человек — ack и ждём дальше
        }
      }
      if (!owner) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!owner) die('Владелец не найден за 2 минуты. Перезапустите npm run setup после сообщения боту.');
    // ack все прочитанные апдейты — Telegram их не реплеит
    await tg(token, 'getUpdates', { offset: owner.updateId + 1, timeout: 0 }).catch(() => {});
    secretPut('OWNER_TELEGRAM_ID', String(owner.tgId));
    p(`   ✓ владелец: ${owner.firstName || '?'} (id ${owner.tgId})`);
  }

  // ── 7. Webhook ──
  stepLog('Регистрация webhook');
  let workerUrl = deriveWorkerUrl({ deployOutput: deployOut, workerName: parseWorkerName(toml), subdomain: null });
  if (!workerUrl) {
    workerUrl = await ask('   URL воркера (https://<name>.<sub>.workers.dev): ');
    if (!/^https:\/\/[\w.-]+\.workers\.dev/.test(workerUrl)) die('Некорректный URL воркера.');
  }
  const whUrl = `${workerUrl.replace(/\/+$/, '')}/telegram/webhook`;
  await tg(token, 'setWebhook', buildSetWebhookPayload({ url: whUrl, secretToken: webhookSecret }));
  webhookState = `установлен: ${maskUrl(whUrl)}`;
  const info = await tg(token, 'getWebhookInfo');
  if (maskUrl(info.url ?? '') !== maskUrl(whUrl)) die('getWebhookInfo: url не совпадает с установленным.');
  if (info.last_error_message) p(`   ⚠️  Telegram last_error: ${hide(info.last_error_message)}`);
  p(`   ✓ webhook: ${maskUrl(whUrl)}`);

  // ── 8. Menu Button — голубая кнопка Mini App у поля ввода ──
  stepLog('Menu Button (кнопка приложения у поля ввода)');
  const appUrl = getTomlVar(toml, 'MINI_APP_URL') ?? workerUrl;
  await tg(token, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: '💰 Бюджет', web_app: { url: appUrl } },
  });
  p(`   ✓ menu button: ${maskUrl(appUrl)}`);

  // ── 9. Финал ──
  stepLog('Проверка /health');
  try {
    const h = await fetch(`${workerUrl}/health`).then((r) => r.json());
    if (!h?.ok) throw new Error('ok != true');
    p('   ✓ /health отвечает');
  } catch (e) {
    p(`   ⚠️  /health недоступен (${hide(String(e.message ?? e))}) — проверьте деплой/URL.`);
  }
  p(`
✅ Готово. Напишите боту /start — вы будете зарегистрированы владельцем.

Итог:
   бот            @${me.username}
   воркер         ${maskUrl(whUrl)}
   webhook        ${webhookState}
   деплой         ${SKIP_DEPLOY ? 'пропущен' : 'выполнен'}
   OWNER_TG_ID    ${existing.has('OWNER_TELEGRAM_ID') ? 'оставлен' : 'задан'}
   WEBHOOK_SECRET обновлён (рандом, только в Cloudflare)
   JWT_SECRET     ${!existing.has('JWT_SECRET') || ROTATE ? 'обновлён' : 'оставлен'}
   DATA_KEY       ${!existing.has('DATA_KEY') ? 'создан (см. выше — СОХРАНИТЬ!)' : 'оставлен'}

Повторный запуск безопасен: шаги идемпотентны, webhook-секрет при этом обновляется.`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
