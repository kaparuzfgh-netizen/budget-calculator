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
npm run wrangler -- d1 migrations apply DB --local
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

Все команды — **из корня репозитория** (`budget-calculator`), в PowerShell или Git Bash.
Wrangler вызывается через `npm run wrangler -- <аргументы>` (напрямую `npx wrangler` из корня не работает: он установлен внутри `apps/api`).

**Что нужно заранее:**
1. Выполнить `npm ci` (один раз).
2. Бесплатный аккаунт на [dash.cloudflare.com](https://dash.cloudflare.com).
3. Токен бота от @BotFather (вид `123456789:AA...`). Никому не показывать и не вставлять в чаты.

**Шаги:**

1. Вход в Cloudflare (откроется браузер, нажмите Allow):
   ```
   npm run wrangler -- login
   ```
2. Создать базу данных:
   ```
   npm run wrangler -- d1 create budget-companion
   ```
   В выводе будет строка `database_id = "xxxxxxxx-xxxx-..."`. Скопируйте само значение
   и вставьте в `apps/api/wrangler.toml` вместо `PLACEHOLDER_SET_BY_OWNER`.
3. Применить миграции к удалённой базе:
   ```
   npm run wrangler -- d1 migrations apply DB --remote
   ```
   (на вопрос подтверждения ответьте `y`). Из корня команда возьмёт `wrangler.toml` из `apps/api`,
   потому что `npm exec -w apps/api` запускается в этой папке.
4. Первый деплой воркера:
   ```
   npm run deploy -w apps/api
   ```
   В конце напечатается адрес вида `https://budget-companion-api.<ваш-поддомен>.workers.dev`.
   Проверьте: откройте `<адрес>/health` в браузере — должен вернуться JSON с `"ok":true`.
5. Секреты (после деплоя; каждая команда спросит значение — вставьте и нажмите Enter, ввод не отображается):
   ```
   npm run wrangler -- secret put TELEGRAM_BOT_TOKEN
   npm run wrangler -- secret put TELEGRAM_WEBHOOK_SECRET
   npm run wrangler -- secret put JWT_SECRET
   ```
   Для двух последних сгенерируйте случайные значения:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Запускайте эту команду отдельно для каждого секрета (значения должны быть разные).
6. Дальше деплой делает CI (`deploy-v2.yml`) при пуше в `main` по `apps/**`, если заданы секреты GitHub (ниже).
   Этот шаг можно пока пропустить: ручной `npm run deploy -w apps/api` работает всегда.

Webhook Telegram и вход пользователей появятся на шаге 3 миграции — сейчас бот ещё не подключён,
поэтому на шагах 1–6 бот не отвечает: это нормально.

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
