# Разработка (Cloudflare Workers + D1 + Workers Static Assets)

Основной документ разработки ([ADR-0001](adr/0001-platform-and-architecture.md)).
Миграция v1→v2 завершена шагом 9: legacy-стек (`apps-script/`, `mini-app/`,
clasp-пайплайн) удалён; упоминания v1 в тексте вех — исторический контекст
(«порт v1 X.gs») и оставлены как атрибуция происхождения кода.

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
npm run check         # всё: lint, typecheck, тесты API, сборка web
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

## Стейджинг-окружение (`--env staging`)

Отдельное окружение для проверки кода на живом Cloudflare, не трогая прод:
свой воркер `budget-companion-api-staging`, своя D1 `budget-companion-staging`
(уже создана и вписана в `apps/api/wrangler.toml`), свои секреты и **свой бот** —
у Telegram один webhook на бота, поэтому продовый для стейджинга не подходит.
Cron на стейджинге выключен (`[env.staging.triggers] crons = []` — напоминания
шлёт только прод).

**Первичная настройка (владелец, один раз):**

1. В @BotFather → `/newbot` — создать тест-бота (например `budget_dev_bot`), взять токен.
2. Запустить мастер — всё то же, что `npm run setup`, но против `[env.staging]`:
   ```
   npm run setup:staging
   ```
   Просит токен тест-бота; дальше сам: `TELEGRAM_BOT_USERNAME` →
   `[env.staging.vars]`, миграции на staging-D1, деплой staging-воркера,
   секреты `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`/`JWT_SECRET`/`DATA_KEY`
   (генерируются заново — у стейджинга СВОЙ DATA_KEY, не продовый),
   `OWNER_TELEGRAM_ID` через сообщение тест-боту, webhook + menu-button.
   `MINI_APP_URL` в `[env.staging.vars]` уже указывает на staging-воркер.

**Дальнейшие деплои в стейджинг:** `npm run release:staging` — тот же конвейер
(check → сборка web → миграции → deploy → /health), все wrangler-вызовы с
`--env staging`. Прод релизится как раньше — `npm run release`.

Ограничения: `[env.staging]` должен оставаться последним блоком wrangler.toml
(`envSection()` в setup-utils режет по следующему top-level заголовку);
CI деплоит только прод; стейджинг-данные тестовые — потерю его DATA_KEY
можно пережить (в отличие от продового, см. DR).

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
3. доход «6200» (или «0»/«Пропустить» — базовый вычисляется из обязательств)
   → вопрос бюджета повседневных → «60000 rub» → часовой пояс кнопками;
4. платежи: «Аренда 700 usd 1» + «Связь 500» → «Готово» → сводка с inline-кнопками
   (нижней reply-клавиатуры нет — меню через `/menu`);
5. `/plan` → доход, регулярные платежи, бюджет, «Свободный профицит» + строка курсов;
6. «➕ Трата» → «3200 kgs кофе» → статус недели с записью;
7. `/week` → потрачено/бюджет/остаток, burn rate, дневной остаток;
8. `/profile` → профиль + платежи + кнопка «пройти заново»;
9. незнакомому аккаунту — молчание (ни ответа, ни callback);
10. `/cancel` посреди настройки → отмена, `/start` рестартует чисто.

## Веха C2: редактируемый профиль и факт дохода (шаг 4в)

Деплой: **`npm run release`** (typecheck+тесты → миграции remote → deploy →
/health; при провале миграций деплой не выполняется). Ручной путь:
`npm run wrangler -- d1 migrations apply DB --remote` → `npm run deploy -w apps/api`.
`npm run setup` перезапускать НЕ нужно — `allowed_updates` не менялись.

## API Mini App (веха E, ч.1 — REST)

Все роуты за Bearer-JWT (`/api/tma/auth` → `Authorization: Bearer`); доступ
только к своим данным; суммы в minor units; ошибки `{error:{code,message}}`;
создание идемпотентно по `client_id` (uuid ≤64с, повтор → `duplicate:true`).

