/**
 * Config.gs — статический финансовый профиль (baseline из ТЗ).
 *
 * Секреты НЕ здесь: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY,
 * WEBHOOK_SECRET хранятся в Script Properties (Настройки проекта → Свойства сценария).
 *
 * Живые значения (курсы, лимиты, ставка вклада, доли) бот читает из листа
 * FX_and_Settings — их можно менять в таблице без правки кода. Этот файл задаёт
 * начальные значения (сид) и fallback'и.
 */

const CONFIG = {
  APP_NAME: 'Personal Finance Companion',
  VERSION: '1.0.0',

  PROFILE: {
    BASE_CURRENCY: 'USD',   // базовая валюта учёта
    INCOME_CURRENCY: 'EUR', // валюта зарплаты
    LIVING_CURRENCY: 'KGS', // валюта ежедневных трат (MBANK)
    DEBT_CURRENCY: 'RUB',   // валюта ипотек
    BASE_INCOME_USD: 5800.00,
  },

  // Обязательные платежи (жильё и подписки, USD)
  USD_COMMITMENTS: [
    { category: 'Housing',       name: 'Apartment Rent',   amount: 700.00, currency: 'USD', due_day: 1 },
    { category: 'Subscriptions', name: 'AI Subscriptions', amount: 25.00,  currency: 'USD', due_day: 5 },
    { category: 'Subscriptions', name: 'Zoom',             amount: 17.00,  currency: 'USD', due_day: 10 },
    { category: 'Infra',         name: 'VPS & Railway',    amount: 25.00,  currency: 'USD', due_day: 15 },
  ],

  // Обязательные платежи в RUB
  RUB_COMMITMENTS: [
    { category: 'Family',    name: 'Alimony',        amount: 30000.00, currency: 'RUB', due_day: 10 },
    { category: 'Education', name: 'English (Son)',  amount: 18000.00, currency: 'RUB', due_day: 1 },
    { category: 'Education', name: 'English (Self)', amount: 12000.00, currency: 'RUB', due_day: 1 },
  ],

  LIVING: {
    MONTHLY_CAP_RUB: 60000.00,   // лимит еда/хозяйство в месяц
    WEEKLY_BUDGET_RUB: 15000.00, // недельный бюджет
  },

  // Ипотеки. Epoch — дата, на которую верен initial_balance (платежи считаются от неё).
  DEBTS: [
    {
      id: 'SBER',
      name: 'Ипотека Сбербанк',
      initial_balance_rub: 1287312.00,
      rate: 0.1190,
      payment_type: 'monthly',        // аннуитет раз в месяц
      payment_amount_rub: 44282.00,
      due_day: 25,
      maturity: '2029-07-25',         // сохраняется при ЧДП со снижением платежа
      epoch: '2026-10-01',
    },
    {
      id: 'TBANK',
      name: 'Ипотека Т-Банк',
      initial_balance_rub: 1491303.00,
      rate: 0.0859,
      payment_type: 'biweekly',       // раз в две недели, 26 платежей/год
      payment_amount_rub: 17314.00,   // за период; нормализация ×26/12 = 37 513.67 ₽/мес
      due_day: null,
      maturity: null,
      epoch: '2026-10-01',
    },
  ],

  // Целевое распределение инвестиционного пула (DCA)
  INVEST_SPLIT: { broad_market_etf: 0.58, growth_stocks: 0.23, crypto_assets: 0.19 },
  ETF_BENCHMARK: 'VOO',   // broad market
  TECH_TICKERS: ['NVDA', 'TSLA'],
  CRYPTO_TICKERS: ['BTC', 'SOL'],

  // Арбитражный бенчмарк: ставка годового вклада
  ARBITRAGE: { DEPOSIT_RATE_ANNUAL: 0.16 },

  // Каскад дельты бонуса: (доход − база) → 50% досрочка/вклад, 50% инвестиции
  SURPLUS: { BONUS_PREPAY_SHARE: 0.5, BONUS_DCA_SHARE: 0.5 },

  // Еженедельный опрос: воскресенье 20:00 (часовой пояс проекта)
  WEEKLY_ASK: { weekday: 'SUNDAY', hour: 20 },

  // Резервные курсы, если GOOGLEFINANCE ещё не рассчитался
  FX_FALLBACK: { EURUSD: 1.09, USDRUB: 97.0, USDKGS: 86.5 },

  // Таймауты внешних API (мс) — защита от зависаний UrlFetchApp
  HTTP_TIMEOUT_MS: 25000,

  // URL Mini App (опционально; кнопка /app)
  MINI_APP_URL: '',
};

/** Коды листов — единственное место имён табов. */
const SHEETS = {
  FX_SETTINGS: 'FX_and_Settings',
  COMMITMENTS: 'Commitments_Registry',
  MONTHLY: 'Monthly_Cycles',
  WEEKLY: 'Weekly_Expenses',
  DEBTS: 'Debt_Engine',
  PORTFOLIO: 'Portfolio',
  NETWORTH: 'NetWorth_History',
  FX_HISTORY: 'FX_History',
};

/** Ключи Script Properties. */
const PROP = {
  BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  CHAT_ID: 'TELEGRAM_CHAT_ID',
  GEMINI_KEY: 'GEMINI_API_KEY',
  WEBHOOK_SECRET: 'WEBHOOK_SECRET',
  SHEET_ID: 'SHEET_ID', // опционально, если скрипт не привязан к таблице
};
