# 💰 Personal Finance Companion — Personal Finance Engine (Serverless)

[![CI](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/ci.yml/badge.svg)](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/ci.yml)
[![Deploy Apps Script](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/deploy-apps-script.yml/badge.svg)](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/deploy-apps-script.yml)
[![Deploy v2 (Cloudflare)](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/deploy-v2.yml/badge.svg)](https://github.com/kaparuzfgh-netizen/budget-calculator/actions/workflows/deploy-v2.yml)

Серверлесс-движок личных финансов для Telegram. **TCO: $0/мес.**

> **v2 в проде.** Идёт миграция v1→v2 ([ADR-0001](docs/adr/0001-platform-and-architecture.md)):
> до шага 9 в репозитории живут **два стека одновременно** — см. таблицу ниже.

## Структура репозитория: v1 и v2

| Стек | Статус | Что это | Документация |
|------|--------|---------|--------------|
| **v2** — `apps/api`, `apps/web` | **production** | Мультипользовательский Telegram-бот + Mini App (Preact): Cloudflare Worker (Hono + D1), SPA раздаётся тем же воркером через Workers Static Assets | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — карта системы · [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — гид пользователя · [docs/v2-development.md](docs/v2-development.md) — разработка и деплой |
| **v1** — `apps-script/`, `mini-app/` | legacy, жив до шага 9 миграции | Однопользовательский бэкенд на Google Apps Script, БД — Google Sheets, Mini App — один `index.html` на Pages | [SETUP.md](SETUP.md) — установка · [SECURITY.md](SECURITY.md) — аудит · разделы «v1 (legacy)» ниже |

## v2: быстрый старт

Предусловия: **Node.js ≥ 20**, бесплатный аккаунт [dash.cloudflare.com](https://dash.cloudflare.com), токен бота от @BotFather.

```bash
npm ci                          # зависимости всех workspaces
npm run wrangler -- login       # вход в Cloudflare (браузер), один раз
```

Один раз — создать базу и вписать `database_id` в `apps/api/wrangler.toml`:

```bash
npm run wrangler -- d1 create budget-companion
```

Дальше всё делает мастер (токен BotFather → миграции D1 → деплой → секреты
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`/`JWT_SECRET`/`OWNER_TELEGRAM_ID` →
webhook → menu-button):

```bash
npm run setup                   # --dry-run — только план
```

После мастера напишите боту `/start` — вы зарегистрированы владельцем;
`/invite` создаёт одноразовую ссылку-приглашение для участников.

**Локальная разработка:**

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars   # секреты для wrangler dev (в .gitignore)
npm run dev -w apps/api                            # локальный воркер + D1 (miniflare)
npm run wrangler -- d1 migrations apply DB --local # миграции в локальную D1
npm run check                                      # lint + smoke v1 + typecheck + тесты API + сборка web
```

**Релиз:**

```bash
npm run release    # проверки → сборка apps/web → миграции D1 → wrangler deploy → /health
```

**Mini App:** голубая menu-button **«💰 Бюджет»** у поля ввода запускает Mini App
(`setChatMenuButton`, ставится мастером; вручную —
`node scripts/telegram-webhook.mjs menu <url>`).

Подробно: [docs/v2-development.md](docs/v2-development.md) ·
архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
гид пользователя: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

---

## v1 (legacy): Google Apps Script + Google Sheets — до шага 9 миграции

> Всё ниже описывает **v1** — однопользовательский бэкенд: Google Sheets как база
> данных и BI-слой, Google Apps Script как оркестратор, Gemini 2.0 Flash как
> vision-парсер чеков. Установка и эксплуатация — [SETUP.md](SETUP.md).

### Возможности v1

| # | Модуль | Что делает |
|---|--------|-----------|
| 1 | **Monthly Cashflow & Waterfall Engine** | `/income 6200 eur` → конвертация в базовый USD, аудит активных обязательств из `Commitments_Registry`, расчёт Free Surplus; **дельта бонуса** (доход − база $5 800) каскадом 50/50: досрочное погашение (с арбитражем «вклад 16%») и инвестиционный пул (58% ETF / 23% Tech / 19% Crypto) |
| 2 | **Dynamic Debt State & Roll-Forward** | Две ипотеки: Сбербанк 11.9% (аннуитет, платёж 44 282 ₽) и Т-Банк 8.59% (раз в 2 недели 17 314 ₽ = 37 513.67 ₽/мес). ЧДП вычитается из тела и **снижает платёж с сохранением даты maturity (2029-07-25)** по формуле $P_{нов}=(B-L)\cdot\frac{r(1+r)^n}{(1+r)^n-1}$; `Commitments_Registry` обновляется автоматически |
| 3 | **Weekly Expense Sync via Vision AI** | Воскресенье 20:00 — бот спрашивает траты. Скриншот из MBANK → **Gemini 2.0 Flash** (бесплатный лимит), при недоступности — **резервный Groq** (Llama 4 Scout); строгая JSON-схема различает экраны: аналитика расходов (→ недельный лимит, burn rate, дневной остаток) и **остаток ипотеки → сверка с движком одной кнопкой**. Категории обучаются: `/alias "кафе" Питание` |
| 4 | **Investment & Net Worth Tracker** | `Portfolio`: цена через `=GOOGLEFINANCE(A,"price")` для акций/ETF и `=GOOGLEFINANCE("CURRENCY:"&A&"USD")` для крипты (MOEX-бумаги — ручная цена колонкой Manual Price); PnL, текущая/целевая доля, rebalance delta. Net Worth = `(Cash + Вклады + Portfolio) − (долг в USD)`: мультивалютный кэш (USD/EUR/RUB/KGS), вклады из листа `Deposits`, ежедневные снапшоты |
| 5 | **Interactive UI** | Telegram-бот (команды + диалоги + inline-кнопки `[Apply to Sheet]` / `[Edit Commitments]`) + Telegram Mini App (dark mode, тикер валют, слайдер дохода, слайдер ЧДП Сбербанка 0→1 287 312 ₽ с мгновенным «платёж ↓ vs срок ↓», валютные сигналы, портфель, net worth gauge) |
| 6 | **FX Analytics & Forecast** | 180-дневная история курсов (GOOGLEFINANCE) → перцентили, RSI(14), SMA-тренд, волатильность ±σ и статистический прогноз на 7/30 дней; рекомендации по таймингу конвертаций **EUR→RUB (ипотеки), EUR→KGS (жизнь), EUR→USD (инвестиции)**: «конвертировать сейчас / дробить 50/50 / отложить» с гасителем боковика |
| 7 | **Автопилот, здоровье и метрики** | Push-алерты при входе курса в выгодную зону (топ-15% перцентиля, кулдаун 7 дней); напоминания о списаниях за 2 дня; понедельничный nudge; digest «факт vs план» с savings rate; детектор аномалий «такого не может быть» (12 инвариантов, `/anomalies`); журнал `Ops_Log`; **ежемесячный бэкап вне Google** (zip со CSV всех данных — документом в Telegram-чат, опционально копия в приватный репозиторий GitHub); продуктовые метрики |

### Архитектура v1 (legacy, до шага 9)

```
                     ┌─────────────────────────────┐
                     │        Telegram             │
                     │  ┌────────────┐ ┌─────────┐ │
   /income /plan ───▶│  │   Бот      │ │ Mini App│ │
   скриншот MBANK ──▶│  └─────┬──────┘ └────┬────┘ │
                     └────────┼─────────────┼──────┘
                              │ webhook     │ REST (initData HMAC-SHA256)
                              ▼             ▼
                     ┌─────────────────────────────┐
                     │  Google Apps Script Web App │
                     │  • Code.gs — роутер doPost  │
                     │  • CashflowEngine / Debt    │
                     │    Engine / VisionParser    │
                     │  • триггеры: Sunday 20:00,  │
                     │    daily, monthly           │
                     └───────┬─────────────┬───────┘
                             │             │ UrlFetchApp
                             ▼             ▼
                   ┌──────────────┐  ┌───────────────────┐
                   │ Google Sheets │  │ Gemini 2.0 Flash  │
                   │ БД + BI +     │  │ free tier (15 RPM)│
                   │ GOOGLEFINANCE │  └───────────────────┘
                   └──────────────┘
```

### Структура проекта

```
budget-calculator/
├── README.md                  ← вы здесь (v1 и v2, архитектура + математика)
├── SETUP.md                   v1: пошаговый деплой через clasp (~15 минут)
├── CONTRIBUTING.md            команды и правила разработки
├── AGENTS.md                  заметки для ИИ-агентов и автоматизации
├── CHANGELOG.md               история изменений (Keep a Changelog)
├── SECURITY.md                🔐 аудит безопасности v1 и v2 + политика секретов
├── LICENSE                    все права защищены (частный проект)
├── package.json               npm-скрипты: check / test / deploy / setup / release
├── .gitignore                 секреты и креды не попадают в репозиторий
├── .gitleaks.toml             правила сканера секретов (gitleaks)
├── .claspignore               в Apps Script пушатся только *.gs и appsscript.json
├── .clasp.json.example        шаблон привязки к проекту (scriptId + rootDir)
├── .deploy.json.example       шаблон id развёртывания для npm run deploy
├── secrets.example.json       шаблон секретов (без значений; secrets.json в .gitignore)
├── .github/workflows/         CI: lint+test+gitleaks; CD: clasp deploy, Pages, v2 (Cloudflare)
├── docs/
│   ├── ARCHITECTURE.md        карта системы v2 (диаграммы, данные, деплой)
│   ├── USER_GUIDE.md          гид пользователя v2 (команды, экраны, FAQ)
│   ├── v2-development.md      разработка и деплой v2
│   ├── BOT_SETUP.md           v1: настройка профиля бота в @BotFather
│   ├── ux/navigation.md       навигация бота v2 (источник истины + реестр экранов)
│   └── adr/                   архитектурные решения (ADR-0001: платформа v2)
├── apps/
│   ├── api/                   v2: Cloudflare Worker — Hono-роутер, D1, cron
│   │   ├── migrations/        SQL-миграции D1 (иммутабельны, wrangler d1 migrations)
│   │   ├── src/               http/ services/ bot/ tma/ domain/ db/ fx/ telegram/
│   │   ├── test/              vitest в рантайме workerd с локальной D1
│   │   └── wrangler.toml      биндинги D1, [assets] SPA, [triggers] cron, [vars]
│   └── web/                   v2: Mini App на Preact (Vite) → dist → Static Assets
├── apps-script/               v1: бэкенд — пушится в Apps Script через clasp
│   ├── appsscript.json        манифест (часовой пояс, oauthScopes, webapp)
│   ├── Config.gs              финансовый профиль: доход, обязательства, ипотеки
│   ├── Setup_Sheets.gs        setup() / createSpreadsheet(): автосоздание файла и листов
│   ├── SheetService.gs        слой данных + чтение FX/настроек + санитайзер ячеек
│   ├── TelegramService.gs     обёртка Bot API (сообщения, фото, inline-клавиатуры)
│   ├── Code.gs                webhook-роутер doPost + команды + callback-кнопки
│   ├── CashflowEngine.gs      водопад месяца, каскад дельты бонуса, арбитраж
│   ├── DebtEngine.gs          аннуитет, replay событий, ЧДП, roll-forward, проекции
│   ├── VisionParser.gs        Gemini Flash: скриншот → строгий JSON
│   ├── FXAnalytics.gs        валюты: перцентили, RSI, тренд, прогноз ±σ, рекомендации, push-алерты
│   ├── MetricsEngine.gs      продуктовые метрики и digest «факт vs план» с savings rate
│   ├── InvestNetWorth.gs      портфель, вклады, мультивалютный кэш, net worth, снапшоты
│   ├── TmaApi.gs              REST для Mini App (валидация initData + read-token)
│   ├── Triggers.gs            Sunday 20:00 weekly ask, daily maintenance, monthly
│   └── SecurityAudit.gs       🔐 рантайм-аудит: секреты, токены, webhook, доступы
├── scripts/
│   ├── setup.mjs              v2: мастер подключения бота (npm run setup)
│   ├── release.mjs            v2: релиз — проверки → web → миграции → deploy
│   ├── telegram-webhook.mjs   v2: webhook set/info/delete + menu-button
│   ├── smoke-test.js          v1: офлайн-тесты бэкенда (моки Apps Script)
│   ├── build-bundle.js        опциональная сборка dist/BUNDLE.gs одним файлом
│   ├── deploy.js              v1: npm run deploy: check → push → версия → развёртывание
│   ├── bootstrap.js           v1: первичное создание проекта (clasp create + push)
│   ├── install-hooks.js/.sh   установка pre-commit хука (авто при npm install)
│   ├── lint-sh.js             опциональный shellcheck
│   └── hooks/pre-commit       блокирует коммит с токенами/ключами + eslint
└── mini-app/                  v1: Mini App — один файл
    ├── index.html             Vue 3 + Tailwind + Chart.js, CDN-зависимости
    └── README.md              деплой на GitHub Pages через CI
```

### Схема Google Sheets (v1)

| Лист | Назначение |
|------|-----------|
| `FX_and_Settings` | B2 `=GOOGLEFINANCE("CURRENCY:EURUSD")`, B3 USDRUB, B4 USDKGS, B5 `=B2*B3` (EUR/RUB кросс) + таблица конфигурации: базовый доход $5 800, лимиты 15 000 ₽/нед и 60 000 ₽/мес, ставка вклада 16%, целевые доли 58/23/19, доли каскада 50/50, кэш |
| `Commitments_Registry` | `Category \| Item \| Base Amount \| Currency \| USD Equivalent (формула) \| Due Day \| Active` — жильё и подписки USD, алименты/английский RUB, строки ипотек ссылаются формулой на `Debt_Engine` (платёж Т-Банка нормализуется `×26/12`) |
| `Monthly_Cycles` | Главный гроссбух: `Month \| Income \| Currency \| Income USD \| Total Mandatory USD \| Free Surplus \| → Prepay \| → ETF \| → Stocks \| → Crypto \| Status` (proposal → applied кнопкой из бота) |
| `Weekly_Expenses` | `Date \| Week # \| Total (KGS) \| In RUB (формула) \| In USD (формула) \| Top Cat 1 \| Top Cat 2 \| Budget ₽ \| Variance ₽ \| File ID/Note` |
| `Debt_Engine` | Живое состояние ипотек + **ЧДП-калькулятор с формулой аннуитета прямо в листе** + журнал событий (платежи/ЧДП) + Arbitrage Monitor («16.0% deposit yields +XX ₽/yr more…») |
| `Portfolio` | `Ticker \| Class \| Units \| Avg Buy \| Current Price (GOOGLEFINANCE) \| Value \| PnL $ \| PnL % \| Share \| Target \| Rebalance Delta $` |
| `NetWorth_History` | Ежедневные снапшоты: `Date \| Cash \| Deposits \| Portfolio \| Debt ₽ \| Debt $ \| Net Worth $` + встроенный график |
| `FX_History` | 180-дневная история курсов GOOGLEFINANCE (EURUSD, USDRUB, USDKGS, EURRUB) — данные для `/fx`: перцентили, RSI, прогноз |
| `Deposits` | Вклады как актив: `Date Opened \| Name \| Amount \| Currency \| Rate \| Maturity \| Active` → Net Worth и арбитраж «фактически размещено» |
| `Metrics` | Продуктовые метрики: weekly-ответы, применённый каскад, сверки, исправления Vision, savings rate |
| `Ops_Log` | Журнал операций и ошибок: `Date \| Level \| Source \| Message` — аномалии, сверки, алерты, автороллы, ошибки runtime |

### Команды бота v1

| Команда | Алиасы | Действие |
|---------|--------|----------|
| `/plan [сумма] [валюта]` | `/план` | Водопад месяца: доход → обязательства → лимит жизни → профицит → каскад |
| `/income 6200 eur` | `/доход` | Доход месяца + кнопки `Apply to Sheet` / `Edit Commitments` |
| `/spent 3200 [₽/kgs/$]` | `/трата` | Быстрая трата в недельный учёт |
| фото | | Аналитика расходов MBANK → разбор; экран ипотеки → сверка остатка кнопкой |
| `/week` | `/неделя` | Недельный/месячный бюджет, burn rate, дневной лимит |
| `/prepay sber 50000` | `/чдп` | Досрочное погашение: платёж ↓, срок сохранён |
| `/balance sber 1234567` | `/остаток` | Сверка ипотеки вручную |
| `/fx` | `/валюта`, `/курс` | Валюты: перцентили, RSI, прогноз 7/30д, «когда менять» |
| `/invest` | `/инвестиции` | Портфель и дрейф от целей 58/23/19 |
| `/cash 12000 kgs` | `/кэш` | Кэш в конкретной валюте (usd/eur/rub/kgs) |
| `/alias "кафе" Питание` | `/категория` | Обучение категорий Vision |
| `/status` | `/статус` | Net Worth: кэш + вклады + портфель − долг |
| `/metrics` | `/метрики` | Продуктовые метрики (weekly-ответы, savings rate, каскад, Vision) |
| `/anomalies` | `/аномалии` | Проверка невозможных цифр: остатки/платежи, суммы, Net Worth-прыжки, курсы против медианы |
| `/guide` | `/гайд` | Гид установки: что готово и следующий шаг |
| `/sync` | | Roll-forward долгов + снапшот Net Worth |
| `/app` | | Открыть Mini App |

### Финансовая математика (v1)

**Аннуитет и ЧДП (Сбербанк).** Оставшийся срок `n` выводится инверсией аннуитета из
текущих (баланс, ставка, платёж) → для базы получается 34.5 мес, что совпадает с
банковским графиком (maturity 2029-07-25) с точностью ±50 ₽. При ЧДП `L`:

- **снижение платежа** (срок зафиксирован): $P_{нов}=(B-L)\cdot\dfrac{r(1+r)^n}{(1+r)^n-1}$ — аннуитет линеен по балансу, поэтому $P_{нов}=P\cdot\frac{B-L}{B}$. Пример: L=706 000 ₽ при B=1 287 312 ₽ → платёж 44 282 → **19 998 ₽**;
- **снижение срока** (платёж зафиксирован): $n'=-\ln\!\big(1-\tfrac{(B-L)\,r}{P}\big)/\ln(1+r)$.

**Арбитраж.** Годовая доходность суммы L на вкладе 16% против экономии 11.9% на
досрочке Сбербанка: пока `deposit > rate`, монитор показывает
`+L×(16%−11.9%)` ₽/год в пользу вклада.

**Т-Банк.** Раз в две недели 17 314 ₽, 26 платежей/год → нормализованный месячный
платёж 37 513.67 ₽ участвует в обязательствах; roll-forward считает периоды по 14 дней от `Epoch`.

**Мультивалютность.** Весь учёт в базовом USD; курсы — живые `GOOGLEFINANCE`:
EUR→USD (B2), RUB→USD (÷B3), KGS→USD (÷B4), EUR→RUB (B5). Недельные траты
хранятся в KGS и формульно конвертируются в RUB/USD.

**Валютный анализ и прогноз (`/fx`, вкладка «Валюты»).** По 180-дневной истории
GOOGLEFINANCE для каждой конвертации пользователя (EUR→RUB, EUR→KGS, EUR→USD)
считаются: перцентиль текущего курса в диапазоне, RSI(14), SMA20/50-тренд,
σ-волатильность; прогноз на 7/30 дней — линейная регрессия ± σ√h. Рекомендация:
перцентиль ≥ 70 → «конвертировать сейчас», 45–69 → «дробить 50/50», 30–44 →
«отложить», < 30 → «отложить (кроме обязательных платежей)»; если тренд за 30д
тише собственного шума (|move| < 0.5·σ√30) — рынок боковой, всегда «50/50».
Статистика ≠ гарантия: обязательные платежи конвертируются в срок.

### Где живёт математика (v1)

Математика распределена между тремя слоями **намеренно** — каждый делает то,
что другие не умеют:

| Слой | Что считает | Почему именно здесь |
|------|-------------|---------------------|
| **Формулы Sheets** | живые курсы GOOGLEFINANCE (FX_and_Settings B2–B5, FX_History 180д); конвертации обязательств и недельных трат; Income USD и Total Mandatory в Monthly_Cycles (SUMIFS реестра); вся оценка портфеля (цена, PnL, доли, rebalance); ЧДП-калькулятор и арбитражный монитор в Debt_Engine | GAS не может вызвать GOOGLEFINANCE напрямую — только читать ячейки; формулы пересчитываются при открытии таблицы без участия бота (BI-слой живёт сам) |
| **Apps Script (бот)** | replay ипотеки (проценты по событиям, ЧДП, reconcile — событийная логика формулами невозможна); инверсия аннуитета и проекции погашения; каскад дельты бонуса; валютная статистика (перцентили, RSI, регрессия ±σ — на данных FX_History); метрики и digest; всё, что требует чтения журналов и триггеров | событийные журналы, симуляции и статистика — вне выразимости формул; плюс запись в Telegram |
| **Mini App (браузер)** | ЧДП-симулятор «платёж ↓ vs срок ↓» мгновенно при движении слайдера (аннуитет, тот же ±50 ₽) | интерактивность без похода на сервер |

**Дублирование — осознанное и сверяемое:** формула аннуитета живёт в трёх местах (лист B8, `DebtEngine`, Mini App) — все протестированы на консистентность, а `securityAudit()` ежедневно-проверяемо сверяет лист с кодом (ЧДП-калькулятор и кросс EUR/RUB, допуск 0.5%). Единственный нюанс определений: в `Monthly_Cycles` «Free Surplus» = доход − обязательства (схема ТЗ), бот и Mini App показывают профицит **после** лимита жизни — digest сравнивает корректно (план и факт оба «после жизни»).

### Бесплатные лимиты (v1)

| Сервис | Free tier | Нагрузка проекта |
|--------|-----------|------------------|
| Apps Script | триггеры ~90 мин/день, UrlFetch 20 000/день | единицы минут и вызовов |
| Gemini 2.0 Flash (AI Studio) | 15 RPM | 1 запрос на скриншот |
| Telegram Bot API | безлимит | — |
| Cloudflare Pages / GitHub Pages | статика $0 | 1 файл `index.html` |

v2 укладывается в те же $0: Workers Free, D1 Free (5 млн чтений/сутки),
Frankfurter — без ключа, Telegram Bot API бесплатен
(см. [AUDIT_REPORT.md](AUDIT_REPORT.md), оценка затрат).

### Безопасность

v1: секреты — только в Script Properties Apps Script; в репозитории их нет (`.gitignore`,
`secrets.example.json`, pre-commit хук и gitleaks-правила). Чтение API Mini App защищается
свойством `TMA_READ_TOKEN`, записи — подписью `initData` (HMAC-SHA256). Полный отчёт аудита,
модель угроз и действия при утечке — [SECURITY.md](SECURITY.md). Быстрая проверка живого
проекта — функция `securityAudit()` в Apps Script.

v2: модель угроз и контроли (tenant-изоляция, JWT, webhook) — в разделе
«Раздел v2 (Cloudflare Workers)» того же [SECURITY.md](SECURITY.md).

### Настройка бота в Telegram (v1)

Минимум: выполните `setupBotProfile()` в Apps Script — командное меню
(автокомплит «/» с описаниями), описание пустого чата и «О боте» настроятся
сами. Вручную в @BotFather — только иконка и кнопка Mini App
(`/setmenubutton`); после `/start` бот показывает постоянное меню
`План · Курсы · Неделя · Статус`. Подробно, по страницам BotFather:
[docs/BOT_SETUP.md](docs/BOT_SETUP.md).

### Установка v1

Полный пошаговый гайд — [SETUP.md](SETUP.md). Коротко: `npm ci` →
`npx clasp login` → `npm run bootstrap` (создаст проект и запушит код) →
Script Properties → `npm run deploy` → `setupWebhook`. Таблица, листы,
триггеры и два секрета создаются автоматически функцией `createSpreadsheet()`.