| Метод | Путь | Описание |
|---|---|---|
| GET | /api/tma/plan?income&currency | План месяца (аргумент → факт → базовый → расчёт из обязательств) |
| GET | /api/tma/week | Неделя/месяц, burn rate, дневной остаток |
| GET/POST | /api/tma/expenses | Список недели (≤50) / новая трата |
| PATCH/DELETE | /api/tma/expenses/:id | Правка/удаление своей записи |
| GET/POST | /api/tma/income | Месяц: записи+итог / новый доход |
| DELETE | /api/tma/income/:id | Удаление записи |
| GET/PATCH | /api/tma/profile | Профиль (вкл. `baseline_income_minor`/`baseline_source`, флаги напоминаний); PATCH — базовый доход/валюты/бюджет/tz/тумблеры напоминаний |
| GET | /api/tma/export | JSON-экспорт всех данных пользователя (attachment) |
| GET/POST | /api/tma/commitments | Платежи (вкл. ⏸) / новый (макс 30) |
| PATCH/DELETE | /api/tma/commitments/:id | Правка суммы/дня/имени/активности; удаление |

## Веха E: правка и удаление трат

Деплой: `npm run release` — применит `0006_rate_limit.sql` сам.

Ручной чеклист (Telegram):
1. «➕ Трата» → «344 кафе» → в ответе `[↩ Отменить] [✏️ Изменить] [🏠 Меню]`;
2. «↩ Отменить» → «Трата удалена», в /week итог обновился; второе нажатие — тишина;
3. «✏️ Изменить» → промпт «Новая сумма…» → «700 eur бензин» → карточка с новой суммой;
4. «📅 Неделя» → `[📋 Траты недели]` → список (≤20, новые сверху), пусто → «Трат за неделю нет»;
5. Строка списка → карточка траты → `🗑 Удалить` → подтверждение → список без записи;
6. `/expenses` — тот же список из любого места;
7. `[← Назад]` из списка → «Неделя», из карточки → список, `[🏠]` отовсюду → меню;
8. `/cancel` в промпте правки → обратно на карточку траты;
9. Чужой id в колбэке (вручную не проверить — покрыто тестом изоляции);
10. Голая сумма ВНЕ активного промпта → «Не знаю такую команду», трата не пишется
    (запись только из `spent_ask`); в промпте правки текст принимает только экран правки.

## Веха D: напоминания и приватность (шаг 4б)

Деплой: `npm run release` — применит `0005_reminders.sql` сам. Cron уже в
`wrangler.toml [triggers]` — после деплоя работает сам, проверка:
`wrangler tail` и дождаться часа с нужным локальным временем.

Ручной чеклист (Telegram):
1. «⚙️ Профиль» → «🔔 Напоминания» — два тогла ✅/⏸, перерисовка свежая;
2. Выкл «недельные» → в воскресенье 20:00 локально бот молчит;
3. «🗄 Мои данные» → «📤 Экспорт» — приходит `budget-export-<дата>.json`;
4. Второй `/export` подряд → «раз в минуту»;
5. «🗑 Удалить всё» → подтверждение → «Данные удалены»; следующий текст
   обрабатывается как от незнакомца;
6. Платёж со сроком через 2 дня (каденс monthly/interval_days/yearly) →
   в 10:00 локально «⏰ Через 2 дня платежи»;
7. Воскресенье 20:00 локально → «📅 Итоги недели»;
8. Локально проверить cron: `wrangler dev --test-scheduled` + `curl
   'http://localhost:8787/__scheduled?cron=0+*+*+*+*'`;
9. Заблокировать бота → следующий cron выключает флаги (403) и логирует
   `reminders: N sent, M deduped, K failed`;
10. `/delete_me` дважды / старый колбэк — второй молча игнорируется.

## Веха C3: единая навигация (нав-док + реестр)

Источник истины — `docs/ux/navigation.md` + `apps/api/src/bot/nav/screens.json`.
Любое изменение экранов → сначала сюда, потом в код (тесты сверяют).

Ручной чеклист (Telegram):
1. `/menu` или 🏠 → экран «Главное меню» с 5 inline-пунктами;
2. `/plan`, `/week` — внизу ряд `[🏠 Меню]`;
3. «➕ Трата» → промпт с `[✖ Отмена]` → жмёт — назад;
4. «💵 Доход» → промпт с `[✖ Отмена]`; `/income` при записях → список с 🗑 и «Назад»;
5. «⚙️ Профиль» → разделы; ← Назад возвращает в профиль;
6. Правка лимита → сохранение → возврат в профиль (не «никуда»);
7. «Платежи» → карточка → сумма/день/вкл-выкл → возврат в карточку;
8. 🗑 платежа → подтверждение → возврат в список платежей;
9. «➕ Добавить» платёж → после ввода — список платежей;
10. Stale-кнопки (старое сообщение) — молча игнорируются;
11. `/cancel` в промпте → отмена + ответ, не тишина;
12. Любая ошибка обработчика → «Что-то пошло не так» + `[🏠 Меню]`.

