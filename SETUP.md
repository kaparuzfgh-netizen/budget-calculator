# 🚀 Установка

~15 минут. Нужны: Google-аккаунт, Telegram, бесплатный ключ Gemini, Node.js ≥ 20.

Установка и обновления идут через **[clasp](https://github.com/google/clasp)** —
официальный CLI Google Apps Script (ставится локально с `npm ci`, глобально
ничего не нужно). Модули `apps-script/*.gs` пушатся в проект как есть.

## Предусловия (один раз)

```bash
npm ci                        # зависимости (clasp, eslint, prettier)
npx clasp login               # интерактивный вход — откроется браузер
```

Также включите **Apps Script API**: [script.google.com/home/usersettings](https://script.google.com/home/usersettings) → «API Google Apps Script» → вкл.

### Шаг 1 · 2 мин — бот и ваш ID

1. В Telegram: [@BotFather](https://t.me/BotFather) → `/newbot` → имя → username (оканчивается на `bot`) → скопируйте **токен** `123456789:AAH...`.
2. [@userinfobot](https://t.me/userinfobot) → напишите что угодно → он ответит вашим **chat_id** (число).

### Шаг 2 · 2 мин — проект Apps Script и код

```bash
npm run bootstrap
```

Скрипт создаст standalone-проект «Budget Companion», запишет `.clasp.json`
(в `.gitignore`) и запушит все 15 модулей `apps-script/*.gs`. В конце он
напечатает следующие шаги. Если проект уже существует — bootstrap откажется
работать: используйте `npm run deploy`.

### Шаг 3 · 2 мин — настройки и секреты

Откройте проект (`npx clasp open-script` или [script.google.com](https://script.google.com)) → слева **⚙ Настройки проекта**:

1. **Часовой пояс** → ваш (например, `(UTC+6) Бишкек`). Важно: от него зависит час воскресного опроса.
2. **Свойства сценария → Добавить** — всего **три** свойства:

| Свойство | Значение |
|----------|----------|
| `TELEGRAM_BOT_TOKEN` | токен из Шага 1 |
| `TELEGRAM_CHAT_ID` | ваш chat_id из Шага 1 |
| `GEMINI_API_KEY` | ключ с [aistudio.google.com/apikey](https://aistudio.google.com/apikey): войти личным аккаунтом → принять условия → **Create API key** → скопировать `AIza...` |
| `GROQ_API_KEY` | *(опционально)* резервный AI-провайдер: [console.groq.com](https://console.groq.com) → API Keys → Create. Если Gemini недоступен, скриншоты разбирает Groq (Llama 4 Scout, free tier) |
| `GROQ_MODEL` | *(опционально)* переопределить модель Groq, если хотите `meta-llama/llama-4-maverick-17b-128e-instruct` вместо Scout по умолчанию. Важно: только vision-модели (Scout/Maverick) — текстовые модели Groq картинки не принимают |
| `GH_BACKUP_TOKEN` / `GH_BACKUP_REPO` | *(опционально)* дубль бэкапа в GitHub: токен [PAT](https://github.com/settings/tokens) (scope: `Contents` приватного репо, Read and write) + имя репозитория вида `user/private-repo`. Без них бэкап уходит только в Telegram-чат |

`WEBHOOK_SECRET` и `TMA_READ_TOKEN` **создадутся сами** при первом запуске — вручную их добавлять не надо.

### Шаг 4 · 2 мин — автосоздание таблицы

1. В выпадающем списке функций выберите **`createSpreadsheet`** → **Выполнить** → разрешите доступ (Дополнительно → перейти → Разрешить).
2. Скрипт сам создаст таблицу `Budget Companion` в Google Drive, все 11 листов (включая `Deposits` — вклады, `Metrics` — метрики и `Ops_Log` — журнал операций/ошибок), формулы `GOOGLEFINANCE`, триггеры и два автосекрета. Ссылка на таблицу — в логе выполнения.
3. Откройте таблицу по ссылке из лога (первое открытие заставляет GOOGLEFINANCE рассчитать историю курсов в `FX_History`).
4. В листе `Debt_Engine` сверьте колонку `Epoch` (дата, на которую верны балансы ипотек; по умолчанию `2026-10-01`) со своим графиком платежей.

### Шаг 5 · 2 мин — деплой и webhook

1. Выполните:
   ```bash
   npm run deploy
   ```
   Скрипт прогонит проверки, запушит код, создаст иммутабельную версию и
   развёртывание веб-приложения, сохранит его id в `.deploy.json` и напечатает
   URL вида `https://script.google.com/macros/s/AKfycb…/exec`.
   Доступ настроен манифестом: «выполнять как я», «все» (требование Telegram).
2. В редакторе выберите функцию **`setupWebhook`** → Выполнить (URL подхватится сам; если нет — вставьте строкой в функцию и повторите).
3. Напишите боту `/start` → затем `/plan`, `/status`, `/fx`.

Молчит? Выполните `debugWebhook` и смотрите лог: там URL webhook и последняя ошибка доставки.

### Шаг 6 · 1 мин — профиль бота и аудит

1. Выполните **`setupBotProfile`** — командное меню (автокомплит «/»), описание
   пустого чата и «О боте» поставятся сами. Иконка и кнопка Mini App — вручную
   в @BotFather ([docs/BOT_SETUP.md](docs/BOT_SETUP.md), 2 минуты).
2. Выполните **`securityAudit`** — проверит секреты, токены, webhook и здоровье.
   Все пункты должны быть ✅.

### Шаг 7 · 3 мин — Mini App (по желанию)

Публикация — через GitHub Pages из этого же репозитория (CI):

1. Включите Pages: **Settings → Pages → Source: GitHub Actions**.
2. Задайте переменную: **Settings → Secrets and variables → Actions → Variables →
   New** → имя `WEBAPP_URL`, значение — URL веб-приложения из Шага 5
   (`https://script.google.com/macros/s/…/exec`).
3. Запустите workflow **Deploy Mini App** (Actions → workflow_dispatch) или
   просто запушьте изменение в `mini-app/` — CI сам подставит URL в копию
   `index.html` и выложит на `https://<username>.github.io/budget-calculator/`.
4. @BotFather → `/setmenubutton` → выберите бота → вставьте URL Pages → название `Дашборд`.
5. В таблице `FX_and_Settings` впишите этот URL в ключ `MINI_APP_URL` — теперь команда `/app` открывает дашборд, **токен доступа подставится автоматически**. Готовую ссылку с токеном для браузера вернёт функция `getAccessInfo()`.

Локальная проверка без Pages: откройте `mini-app/index.html` с параметром
`?api=<URL веб-приложения>` (подробно — `mini-app/README.md`).

## Карта пути (что вы имеете на каждом шаге)

| После шага | Что работает |
|-----------|--------------|
| 2 | Проект Apps Script с полным кодом (15 модулей) |
| 3 | Код + секреты (кроме 2 автосекретов) |
| 4 | + таблица со всеми листами и триггерами (Sunday 20:00, daily, monthly) |
| 5 | + бот отвечает: /plan /income /spent /week /prepay /invest /fx /status |
| 6 | + подтверждено, что защита включена |
| 7 | + дашборд со слайдерами, валютными сигналами и ЧДП-симулятором |

## Чеклист приёмки

- [ ] `/start` отвечает приветствием
- [ ] `/plan` — водопад с вашими цифрами (база $5 800 и т.д.)
- [ ] `/fx` — перцентили, прогноз 7/30д, рекомендации EUR→₽/сом/$ (после открытия FX_History)
- [ ] Скриншот аналитики MBANK разбирается в суммы и категории; скриншот остатка ипотеки → сверка кнопкой
- [ ] Валютные push-алерты: входят в топ-15% перцентиля — бот сам напишет (проверка: логика в dailyMaintenance)
- [ ] Напоминание о списании приходит за 2 дня (аренда 1-го → сообщение 29-го числа)
- [ ] Digest «факт vs план + savings rate» — утром последнего дня месяца (тест: `testDigest`)
- [ ] `/anomalies` — «Аномалий нет» или понятные находки (детектор невозможных цифр)
- [ ] Воскресенье 20:00 — бот сам спросил про недельные траты (проверить: `testWeeklyAsk`)
- [ ] `backupNow` в редакторе — в чат с ботом пришёл zip `budget-backup-….zip` с CSV всех данных (бэкап вне Google; дальше — автоматически 1-го числа)
- [ ] `/prepay sber 1000` → платёж Сбербанка уменьшился на ~34 ₽ (тестовые строки потом удалите в журнале Debt_Engine)
- [ ] Mini App открывается из Telegram, слайдеры пересчитывают водопад
- [ ] В `NetWorth_History` каждый день появляется снапшот

## 🔄 Как обновляться (когда вышла новая версия проекта)

```bash
git pull
npm ci        # если менялись зависимости
npm run deploy
```

`deploy` обновляет **существующее** развёртывание (id берётся из `.deploy.json`) —
URL веб-приложения и webhook не меняются. После обновления:

1. В редакторе выполните **`setup()`** — создаст новые листы/миграции, пересоздаст триггеры. Существующие данные не трогает.
2. Выполните **`securityAudit`** — убедиться, что webhook указывает на текущее развёртывание и все триггеры на месте (если URL всё же сменился — `setupWebhook`).
3. Mini App обновится сам при следующем открытии (CI Pages деплоит `mini-app/` при пуше в main).

## ⚙️ CI/CD (GitHub Actions) — настройка один раз

В репозитории три workflow: **CI** (на каждый push/PR), **Deploy Apps Script**
(push в main по `apps-script/**` или вручную) и **Deploy Mini App** (Pages).
Чтобы деплойные workflow заработали, задайте секреты:

| Где | Имя | Значение |
|-----|-----|----------|
| Secret (environment `production` или репозитория) | `CLASPRC_JSON` | содержимое `~/.clasprc.json` после `npx clasp login` — **это OAuth-refresh-токен Google, не печатайте в лог и не коммитьте** |
| Secret | `CLASP_JSON` | содержимое вашего `.clasp.json` (`{"scriptId": "…", "rootDir": "./apps-script"}`) |
| Secret или Variable | `DEPLOYMENT_ID` | id развёртывания (из `npm run deploy` или `npx clasp deployments`); если не задан — workflow создаст новое развёртывание |
| Variable | `WEBAPP_URL` | URL веб-приложения — для подстановки в `mini-app/index.html` при сборке Pages |

До настройки секретов деплойный workflow **пропускается без ошибки**
(в логе будет notice). Подсказка для CLASPRC_JSON на Unix: `cat ~/.clasprc.json`;
на Windows: `type %USERPROFILE%\.clasprc.json` — вывод целиком вставьте
в секрет, никуда не публикуя.

## Частые проблемы

| Симптом | Причина и решение |
|---------|-------------------|
| `clasp` не авторизован / «User has not enabled the Apps Script API» | `npx clasp login`; включите API: [script.google.com/home/usersettings](https://script.google.com/home/usersettings) |
| `npm run deploy` ругается на отсутствие `.clasp.json` | первый запуск — `npm run bootstrap` (или `cp .clasp.json.example .clasp.json` + scriptId существующего проекта) |
| `createSpreadsheet`/`setup` падает с «The number of rows … does not match» (13≠12) | баг старой версии — исправлен. Если таблица успела создаться наполовину: выполните `setup()` (достроит листы), затем `repairSettings` (допишет ключи и формулы курсов). Новую `createSpreadsheet` не запускайте — SHEET_ID уже сохранён |
| Бот молчит | `debugWebhook` → смотрите лог; webhook привязан к деплою (`setupWebhook` после `npm run deploy`) |
| «Скрипт не привязан к таблице» | выполняли `setup()` без `createSpreadsheet` — выполните `createSpreadsheet` |
| `/fx` пишет «FX_History ещё не заполнен» | откройте лист FX_History в таблице (GOOGLEFINANCE рассчитывается при открытии) |
| Gemini: «не задан GEMINI_API_KEY» | Шаг 3, свойство с точным именем `GEMINI_API_KEY` |
| Воскресный опрос пришёл не в 20:00 | не тот часовой пояс проекта — Шаг 3.1, затем перепустите `setup()` |
| Mini App показывает «unauthorized» из браузера | открывайте с токеном: `getAccessInfo()` вернёт готовую ссылку |
| Push уехал не то содержимое | `npx clasp status` показывает реальный список файлов; `apps-script/` должен содержать только `*.gs` и `appsscript.json` |

## Что где менять в эксплуатации

| Хочу изменить | Где |
|---------------|-----|
| Базовый доход / лимиты / ставка вклада / доли DCA | Лист `FX_and_Settings` (таблица Config) |
| Обязательства (суммы, Active) | Лист `Commitments_Registry` |
| Холдинги портфеля | Лист `Portfolio` (цены подтянутся сами) |
| Начальные балансы ипотек | `apps-script/Config.gs` → `npm run deploy` + `createSpreadsheet` заново или руками в `Debt_Engine` |
| Час воскресного опроса | `apps-script/Triggers.gs → installTriggers_` → перепустить `setup()` |
| Пороги валютных алертов (топ-15%, кулдаун) | `apps-script/Config.gs → FX_ALERTS` |
| Модель Groq (Scout → Maverick) | Script Property `GROQ_MODEL` |
| URL Mini App | Ключ `MINI_APP_URL` в `FX_and_Settings` |

## Локальная разработка

```bash
npm run check        # lint + офлайн smoke-тесты (моки Apps Script)
npm run build:bundle # опционально: один файл dist/BUNDLE.gs (в .gitignore)
npm run deploy       # деплой: check → clasp push → версия → развёртывание
```

Секреты — только в Script Properties; локально держите в `secrets.json`
(в `.gitignore`), pre-commit хук не даст их закоммитить ([SECURITY.md](SECURITY.md)).
