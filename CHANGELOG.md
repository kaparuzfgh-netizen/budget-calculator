# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

## [Unreleased]

### Удалено
- **Шаг 9: legacy-стек v1 полностью удалён** — миграция завершена
  ([ADR-0001](docs/adr/0001-platform-and-architecture.md)). Убраны:
  `apps-script/` (14 модулей + appsscript.json), `mini-app/` (статичный
  index.html на Pages), скрипты `build-bundle`/`smoke-test`/`gen-golden`/
  `deploy`/`bootstrap`, workflow `deploy-apps-script.yml` и
  `deploy-mini-app.yml`, `.claspignore`, `secrets.example.json`,
  v1-доки (`docs/BOT_SETUP.md`, `docs/PRODUCT_AUDIT.md`, `docs/audits/`),
  dev-зависимость `@google/clasp` (+ override). Данных для переноса
  не было — весь учёт в v1 вёлся на бумаге.
- `package.json`: `lint` = `eslint scripts apps` (без сборки бандла),
  `check` = lint + typecheck + test:api + build:web, `test` = test:api;
  `eslint.config.mjs` переписан без gasGlobals и `dist/*.gs`; CI — без
  smoke-шага; `deploy-v2.yml` чинит порядок (сборка web ДО deploy воркера)
  и убирает устаревший Pages-шаг (SPA отдаётся [assets] воркера).
- Эталонные числа v1 сохранены как фикстура
  `apps/api/test/domain/golden.legacy.json` (golden-тесты живы,
  генератор удалён — фикстура заморожена).
- `AGENTS.md`, `README.md`, `SETUP.md`, `CONTRIBUTING.md`, `SECURITY.md`
  переписаны под единственный стек.

### Добавлено
- **Шаг 8: обмен валют — аналитика, алерты и журнал обменов.** Порт v1
  `FXAnalytics.gs` один-в-один в `src/domain/fx.ts` (кросс через USD по
  совпадающим датам, SMA20/50, RSI-14 простым средним, линейная регрессия,
  перцентиль/вперед-прогноз 7·30д, сигналы convert/split/wait/hold по
  порогам v1). `FxProvider` + `Frankfurter` получили опциональный
  `history()` (фейк-провайдеры совместимы). Миграция `0013_fx.sql`:
  `exchanges` (minor units, `rate`=to/from, `market_rate` по кэшу
  Frankfurter, `source_key` идемпотентность) и `profiles.fx_alerts_enabled`.
  Бот `/fx` + `💱 Курсы` в меню: `FX_HUB` с текстом анализа как в v1,
  журнал `FX_LIST→FX_ITEM`, мастер записи `FX_ADD_*`, правки/удаление —
  редьюсер `bot/fxan.ts`, `fxa:*` step-aware. Cron-алерты в окне
  10:00–21:59: перцентиль ≥85 → «выгодное окно», ≤15 → «нижняя зона»,
  кулдаун ISO-неделя через `claimReminder('fx', …)`, тумблер в
  Профиль→Напоминания. Mini App: `GET /api/tma/fx` (анализ+журнал) и
  `/api/tma/exchanges` CRUD за Bearer-JWT (`client_id` → duplicate,
  чужой id → 404), экран `screens/fx.tsx` + кнопка на главной. Экспорт
  (schema 4) и `/delete_me` включают обмены. Тесты: золотые значения
  домена (`domain/fx.test.ts`), сквозные бот/repo/TMA/алерты/напоминания
  (`fx.test.ts`), nav-реестр и privacy-таблицы расширены.