### Ручной тест-чеклист вехи C2 (Telegram)

1. «⚙️ Профиль» → сводка + разделы кнопками (доход/бюджет/платежи/валюта-пояс/напоминания/данные);
2. «Изменить базовый» → 7500 → профиль обновлён; «Убрать»/0 → базовый
   вычисляется из платежей+бюджета+кредитов;
3. «💸 Бюджет» → новая сумма → недельный бюджет пересчитан (cap×12/52);
4. «Регулярные платежи» → платёж → «✏️ Сумма» 800 → в /plan видна новая сумма;
5. «⏸ Выключить» → платёж исчез из суммы /plan, в списке виден с ⏸;
6. «🗑 Удалить» → подтверждение → платёж удалён; «➕ Добавить» → строка «Интернет 600 kgs 5»;
7. «Валюта и пояс» → смена валюты с предупреждением «суммы не пересчитываются»; таймзона кнопками;
8. «💵 Доход» (меню) → «5200 eur зарплата» → «Записал доход — итого за месяц»;
9. `/income` без аргументов → список записей с кнопками 🗑 и подтверждением;
10. `/plan` → «Доход — факт за <месяц>» и «N записей»; `/plan 1000 usd` → «задано вручную»;
11. Новый онбординг: шаг дохода → кнопка «Пропустить» → income=0, /plan → «доход не указан»;
12. `/cancel` в любой правке → «отменена», команда во время правки → правка отменена.

## Веха F: UX-фиксы (голая сумма, нижняя клавиатура)

- **Голая сумма больше не пишет трату.** Fallback «не команда → попробовать как
  сумму» удалён: текст вне активного шага → «Не знаю такую команду — попробуй
  /help». Запись расхода — только через «➕ Трата» / `/spent` (промпт
  `spent_ask`); «344» внутри `spent_ask`/`income_ask`/промптов правки —
  по-прежнему ввод шага.
- **Нижняя reply-клавиатура выведена из контракта (R5).** Навигация — только
  inline-кнопки + `/menu`/`🏠 Меню`. Показанная когда-то клавиатура у клиента
  висит, пока бот явно не пошлёт `remove_keyboard`: разовая миграция
  `kb_removed` (claim `INSERT OR IGNORE` в `reminder_log`, новых таблиц нет)
  перед первым сообщением шлёт служебное «·» с `remove_keyboard` — ровно
  один раз на пользователя; сбой отправки откатывает claim → ретрай на
  следующем сообщении. Все исходящие тексты (вебхук: сообщения и
  колбэк-ответы; cron-напоминания) идут через `tgWithKeyboardMigration`
  (`src/services/access.ts`); `sendDocument` — без изменений.

Ручной чеклист (Telegram):
1. «344» с главного экрана → «Не знаю такую команду», в /week записи нет;
2. «➕ Трата» → «344» → записано; «💵 Доход» → «➕» → «344» → доход записан;
3. у старого пользователя нижняя клавиатура исчезает после первого ответа бота
   (приходит служебное «·» без уведомления) и не возвращается;
4. финал онбординга — сводка с inline-кнопками, нижней клавиатуры нет.

## Веха G: Mini App — SPA на Preact (шаг 5)

SPA живёт **в том же воркере**: `wrangler.toml [assets]` раздаёт
`apps/web/dist` как Workers Static Assets (`not_found_handling =
"single-page-application"`, binding `ASSETS`). Ассеты проверяются первыми;
`run_worker_first = ["/api/*", "/telegram/*", "/health"]` гарантирует, что
API-роуты и webhook никогда не перехватываются SPA-fallback'ом. Адрес
приложения — URL воркера (`MINI_APP_URL` в `[vars]`); кнопка
запуск — menu-button «💰 Бюджет» у поля ввода (`setChatMenuButton`;
`node scripts/telegram-webhook.mjs menu <url>`).

