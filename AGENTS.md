# AGENTS.md — заметки для ИИ-агентов и автоматизации

## Проект

Serverless-бот личных финансов: бэкенд — Google Apps Script (`apps-script/*.gs`,
единый глобальный скоуп модулей!), БД — Google Sheets, UI — Telegram-бот
+ Mini App (`mini-app/index.html`). Runtime — **не Node**: см. ограничения ниже.

## Команды

- `npm ci` — зависимости (clasp, eslint, prettier — всё dev).
- `npm run check` — lint + офлайн smoke-тесты. **Обязательно перед коммитом.**
- `npm test` — только тесты (работают без сети и Google).
- `npm run build:bundle` — `dist/BUNDLE.gs` (опциональный артефакт, gitignored).
- `npm run deploy [-- --dry-run]` — check → `clasp push --force` → версия → деплой.
- `npx clasp status` — какие файлы уедут в Apps Script.
- `npx clasp login` — только пользователь (интерактивный браузер).

## Жёсткие правила

1. **Никогда не коммитить секреты**: `secrets.json`, `.env`, `.clasp.json`,
   `.deploy.json`, `~/.clasprc.json` — всё в `.gitignore`. Значения живут в
   Script Properties Apps Script.
2. **Никогда не добавлять `BUNDLE.gs` (и вообще не-`*.gs`/`appsscript.json`)
   в `apps-script/`** — clasp пушит содержимое папки; `.claspignore` режет
   лишнее, но не добавляй туда файлы вообще.
3. Новый `apps-script/*.gs` → добавить в `ORDER` (`scripts/build-bundle.js`);
   тест A0 падает, если файл не покрыт.
4. **Cross-file globals**: `.gs`-файлы видят top-level `function`/`const`
   друг друга — нет импортов. ESLint поэтому линтит собранный
   `dist/BUNDLE.gs`, а не отдельные файлы.
5. **GAS V8 ≠ Node**: нет `fetch`, `URLSearchParams`, `URL`, `atob`, `btoa`,
   `crypto`, таймеров, `process`. Вместо — `UrlFetchApp`, `Utilities`,
   `PropertiesService` и т.д. Не предлагать web-API в `.gs`-коде.
   Известный баг: `URLSearchParams` в `TmaApi.gs/validateInitData_` —
   не «чинить молча», сначала согласовать с владельцем.
6. Бизнес-логику `apps-script/*.gs` не менять без явной задачи; пользовательский
   текст — отдельным минимальным диффом.
7. Деплой/вход в Google — только владелец (interactive). Агенту достаточно
   `--dry-run` и `clasp status`. Секреты CI (`CLASPRC_JSON`, `CLASP_JSON`,
   `DEPLOYMENT_ID`) настраивает владелец — SETUP.md, раздел CI/CD.
8. `node_modules/` и `dist/` — не трекаются.
