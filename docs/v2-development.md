# Разработка v2 (Cloudflare Workers + D1 + Pages)

Каркас нового стека (шаг 1 миграции, [ADR-0001](adr/0001-platform-and-architecture.md)).
Старый бэкенд (`apps-script/*.gs`, clasp-пайплайн) живёт до шага 9 — не трогаем.

## Структура

| Путь | Что это |
|------|---------|
| `apps/api` | Cloudflare Worker: Hono-роутер, TypeScript strict, D1 |
| `apps/api/migrations/` | SQL-миграции D1 (`wrangler d1 migrations apply`) |
| `apps/api/src/domain/` | чистые функции домена (без I/O) — наполнится на шаге 2 |
| `apps/api/src/http/` | роутер и HTTP-слой |
| `apps/api/src/db/repo.ts` | репозиторный слой: `scoped(db, userId)` — всегда `WHERE user_id = ?` |
| `apps/api/test/` | vitest-тесты, исполняются в workerd с локальной D1 |
| `apps/web` | Mini App v2: Vite + TypeScript (сборка → `apps/web/dist`) |

## Зависимости

Из корня репозитория:

```bash
npm ci
```

npm-workspaces ставят зависимости обоих приложений. Отдельные команды:
`npm run <script> -w apps/api` или `-w apps/web`.

## Локальный запуск API

```bash
npm run dev -w apps/api      # wrangler dev — локальный воркер на miniflare
curl http://localhost:8787/health   # → {"ok":true,"app":"budget-companion-api",...}
```

Локальная D1 создаётся автоматически (miniflare). Применить миграции локально:

```bash
cd apps/api && npx wrangler d1 migrations apply DB --local
```

## Тесты и проверки

```bash
npm run test:api      # vitest в рантайме workerd (проверки /health, миграций, изоляции tenant)
npm run typecheck     # tsc --noEmit по всем apps/*
npm run check         # всё: legacy lint + smoke, typecheck, тесты API, сборка web
```

Важно: тесты идут в **workerd**, а не в Node — так ловится класс ошибок
«API есть в Node, но нет в Workers» (аналог S1 с `URLSearchParams` в Apps Script).

## Деплой (владелец, один раз)

```bash
cd apps/api
npx wrangler login                    # браузер, аккаунт Cloudflare
npx wrangler d1 create budget-companion
# → скопировать database_id в wrangler.toml вместо PLACEHOLDER_SET_BY_OWNER
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put JWT_SECRET    # случайная строка 32+ символов
```

Дальше деплой делает CI (workflow `deploy-v2.yml`) при пуше в `main` по `apps/**`,
либо вручную: `npm run deploy -w apps/api`.

### CI/CD: секреты GitHub

| Где | Имя | Значение |
|-----|-----|----------|
| Secret | `CLOUDFLARE_API_TOKEN` | API-токен Cloudflare (ниже — минимальный скоуп) |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Account ID из дашборда Cloudflare (Workers → справа) |

**API-токен** создаётся в [dash.cloudflare.com](https://dash.cloudflare.com) →
My Profile → API Tokens → Create Custom Token. Минимальные права
(Account → для аккаунта владельца):

| Ресурс | Право | Зачем |
|--------|-------|-------|
| Account → Workers Scripts | Edit | `wrangler deploy` |
| Account → D1 | Edit | миграции `--remote` |
| Account → Cloudflare Pages | Edit | деплой `apps/web` |

Без секретов workflow деплоя пропускается без ошибки (notice в логе).

## Жёсткие правила (повтор из AGENTS.md)

- В `apps/api` — только Workers-совместимые API (Web Crypto, `fetch`, `URL`…).
  Node-only API (`process`, `fs`, `Buffer`…) в коде воркера запрещены — vitest
  это проверяет реальным рантаймом, но статический анализ их не поймает.
- Доступ к пользовательским данным — только через `scoped(db, userId)` в
  `src/db/repo.ts` (каждый запрос добавляет `WHERE user_id = ?`).
- Никаких токенов в URL — только `Authorization: Bearer` (шаг 3).
- Секреты — только `wrangler secret put`; `.dev.vars` для локальной разработки
  (в `.gitignore`).