**Аутентификация:** `POST /api/tma/auth {initData}` — проверка подписи
Telegram `initData` (HMAC-SHA256 «WebAppData» от токена бота, Web Crypto),
`auth_date` ≤ 24ч, обязательное поле `user`; пользователь обязан
существовать и быть онбоарден → JWT HS256 (секрет `JWT_SECRET`, payload
`{tg_id}`, TTL 12ч). Дальше `Authorization: Bearer` на `GET
/api/tma/overview` — доход месяца, платежи, недельный бюджет и траты
(все суммы — tenant-scoped через `scoped(userId)`).

Деплой: `npm run release` — шаг сборки `apps/web` идёт перед
`wrangler deploy`, иначе уедут устаревшие ассеты.

**Экраны (Preact).** UI — `apps/web/src` (Preact 10, JSX через
jsxImportSource: preact, без react-compat): `main.tsx` (boot/auth/тема,
экраны «не из Telegram»/«нет доступа»/сеть+retry), `app.tsx` (стек
экранов в state — верхняя панель «← Назад»/«🏠 На главную» на вложенных,
flash после мутаций; экран-источник перемонтируется и перезагружает данные),
`api.ts` (fetch-клиент: JWT только в памяти; при 401 — один reauth и один
повтор запроса, дальше «Нет доступа»), `fmt.ts` (копия fmtMoney бота +
клиентская валидация тех же лимитов), `screens/*`: Обзор, План (с
«доходом вручную» → ?income&currency), Неделя + карточка траты
(PATCH/DELETE с подтверждением), +Трата (client_id=uuid один раз на
открытие формы — идемпотентность), Доход (итог+записи+добавить+удалить),
Профиль (секции ДОХОД/БЮДЖЕТ/ЧАСОВОЙ ПОЯС/НАПОМИНАНИЯ/ДАННЫЕ: базовый доход,
бюджет, таймзона пресеты+IANA, свитчи напоминаний, экспорт JSON;
регулярные платежи: список/карточка PATCH amount·каденс
(frequency·due_day·interval_days·anchor_on·due_month)·active/DELETE,
добавление).

Ручной чеклист (Telegram):
1. menu-button «💰 Бюджет» слева от поля ввода → открывает Mini App внутри Telegram;
2. экран «Обзор»: доход месяца (факт/базовый/расчёт), платежи, неделя
   потрачено/бюджет/остаток, месяц, burn rate; 5 кнопок-разделов;
3. «📊 План»: доход с источником, платежи, бюджет, остаток;
   «Доход вручную» 5000 USD → «задано вручную», пересчёт; «Сбросить»;
4. «📅 Неделя»: сводка + список трат; строка → карточка → правка суммы →
   «Сохранить» → в списке новая сумма; «Удалить» → подтверждение → список
   без записи;
5. «➕ Трата» → «320» → «Трата записана» + возврат на Обзор со свежими
   цифрами; повторный submit не дублирует (client_id);
6. «💵 Доход»: итог, «Добавить доход» 5000 → запись в списке; 🗑 →
   подтверждение → запись исчезла, итог пересчитан;
7. «⚙️ Профиль»: базовый доход/бюджет/таймзона/свитчи напоминаний —
   сохранения видны после перезахода; «📤 Экспорт данных» → JSON-файл;
   платёж → карточка → правка суммы/дня, ⏸ выключить/включить,
   🗑 с подтверждением; «➕ Добавить» → платёж в списке;
8. «← Назад»/«🏠» на вложенных экранах; тупиков нет;
9. после траты в боте («➕ Трата 320») обновление видно в Mini App;
10. URL воркера в обычном браузере (без Telegram) → «Не из Telegram»;
11. `GET /api/tma/overview` без `Authorization` → 401 JSON, не index.html;
12. `GET /health` и webhook работают как раньше (run_worker_first);
13. не-онбоарденный пользователь → «Нет доступа».

## Веха I: скриншоты банка (шаг 7)

Порт v1 `VisionParser.gs` + `handlePhoto_`/`handleDebtBalancePhoto_` из `Code.gs`:
пользователь присылает скриншот банковского приложения — бот разбирает его
мультимодальной моделью и пишет недельную трату или предлагает сверку кредита.

**Архитектура.** `src/vision/` — провайдеры и санитайзинг (`parseScreenshot`
Gemini → Groq, `sanitizeVision`, `toBase64` чанками 32 КБ); `src/bot/vision.ts` —
чистые тексты/разметка; `src/services/vision.ts` — оркестрация (`handleVisionPhoto`,
`handleVsCallback`); точки входа — `router.ts` (поля `photo`/`document` в апдейте)
и `access.ts` (фото до текстовой маршрутизации, подпись игнорируется;
диспетчер `vs:*` рядом с `dbt:`/`ln:`).