- **Mini App: ядро экранов на Preact (веха G, продолжение).** `apps/web`
  переписан с чистого DOM на Preact 10 (зависимость `preact@10.26.9`,
  tsconfig: `jsx: react-jsx` + `jsxImportSource: preact`, без react-compat).
  Стек экранов в state с панелью «← Назад»/«🏠 На главную»: Обзор (доход
  с источником, платежи, неделя, месяц, burn rate из /week), План
  (итоги в USD + «доход вручную» через query income&currency), Неделя
  (сводка + список трат; карточка — PATCH сумма/валюта/заметка и DELETE
  с подтверждением), +Трата (`client_id=crypto.randomUUID()` один раз на
  открытие формы — идемпотентность), Доход (итог, добавить, удалить с
  подтверждением), Профиль (PATCH типичный доход/лимит/таймзона с пресетами
  и IANA-вводом; платежи: список, карточка PATCH amount·due_day·active,
  DELETE с подтверждением, добавление). JWT только в памяти; при 401 —
  один повторный auth и один повтор запроса. Сохранены экраны «не из
  Telegram»/«нет доступа»/сеть+retry; fmtMoney — копия формата бота;
  клиентская валидация тех же лимитов, что у API.
- **Шаг 5: Telegram Mini App на Cloudflare — экран «Обзор».** SPA из
  `apps/web` (Vite, тёмная тема из `themeParams`, `telegram-web-app.js`)
  раздаётся тем же воркером через Workers Static Assets
  (`wrangler.toml [assets]`, SPA-fallback, `run_worker_first` для
  `/api/*`, `/telegram/*`, `/health`). Аутентификация: `POST /api/tma/auth`
  — верификация `initData` (HMAC-SHA256 «WebAppData», Web Crypto,
  `auth_date` ≤ 24ч, `user` обязателен, пользователь онбоарден) → JWT HS256
  (`{tg_id}`, TTL 12ч). `GET /api/tma/overview` по Bearer-JWT: доход
  месяца (факт/типичный через `resolveIncome`), обязательные платежи,
  недельный бюджет + потрачено за неделю/месяц (`weeklyStatus`),
  `fx_note` при устаревших курсах. Кнопка `[📱 Приложение]` (`web_app` →
  `MINI_APP_URL` из `[vars]`) на экране HOME; в реестре — `external: true`.
  `release.mjs`: шаг сборки `apps/web` перед `wrangler deploy` (план [1..6]).
  Тесты: фикстура-подпись initData, отказы (подделка/старый/без user/чужой
  токен), JWT-гейт (roundtrip, expired, чужой секрет), изоляция overview,
  SPA-smoke через SELF.
- **Веха E: REST API Mini App (паритет бота, ч.1).** `src/tma/api.ts` —
  `/api/tma/plan|week|expenses|income|profile|commitments` за Bearer-JWT;
  та же валидация (суммы ≤1e9, платежи ≤30, день 1-31, tz, zod); идемпотентность
  `client_id` → `source_key=tma:<id>`; чужие id → 404; PATCH профиля пересчитывает
  недельный бюджет ×12/52. Репо: `findExpenseByKey`, `findIncomeByKey`,
  `patchCommitment` +`name`.
- **Веха E: харденинг Mini App (шаг 5).** Миграция `0006` (`rate_limit`);
  20 попыток/10 мин на `POST /api/tma/auth` по хэшу `CF-Connecting-IP`
  (429 + `Retry-After`); security-заголовки на все ответы (nosniff,
  no-referrer, no-store на API, CSP на SPA с `frame-ancestors telegram.org`);
  одинаковый текст 403 для «нет пользователя»/«не онбоарден»; тесты
  rate-limit/заголовков/JWT-незнакомца/replay.
- **Веха E: правка и удаление трат.** `SPENT_DONE` получил
  `[↩ Отменить] [✏️ Изменить]` (`ex:undo:<id>` — мгновенное удаление своей строки;
  `ex:e:<id>` → промпт новой суммы). `WEEK` получил `[📋 Траты недели]` → новый экран
  `EXPENSES_LIST` (≤20 записей недели, кнопка-строка → `EXPENSE` карточка с
  `[✏️ Изменить] [🗑 Удалить]` → confirm `EXPENSE_DEL`). Команда `/expenses` открывает
  список. Все id проверяются на владельца (`WHERE id=? AND user_id=?`, чужой/устаревший
  колбэк — молча), `ex:*` принимаются и без разговора (conv очищен после записи),
  рендеры через `render`-эффект — список всегда свежий. Репо: `getExpense`,
  `patchExpense`, `deleteExpense`. `weekStartInTz` в parse.ts. Нав-тест проверяет,
  что каждое ребро menu/result экрана имеет кнопку в разметке.
