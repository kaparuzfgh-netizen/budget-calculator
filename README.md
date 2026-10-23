# 💰 Personal Finance Companion — Personal Finance Engine (Serverless)

Серверлесс-движок личных финансов для Telegram: Google Sheets как база данных и BI-слой,
Google Apps Script как оркестратор, Gemini 2.0 Flash как vision-парсер чеков.
**TCO: $0/мес.**

## Возможности

| # | Модуль | Что делает |
|---|--------|-----------|
| 1 | **Monthly Cashflow & Waterfall Engine** | `/income 6200 eur` → конвертация в базовый USD, аудит активных обязательств из `Commitments_Registry`, расчёт Free Surplus; **дельта бонуса** (доход − база $5 800) каскадом 50/50: досрочное погашение (с арбитражем «вклад 16%») и инвестиционный пул (58% ETF / 23% Tech / 19% Crypto) |
| 2 | **Dynamic Debt State & Roll-Forward** | Две ипотеки: Сбербанк 11.9% (аннуитет, платёж 44 282 ₽) и Т-Банк 8.59% (раз в 2 недели 17 314 ₽ = 37 513.67 ₽/мес). ЧДП вычитается из тела и **снижает платёж с сохранением даты maturity (2029-07-25)** по формуле $P_{нов}=(B-L)\cdot\frac{r(1+r)^n}{(1+r)^n-1}$; `Commitments_Registry` обновляется автоматически |
| 3 | **Weekly Expense Sync via Vision AI** | Триггер каждое **воскресенье 20:00**: бот спрашивает траты за неделю. Скриншот MBANK (Кыргызстан) → Gemini 2.0 Flash со строгой JSON-схемой (`total_spent`, `currency ∈ {KGS,RUB,USD}`, `top_categories`, `is_full_month_analytics`) → строка в `Weekly_Expenses` + отчёт: потрачено, burn rate, допустимо в день до конца месяца |
| 4 | **Investment & Net Worth Tracker** | `Portfolio`: цена через `=GOOGLEFINANCE(A,"price")` для акций/ETF и `=GOOGLEFINANCE("CURRENCY:"&A&"USD")` для крипты; PnL, текущая/целевая доля, rebalance delta. Net Worth = `(Cash + Portfolio) − (долг по ипотекам в USD)`, ежедневные снапшоты |
| 5 | **Interactive UI** | Telegram-бот (команды + диалоги + inline-кнопки `[Apply to Sheet]` / `[Edit Commitments]`) + Telegram Mini App (dark mode, тикер валют, слайдер дохода, слайдер ЧДП Сбербанка 0→1 287 312 ₽ с мгновенным «платёж ↓ vs срок ↓», валютные сигналы, портфель, net worth gauge) |
| 6 | **FX Analytics & Forecast** | 180-дневная история курсов (GOOGLEFINANCE) → перцентили, RSI(14), SMA-тренд, волатильность ±σ и статистический прогноз на 7/30 дней; рекомендации по таймингу конвертаций **EUR→RUB (ипотеки), EUR→KGS (жизнь), EUR→USD (инвестиции)**: «конвертировать сейчас / дробить 50/50 / отложить» с гасителем боковика |

## Архитектура

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

## Структура проекта

```
budget-calculator/
├── README.md                  ← вы здесь (архитектура + математика)
├── SETUP.md                   пошаговый деплой за 15 минут
├── SECURITY.md                🔐 аудит безопасности + политика секретов в git
├── .gitignore                 секреты и креды не попадают в репозиторий
├── .gitleaks.toml             правила сканера секретов (gitleaks)
├── apps-script/               бэкенд — вставить в редактор Apps Script
│   ├── appsscript.json        манифест: часовой пояс, права, web app
│   ├── Config.gs              финансовый профиль: доход, обязательства, ипотеки
│   ├── Setup_Sheets.gs        setup() / createSpreadsheet(): автосоздание файла и листов
│   ├── SheetService.gs        слой данных + чтение FX/настроек + санитайзер ячеек
│   ├── TelegramService.gs     обёртка Bot API (сообщения, фото, inline-клавиатуры)
│   ├── Code.gs                webhook-роутер doPost + команды + callback-кнопки
│   ├── CashflowEngine.gs      водопад месяца, каскад дельты бонуса, арбитраж
│   ├── DebtEngine.gs          аннуитет, replay событий, ЧДП, roll-forward, проекции
│   ├── VisionParser.gs        Gemini Flash: скриншот → строгий JSON
│   ├── FXAnalytics.gs        валюты: перцентили, RSI, тренд, прогноз ±σ, рекомендации
│   ├── InvestNetWorth.gs      портфель, net worth, ежедневные снапшоты
│   ├── TmaApi.gs              REST для Mini App (валидация initData + read-token)
│   ├── Triggers.gs            Sunday 20:00 weekly ask, daily maintenance, monthly
│   ├── SecurityAudit.gs       🔐 рантайм-аудит: секреты, токены, webhook, доступы
│   ├── secrets.example.json   шаблон секретов (без значений; реальный secrets.json в .gitignore)
│   └── .clasp.json.example    опционально для разработки через clasp
├── scripts/
│   ├── install-hooks.sh       установка pre-commit хука защиты секретов
│   └── hooks/pre-commit       блокирует коммит с токенами/ключами
└── mini-app/
    ├── index.html             Mini App: Vue 3 + Tailwind + Chart.js, один файл
    └── README.md              хостинг на Cloudflare Pages / GitHub Pages
```