**Согласие — opt-in.** `profiles.vision_enabled` (миграция `0012_vision.sql`,
по умолчанию 0). Тумблер — в ⚙️ Профиль → 🔔 Напоминания (`pf:rem:vision`).
При выключенном флаге фото НЕ уходит провайдеру — бот отвечает подсказкой.

**Провайдеры.** Основной — Gemini, `GEMINI_MODEL` (по умолчанию
`gemini-3.5-flash-lite` — GA-класс flash-lite; любая свежая flash-модель
работает, `generateContent`, тело как в v1:
`inline_data`/`mime_type`/`response_schema` snake_case, 1 ретрай на 429/5xx).
Резерв — Groq (`chat/completions`, OpenAI-совместимый, `GROQ_MODEL`, по умолчанию
`meta-llama/llama-4-scout-17b-16e-instruct`). Ошибки — `VisionError`: провайдер +
HTTP-статус, без тел ответов, ключей и file_path (в лог — то же самое + `update_id`).

**Секреты.** `GEMINI_API_KEY`, `GROQ_API_KEY` (и опционально `GROQ_MODEL`) —
`wrangler secret put`; локально `.dev.vars`. Ключ Gemini идёт в `?key=` URL
(протокол провайдера), Groq — в `Authorization: Bearer`; ни в логах, ни в
ошибках они не появляются. Без ключей бот отвечает «не настроено на сервере».

**Лимиты.** 20 скриншотов/день/пользователь — claim-бакеты `vision:<дата>:n`
в `reminder_log` (идемпотентно к редоставке webhook). Вход ≤10 МБ (getFile
`file_size` и скачанные байты). Документ — только `image/*`.

**Записи.** `expense_analytics` → одна трата `source='vision'`,
`source_key='vis:<update_id>'` (INSERT OR IGNORE → редоставка не дублирует);
полномесячная аналитика (`is_full_month_analytics`) — только инфо, без записи.
`debt_balance` → выбор кредита кнопками `vs:rec:<id>` (сумма в
`conversation_state`, НЕ в callback_data) → подтверждение `VIS_RECON` →
`vs:reconok:<id>` пишет `debt_events(kind='reconcile', source='manual',
source_key='vis:rec:<update_id>:<id>')` — тот же replay-движок, что и ручная
сверка. Чужие id молча игнорируются (R7).

**Статус недели** после записи — через `runWeek` (тот же путь, что `/week`).

### Ручной тест-чеклист вехи I (Telegram)
1. Флаг выключен → фото → подсказка «включите в Профиль → Напоминания»;
2. Вкл → скриншот «Аналитика расходов за неделю» → «🤖 Gemini разобрал…» +
   статус недели, трата в `/expenses` и Mini App;
3. Скриншот за весь месяц → «аналитика за весь месяц — не записываю»;
4. Скриншот кредита с остатком → «какой это кредит?» + кнопки своих кредитов
   → «Сверить … до …?» → ✅ → карточка с новым остатком в `/credits`;
5. Не-скриншот (перевод/баланс) → «Не нашёл…» + «/spent 3200»;
6. 21-й скриншот за день → «Лимит: 20 скриншотов в день»;
7. Выключить флаг → фото → снова подсказка (провайдер не дергается).

## Веха J: обмен валют (шаг 8)

Порт v1 `FXAnalytics.gs` один-в-один + журнал фактических обменов. Три
поверхности на одной аналитике (`services/fx.ts`): бот `/fx`, Mini App
`💱 Курсы`, cron-алерты.

**Аналитика.** `src/domain/fx.ts` — чистые функции из v1 без изменений семантики:
`cross_` (кросс-ряд по совпадающим датам — пара без прямой истории считается
через USD: `from→USD × USD→to`), `mean_`/`std_` (выборочная, n−1), `sma_`,
`rsi_` (14, простое усреднение — не Wilder), `slopeRel_` (линейная регрессия,
наклон/cur), `forecast_` (mid = `cur·(1+slope·h)`, band = `σ доходностей·√h`),
`stats_` (perцентиль, z180, SMA20/50, Δ30д, волатильность), `signal_` («боковик»
при `|z180|<0.5` или тихом тренде → split; score = перцентиль + RSI-бонус
±5 → convert ≥70 / split 45–69 / wait 30–44 / hold <30 — пороги v1),
`makeAction_` (<30 точек → null). Золотые значения — `test/domain/fx.test.ts`.

