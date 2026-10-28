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
- `npm run setup` — мастер подключения бота v2 (токен BotFather один раз,
  дальше всё само; `--dry-run` печатает план).
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
5. **Mini App API:** `/api/tma/*` — Bearer-JWT, только scoped(user.id), суммы
   minor units, идемпотентность `client_id`; правила — как у бота (та же валидация).
6. **GAS V8 ≠ Node**: нет `fetch`, `URLSearchParams`, `URL`, `atob`, `btoa`,
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
15. **Вебхук:** никогда не логировать текст сообщений, токены, коды инвайтов
    и их хэши (в логах — только `update_id` и код ошибки). Незнакомым
    отправителям — тишина и ноль записей в БД. Код приглашения хранится
    только как SHA-256 hex; в audit_log — `expires_at`, не код.
17. **Деньги:** в D1 — INTEGER minor units (копейки); домен — float,
    конвертация `toMinor/fromMinor` на границе repo. Курсы — только через
    `getFxRates` (D1-кэш 6ч + provider). Онбординг — чистый редьюсер
    `bot/onboarding.ts` (эффекты исполняет services/access.ts).
18. **Навигация бота:** источник истины — `docs/ux/navigation.md` +
    `src/bot/nav/screens.json` (zod-реестр). Любое изменение экранов
    сначала вносится в оба; нав-ряды только через `navRow()` (R1–R4),
    колбэки `nv:home`/`nv:back:<id>`/`nv:go:<id>` whitelist-ятся реестром.
    Тест `nav.test.ts` сверяет реестр, mermaid-схему и ряды.
18. **Профиль:** `income_minor` — «типичный доход» (0 = не задан); факт —
    `income_entries` по месяцам (`/income`). Правки профиля — редьюсер
    `bot/profile.ts` (`advancePf`); колбэки `pf:*`/`in:*` step-aware
    (`PF_STEPS`), CAS-запись состояния; ВСЕ мутации по id —
    `WHERE id=? AND user_id=?` (чужие id молча игнорируются).
16. Проверка `X-Telegram-Bot-Api-Secret-Token` — fail-closed (нет секрета в
    env → 503) и константная по времени (`src/http/security.ts`).
19. **Mini App (шаг 5):** SPA — Workers Static Assets в том же воркере
    (`wrangler.toml [assets]` → `../web/dist`, SPA-fallback;
    `run_worker_first = ["/api/*", "/telegram/*", "/health"]`, иначе
    SPA перехватит эти пути). Перед `wrangler deploy` — сборка `apps/web`
    (в `scripts/release.mjs` уже есть). Auth: `POST /api/tma/auth {initData}`
    — HMAC «WebAppData» по токену бота (Web Crypto), `auth_date` ≤ 24ч,
    юзер onboarded → JWT HS256 `{tg_id}` на 12ч (`src/tma/auth.ts`);
    дальше `Authorization: Bearer` на `/api/tma/*` (любой не-валидный → 401).
    Запуск Mini App — menu-button у поля ввода (`setChatMenuButton`,
    `web_app` → `MINI_APP_URL` из `[vars]`): ставится в `npm run setup` или
    `node scripts/telegram-webhook.mjs menu <url>`. Inline-кнопки
    «📱 Приложение» в экранах бота нет.