## Схема Google Sheets

| Лист | Назначение |
|------|-----------|
| `FX_and_Settings` | B2 `=GOOGLEFINANCE("CURRENCY:EURUSD")`, B3 USDRUB, B4 USDKGS, B5 `=B2*B3` (EUR/RUB кросс) + таблица конфигурации: базовый доход $5 800, лимиты 15 000 ₽/нед и 60 000 ₽/мес, ставка вклада 16%, целевые доли 58/23/19, доли каскада 50/50, кэш |
| `Commitments_Registry` | `Category \| Item \| Base Amount \| Currency \| USD Equivalent (формула) \| Due Day \| Active` — жильё и подписки USD, алименты/английский RUB, строки ипотек ссылаются формулой на `Debt_Engine` (платёж Т-Банка нормализуется `×26/12`) |
| `Monthly_Cycles` | Главный гроссбух: `Month \| Income \| Currency \| Income USD \| Total Mandatory USD \| Free Surplus \| → Prepay \| → ETF \| → Stocks \| → Crypto \| Status` (proposal → applied кнопкой из бота) |
| `Weekly_Expenses` | `Date \| Week # \| Total (KGS) \| In RUB (формула) \| In USD (формула) \| Top Cat 1 \| Top Cat 2 \| Budget ₽ \| Variance ₽ \| File ID/Note` |
| `Debt_Engine` | Живое состояние ипотек + **ЧДП-калькулятор с формулой аннуитета прямо в листе** + журнал событий (платежи/ЧДП) + Arbitrage Monitor («16.0% deposit yields +XX ₽/yr more…») |
| `Portfolio` | `Ticker \| Class \| Units \| Avg Buy \| Current Price (GOOGLEFINANCE) \| Value \| PnL $ \| PnL % \| Share \| Target \| Rebalance Delta $` |
| `NetWorth_History` | Ежедневные снапшоты: `Date \| Cash \| Portfolio \| Debt ₽ \| Debt $ \| Net Worth $` + встроенный график |
| `FX_History` | 180-дневная история курсов GOOGLEFINANCE (EURUSD, USDRUB, USDKGS, EURRUB) — данные для `/fx`: перцентили, RSI, прогноз |

## Финансовая математика

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

## Бесплатные лимиты

| Сервис | Free tier | Нагрузка проекта |
|--------|-----------|------------------|
| Apps Script | триггеры ~90 мин/день, UrlFetch 20 000/день | единицы минут и вызовов |
| Gemini 2.0 Flash (AI Studio) | 15 RPM | 1 запрос на скриншот |
| Telegram Bot API | безлимит | — |
| Cloudflare Pages / GitHub Pages | статика $0 | 1 файл `index.html` |

## Безопасность

Секреты — только в Script Properties Apps Script; в репозитории их нет (`.gitignore`,
`secrets.example.json`, pre-commit хук и gitleaks-правила). Чтение API Mini App защищается
свойством `TMA_READ_TOKEN`, записи — подписью `initData` (HMAC-SHA256). Полный отчёт аудита,
модель угроз и действия при утечке — [SECURITY.md](SECURITY.md). Быстрая проверка живого
проекта — функция `securityAudit()` в Apps Script.

## Установка

Полный пошаговый гайд — [SETUP.md](SETUP.md) (~15 минут, нужны только Google-аккаунт и Telegram).
Таблицу можно не создавать руками: см. «Быстрый путь» через `createSpreadsheet()`.