**Провайдер.** `FxProvider` получил опциональный `history(base, quotes,
from, to)` → `FxHistory` (мапа quote→ряд `FxPoint`); Frankfurter —
`GET /v2/rates?base=…&quotes=…&from=…&to=…` (тот же endpoint, таймаут 8 с).
Фейк-провайдеры без `history` совместимы — `histOf()` бросает
`FxUnavailable`, пары уходят в `skipped`.

**Пары** (`fxPairDefs`): жизнь `income→living` (алерты вкл), база
`income→base` (алерты выкл — как в v1 eur_usd), дальше валюты кредитов
`income→<ccy>` (алерты вкл). Дубли и self-пары отбрасываются.

**Журнал обменов.** Миграция `0013_fx.sql`: таблица `exchanges`
(from/to, `amount_*_minor` INTEGER, `rate` REAL = to/from, `market_rate`
REAL — курс Frankfurter на дату записи через `getFxRates`, `spent_on`,
`note`, `source`/`source_key` — идемпотентность `tma:<client_id>`/`tg:<upd>`
partial-UNIQUE как в 0011) + `profiles.fx_alerts_enabled` (DEFAULT 1).
Repo: `addExchange` считает `rate` сам (INSERT OR IGNORE по ключу),
`listExchanges`/`getExchange`/`patchExchange`/`deleteExchange` — все
`WHERE id=? AND user_id=?`; экспорт (`exportUserData`, schema 4) и
`/delete_me` включают обмены, в экспорт `source_key` не попадает.

**Бот.** `/fx` (и `💱 Курсы` в меню) → `FX_HUB`: текст анализа как в v1
(заголовок со штампом, ▲/▼ Δ30д, перцентиль, RSI, сигнал, прогноз 7/30д,
дисклеймер «статистическая модель, тайминг вторичен») + `[📋 Журнал]
[➕ Записать обмен]`. Редьюсер `bot/fxan.ts`: `FX_LIST` (≤20 обменов
кнопками-строками) → `FX_ITEM` (суммы, rate vs рынок, ✏️ суммы/дата/заметка,
🗑 удалить с confirm `FX_DEL`) и мастер `FX_ADD_FROM → FX_ADD_TO →
FX_ADD_AMOUNTS («500 → 48500») → FX_ADD_DATE (📅 Сегодня / текстом) →
FX_ADD_NOTE (⏭ Пропустить)`. Валюты — кнопки из профиля+кредитов или код
текстом. `market_rate` пишется при записи (провайдер молчит → null).
`fxa:*` step-aware по `FX_STEPS`; `/cancel` — `fxCancelTarget`; экраны —
в реестре `screens.json` + `docs/ux/navigation.md` (сплюснуто: промпты
правки — дети `FX_ITEM`).

**Mini App.** `GET /api/tma/fx` — `{analysis, exchanges}` (та же
`buildAnalysis`, история по одному запросу на пару); `GET/POST
/api/tma/exchanges`, `PATCH/DELETE /api/tma/exchanges/:id` — zod на
границе, суммы major→minor, `client_id` → `duplicate:true` при повторе,
чужой id → 404. Экран `screens/fx.tsx` (анализ-карточки + журнал, формы
добавления/правки, confirm удаления) на роуте `fx` + кнопка `💱 Курсы`
на главной.

**Алерты.** Cron (`services/reminders.ts`, то же окно 10:00–21:59 локали,
что у платежей): для пар с `alerts` при `profile.fx_alerts_enabled=1` —
перцентиль ≥85 → «💱 Выгодное окно конвертации» (кнопка `/fx`), ≤15 →
«нижняя зона». Кулдаун — ISO-неделя на пару и направление через
`claimReminder('fx', '<pair>:<hi|lo>:<YYYY-Www>')`; сбой отправки снимает
claim (следующий тик повторит). Тумблер — `⚙️ Профиль → 🔔 Напоминания`
(`pf:rem:fx`).

**Известные ограничения.** Анализ только по дневным курсам Frankfurter
(кросс через USD для редких пар); `market_rate` — курс дня записи, не
момента сделки; в журнале нет связи обмена с тратами/планом.

