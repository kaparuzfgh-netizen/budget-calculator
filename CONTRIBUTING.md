# Участие в проекте

Проект частный — изменения вносит владелец и приглашённые участники.

## Среда

- Node.js ≥ 20 (в `.nvmrc` — 22). Зависимости: `npm ci`.
- Cloudflare: `npm run wrangler -- login` (wrangler локальный, глобально не нужен).

## Команды

| Команда | Что делает |
|---------|-----------|
| `npm run check` | lint + typecheck + тесты API + сборка web — **запускать перед каждым коммитом** |
| `npm test` / `npm run test:api` | тесты API (vitest в рантайме workerd + локальная D1) |
| `npm run lint` | eslint: `scripts/` + `apps/` |
| `npm run lint:sh` | shellcheck по sh-скриптам (если установлен) |
| `npm run typecheck` | `tsc --noEmit` по `apps/*` (TypeScript strict) |
| `npm run build:web` | сборка Mini App `apps/web` → `dist` |
| `npm run format` / `format:check` | prettier по tooling и конфигам |
| `npm run setup` | мастер подключения бота (токен → миграции → деплой → webhook) |
| `npm run release` | релиз: check → web → миграции D1 → `wrangler deploy` → /health |
| `npm run dev -w apps/api` | локальный воркер + D1 (miniflare) |

## Правила

1. **Секреты не коммитим.** Прод — `wrangler secret put`; локально —
   `apps/api/.dev.vars` (в `.gitignore`). pre-commit хук и gitleaks страхуют,
   но не заменяют внимательность.
2. **`apps/api` — только Web API** (Workers ≠ Node): `fetch`, Web Crypto,
   `crypto`, `URL`, `URLSearchParams`; никаких `process`, `fs`, `Buffer`,
   `node:*`. Линтер это не отловит — смотри внимательно.
3. **SQL — только в `apps/api/src/db/repo.ts` и `apps/api/src/db/scoped/*`**, каждый запрос —
   `WHERE user_id = ?` (изоляция tenant). Сырые `db.prepare` вне этих файлов
   запрещены; на новые чтения/мутации — тест «A не видит B».
4. **Миграции иммутабельны**: только новые файлы `migrations/NNNN_name.sql`.
5. **Навигация бота** — сначала `docs/ux/navigation.md` +
   `src/bot/nav/screens.json`, потом код; `nav.test.ts` сверяет реестр,
   mermaid-схему и ряды.
6. Деньги — INTEGER minor units в D1, float в домене (`toMinor/fromMinor`
   на границе repo). Курсы — через `getFxRates` (кэш + provider).
7. Не логировать текст сообщений, токены, коды инвайтов, байты изображений,
   тела ответов провайдеров — в логах только `update_id` и коды ошибок.
8. Бизнес-логика не правится в стилевых PR; мелкие текстовые правки —
   отдельным коммитом от функциональных.
9. Документация — на русском, стиль как в README/SETUP.

## Стиль

- `apps/api`, `apps/web` — TypeScript strict + `exactOptionalPropertyTypes`;
  zod-схемы на каждом входе; домен `src/domain/` — чистые функции без I/O.
- `scripts/*.js` — CommonJS, `*.mjs` — ESM; Node ≥20, без новых
  runtime-зависимостей.
- Конфиги и scripts форматируются prettier (`npm run format`).
- Коммиты — русским языком, как в истории репозитория.

## Деплой

`npm run release` делает всё: `npm run check` → сборка `apps/web` →
миграции D1 (remote) → `wrangler deploy` (воркер + Static Assets) → /health.
Первый раз — `npm run setup` (SETUP.md). CI/CD: push в `main` →
`.github/workflows/deploy-v2.yml` (секреты `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` — без них деплой пропускается с notice).
