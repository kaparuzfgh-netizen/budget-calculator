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

## Подключение бота (веха B — webhook, владелец, инвайты)

Webhook живёт на `POST /telegram/webhook`. Основной путь — одна команда:

```bash
npm run setup
```

### Предусловия (один раз)

- `npm run wrangler -- login` — вход в Cloudflare (браузер);
- `npm run wrangler -- d1 create budget-companion` → `database_id` вписать
  в `apps/api/wrangler.toml` вместо `PLACEHOLDER_SET_BY_OWNER`;
- токен бота: в Telegram открой **@BotFather → /newbot** (или /mybots →
  API Token) — мастер спросит его один раз скрытым вводом (или задай env
  `TELEGRAM_BOT_TOKEN`).

### Что делает мастер (8 шагов, ошибки — понятными русскими сообщениями)

Проверки окружения → токен + `getMe` → username бота в `wrangler.toml` →
миграции D1 + `wrangler deploy` → секреты (`TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET` — новый при каждом запуске, `JWT_SECRET` — если
нет) → поиск владельца через getUpdates → `setWebhook` → проверка `/health`.

Флаги: `--dry-run` (только план), `--skip-deploy`, `--rotate` (перегенерировать
JWT тоже). **Повторный запуск безопасен** — шаги идемпотентны; учти, что
webhook-секрет обновляется при каждом запуске (нельзя прочитать обратно,
поэтому регенерируется, а не переиспользуется).

Типичные ошибки: «токен неверный» → скопируй заново из @BotFather;
«database_id = PLACEHOLDER» → шаг `d1 create` выше; «не авторизован» →
`npm run wrangler -- login`; «владелец не найден за 2 минуты» → напиши
боту любое сообщение и перезапусти.

После мастера: напиши боту `/start` → `/invite` → ссылка для второго
аккаунта. Незнакомым бот не отвечает — это by design.

<details>
<summary>Ручной путь / fallback (без мастера)</summary>

1. Узнай numeric Telegram ID: напиши боту `/id` (пока `OWNER_TELEGRAM_ID`
   не задан, отвечает всем один раз) или @userinfobot (сторонний сервис).
   `npm run wrangler -- secret put OWNER_TELEGRAM_ID`.
2. Секреты: `npm run wrangler -- secret put TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET`, `JWT_SECRET`.
3. `TELEGRAM_BOT_USERNAME` (без @) в `apps/api/wrangler.toml` `[vars]`.
4. `npm run wrangler -- d1 migrations apply DB --remote`
5. `npm run deploy -w apps/api`
6. `npm run webhook:set -- https://<воркер>.workers.dev/telegram/webhook`
   (токен и секрет спросит скрытым вводом).
   Проверка: `npm run webhook:info`; удаление: `npm run webhook:delete`.

</details>

**Диагностика:** `npm run webhook:info` (URL замаскирован, видны
`last_error_message` и `pending_update_count`), `npm run wrangler -- tail`.

## Веха C: онбординг и бюджет (шаг 4)

После деплоя этого шага владелец должен:

1. `npm run wrangler -- d1 migrations apply DB --remote` (новые таблицы
   profiles/commitments/weekly_expenses/conversation_state/fx_rates);
2. `npm run deploy -w apps/api`;
3. `npm run setup` — перезапуск мастера ОДИН раз, чтобы webhook получил
   `allowed_updates = ["message","callback_query"]` (инлайн-кнопки).

### Ручной тест-чеклист вехи C (Telegram)

1. `/start` → приветствие условий с кнопкой «Согласен»;
2. согласие → вопрос валюты дохода с кнопками USD/EUR/RUB/KGS/Другая;
3. доход «6200» → вопрос лимита жизни → «60000 rub» → часовой пояс кнопками;
4. платежи: «Аренда 700 usd 1» + «Связь 500» → «Готово» → сводка + меню внизу;
5. `/plan` → доход, обязательства, лимит, «Свободный профицит» + строка курсов;
6. «➕ Трата» → «3200 kgs кофе» → статус недели с записью;
7. `/week` → потрачено/лимит/остаток, burn rate, дневной остаток;
8. `/profile` → профиль + платежи + кнопка «пройти заново»;
9. незнакомому аккаунту — молчание (ни ответа, ни callback);
10. `/cancel` посреди настройки → отмена, `/start` рестартует чисто.

## Веха C2: редактируемый профиль и факт дохода (шаг 4в)

Деплой: `npm run wrangler -- d1 migrations apply DB --remote` →
`npm run deploy -w apps/api`. **`npm run setup` перезапускать НЕ нужно** —
`allowed_updates` не менялись.

### Ручной тест-чеклист вехи C2 (Telegram)

1. «⚙️ Профиль» → сводка + 4 раздела кнопками (доход/лимит/платежи/валюта-пояс);
2. «Изменить типичный» → 7500 → профиль обновлён; «Убрать» → типичный = 0;
3. «Лимит жизни» → новая сумма → недельный бюджет пересчитан (cap×12/52);
4. «Платежи» → платёж → «✏️ Сумма» 800 → в /plan видна новая сумма;
5. «⏸ Выключить» → платёж исчез из суммы /plan, в списке виден с ⏸;
6. «🗑 Удалить» → подтверждение → платёж удалён; «➕ Добавить» → строка «Интернет 600 kgs 5»;
7. «Валюта и пояс» → смена валюты с предупреждением «суммы не пересчитываются»; таймзона кнопками;
8. «💵 Доход» (меню) → «5200 eur зарплата» → «Записал доход — итого за месяц»;
9. `/income` без аргументов → список записей с кнопками 🗑 и подтверждением;
10. `/plan` → «Доход — факт за <месяц>» и «N записей»; `/plan 1000 usd` → «задано вручную»;
11. Новый онбординг: шаг дохода → кнопка «Пропустить» → income=0, /plan → «доход не указан»;
12. `/cancel` в любой правке → «отменена», команда во время правки → правка отменена.

## Жёсткие правила (повтор из AGENTS.md)

- В `apps/api` — только Workers-совместимые API (Web Crypto, `fetch`, `URL`…).
  Node-only API (`process`, `fs`, `Buffer`…) в коде воркера запрещены — vitest
  это проверяет реальным рантаймом, но статический анализ их не поймает.
- Доступ к пользовательским данным — только через `scoped(db, userId)` в
  `src/db/repo.ts` (каждый запрос добавляет `WHERE user_id = ?`).
- Никаких токенов в URL — только `Authorization: Bearer` (шаг 3).
- Секреты — только `wrangler secret put`; `.dev.vars` для локальной разработки
  (в `.gitignore`).