### Ручной тест-чеклист вехи J
1. `/fx` → карточки EUR→RUB и EUR→USD со стрелками/перцентилем/сигналами;
   у кредитовой валюты — третья карточка; у пары <30 точек истории — skipped;
2. `➕ Записать обмен` → кнопкой EUR → `RUB` текстом → `500 → 48500` →
   `📅 Сегодня` → заметка → в журнале строка с rate и «рынок …»;
3. карточка обмена → `✏️ Суммы` `400 → 39000` → rate пересчитан;
   `✏️ Дата`, `✏️ Заметка`, `🗑 Удалить` → confirm;
4. `/cancel` на любом шаге мастера → «Отменено» + экран-источник;
5. Mini App `💱 Курсы`: те же карточки, добавление (повтор submit — один
   обмен), правка, удаление;
6. профиль → напоминания → выкл «Алерты по курсам» → пушей нет; вкл →
   в окне 10:00–21:59 при перцентиле ≥85 приходит «выгодное окно» (не чаще
   раза в неделю на пару);
7. `/export` содержит `exchanges` без `source_key`; `/delete_me` чистит.

## Жёсткие правила (повтор из AGENTS.md)

- В `apps/api` — только Workers-совместимые API (Web Crypto, `fetch`, `URL`…).
  Node-only API (`process`, `fs`, `Buffer`…) в коде воркера запрещены — vitest
  это проверяет реальным рантаймом, но статический анализ их не поймает.
- Доступ к пользовательским данным — только через `scoped(db, userId)` в
  `src/db/repo.ts` (каждый запрос добавляет `WHERE user_id = ?`).
- Никаких токенов в URL — только `Authorization: Bearer` (шаг 3).
- Секреты — только `wrangler secret put`; `.dev.vars` для локальной разработки
  (в `.gitignore`).

## Шифрование (DATA_KEY)

Локально задайте `DATA_KEY` в `apps/api/.dev.vars` (генерация — команда в
`.dev.vars.example`). Без него контуры данных отвечают 503. В тестах ключ
задан биндингом в `vitest.config.ts` + `test/setup.ts`. Если тест вставляет
строки сырым SQL и фильтрует по name/note/amount — помните: они в БД шифртекст,
фильтруйте по plaintext-колонкам (due_day, даты, валюта, source_key).

## Disaster Recovery (A2-3)

**Что может погибнуть и как восстановиться:**

1. **`DATA_KEY` (мастер-ключ шифрования).** Потеря = ВСЕ зашифрованные
   пользовательские данные не расшифровать никогда (суммы, заметки, имена
   кредитов/контрагентов, состояния диалогов). Храните копию ключа в
   менеджере паролей владельца — отдельно от Cloudflare-аккаунта. Восстановление
   после потери невозможно: только `wrangler secret put DATA_KEY` нового
   ключа и заведение данных заново (старые `enc1:`-строки останутся мусором —
   рекомендуется сбросить пользовательские таблицы).
2. **База D1.** Точечное восстановление — Time Travel
   (`wrangler d1 time-travel restore DB --timestamp <RFC3339>`; окно ~30 дней).
   Резервные копии — периодический `wrangler d1 export DB --remote
   --output backup.sql` (хранить рядом с копией DATA_KEY: шифртекст без
   ключа бесполезен, но и без БД ключ бесполезен). Восстановление из дампа:
   `wrangler d1 execute DB --remote --file backup.sql`.
3. **Секреты воркера** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   `JWT_SECRET`, `OWNER_TELEGRAM_ID`, `DATA_KEY`, `GEMINI_API_KEY`,
   `GROQ_API_KEY`). Список имён — `wrangler secret list` (значения Cloudflare
   не отдаёт). Все значения — в менеджере паролей владельца; пересоздание —
   `wrangler secret put <NAME>` + `npm run release`. Потеря `JWT_SECRET` не
   страшна (протухнут сессии Mini App — пользователи просто перелогинятся),
   потеря `TELEGRAM_BOT_TOKEN` критична — восстановить только через
   @BotFather (`/revoke` → новый токен).
4. **Наблюдаемость.** Сбои cron/webhook пишутся в `console.error` — смотреть
   `wrangler tail`. С прогона аудита-2 владелец получает Telegram-сообщение
   при падении тика или ошибках обработки пользователей (A2-2); если такого
   сообщения нет — проверяйте, что `OWNER_TELEGRAM_ID` задан и бот не
   заблокирован владельцем.
