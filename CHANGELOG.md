# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

## [Unreleased]

### Добавлено
- **`npm run setup` — интерактивный мастер подключения бота v2:** владельцу
  нужен только токен @BotFather (скрытый ввод, поддерживает вставку);
  остальное автоматизировано — getMe, username в `wrangler.toml`,
  миграции D1 + `wrangler deploy`, секреты через stdin
  (`TELEGRAM_WEBHOOK_SECRET` генерируется заново при каждом запуске,
  `JWT_SECRET` — если отсутствует или `--rotate`), поиск владельца через
  getUpdates с подтверждением, `setWebhook` + проверка `getWebhookInfo`
  и `/health`. Флаги `--dry-run`, `--skip-deploy`, `--rotate`; идемпотентен;
  ошибки — понятными русскими сообщениями. Ручной путь сохранён в docs
  как fallback.
- **Webhook бота v2** (шаг 3 миграции): `POST /telegram/webhook` с проверкой
  `X-Telegram-Bot-Api-Secret-Token` (fail-closed, константное сравнение через
  SHA-256), дедуп `update_id` (миграция `0002_processed_updates.sql`),
  авто-бутстрап владельца по `OWNER_TELEGRAM_ID`, одноразовые инвайты
  `/invite` (в БД — только SHA-256 кода, TTL 48ч, лимит 10 активных),
  `/start <code>` с атомарным погашением одним D1 batch, команды
  `/start /help /id`, молчание для незнакомцев. Клиент Telegram
  `sendMessage` с HTML-экранированием имён. Скрипт
  `scripts/telegram-webhook.mjs` (`webhook:set|info|delete`, скрытый ввод
  секретов). В тестах — гонка двух sender'ов на один код, отсутствие
  открытого кода в БД, отсутствие секретов в логах ошибок.
- **Каркас v2** (шаг 1 миграции, [ADR-0001](docs/adr/0001-platform-and-architecture.md)):
  npm-workspaces `apps/*`; `apps/api` — Cloudflare Worker (TypeScript strict,
  Hono, zod) с `GET /health`, биндингами D1 `DB` и секретами
  (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `JWT_SECRET`), миграцией
  `0001_init.sql` (users/invites/consents/audit_log) и репозиторным слоем
  `scoped(db, userId)` с принудительным `WHERE user_id = ?`; `apps/web` —
  placeholder на Vite + TypeScript. Тесты vitest исполняются в workerd
  (@cloudflare/vitest-plugin) с локальной D1: /health, миграции, изоляция
  tenant «A не видит B», проверка рантайма.
- CI: в `ci.yml` добавлены typecheck, тесты API и сборка web;
  `deploy-v2.yml` — деплой в Cloudflare (миграции D1 → wrangler deploy →
  Pages) по секретам `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`,
  до их настройки пропускается без ошибки.
- `docs/v2-development.md` — локальный запуск, миграции, настройка деплоя.
- Правила v2 в AGENTS.md (только Workers-совместимые API, изоляция через
  репозиторий, без токенов в URL, секреты через `wrangler secret`).

### Изменено
- Разработка и деплой — только через clasp: `npm run bootstrap` (первый раз)
  и `npm run deploy` (push → версия → развёртывание → URL). `apps-script/`
  содержит теперь только пушаемые файлы (15 `*.gs` + `appsscript.json`);
  `.clasp.json.example` и `secrets.example.json` вынесены в корень,
  `.claspignore` явно запрещает пуш всего остального.
- `BUNDLE.gs` больше не хранится в репозитории: при желании собирается
  командой `npm run build:bundle` → `dist/BUNDLE.gs` (в `.gitignore`,
  в Apps Script не пушится). Порядок модулей — массив `ORDER`
  в `scripts/build-bundle.js`, общий с smoke-тестами.
- Установка в SETUP.md переписана под clasp-цикл; убран быстрый путь
  «вставить один файл» — вся установка и обновление идут одинаково.

### Добавлено
- Tooling: `package.json` (dev: @google/clasp, eslint flat-config, prettier),
  `npm run check` = lint + тесты; `node_modules/.bin/clasp` — локальный.
- `scripts/deploy.js` (`--dry-run`), `scripts/bootstrap.js`,
  `scripts/install-hooks.js` (prepare-hook при `npm install`),
  `scripts/lint-sh.js` (опциональный shellcheck).
- CI/CD: `ci.yml` (lint, тесты, сборка бандла, shellcheck, gitleaks),
  `deploy-apps-script.yml` (main + apps-script/** → clasp deploy через секреты
  CLASPRC_JSON/CLASP_JSON/DEPLOYMENT_ID, environment production),
  `deploy-mini-app.yml` (GitHub Pages с подстановкой `WEBAPP_URL`),
  `dependabot.yml`, шаблон PR.
- `eslint.config.mjs` — линт `scripts/` и собранного `dist/BUNDLE.gs`
  с глобалами Apps Script; `.editorconfig`, `.nvmrc` (Node 22),
  `.prettierrc.json` + `.prettierignore`, `LICENSE`, `CHANGELOG.md`,
  `CONTRIBUTING.md`, `AGENTS.md`, `.deploy.json.example`.

### Удалено
- `apps-script/BUNDLE.gs` (артефакт сборки — теперь генерируется в `dist/`).
- `scripts/build-bundle.sh` (заменён кроссплатформенным `scripts/build-bundle.js`).
