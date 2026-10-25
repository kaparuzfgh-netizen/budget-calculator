# AGENTS.md — заметки для ИИ-агентов и автоматизации

## Проект

Идёт миграция v1→v2 ([ADR-0001](docs/adr/0001-platform-and-architecture.md)).
До шага 9 живут **два стека одновременно**:

- **v1 (legacy):** Google Apps Script (`apps-script/*.gs`, единый глобальный
  скоуп модулей!), БД — Google Sheets, Mini App — `mini-app/index.html`.
  Runtime — **не Node**.
- **v2 (новый):** `apps/api` — Cloudflare Worker (TypeScript strict, Hono, D1
  через `wrangler d1 migrations`); `apps/web` — Mini App на Vite + TypeScript.
  Разработка v2 — `docs/v2-development.md`.

## Команды

- `npm ci` — все зависимости (workspaces: legacy + apps/*).
- `npm run check` — lint + smoke (v1) + typecheck + тесты API + сборка web.
  **Обязательно перед коммитом.**
- `npm test` — только офлайн-тесты v1 (моки Apps Script).
- `npm run typecheck` — `tsc --noEmit` по `apps/*`.
- `npm run test:api` — vitest в рантайме workerd с локальной D1.
- `npm run build:web` — сборка `apps/web` → `dist`.
- `npm run build:bundle` — `dist/BUNDLE.gs` (опциональный артефакт v1, gitignored).
- `npm run deploy [-- --dry-run]` — v1: check → `clasp push --force` → версия → деплой.
- `npm run dev -w apps/api` — wrangler dev (локальный воркер + D1).
- `npx clasp status` — какие файлы уедут в Apps Script.
- `npx clasp login` / `npx wrangler login` — только пользователь (браузер).

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
7. Деплой/вход в Google и Cloudflare — только владелец (interactive). Агенту
   достаточно `--dry-run` и `clasp status` / `wrangler deploy --dry-run`.
   Секреты CI (`CLASPRC_JSON`, `CLASP_JSON`, `DEPLOYMENT_ID`,
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) настраивает владелец —
   SETUP.md и docs/v2-development.md.
8. `node_modules/`, `dist/`, `.wrangler/`, `dist-check/` — не трекаются.

## Правила v2 (apps/*)

9. **Workers ≠ Node**: в коде `apps/api` — только Web API (fetch, Web Crypto,
   `crypto`, `URL`, `URLSearchParams` здесь ЕСТЬ), никаких `process`, `fs`,
   `Buffer`, `node:*`. Тесты идут в workerd — но статически такие ошибки линтер
   не ловит, будь внимателен.
10. **Изоляция tenant (S5):** доступ к БД — только через `scoped(env.DB, userId)`
    в `apps/api/src/db/repo.ts`; каждый запрос обязан содержать
    `WHERE user_id = ?` (или join через таблицу с user_id). Сырые
    `db.prepare(...)` вне repo.ts запрещены; тест «A не видит B» обязателен.
11. **Никаких токенов в URL** — только `Authorization: Bearer <JWT>` после
    проверки `initData` (шаг 3). Секреты — `wrangler secret put`, локально —
    `.dev.vars` (в .gitignore).
12. Миграции — только новые файлы `migrations/NNNN_name.sql` (иммутабельны);
    применение — `wrangler d1 migrations apply DB [--local|--remote]`.
13. Zod-схемы на каждом входе (S12); домен в `src/domain/` — чистые функции
    без I/O (числа-эталоны из `scripts/smoke-test.js`).
14. Не «чинить молча» найденные баги v1 (например `URLSearchParams` в
    `TmaApi.gs`) — v1 живёт до шага 9 как есть, находки — в отчёт владельцу.