- **Шаг 4б: напоминания и приватность (веха D):** миграция `0005`
  (`reminder_log` + `profiles.reminders_weekly/reminders_payments`); cron `0 * * * *`
  → `runReminders` — воскресный итог недели 20:00 локально и напоминания о платежах
  за 2 дня 10:00 локально (idem claim через reminder_log; 403 → флаги выкл;
  прочие ошибки → ретрай на следующем часе). Экраны `PF_REMINDERS` (тоглы),
  `PF_DATA`, `PF_DELETE_ASK` в реестре навигации; `/export` — JSON собственных
  строк как документ (rate-limit 1/мин через claimReminder); `/delete_me` —
  batch-удаление всех `user_id`-строк + users. `sendDocument` в клиенте (FormData+Blob).
- **Единая навигация (веха C3):** реестр `src/bot/nav/screens.json` +
  `docs/ux/navigation.md` (тест doc-sync сверяет mermaid-схему с реестром);
  экран HOME (`/menu`, `🏠 Меню`, `nv:home`); обязательные нав-ряды R1–R4
  через `navRow()`; `[✖ Отмена]` на промптах; `[🏠 Меню]` на результатах
  /plan, /week, трата, доход; R8 — честный ответ «Что-то пошло не так» +
  🏠 при падении обработчика. `npm run release` — проверки → миграции →
  deploy → /health (деплой отменяется при неприменённых миграциях).
- **Шаг 4в: редактируемый профиль и переменный доход:** миграция `0004`
  (`income_entries` — факт дохода по месяцам в таймзоне юзера, `commitments.updated_at`);
  `income_minor` профиля = «типичный доход» (0 — не задан). `/income` — запись/список/
  удаление с подтверждением; `/plan` резолвит доход: override → факт месяца → типичный →
  «без дохода». Профиль — меню разделов (`pf:*` колбэки, step-aware + CAS): доход,
  лимит жизни, платежи (сумма/день/вкл-выкл/удалить/добавить), валюта+таймзона
  (предупреждение «суммы не пересчитываются»). «Пропустить» на шаге дохода онбординга;
  кнопка «заново» и `ob:reset` удалены. Меню клавиатуры + кнопка «💵 Доход».
- **Онбординг и бюджет (шаг 4):** миграция `0003` (profiles, commitments,
  weekly_expenses, conversation_state, fx_rates; деньги — INTEGER minor);
  онбординг как чистый редьюсер (согласие → валюта/доход/лимит/таймзона/
  платежи → профиль + персистентное меню); команды `/plan`, `/spent` (и
  кнопка «➕ Трата» + голая сумма), `/week`, `/profile`, `/cancel`;
  inline-кнопки и `callback_query` в webhook; FX-провайдер Frankfurter
  с D1-кэшем 6ч и stale-fallback; изоляция tenant на всех новых таблицах.
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
- **v2: нижняя reply-клавиатура выведена из контракта навигации (R5).**
  Навигация — только inline-кнопки + `/menu`/`🏠 Меню`: финал онбординга шлёт
  сводку с inline HOME вместо `keyboard`; `helpOnboarded` указывает на `/menu`.
  Одноразовая миграция `kb_removed` (claim в `reminder_log`, миграций БД нет):
  перед первым сообщением бот шлёт служебное «·» с `remove_keyboard` — у
  старых пользователей клавиатура скрывается ровно один раз, при сбое —
  ретрай на следующем сообщении. Все исходящие тексты (вебхук и cron) идут
  через `tgWithKeyboardMigration`; `ReplyMarkup.remove_keyboard` в клиенте.
- **v2: голая сумма больше не записывает трату.** Удалён fallback
  «не команда → parseAmount → runSpent»: некомандный текст вне активного
  шага отвечает «Не знаю такую команду — попробуй /help». Расход — только
  через «➕ Трата» / `/spent` (промпт `spent_ask`).

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
