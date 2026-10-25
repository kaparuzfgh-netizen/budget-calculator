# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

## [Unreleased]

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
