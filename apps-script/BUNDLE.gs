/**
 * BUNDLE.gs — ЕДИНЫЙ файл всего бэкенда для быстрой установки.
 * Сгенерирован автоматически скриптом scripts/build-bundle.sh —
 * при изменении модулей apps-script/*.gs перегенерируйте бандл.
 *
 * Установка (быстрый путь, SETUP.md): вставьте содержимое этого файла
 * ЦЕЛИКОМ в стандартный пустой Code.gs нового проекта Apps Script.
 * Ничего больше создавать не нужно. Либо бандл, либо отдельные
 * файлы apps-script/*.gs — не одновременно (будут конфликты имён).
 */

// ════════════════════════════════════════════════════════════════════
// Config.gs
// ════════════════════════════════════════════════════════════════════
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

  // Резервный vision-провайдер: Groq (console.groq.com, free tier).
  // Ключ GROQ_API_KEY в Script Properties — опционален; используется,
  // если Gemini недоступен или его ключ не задан. Vision-модели Groq:
  // llama-4-scout (по умолчанию — быстрее и лимиты больше) и
  // llama-4-maverick (переопределяется свойством GROQ_MODEL).
  GROQ: {
    URL: 'https://api.groq.com/openai/v1/chat/completions',
    MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct',
  },

  // Push-алерты по валютам (ежедневная проверка в dailyMaintenance)
  FX_ALERTS: {
    ACTIONS: ['eur_rub', 'eur_kgs'], // какие конвертации мониторить
    HIGH_PERCENTILE: 85,             // окно «выгодно конвертировать»
    LOW_PERCENTILE: 15,              // «курс в нижней зоне — отложите»
    COOLDOWN_DAYS: 7,                // не спамить чаще раза в N дней на пару
  },

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
  DEPOSITS: 'Deposits',
  METRICS: 'Metrics',
  OPS_LOG: 'Ops_Log',
};

/** Ключи Script Properties. */
const PROP = {
  BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  CHAT_ID: 'TELEGRAM_CHAT_ID',
  GEMINI_KEY: 'GEMINI_API_KEY',
  GROQ_KEY: 'GROQ_API_KEY',
  GROQ_MODEL: 'GROQ_MODEL', // опционально: переопределить модель Groq (напр. meta-llama/llama-4-maverick-17b-128e-instruct)
  WEBHOOK_SECRET: 'WEBHOOK_SECRET',
  SHEET_ID: 'SHEET_ID', // опционально, если скрипт не привязан к таблице
};

// ════════════════════════════════════════════════════════════════════
// SheetService.gs
// ════════════════════════════════════════════════════════════════════
/**
 * SheetService.gs — слой данных Google Sheets + утилиты.
 * Единственная точка доступа к таблице для всех движков.
 */

/** Таблица: привязанная (container-bound) или по SHEET_ID из Script Properties. */
function ss_() {
  const byId = getProp_(PROP.SHEET_ID, '');
  if (byId) return SpreadsheetApp.openById(byId);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Скрипт не привязан к таблице и SHEET_ID не задан');
  return active;
}

function sheet_(code) {
  const name = SHEETS[code];
  let sh = ss_().getSheetByName(name);
  if (!sh) sh = ss_().insertSheet(name);
  return sh;
}

/** Все данные листа начиная со строки startRow (1-based), без заголовков. */
function readRange_(code, startRow) {
  const sh = sheet_(code);
  const last = sh.getLastRow();
  if (last < startRow) return [];
  return sh.getRange(startRow, 1, last - startRow + 1, Math.max(1, sh.getLastColumn())).getValues();
}

function appendRow_(code, values) {
  sheet_(code).appendRow(values);
}

function clearSheet_(code) {
  const sh = sheet_(code);
  sh.clear();
  sh.getRange('A1:Z1000').clearNote();
}

// ─────────────────────────── FX ───────────────────────────

/** Живые курсы из FX_and_Settings (B2 EURUSD, B3 USDRUB, B4 USDKGS) с fallback.
 *  Флаг FALLBACK_USED = true, если хоть один курс не рассчитан (#N/A/пусто):
 *  значит GOOGLEFINANCE недоступен и все конвертации идут на резервные значения. */
function getFx_() {
  const sh = sheet_(SHEETS.FX_SETTINGS);
  const v = sh.getRange('B2:B4').getValues();
  let fbUsed = false;
  const num = function (x, fb) {
    if (typeof x === 'number' && isFinite(x) && x > 0.1) return x;
    fbUsed = true;
    return fb;
  };
  const out = {
    EURUSD: num(v[0][0], CONFIG.FX_FALLBACK.EURUSD),
    USDRUB: num(v[1][0], CONFIG.FX_FALLBACK.USDRUB),
    USDKGS: num(v[2][0], CONFIG.FX_FALLBACK.USDKGS),
  };
  out.FALLBACK_USED = fbUsed;
  return out;
}

/** Конвертация между EUR/USD/RUB/KGS через базу USD. */
function convert_(amount, from, to, fx) {
  const toUsd = {
    USD: (a) => a,
    EUR: (a) => a * fx.EURUSD,
    RUB: (a) => a / fx.USDRUB,
    KGS: (a) => a / fx.USDKGS,
  };
  const fromUsd = {
    USD: (a) => a,
    EUR: (a) => a / fx.EURUSD,
    RUB: (a) => a * fx.USDRUB,
    KGS: (a) => a * fx.USDKGS,
  };
  from = (from || 'USD').toUpperCase();
  to = (to || 'USD').toUpperCase();
  if (!toUsd[from] || !fromUsd[to]) throw new Error('Неизвестная валюта: ' + from + '/' + to);
  return fromUsd[to](toUsd[from](amount));
}

// ─────────────────────────── Settings ───────────────────────────

/** Таблица конфигурации на листе FX_and_Settings, начиная со строки 8 (A=key, B=value). */
function getSettings_() {
  const out = {};
  const values = readRange_(SHEETS.FX_SETTINGS, 8);
  values.forEach((r) => {
    if (r[0]) out[String(r[0]).trim()] = r[1];
  });
  return out;
}

function getSetting_(key, fallback) {
  const v = getSettings_()[key];
  return v === undefined || v === '' || v === null ? fallback : v;
}

function getSettingNum_(key, fallback) {
  const v = getSetting_(key, null);
  if (v === null) return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function setSetting_(key, value) {
  const sh = sheet_(SHEETS.FX_SETTINGS);
  const last = Math.max(sh.getLastRow(), 8);
  const keys = sh.getRange(8, 1, last - 7, 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) {
      sh.getRange(8 + i, 2).setValue(value);
      return;
    }
  }
  sh.getRange(last + 1, 1, 1, 2).setValues([[key, value]]);
}

// ─────────────────────────── Properties ───────────────────────────

function getProp_(key, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null || v === '' ? fallback : v;
}

/** Диалоговое состояние пользователя (например, ждём недельные траты). */
function getBotState_() {
  try {
    return JSON.parse(PropertiesService.getUserProperties().getProperty('BOT_STATE') || '{}');
  } catch (e) {
    return {};
  }
}

function setBotState_(state) {
  PropertiesService.getUserProperties().setProperty('BOT_STATE', JSON.stringify(state || {}));
}

// ─────────────────────────── Dates ───────────────────────────

function tz_() {
  return ss_().getSpreadsheetTimeZone() || 'Asia/Bishkek';
}

function fmtISO_(d) {
  return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}

function fmtMonthKey_(d) {
  return Utilities.formatDate(d, tz_(), 'yyyy-MM');
}

function nowTz_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm');
}

/** Понедельник недели, содержащей d. */
function mondayOf_(d) {
  const dt = new Date(d.getTime());
  const shift = (dt.getDay() + 6) % 7; // Пн=0
  dt.setDate(dt.getDate() - shift);
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/** Ключ недельного цикла: ISO-дата воскресенья, открывшего цикл.
 *  Опрос уходит в вс 20:00; ответы с вс по сб (включая пн-надж)
 *  относятся к этому воскресенью — так ключи вопроса и ответа совпадают. */
function weekKey_(d) {
  const dt = new Date((d || new Date()).getTime());
  dt.setDate(dt.getDate() - dt.getDay()); // откат к воскресенью (getDay: вс=0)
  return fmtISO_(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()));
}

/** ISO-номер недели. */
function isoWeek_(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
}

/** Сколько дней осталось до конца месяца (включая сегодняшний). */
function daysLeftInMonth_() {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return daysInMonth - now.getDate() + 1;
}

// ─────────────────────────── Format & parse ───────────────────────────

function fmtMoney_(n, cur) {
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(Number(n) || 0);
  const fixed = (abs >= 1000 ? abs.toFixed(0) : abs.toFixed(2)).replace('.', ',');
  const grouped = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sym = { USD: '$', EUR: '€', RUB: '₽', KGS: 'с' }[(cur || 'USD').toUpperCase()] || '';
  return sign + grouped + (sym ? ' ' + sym : '');
}

function fmtPct_(x, digits) {
  return (100 * (Number(x) || 0)).toFixed(digits === undefined ? 1 : digits) + '%';
}

/** "5 000,50" | "5000.5" | "5000" → число; null если не число. */
function parseAmount_(text) {
  const s = String(text).replace(/\s|\u00A0/g, '').replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** Определяет валюту в тексте: EUR/€, RUB/₽/руб, KGS/с/сом, USD/$. */
function detectCurrency_(text, fallback) {
  const s = (text || '').toLowerCase();
  if (/(eur|€|евро)/.test(s)) return 'EUR';
  if (/(rub|₽|руб)/.test(s)) return 'RUB';
  if (/(kgs|сом|кгс)/.test(s)) return 'KGS';
  if (/(usd|\$|долл)/.test(s)) return 'USD';
  return fallback || 'RUB';
}

/**
 * Защита от formula-injection: пользовательский текст, попадающий в ячейки,
 * не должен начинаться с = + - @ (иначе Sheets выполнит его как формулу).
 */
function safeCellText_(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** Журнал операций/ошибок в таблице (Ops_Log): видно историю без консоли GAS. */
function logOps_(level, source, message) {
  try {
    sheet_(SHEETS.OPS_LOG).appendRow([
      new Date(), level, source, safeCellText_(String(message).slice(0, 300)),
    ]);
  } catch (e) {
    console.warn('logOps: ' + e.message); // журнал не должен ломать вызывающего
  }
}

// ─────────────────────────── Lock ───────────────────────────

/** Сериализация конкурентных записей (webhook + триггеры). */
function runWithLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Сервер занят, повторите через минуту');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ════════════════════════════════════════════════════════════════════
// TelegramService.gs
// ════════════════════════════════════════════════════════════════════
/**
 * TelegramService.gs — обёртка Telegram Bot API.
 * Сообщения (HTML), inline-клавиатуры, callback-ответы, скачивание файлов.
 */

const TG_API = 'https://api.telegram.org';

function tgToken_() {
  const t = getProp_(PROP.BOT_TOKEN, '');
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  return t;
}

function tgCall_(method, payload) {
  const resp = UrlFetchApp.fetch(TG_API + '/bot' + tgToken_() + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
    followRedirects: true,
    deadline: CONFIG.HTTP_TIMEOUT_MS / 1000,
  });
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error('Telegram ' + method + ': невалидный ответ (' + code + '): ' + body.slice(0, 200));
  }
  if (!json.ok) throw new Error('Telegram ' + method + ': ' + (json.description || code));
  return json.result;
}

function sendMessage_(chatId, html, opts) {
  opts = opts || {};
  const payload = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (opts.buttons && opts.buttons.length) payload.reply_markup = { inline_keyboard: [opts.buttons] };
  else if (opts.menu) payload.reply_markup = { keyboard: opts.menu, resize_keyboard: true, is_persistent: true };
  return tgCall_('sendMessage', payload);
}

function answerCallback_(callbackQueryId, text) {
  try {
    tgCall_('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' });
  } catch (e) {
    console.warn('answerCallback: ' + e.message);
  }
}

/** Скачивает файл из Telegram CDN → { base64, mime } для Gemini. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // лимит против DoS и сжигания квоты Gemini

function downloadTelegramFile_(fileId) {
  const info = tgCall_('getFile', { file_id: fileId });
  if (!info.file_path) throw new Error('Telegram не вернул file_path');
  if (info.file_size && info.file_size > MAX_IMAGE_BYTES) {
    throw new Error('Файл слишком большой (>8 МБ). Пришлите скриншот поменьше.');
  }
  const url = TG_API + '/file/bot' + tgToken_() + '/' + info.file_path;
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, deadline: CONFIG.HTTP_TIMEOUT_MS / 1000 });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Не удалось скачать файл из Telegram (HTTP ' + resp.getResponseCode() + ')');
  }
  const blob = resp.getBlob();
  const mime = blob.getContentType() || 'image/jpeg';
  if (!/^image\//.test(mime)) {
    throw new Error('Это не изображение (' + mime + '). Пришлите, пожалуйста, скриншот картинкой.');
  }
  const bytes = blob.getBytes();
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Изображение слишком большое (>8 МБ).');
  }
  return { base64: Utilities.base64Encode(bytes), mime: mime };
}

function escHtml_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** URL таблицы — для кнопки Edit Commitments и ссылок. */
function sheetUrl_() {
  return ss_().getUrl();
}

/** Whitelist: бот отвечает только владельцу (или подсказывает chat_id, если он не задан). */
function authorizeChat_(chatId) {
  const owner = getProp_(PROP.CHAT_ID, '');
  if (!owner) {
    sendMessage_(
      chatId,
      '🔐 Chat ID этого чата: <code>' + chatId + '</code>\n\n' +
        'Добавьте его в Script Properties как <b>TELEGRAM_CHAT_ID</b> и повторите команду.'
    );
    return false;
  }
  return String(chatId) === String(owner);
}

// ════════════════════════════════════════════════════════════════════
// Setup_Sheets.gs
// ════════════════════════════════════════════════════════════════════
/**
 * Setup_Sheets.gs — self-contained инициализация таблицы.
 * Создаёт листы по схеме ТЗ, формулы GOOGLEFINANCE, ЧДП-калькулятор,
 * Arbitrage Monitor, сиды портфеля и график Net Worth. Идемпотентно:
 * уже заполненные листы не перезаписываются.
 *
 * Запуск: выбрать функцию setup() → Выполнить (один раз).
 */

function setup() {
  // WEBHOOK_SECRET и TMA_READ_TOKEN генерируются автоматически при первом запуске —
  // вручную в Script Properties добавлять нужно только токен бота, chat_id и ключ Gemini.
  ensureSecret_(PROP.WEBHOOK_SECRET, 32);
  ensureSecret_(PROP.TMA_READ_TOKEN, 24);

  const built = runWithLock_(function () {
    return {
      fx: buildOnce_(SHEETS.FX_SETTINGS, buildFxSettings_),
      commitments: buildOnce_(SHEETS.COMMITMENTS, buildCommitments_),
      monthly: buildOnce_(SHEETS.MONTHLY, buildMonthlyCycles_),
      weekly: buildOnce_(SHEETS.WEEKLY, buildWeeklyExpenses_),
      debts: buildOnce_(SHEETS.DEBTS, buildDebtEngine_),
      portfolio: buildOnce_(SHEETS.PORTFOLIO, buildPortfolio_),
      networth: buildOnce_(SHEETS.NETWORTH, buildNetWorth_),
      fxhistory: buildOnce_(SHEETS.FX_HISTORY, buildFxHistory_),
      deposits: buildOnce_(SHEETS.DEPOSITS, buildDeposits_),
      metrics: buildOnce_(SHEETS.METRICS, buildMetrics_),
      opslog: buildOnce_(SHEETS.OPS_LOG, buildOpsLog_),
      networthMigrated: migrateNetWorthSheet_(),
      triggers: installTriggers_(),
    };
  });
  let msg = 'Готово: ' + JSON.stringify(built) +
    '\nЛисты: ' + ss_().getSheets().map(function (s) { return s.getName(); }).join(', ');
  // Триггеры срабатывают по часовому поясу ПРОЕКТА — расхождение с таблицей ломает час опроса
  try {
    const stz = Session.getScriptTimeZone();
    const shz = ss_().getSpreadsheetTimeZone();
    if (stz && shz && stz !== shz) {
      msg += '\n⚠️ Часовой пояс проекта (' + stz + ') отличается от таблицы (' + shz +
        '). Установите пояс проекта: ⚙ Настройки проекта → Часовой пояс.';
    }
  } catch (e) { /* non-critical */ }
  console.log(msg);
  return msg;
}

/** Генерирует секрет, если его ещё нет в Script Properties. */
function ensureSecret_(key, length) {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty(key)) {
    let v = Utilities.getUuid().replace(/-/g, '');
    while (v.length < (length || 32)) v += Utilities.getUuid().replace(/-/g, '');
    p.setProperty(key, v.slice(0, length || 32));
  }
}

/**
 * Автоматическое создание таблицы Google Sheets (standalone-скрипт, без ручной
 * привязки): создаёт файл в Google Drive, запоминает SHEET_ID в Script Properties
 * и сразу строит все листы через setup(). Запускать один раз из редактора.
 */
function createSpreadsheet(name) {
  const ss = SpreadsheetApp.create(name || 'Budget Companion');
  PropertiesService.getScriptProperties().setProperty(PROP.SHEET_ID, ss.getId());
  setup();
  // удаляем служебный пустой лист, созданный Google по умолчанию
  ['Лист1', 'Sheet1'].forEach(function (def) {
    const sh = ss.getSheetByName(def);
    if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  const msg = '✅ Таблица создана автоматически:\n' + ss.getUrl() + '\nSHEET_ID сохранён в Script Properties.';
  console.log(msg);
  return msg;
}

/** Вызывает builder только если лист пуст. */
function buildOnce_(code, builder) {
  const sh = sheet_(code);
  if (sh.getLastRow() > 0 || sh.getLastColumn() > 0) return 'exists';
  builder(sh);
  return 'created';
}

function boldHeader_(sh, cols) {
  sh.getRange(1, 1, 1, cols).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  sh.setFrozenRows(1);
}

// ─────────────────────── FX_and_Settings ───────────────────────

function buildFxSettings_(sh) {
  sh.getRange('A1:B1').setValues([['Rate', 'Value']]).setFontWeight('bold');
  sh.getRange('A2:B5').setValues([
    ['EUR/USD', '=GOOGLEFINANCE("CURRENCY:EURUSD")'],
    ['USD/RUB', '=GOOGLEFINANCE("CURRENCY:USDRUB")'],
    ['USD/KGS', '=GOOGLEFINANCE("CURRENCY:USDKGS")'],
    ['EUR/RUB', '=B2*B3'],
  ]);
  sh.getRange('B2:B5').setNumberFormat('0.0000');

  sh.getRange('A7:B7').setValues([['Key', 'Value']]).setFontWeight('bold');
  sh.getRange('A8:B19').setValues([
    ['BASE_INCOME_USD', CONFIG.PROFILE.BASE_INCOME_USD],
    ['INCOME_CURRENCY', CONFIG.PROFILE.INCOME_CURRENCY],
    ['LIVING_CURRENCY', CONFIG.PROFILE.LIVING_CURRENCY],
    ['WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB],
    ['MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB],
    ['DEPOSIT_RATE_ANNUAL', CONFIG.ARBITRAGE.DEPOSIT_RATE_ANNUAL],
    ['CASH_USD', 0],
    ['TARGET_ETF', CONFIG.INVEST_SPLIT.broad_market_etf],
    ['TARGET_STOCKS', CONFIG.INVEST_SPLIT.growth_stocks],
    ['TARGET_CRYPTO', CONFIG.INVEST_SPLIT.crypto_assets],
    ['BONUS_PREPAY_SHARE', CONFIG.SURPLUS.BONUS_PREPAY_SHARE],
    ['BONUS_DCA_SHARE', CONFIG.SURPLUS.BONUS_DCA_SHARE],
    ['MINI_APP_URL', CONFIG.MINI_APP_URL],
  ]);
  sh.getRange('B8').setNumberFormat('#,##0.00');
  sh.getRange('B10:B12').setNumberFormat('#,##0.00');
  sh.getRange('B13').setNumberFormat('0.00%');
  sh.getRange('B14:B19').setNumberFormat('0.00');
  sh.setColumnWidth(1, 190);
  sh.setColumnWidth(2, 110);
}

// ─────────────────────── Commitments_Registry ───────────────────────

function buildCommitments_(sh) {
  const headers = ['Category', 'Item Name', 'Base Amount', 'Currency', 'USD Equivalent', 'Due Day', 'Active'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);

  const usd = CONFIG.USD_COMMITMENTS;
  const rub = CONFIG.RUB_COMMITMENTS;
  const rows = [];
  usd.forEach(function (c) { rows.push([c.category, c.name, c.amount, 'USD', null, c.due_day, true]); });
  rub.forEach(function (c) { rows.push([c.category, c.name, c.amount, 'RUB', null, c.due_day, true]); });
  // Строки ипотек динамически связаны с Debt_Engine (Т-Банк нормализуется ×26/12)
  rows.push(['Mortgages', 'Ипотека Сбербанк (аннуитет)', null, 'RUB', null, 25, true]);
  rows.push(['Mortgages', 'Ипотека Т-Банк (раз в 2 недели ×26/12)', null, 'RUB', null, null, true]);
  sh.getRange(2, 1, rows.length, 7).setValues(rows);

  const firstRow = 2;
  const lastRow = firstRow + rows.length - 1; // включительно
  for (let r = firstRow; r <= lastRow; r++) {
    const cur = sh.getRange(r, 4).getValue();
    let usdFormula;
    if (cur === 'USD') usdFormula = '=C' + r;
    else if (cur === 'EUR') usdFormula = '=C' + r + '*FX_and_Settings!$B$2';
    else if (cur === 'RUB') usdFormula = '=C' + r + '/FX_and_Settings!$B$3';
    else usdFormula = '=C' + r + '/FX_and_Settings!$B$4';
    sh.getRange(r, 5).setFormula(usdFormula).setNumberFormat('#,##0.00');
    sh.getRange(r, 3).setNumberFormat('#,##0.00');
  }
  const sberRow = lastRow - 1; // платёж Сбербанка (аннуитет)
  const tbankRow = lastRow;    // Т-Банк, нормализация раз-в-2-недели ×26/12
  sh.getRange(sberRow, 3).setFormula('=Debt_Engine!$D$2');
  sh.getRange(tbankRow, 3).setFormula('=Debt_Engine!$D$3*26/12');
  sh.setColumnWidth(2, 260);
}

// ─────────────────────── Monthly_Cycles ───────────────────────

function buildMonthlyCycles_(sh) {
  const headers = [
    'Month (YYYY-MM)', 'Income Received', 'Currency', 'Income in USD',
    'Total Mandatory (USD)', 'Free Surplus (USD)',
    'To Debt Prepayment (USD)', 'To ETF (USD)', 'To Stocks (USD)', 'To Crypto (USD)', 'Status',
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('B2:B1000').setNumberFormat('#,##0.00');
  sh.getRange('D2:J1000').setNumberFormat('#,##0.00');
  sh.setColumnWidth(1, 130);
}

// ─────────────────────── Weekly_Expenses ───────────────────────

function buildWeeklyExpenses_(sh) {
  const headers = [
    'Date', 'Week #', 'Total Spent (KGS)', 'In RUB', 'In USD',
    'Top Category 1', 'Top Category 2', 'Weekly Budget Target ₽', 'Variance / Delta ₽', 'Receipt File ID / Note',
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('C2:E1000').setNumberFormat('#,##0.00');
  sh.getRange('H2:I1000').setNumberFormat('#,##0.00');
  sh.setColumnWidth(10, 220);
}

// ─────────────────────── Debt_Engine ───────────────────────

function buildDebtEngine_(sh) {
  // Блок 1: живое состояние ипотек
  const stateHeaders = ['Id', 'Name', 'Balance ₽', 'Payment ₽', 'Rate', 'Type',
    'Payments Made', 'Initial Balance ₽', 'Epoch', 'Maturity', 'Last Update'];
  sh.getRange(1, 1, 1, stateHeaders.length).setValues([stateHeaders]);
  sh.getRange(1, 1, 1, stateHeaders.length).setFontWeight('bold');

  CONFIG.DEBTS.forEach(function (d, i) {
    sh.getRange(2 + i, 1, 1, stateHeaders.length).setValues([[
      d.id, d.name, d.initial_balance_rub, d.payment_amount_rub, d.rate,
      d.payment_type, 0, d.initial_balance_rub, d.epoch, d.maturity || '', fmtISO_(new Date()),
    ]]);
  });
  sh.getRange('C2:D3').setNumberFormat('#,##0.00');
  sh.getRange('E2:E3').setNumberFormat('0.00%');
  DebtEngine.refreshDerivedState_(); // n (остаток периодов) и Live-пересчёт

  // Блок 2: ЧДП-калькулятор Сбербанка — формула аннуитета прямо в листе
  sh.getRange('A5').setValue('ЧДП-калькулятор (Сбербанк)').setFontWeight('bold');
  sh.getRange('A6:B10').setValues([
    ['Досрочный платёж L, ₽', 0],
    ['Осталось периодов n (движок)', 34.5],
    ['Новый платёж при фикс. сроке, ₽/мес', null],
    ['Экономия платежа, ₽/мес', null],
    ['Новый срок при фикс. платеже, мес', null],
  ]);
  sh.getRange('B6').setBackground('#fde68a'); // жёлтая ячейка ввода
  sh.getRange('B8').setFormula(
    '=IF($B$6<=0,$D$2,($C$2-$B$6)*($E$2/12)*POWER(1+$E$2/12,$B$7)/(POWER(1+$E$2/12,$B$7)-1))'
  ).setNumberFormat('#,##0.00');
  sh.getRange('B9').setFormula('=$D$2-$B$8').setNumberFormat('#,##0.00');
  sh.getRange('B10').setFormula(
    '=IF($B$6<=0,$B$7,-LN(1-($C$2-$B$6)*($E$2/12)/$D$2)/LN(1+$E$2/12))'
  ).setNumberFormat('0.0');

  // Блок 3: Arbitrage Monitor — вклад против досрочки Сбербанка
  sh.getRange('A12').setValue('Arbitrage Monitor').setFontWeight('bold');
  sh.getRange('A13:B16').setValues([
    ['Ставка вклада (годовых)', '=FX_and_Settings!$B$13'],
    ['Лучшая ставка ипотеки', '=MAX($E$2:$E$3)'],
    ['Годовой перевес вклада на L, ₽', null],
    ['Вердикт', null],
  ]);
  sh.getRange('B13:B14').setNumberFormat('0.00%');
  sh.getRange('B15').setFormula('=IF($B$13>$B$14,$B$6*($B$13-$B$14),0)').setNumberFormat('#,##0.00');
  sh.getRange('B16').setFormula(
    '=IF($B$13>$B$14,' +
    '"Deposit arbitrage active: "&TEXT($B$13,"0.0%")&" deposit yields +"&TEXT($B$15,"#,##0")&" ₽/yr more than paying Sberbank early.",' +
    '"Досрочное погашение выгоднее вклада.")'
  );

  // Блок 4: журнал событий (платежи/ЧДП) — источник roll-forward
  sh.getRange('A18').setValue('Event Log (платежи / ЧДП)').setFontWeight('bold');
  const logHeaders = ['Date', 'Debt', 'Event', 'Amount ₽', 'Balance After ₽', 'Payment After ₽', 'Source'];
  sh.getRange(19, 1, 1, logHeaders.length).setValues([logHeaders]).setFontWeight('bold');
  sh.getRange('D19:F1000').setNumberFormat('#,##0.00');
  sh.setColumnWidth(2, 220);
}

// ─────────────────────── Portfolio ───────────────────────

function buildPortfolio_(sh) {
  const headers = ['Ticker', 'Asset Class', 'Units', 'Avg Buy Price ($)', 'Current Price ($)',
    'Market Value ($)', 'PnL ($)', 'PnL (%)', 'Current Share (%)', 'Target Share (%)', 'Rebalance Delta ($)'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);

  // Сид: целевые доли в сумме = 100%. Units/Avg Buy заполняете своими данными.
  const rows = [
    ['VOO', 'broad_market_etf', 0, 0, CONFIG.INVEST_SPLIT.broad_market_etf],
    ['NVDA', 'growth_stocks', 0, 0, 0.115],
    ['TSLA', 'growth_stocks', 0, 0, 0.115],
    ['BTC', 'crypto_assets', 0, 0, 0.12],
    ['SOL', 'crypto_assets', 0, 0, 0.07],
  ];
  rows.forEach(function (r, i) {
    const row = i + 2;
    sh.getRange(row, 1, 1, 4).setValues([r.slice(0, 4)]);
    sh.getRange(row, 10).setValue(r[4]);
    // Цена: акции/ETF — GOOGLEFINANCE(ticker,"price"); крипта — CURRENCY:<TICKER>USD
    const price = r[1] === 'crypto_assets'
      ? '=IFERROR(GOOGLEFINANCE("CURRENCY:"&A' + row + '&"USD"),0)'
      : '=IFERROR(GOOGLEFINANCE(A' + row + ',"price"),0)';
    sh.getRange(row, 5).setFormula(price);
    sh.getRange(row, 6).setFormula('=C' + row + '*E' + row);
    sh.getRange(row, 7).setFormula('=F' + row + '-C' + row + '*D' + row);
    sh.getRange(row, 8).setFormula('=IFERROR(G' + row + '/(C' + row + '*D' + row + '),0)').setNumberFormat('0.00%');
    sh.getRange(row, 9).setFormula('=IFERROR(F' + row + '/SUM($F$2:$F$100),0)').setNumberFormat('0.00%');
    sh.getRange(row, 10).setNumberFormat('0.00%');
    sh.getRange(row, 11).setFormula('=J' + row + '*SUM($F$2:$F$100)-F' + row);
  });
  sh.getRange('C2:G100').setNumberFormat('#,##0.00');
  sh.getRange('K2:K100').setNumberFormat('#,##0.00');
}

// ─────────────────────── NetWorth_History ───────────────────────

function buildNetWorth_(sh) {
  const headers = ['Date', 'Cash USD', 'Deposits USD', 'Portfolio USD', 'Debt ₽', 'Debt USD', 'Net Worth USD'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('B2:G1000').setNumberFormat('#,##0.00');

  // Встроенный график Net Worth (BI прямо в таблице)
  const chart = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange('A2:A1000'))
    .addRange(sh.getRange('G2:G1000'))
    .setOption('title', 'Net Worth, USD')
    .setOption('curveType', 'function')
    .setOption('legend', { position: 'none' })
    .setPosition(1, 9, 0, 0)
    .build();
  sh.insertChart(chart);
}

/** Миграция старых 6-колоночных таблиц NetWorth → 7 колонок (Deposits USD). */
function migrateNetWorthSheet_() {
  const sh = sheet_(SHEETS.NETWORTH);
  if (sh.getLastColumn() !== 6) return false;
  sh.insertColumnAfter(3); // после Cash USD
  sh.getRange(1, 4).setValue('Deposits USD');
  sh.getRange('B2:G1000').setNumberFormat('#,##0.00');
  return true;
}

// ─────────────────────── FX_History (180 дней для анализа/прогноза) ───────────────────────

/** Блоки истории GOOGLEFINANCE: пара → якорь формулы и колонки (Date, Close). */
const FX_HISTORY_BLOCKS = [
  { pair: 'EURUSD', anchor: 'A3', col: 1 },
  { pair: 'USDRUB', anchor: 'D3', col: 4 },
  { pair: 'USDKGS', anchor: 'G3', col: 7 },
  { pair: 'EURRUB', anchor: 'J3', col: 10 },
];

function buildFxHistory_(sh) {
  sh.getRange('A1:K1').setValues([['EUR/USD', '', '', 'USD/RUB', '', '', 'USD/KGS', '', '', 'EUR/RUB', '']])
    .setFontWeight('bold');
  sh.getRange('A2:K2').setValues([['Дата', 'Курс', '', 'Дата', 'Курс', '', 'Дата', 'Курс', '', 'Дата', 'Курс']])
    .setFontWeight('bold');
  FX_HISTORY_BLOCKS.forEach(function (b) {
    sh.getRange(b.anchor).setFormula(
      '=GOOGLEFINANCE("CURRENCY:' + b.pair + '","price",TODAY()-180,TODAY(),"DAILY")'
    );
  });
  sh.setFrozenRows(2);
}

// ─────────────────────── Deposits (вклады как актив) ───────────────────────

function buildDeposits_(sh) {
  const headers = ['Date Opened', 'Name', 'Amount', 'Currency', 'Rate', 'Maturity', 'Active'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('C2:C100').setNumberFormat('#,##0.00');
  sh.getRange('E2:E100').setNumberFormat('0.00%');
  sh.setColumnWidth(2, 220);
}

// ─────────────────────── Metrics (продуктовые метрики) ───────────────────────

function buildMetrics_(sh) {
  const headers = ['Date', 'Key', 'Value'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('A2:A10000').setNumberFormat('yyyy-mm-dd');
  sh.setColumnWidth(2, 200);
}

// ─────────────────────── Ops_Log (журнал операций и ошибок) ───────────────────────

function buildOpsLog_(sh) {
  const headers = ['Date', 'Level', 'Source', 'Message'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  boldHeader_(sh, headers.length);
  sh.getRange('A2:A20000').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.setColumnWidth(4, 420);
}

// ─────────────────────── Webhook ───────────────────────

/** Командное меню бота (автокомплит «/» в Telegram) — ставится setupBotProfile(). */
const BOT_COMMANDS = [
  { command: 'plan', description: 'Водопад месяца: доход → обязательства → каскад' },
  { command: 'income', description: 'Записать доход месяца, напр. 6200 eur' },
  { command: 'spent', description: 'Быстрая трата в недельный учёт' },
  { command: 'week', description: 'Бюджет недели/месяца и дневной лимит' },
  { command: 'fx', description: 'Валюты: прогноз и когда выгодно менять' },
  { command: 'prepay', description: 'ЧДП ипотеки, напр. sber 50000' },
  { command: 'balance', description: 'Сверка остатка ипотеки с банком' },
  { command: 'invest', description: 'Портфель и дрейф от целей 58/23/19' },
  { command: 'cash', description: 'Остаток кэша в валюте, напр. 12000 kgs' },
  { command: 'status', description: 'Net Worth: кэш + вклады + портфель − долг' },
  { command: 'anomalies', description: 'Проверка невозможных цифр' },
  { command: 'metrics', description: 'Метрики и savings rate' },
  { command: 'alias', description: 'Исправить категорию Vision' },
  { command: 'sync', description: 'Пересчёт долгов + снапшот Net Worth' },
  { command: 'guide', description: 'Гид установки: что готово и что дальше' },
  { command: 'help', description: 'Все команды' },
];

/**
 * Настройка профиля бота через Bot API (вместо ручного ввода в @BotFather):
 * командное меню, описание пустого чата и «О боте». Запускать один раз
 * после деплоя (картинка и кнопка Mini App — вручную, см. docs/BOT_SETUP.md).
 */
function setupBotProfile() {
  tgCall_('setMyCommands', { commands: BOT_COMMANDS });
  tgCall_('setMyDescription', {
    description: 'Личный финансовый движок: план месяца и каскад профицита, две ипотеки с ЧДП-калькулятором, траты по скриншоту MBANK (Gemini), валютные сигналы EUR→₽/сом/$, Net Worth и аномалии.\n\nНачните с /start — или просто пришлите скриншот.',
  });
  tgCall_('setMyShortDescription', {
    description: 'Личный финанс-компаньон: план → каскад → контроль. Google Sheets + Gemini, $0/мес',
  });
  logOps_('INFO', 'setup', 'bot profile updated (commands, description, about)');
  return '✅ Командное меню, описание пустого чата и «О боте» обновлены. Осталось вручную: иконка и кнопка Mini App (docs/BOT_SETUP.md).';
}

/** Привязка Telegram Webhook к Web App. Запускать после деплоя. */
function setupWebhook(url) {
  ensureSecret_(PROP.WEBHOOK_SECRET, 32); // страховка, если setup() ещё не выполнялся
  url = url || ScriptApp.getService().getUrl();
  if (!url || url.indexOf('script.google.com') === -1) {
    throw new Error('Разверните Web App и вызовите: setupWebhook("https://script.google.com/macros/s/.../exec")');
  }
  const secret = getProp_(PROP.WEBHOOK_SECRET, '');
  const full = url + (url.indexOf('?') > -1 ? '&' : '?') + 'secret=' + encodeURIComponent(secret);
  const res = tgCall_('setWebhook', {
    url: full,
    secret_token: secret,
    allowed_updates: JSON.stringify(['message', 'callback_query']),
    drop_pending_updates: true,
  });
  const me = tgCall_('getMe', {});
  console.log('Webhook: ' + JSON.stringify(res) + ' | bot @' + me.username);
  return 'Webhook привязан к @' + me.username;
}

/**
 * Резервная копия всей таблицы в Google Drive (бизнес-непрерывность):
 * полная копия с формулами и графиками. Ручной запуск — backupNow();
 * автоматически 1-го числа из monthlyPlanLog. Копии старше ~6 месяцев
 * удаляются в корзину, чтобы Drive не зарастал.
 */
function backupNow() {
  const src = ss_();
  const name = 'Backup ' + src.getName() + ' ' + fmtISO_(new Date());
  DriveApp.getFileById(src.getId()).makeCopy(name);
  logOps_('INFO', 'backup', name);

  // ротация: бэкапы старше ~6 месяцев — в корзину
  try {
    const cutoff = new Date(Date.now() - 190 * 86400000);
    const all = DriveApp.searchFiles(
      'title contains "Backup ' + src.getName() + '" and mimeType = "' + MimeType.GOOGLE_SHEETS + '"');
    while (all.hasNext()) {
      const f = all.next();
      if (f.getDateCreated() < cutoff) f.setTrashed(true);
    }
  } catch (e) { console.warn('backup rotation: ' + e.message); }
  return name;
}

/** Готовые ссылки доступа: API + Mini App с уже подставленным токеном чтения. */
function getAccessInfo() {
  const base = String(CONFIG.MINI_APP_URL || getSetting_('MINI_APP_URL', ''));
  const rt = getProp_('TMA_READ_TOKEN', '');
  const api = ScriptApp.getService().getUrl() || '(сначала разверните Web App)';
  const mini = base
    ? base + (base.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(rt)
    : '(заполните MINI_APP_URL в листе FX_and_Settings после хостинга Mini App)';
  const msg = '🔗 <b>Доступ</b>\nAPI: <code>' + escHtml_(api) + '</code>\nMini App: <code>' + escHtml_(mini) + '</code>';
  console.log(msg.replace(/<[^>]+>/g, ''));
  const chatId = getProp_(PROP.CHAT_ID, '');
  if (chatId) { try { sendMessage_(chatId, msg); } catch (e) { /* уже в логе */ } }
  return msg;
}

/** Диагностика: куда смотрит webhook и были ли ошибки доставки (секрет маскируется). */
function debugWebhook() {
  const info = tgCall_('getWebhookInfo', {});
  if (info && info.url) info.url = String(info.url).replace(/secret=[^&]+/i, 'secret=***');
  console.log(JSON.stringify(info, null, 2));
  return JSON.stringify(info);
}

// ════════════════════════════════════════════════════════════════════
// Code.gs
// ════════════════════════════════════════════════════════════════════
/**
 * Code.gs — точка входа Web App: роутер Telegram Webhook + команды бота.
 *
 * doPost(e):  1) апдейты Telegram (update_id в теле)  2) POST Mini App (TmaApi)
 * doGet(e):   REST Mini App (TmaApi) — см. TmaApi.gs
 */

function doPost(e) {
  try {
    let body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (parseErr) { /* ignore */ }

    if (body.update_id !== undefined) {
      const expected = getProp_(PROP.WEBHOOK_SECRET, '');
      const got = (e && e.parameter && e.parameter.secret) || '';
      if (expected && got !== expected) throw new Error('Неверный webhook secret');
      handleUpdate_(body);
      return ContentService.createTextOutput('ok');
    }
    return tmaHandlePost_(e, body);
  } catch (err) {
    console.error('doPost: ' + err.message + '\n' + (err.stack || ''));
    notifyOwnerError_(err);
    return ContentService.createTextOutput('ok'); // Telegram требует 200, иначе ретраи
  }
}

/** Ошибка в работе — одно сообщение владельцу (не чаще раза в 10 минут) + Ops_Log. */
function notifyOwnerError_(err) {
  try {
    logOps_('ERROR', 'runtime', String(err.message || err).slice(0, 300));
    const cache = CacheService.getScriptCache();
    if (cache.get('lastErrNotify')) return;
    cache.put('lastErrNotify', '1', 600);
    const chatId = getProp_(PROP.CHAT_ID, '');
    if (chatId) {
      sendMessage_(chatId, '⚠️ Ошибка: <code>' + escHtml_(err.message).slice(0, 300) + '</code>\nПодробности в логах Apps Script и листе Ops_Log.');
    }
  } catch (e) { /* best effort */ }
}

// ─────────────────────────── Маршрутизация апдейтов ───────────────────────────

function handleUpdate_(upd) {
  if (upd.callback_query) { handleCallback_(upd.callback_query); return; }
  const msg = upd.message || upd.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  if (!authorizeChat_(chatId)) return;

  if (msg.photo && msg.photo.length) { handlePhoto_(chatId, msg.photo[msg.photo.length - 1].file_id, ''); return; }
  if (msg.document && msg.document.mime_type && msg.document.mime_type.indexOf('image/') === 0) {
    handlePhoto_(chatId, msg.document.file_id, msg.document.mime_type);
    return;
  }
  const text = String(msg.text || '').trim();
  if (!text) return;

  if (text.charAt(0) === '/') { routeCommand_(chatId, text); return; }
  handleFreeText_(chatId, text);
}

// ─────────────────────────── Команды ───────────────────────────

const CMD_ALIAS = {
  'доход': 'income', 'бонус': 'income', 'трата': 'spent', 'неделя': 'week',
  'план': 'plan', 'статус': 'status', 'досрочное': 'prepay', 'чдп': 'prepay',
  'ипотека': 'mortgage', 'инвестиции': 'invest', 'портфель': 'invest',
  'кэш': 'cash', 'cash': 'cash', 'синк': 'sync', 'приложение': 'app',
  'валюта': 'fx', 'курс': 'fx', 'курсы': 'fx', 'валютаанализ': 'fx',
  'баланс': 'balance', 'остаток': 'balance', 'алиас': 'alias', 'категория': 'alias',
  'гайд': 'guide', 'метрики': 'metrics', 'аномалии': 'anomalies', 'аномалия': 'anomalies',
};

function routeCommand_(chatId, text) {
  const m = text.match(/^\/([A-Za-zА-Яа-яЁё0-9_]+)(@\w+)?\s*([\s\S]*)$/);
  if (!m) { sendHelp_(chatId); return; }
  let cmd = m[1].toLowerCase();
  if (CMD_ALIAS[cmd]) cmd = CMD_ALIAS[cmd];
  const args = (m[3] || '').trim();

  try {
    switch (cmd) {
      case 'start': sendStart_(chatId); break;
      case 'help': sendHelp_(chatId); break;
      case 'plan': cmdPlan_(chatId, args); break;
      case 'income': cmdIncome_(chatId, args); break;
      case 'spent': cmdSpent_(chatId, args); break;
      case 'week': cmdWeek_(chatId); break;
      case 'prepay': cmdPrepay_(chatId, args); break;
      case 'mortgage': cmdMortgage_(chatId, args); break;
      case 'invest': cmdInvest_(chatId); break;
      case 'fx': cmdFx_(chatId); break;
      case 'balance': cmdBalance_(chatId, args); break;
      case 'alias': cmdAlias_(chatId, args); break;
      case 'guide': cmdGuide_(chatId); break;
      case 'metrics': cmdMetrics_(chatId); break;
      case 'anomalies': cmdAnomalies_(chatId); break;
      case 'cash': cmdCash_(chatId, args); break;
      case 'status': cmdStatus_(chatId); break;
      case 'sync': cmdSync_(chatId); break;
      case 'app': cmdApp_(chatId); break;
      default: sendHelp_(chatId, 'Неизвестная команда /' + escHtml_(cmd));
    }
  } catch (err) {
    console.error('cmd ' + cmd + ': ' + err.message);
    sendMessage_(chatId, '❌ ' + escHtml_(err.message));
  }
}

/** Постоянное меню бота (reply keyboard): главные действия в один тап. */
const MAIN_MENU_ = [
  ['📊 План', '💱 Курсы'],
  ['📅 Неделя', '🧮 Статус'],
  ['❓ Помощь'],
];

const MENU_LABEL_TO_CMD_ = {
  '📊 План': '/plan',
  '💱 Курсы': '/fx',
  '📅 Неделя': '/week',
  '🧮 Статус': '/status',
  '❓ Помощь': '/help',
};

function sendStart_(chatId) {
  sendMessage_(
    chatId,
    '👋 <b>Personal Finance Companion</b>\n' +
    'База — Google Sheets, курсы и цены — GOOGLEFINANCE, скриншоты чеков разбирает Gemini.\n\n' +
    'Главное — на кнопках под сообщением. Также:\n' +
    '/income 6200 eur — записать доход и применить каскад\n' +
    '/spent 3200 — быстрая трата · или скриншот MBANK / ипотеки прямо в чат\n' +
    '/prepay sber 50000 — ЧДП · /anomalies — проверка цифр\n\n' +
    'Полный список — /help',
    { menu: MAIN_MENU_ }
  );
}

function sendHelp_(chatId, prefix) {
  sendMessage_(
    chatId,
    (prefix ? prefix + '\n\n' : '') +
    '<b>Команды</b>\n' +
    '/plan [сумма] [валюта] — водопад месяца (без аргументов — по базовому доходу)\n' +
    '/income 6200 eur [заметка] — доход месяца: каскад дельты бонуса 50/50 + кнопка Apply\n' +
    '/spent 3200 [₽/kgs/$] [заметка] — трата в недельный учёт\n' +
    'фото-скриншот MBANK — расходы; скриншот ипотеки — сверка остатка с банком\n' +
    '/week — бюджет недели/месяца, burn rate, дневной лимит\n' +
    '/prepay sber|tbank 50000 — частичное досрочное погашение\n' +
    '/balance sber 1234567 — сверка остатка ипотеки вручную\n' +
    '/mortgage sber|tbank [сумма] — отметить плановый платёж вручную\n' +
    '/invest — портфель и дрейф от целей 58/23/19\n' +
    '/fx — валюты: перцентили, RSI, прогноз 7/30д и когда выгодно менять EUR→₽/сом/$\n' +
    '/cash 12000 kgs — остаток кэша в валюте (usd/eur/rub/kgs)\n' +
    '/alias "кафе" Питание — исправить категорию Vision на будущее\n' +
    '/status — Net Worth (кэш + вклады + портфель − долг)\n' +
    '/metrics — продуктовые метрики (ответы недели, savings rate, vision)\n' +
    '/anomalies — проверка невозможных цифр (остатки, курсы, суммы, Net Worth)\n' +
    '/sync — roll-forward долгов + снапшот Net Worth\n' +
    '/guide — гид установки: что готово и следующий шаг\n' +
    '/app — открыть Mini App (дашборд со слайдерами)'
  );
}

/** /plan — просмотр водопада (доход по умолчанию = базе, либо сумма из аргументов). */
function cmdPlan_(chatId, args) {
  const income = parseIncomeArgs_(args);
  const w = CashflowEngine.computeWaterfall(income);
  sendMessage_(chatId, CashflowEngine.renderText(w), monthButtons_(w.monthKey));
}

/** /income — Workflow A: ingest → waterfall → предложение с кнопками. */
function cmdIncome_(chatId, args) {
  const income = parseIncomeArgs_(args);
  if (!income.incomeAmount) {
    throw new Error('Формат: /income 6200 eur (сумма и валюта обязательны)');
  }
  const w = CashflowEngine.computeWaterfall(income);
  CashflowEngine.upsertMonth(w, 'proposal');
  sendMessage_(
    chatId,
    CashflowEngine.renderText(w) + '\n\n📄 Строка месяца записана в Monthly_Cycles со статусом <b>proposal</b>.',
    monthButtons_(w.monthKey)
  );
}

function monthButtons_(monthKey) {
  return [
    { text: '✅ Apply to Sheet', callback_data: 'apply_month:' + monthKey },
    { text: '✏️ Edit Commitments', url: sheetUrl_() },
  ];
}

/** «6200 eur», «6200», «6200 EUR бонус Q4» → {incomeAmount, incomeCurrency}. */
function parseIncomeArgs_(args) {
  if (!args) return { incomeAmount: null, incomeCurrency: null };
  const amount = parseAmount_(args);
  if (amount === null) return { incomeAmount: null, incomeCurrency: null };
  return {
    incomeAmount: amount,
    incomeCurrency: detectCurrency_(args, getSetting_('INCOME_CURRENCY', CONFIG.PROFILE.INCOME_CURRENCY)),
  };
}

/** /spent — быстрая трата в недельный учёт. */
function cmdSpent_(chatId, args) {
  if (!args) throw new Error('Формат: /spent 3200 [₽/kgs/$] [заметка]');
  const parsed = parseTypedExpense_(args);
  if (!parsed) throw new Error('Не понял сумму. Пример: /spent 3200 или /spent 500 kgs');
  const status = CashflowEngine.logWeeklyExpense({
    amount: parsed.total_spent, currency: parsed.currency, note: args, source: 'manual',
  });
  MetricsEngine.logOnce('weekly_answer:' + weekKey_(new Date()), 'manual');
  sendMessage_(chatId,
    '🧾 Записано: ' + fmtMoney_(parsed.total_spent, parsed.currency) + '\n\n' +
    CashflowEngine.renderWeeklyText(status));
}

function cmdWeek_(chatId) {
  sendMessage_(chatId, CashflowEngine.renderWeeklyText(CashflowEngine.weeklyStatus()));
}

/** /prepay — Workflow C: ЧДП со снижением платежа, срок сохраняется. */
function cmdPrepay_(chatId, args) {
  const parts = args.split(/\s+/);
  if (parts.length < 2) throw new Error('Формат: /prepay sber 50000 (или tbank)');
  const debtId = parts[0];
  const amount = parseAmount_(parts[1]);
  if (!amount) throw new Error('Не понял сумму: ' + escHtml_(parts[1]));
  const r = DebtEngine.registerPrepay(debtId, amount);
  const arb = DebtEngine.arbitrage(r.amount);
  const dep = InvestNetWorth.depositsSummary();
  sendMessage_(
    chatId,
    '💸 <b>ЧДП ' + escHtml_(r.name) + '</b>\n' +
    'Списано досрочно: ' + fmtMoney_(r.amount, 'RUB') + '\n' +
    'Остаток долга: ' + fmtMoney_(r.balanceBefore, 'RUB') + ' → <b>' + fmtMoney_(r.balanceAfter, 'RUB') + '</b>\n' +
    'Платёж (срок сохранён): ' + fmtMoney_(r.paymentBefore, 'RUB') + ' → <b>' + fmtMoney_(r.paymentAfter, 'RUB') + '</b>' +
    (r.paymentSaved > 0 ? ' (−' + fmtMoney_(r.paymentSaved, 'RUB') + '/мес)' : '') + '\n\n' +
    '🔗 Commitments_Registry обновится сам (формулы ссылаются на Debt_Engine).\n' +
    '⚖️ ' + (arb.depositWins ? '⚠️ ' : '✅ ') + arb.verdict +
    (dep.count ? '\n🏦 Уже на вкладах: ' + fmtMoney_(dep.totalUSD, 'USD') + ' под ~' + fmtPct_(dep.avgRate) +
      ' — арбитраж фактически работает.' : '')
  );
}

function cmdMortgage_(chatId, args) {
  const parts = args.split(/\s+/);
  if (!parts[0]) throw new Error('Формат: /mortgage sber [сумма] — сумма не обязательна');
  const after = DebtEngine.logPayment(parts[0], parts[1] ? parseAmount_(parts[1]) : undefined);
  sendMessage_(chatId,
    '🏦 ' + escHtml_(after.name) + ' — платёж учтён.\n' +
    'Остаток: ' + fmtMoney_(after.balance, 'RUB') + ' · платёж: ' + fmtMoney_(after.payment, 'RUB'));
}

function cmdInvest_(chatId) {
  sendMessage_(chatId, InvestNetWorth.renderText());
}

/** /fx — анализ валют: перцентили, RSI, прогноз и тайминг конвертаций. */
function cmdFx_(chatId) {
  sendMessage_(chatId, FXAnalytics.renderText(FXAnalytics.build()));
}

/** /anomalies — проверка невозможных/подозрительных цифр. */
function cmdAnomalies_(chatId) {
  sendMessage_(chatId, AnomalyEngine.renderText());
}

/** /balance sber|tbank <остаток ₽> — сверка ипотеки с банком вручную. */
function cmdBalance_(chatId, args) {
  const parts = String(args || '').split(/\s+/);
  if (parts.length < 2 || !parseAmount_(parts[1])) {
    throw new Error('Формат: /balance sber 1234567 (или tbank)');
  }
  proposeReconciliation_(chatId, parts[0], parseAmount_(parts[1]));
}

/** /alias "кафе" Питание — переименование категории Vision на будущее. */
function cmdAlias_(chatId, args) {
  const m = String(args || '').match(/^"?([^"]+?)"?\s+"?([^"]+?)"?$/);
  if (!m || !m[1] || !m[2]) throw new Error('Формат: /alias "как распознал" "как правильно"');
  const from = m[1].trim(), to = m[2].trim();
  // защита от formula-injection: значения попадают в ячейки Settings
  if (/^[=+\-@\t\r]/.test(from) || /^[=+\-@\t\r]/.test(to)) {
    throw new Error('Значения не могут начинаться с = + - @');
  }
  if (from.length > 40 || to.length > 40) throw new Error('Слишком длинно (макс. 40 символов)');
  setSetting_('CAT_ALIAS_' + from.toLowerCase(), to);
  MetricsEngine.log('vision_fix:' + fmtISO_(new Date()), from + '→' + to);
  sendMessage_(chatId, '✅ Категория «' + escHtml_(from) + '» теперь записывается как «' + escHtml_(to) + '».');
}

/** /guide — интерактивный онбординг: что уже готово и следующий шаг (P2). */
function cmdGuide_(chatId) {
  const L = ['🧭 <b>Гид установки</b> — состояние и следующий шаг\n'];
  let step = 0;

  const token = getProp_(PROP.BOT_TOKEN, '');
  const chatIdProp = getProp_(PROP.CHAT_ID, '');
  const visionKey = getProp_(PROP.GEMINI_KEY, '') || getProp_(PROP.GROQ_KEY, '');
  L.push((token ? '✅' : '⬜') + ' 1. Токен бота (TELEGRAM_BOT_TOKEN)');
  L.push((chatIdProp ? '✅' : '⬜') + ' 2. Chat ID (TELEGRAM_CHAT_ID)');
  L.push((visionKey ? '✅' : '⬜') + ' 3. Ключ Vision (GEMINI_API_KEY или GROQ_API_KEY)');
  if (!token) step = 1; else if (!chatIdProp) step = 2; else if (!visionKey) step = 3;

  let sheetOk = false;
  try { ss_().getSheetByName(SHEETS.FX_SETTINGS).getRange('B2').getValue(); sheetOk = true; } catch (e) {}
  L.push((sheetOk ? '✅' : '⬜') + ' 4. Таблица создана (createSpreadsheet)');
  if (sheetOk && !step) step = 4;

  let hookOk = false;
  try { hookOk = !!tgCall_('getWebhookInfo', {}).url; } catch (e) {}
  L.push((hookOk ? '✅' : '⬜') + ' 5. Webhook привязан (деплой + setupWebhook)');
  if (hookOk && !step) step = 5;

  const mini = String(CONFIG.MINI_APP_URL || getSetting_('MINI_APP_URL', ''));
  L.push((mini ? '✅' : '⬜') + ' 6. Mini App подключён (ключ MINI_APP_URL)');
  if (mini && !step) step = 6;

  const next = {
    1: '→ Получите токен у @BotFather и добавьте в Script Properties (SETUP.md, Шаг 1 и 3).',
    2: '→ Узнайте chat_id у @userinfobot и добавьте TELEGRAM_CHAT_ID.',
    3: '→ Создайте ключ на aistudio.google.com/apikey (или console.groq.com) и добавьте.',
    4: '→ Выполните функцию createSpreadsheet в редакторе Apps Script.',
    5: '→ Разверните Web App и выполните setupWebhook (SETUP.md, Шаг 5).',
    6: '→ Всё готово! Дальше: /income 6200 eur, /plan, /fx. Проверка здоровья: /sync и securityAudit.',
    0: '→ Начните с Шага 1 в SETUP.md.',
  }[step];
  L.push('\n<b>Следующий шаг:</b>\n' + next);
  sendMessage_(chatId, L.join('\n'));
}

/** /metrics — продуктовые метрики (weekly response, vision, cascade, savings). */
function cmdMetrics_(chatId) {
  const wrr = MetricsEngine.weeklyResponseRate();
  const va = MetricsEngine.visionAccuracy();
  const L = ['📊 <b>Метрики продукта</b>\n'];
  L.push('Воскресные опросы: ' + (wrr === null ? 'ещё не было' : fmtPct_(wrr, 0) + ' ответов (' +
    MetricsEngine.byPrefix('weekly_ask:').length + ' нед.) — цель >80%'));
  if (va) L.push('Vision: исправлений ' + va.fixes + ' из ' + (va.fixes + va.visionRows) + ' записей (' +
    fmtPct_(va.fixRate, 0) + ') — цель <10%');
  const sr = MetricsEngine.value('savings_rate:');
  if (sr !== null) L.push('Savings rate (посл. месяц): ' + fmtPct_(Number(sr)));
  const cascades = MetricsEngine.byPrefix('cascade_applied:').filter(function (c) {
    return c.key.indexOf(':observed') === -1; // наблюдения digest не считаем применениями
  });
  if (cascades.length) {
    const applied = cascades.filter(function (c) { return c.value === '1'; }).length;
    L.push('Каскад применён: ' + applied + ' из ' + cascades.length + ' мес.');
  }
  sendMessage_(chatId, L.join('\n'));
}

function cmdCash_(chatId, args) {
  const parsed = parseTypedExpense_(args || '');
  if (!parsed) throw new Error('Формат: /cash 12000 kgs (валюта: usd/eur/rub/kgs)');
  const totalUSD = InvestNetWorth.setCash(parsed.total_spent, parsed.currency);
  sendMessage_(chatId, '💵 Кэш ' + parsed.currency + ' = ' + fmtMoney_(parsed.total_spent, parsed.currency) +
    ' · всего кэша: ' + fmtMoney_(totalUSD, 'USD') + '\n\n' +
    InvestNetWorth.renderNetWorthText(InvestNetWorth.netWorth()));
}

function cmdStatus_(chatId) {
  const debts = DebtEngine.replayAll();
  const nw = InvestNetWorth.takeSnapshot();
  const weekly = CashflowEngine.weeklyStatus();
  const L = [InvestNetWorth.renderNetWorthText(nw), ''];
  if (getFx_().FALLBACK_USED) {
    L.push('⚠️ Курсы GOOGLEFINANCE недоступны — цифры на резервных значениях (примерные).');
    L.push('');
  }
  debts.forEach(function (d) {
    const p = DebtEngine.projection(d, 0);
    L.push('🏦 ' + escHtml_(d.name) + ': ' + fmtMoney_(d.balance, 'RUB') +
      ' под ' + fmtPct_(d.rate) + ' · платёж ' + fmtMoney_(DebtEngine.normalizedMonthlyRUB(d), 'RUB') + '/мес' +
      ' · погашение ' + p.payoffISO + ' (' + p.monthsLeft + ' мес)');
  });
  L.push('');
  L.push(CashflowEngine.renderWeeklyText(weekly));
  sendMessage_(chatId, L.join('\n'));
}

function cmdSync_(chatId) {
  const posted = DebtEngine.checkDuePayments();
  DebtEngine.replayAll();
  InvestNetWorth.takeSnapshot();
  sendMessage_(chatId,
    '🔄 <b>Sync выполнен</b>\n' +
    (posted.length ? 'Автопостановка платежей: ' + escHtml_(posted.join(', ')) + '\n' : '') +
    'Долги пересчитаны, Net Worth снапшот обновлён.\n\n' +
    InvestNetWorth.renderNetWorthText(InvestNetWorth.netWorth()));
}

function cmdApp_(chatId) {
  const base = String(CONFIG.MINI_APP_URL || getSetting_('MINI_APP_URL', ''));
  if (!base) {
    sendMessage_(chatId, 'Mini App ещё не подключён: укажите URL хостинга в листе FX_and_Settings (ключ MINI_APP_URL) — см. SETUP.md, Шаг 7.');
    return;
  }
  // токен доступа подставляется автоматически — владелец его даже не видит
  const rt = getProp_('TMA_READ_TOKEN', '');
  const url = base + (base.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(rt);
  sendMessage_(chatId, '📊 <b>Дашборд</b> — слайдеры сценариев, валютные сигналы, ЧДП-калькулятор, портфель и Net Worth.', [
    { text: ' Открыть дашборд', web_app: { url: url } },
  ]);
}

// ─────────────────────────── Callback-кнопки ───────────────────────────

function handleCallback_(cb) {
  const chatId = cb.message ? cb.message.chat.id : null;
  if (!chatId || !authorizeChat_(chatId)) return;
  const data = String(cb.data || '');

  if (data.indexOf('apply_month:') === 0) {
    const monthKey = data.split(':')[1];
    CashflowEngine.setMonthStatus(monthKey, 'applied');
    MetricsEngine.logOnce('cascade_applied:' + monthKey, 1);
    answerCallback_(cb.id, 'Applied ✅');
    tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id });
    sendMessage_(chatId, '✅ Месяц ' + escHtml_(monthKey) + ' применён: каскад зафиксирован в Monthly_Cycles.');
    return;
  }

  // Сверка ипотек с банком (P1)
  if (data.indexOf('recon_apply:') === 0) {
    const parts = data.split(':'); // recon_apply:SBER:1234567
    try {
      const r = DebtEngine.reconcile(parts[1], parts[2]);
      answerCallback_(cb.id, 'Применено ✅');
      tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id });
      sendMessage_(
        chatId,
        r.unchanged
          ? '✅ ' + escHtml_(r.name) + ': остатки уже совпадали.'
          : (r.bigDrift ? '⚠️ <b>Большое расхождение (>20%)</b> — убедитесь, что это остаток ОСНОВНОГО долга, а не общая задолжённость с процентами.\n' : '') +
            '✅ ' + escHtml_(r.name) + ': остаток ' + fmtMoney_(r.before, 'RUB') + ' → <b>' + fmtMoney_(r.after, 'RUB') + '</b>' +
            ' (Δ ' + (r.drift > 0 ? '+' : '') + fmtMoney_(r.drift, 'RUB') + ')\n' +
            'Платёж не изменился; срок пересчитан: ~' + r.monthsLeft + ' мес (погашение к ' + r.payoffISO + ')'
      );
      MetricsEngine.logOnce('recon_ok:' + fmtMonthKey_(new Date()), parts[1]);
    } catch (e) {
      answerCallback_(cb.id, 'Ошибка');
      sendMessage_(chatId, '❌ ' + escHtml_(e.message));
    }
    return;
  }
  if (data === 'recon_ok') {
    MetricsEngine.logOnce('recon_ok:' + fmtMonthKey_(new Date()), 'manual');
    answerCallback_(cb.id, 'Записано ✅');
    tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id });
    sendMessage_(chatId, '✅ Сверка зафиксирована. Хорошего месяца!');
    return;
  }
  if (data === 'recon_how') {
    answerCallback_(cb.id, '');
    sendMessage_(chatId,
      '📸 Просто пришлите скриншот экрана ипотеки (остаток долга) прямо в чат — ' +
      'бот распознает остаток, сравнит с движком и предложит применить.\n' +
      'Или вручную: /balance sber 1234567');
    return;
  }
  if (data === 'recon_cancel') {
    answerCallback_(cb.id, 'Отменено');
    tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id });
    return;
  }

  answerCallback_(cb.id, '');
}

// ─────────────────────────── Скриншоты (Vision) ───────────────────────────

function handlePhoto_(chatId, fileId, mime) {
  try {
    tgCall_('sendChatAction', { chat_id: chatId, action: 'typing' });
    const file = downloadTelegramFile_(fileId); // валидирует, что это изображение
    const parsed = parseExpenseScreenshot_(file.base64, mime || file.mime);

    if (parsed.screen_type === 'debt_balance') return handleDebtBalancePhoto_(chatId, parsed);

    if (parsed.screen_type === 'other' || !parsed.total_spent) {
      sendMessage_(chatId,
        '🤖 Не нашёл на скриншоте ни аналитики расходов, ни остатка долга (провайдер: ' + parsed.provider + ').\n' +
        'Пришлите экран «Аналитика/Расходы за период» из MBANK или экран ипотеки с остатком долга.\n' +
        'Или введите сумму: /spent 3200');
      return;
    }

    const head = '🤖 <b>' + (parsed.provider === 'groq' ? 'Groq (резерв)' : 'Gemini') + ' разобрал скриншот</b>\n' +
      'Период: ' + escHtml_(parsed.period || '—') + ' · Валюта: ' + parsed.currency + '\n' +
      'Сумма: <b>' + fmtMoney_(parsed.total_spent, parsed.currency) + '</b>' +
      (parsed.top_categories.length
        ? '\nКатегории: ' + parsed.top_categories.map(function (c) {
            return escHtml_(c.category) + ' ' + fmtMoney_(c.amount, parsed.currency);
          }).join(' · ')
        : '');

    if (parsed.is_full_month_analytics) {
      sendMessage_(chatId, head + '\n\nℹ️ Это аналитика за <b>весь месяц</b> — не записываю её как недельную.' +
        ' Свежий месячный расход покажет /week.');
      return;
    }

    const c1 = parsed.top_categories[0], c2 = parsed.top_categories[1];
    const status = CashflowEngine.logWeeklyExpense({
      amount: parsed.total_spent,
      currency: parsed.currency,
      cat1: c1 ? c1.category + ' ' + round2_(c1.amount) : '',
      cat2: c2 ? c2.category + ' ' + round2_(c2.amount) : '',
      note: 'vision/' + parsed.provider + ' · file ' + fileId.slice(0, 12),
    });
    MetricsEngine.logOnce('weekly_answer:' + weekKey_(new Date()), parsed.provider);
    sendMessage_(chatId, head + '\n\n' + CashflowEngine.renderWeeklyText(status));
  } catch (err) {
    console.error('photo: ' + err.message);
    sendMessage_(chatId, '😕 ' + escHtml_(err.message) +
      '\nПопробуйте переснять скриншот (полный экран аналитики) или введите сумму: /spent 3200');
  }
}

/** Скриншот остатка ипотеки → сверка Debt_Engine (P1: «просто пришли скрин»). */
function handleDebtBalancePhoto_(chatId, parsed) {
  if (!parsed.debt_balance_rub) {
    sendMessage_(chatId, '🏦 Вижу экран ипотеки, но остаток долга не распознан.\n' +
      'Введите вручную: /balance sber 1234567 (или tbank)');
    return;
  }
  const debtId = debtIdFromBank_(parsed.bank);
  if (!debtId) {
    sendMessage_(
      chatId,
      '🏦 Остаток долга на скриншоте: <b>' + fmtMoney_(parsed.debt_balance_rub, 'RUB') + '</b>\n' +
      'Банк не распознан — какая это ипотека?',
      [
        { text: 'Сбербанк', callback_data: 'recon_apply:SBER:' + parsed.debt_balance_rub },
        { text: 'Т-Банк', callback_data: 'recon_apply:TBANK:' + parsed.debt_balance_rub },
      ]
    );
    return;
  }
  proposeReconciliation_(chatId, debtId, parsed.debt_balance_rub);
}

/** Сравнить факт с движком и предложить применить. */
function proposeReconciliation_(chatId, debtId, actualRUB) {
  const debt = DebtEngine.getDebt(debtId);
  const drift = actualRUB - debt.balance;
  const text =
    '🏦 <b>' + escHtml_(debt.name) + '</b>\n' +
    'В движке: ' + fmtMoney_(debt.balance, 'RUB') + '\n' +
    'На скриншоте: <b>' + fmtMoney_(actualRUB, 'RUB') + '</b>\n' +
    (Math.abs(drift) < 1
      ? '✅ Совпадает — ничего делать не нужно.'
      : 'Δ ' + (drift > 0 ? '+' : '') + fmtMoney_(drift, 'RUB') + ' — применить фактический остаток?');
  if (Math.abs(drift) < 1) { sendMessage_(chatId, text); return; }
  sendMessage_(chatId, text, [
    { text: '✅ Применить остаток', callback_data: 'recon_apply:' + debtId + ':' + Math.round(actualRUB) },
    { text: 'Отмена', callback_data: 'recon_cancel' },
  ]);
}

// ─────────────────────────── Свободный текст ───────────────────────────

function handleFreeText_(chatId, text) {
  // Кнопки постоянного меню → соответствующие команды
  const menuCmd = MENU_LABEL_TO_CMD_[text.trim()];
  if (menuCmd) { routeCommand_(chatId, menuCmd); return; }

  const state = getBotState_();

  if (state.mode === 'await_week') {
    if (/^(0|ноль|никак|нет)$/i.test(text.trim())) {
      setBotState_({});
      sendMessage_(chatId, '👌 Записано: трат нет.\n\n' +
        CashflowEngine.renderWeeklyText(CashflowEngine.weeklyStatus()));
      return;
    }
    const parsed = parseTypedExpense_(text);
    if (parsed) {
      setBotState_({});
      const status = CashflowEngine.logWeeklyExpense({
        amount: parsed.total_spent, currency: parsed.currency, note: 'weekly reply', source: 'chat',
      });
      MetricsEngine.logOnce('weekly_answer:' + weekKey_(new Date()), 'chat');
      sendMessage_(chatId, '🧾 Записано: ' + fmtMoney_(parsed.total_spent, parsed.currency) + '\n\n' +
        CashflowEngine.renderWeeklyText(status));
    } else {
      sendMessage_(chatId, 'Пришлите сумму (например <code>4350</code> или <code>3500 kgs</code>) или скриншот MBANK.');
    }
    return;
  }

  // вне контекста: если похоже на сумму — подсказываем команду
  if (parseTypedExpense_(text)) {
    sendMessage_(chatId, 'Похоже на сумму. Записать трату: /spent ' + escHtml_(text));
  }
}

// ════════════════════════════════════════════════════════════════════
// CashflowEngine.gs
// ════════════════════════════════════════════════════════════════════
/**
 * CashflowEngine.gs — водопад месяца, каскад профицита, недельные расходы.
 *
 * Правила ТЗ:
 *   Surplus = Income(USD) − Mandatory(USD)          (реестр активных обязательств + ипотеки)
 *   Каскад дельты бонуса: если Income > базы $5 800 →
 *     50% дельты → Debt Prepayment (Сбербанк / арбитраж с вкладом 16%)
 *     50% дельты → инвестиционный пул: 58% ETF / 23% Tech / 19% Crypto
 */

const CashflowEngine = {

  /** Активные обязательства из реестра, разбивка по категориям (USD). */
  registrySummary: function () {
    const rows = readRange_(SHEETS.COMMITMENTS, 2);
    let total = 0, mortgages = 0, other = 0, rubItems = 0;
    rows.forEach(function (r) {
      const active = r[6] === true || String(r[6]).toUpperCase() === 'TRUE';
      if (!active) return;
      const usd = Number(r[4]) || 0;
      total += usd;
      if (String(r[0]) === 'Mortgages') mortgages += usd;
      else {
        other += usd;
        if (String(r[3]).toUpperCase() === 'RUB') rubItems += usd;
      }
    });
    return { total: total, mortgages: mortgages, other: other, otherNonRub: other - rubItems, rubItems: rubItems };
  },

  /**
   * Полный водопад месяца.
   * opts: { incomeAmount, incomeCurrency, extraPrepayRUB, extraDcaUSD }
   */
  computeWaterfall: function (opts) {
    opts = opts || {};
    const fx = getFx_();
    const baseIncome = getSettingNum_('BASE_INCOME_USD', CONFIG.PROFILE.BASE_INCOME_USD);
    const capRUB = getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB);
    const weeklyRUB = getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB);

    const income = (opts.incomeAmount !== undefined && opts.incomeAmount !== null && opts.incomeAmount !== '')
      ? Number(opts.incomeAmount)
      : baseIncome;
    const incomeCur = (opts.incomeCurrency || CONFIG.PROFILE.INCOME_CURRENCY).toUpperCase();
    const incomeUSD = convert_(income, incomeCur, 'USD', fx);

    const reg = this.registrySummary();
    const livingUSD = capRUB / fx.USDRUB;
    const surplusUSD = incomeUSD - reg.total - livingUSD;

    const bonusDelta = Math.max(0, incomeUSD - baseIncome);
    const prepayShare = getSettingNum_('BONUS_PREPAY_SHARE', CONFIG.SURPLUS.BONUS_PREPAY_SHARE);
    const dcaShare = getSettingNum_('BONUS_DCA_SHARE', CONFIG.SURPLUS.BONUS_DCA_SHARE);
    const extraPrepayUSD = (Number(opts.extraPrepayRUB) || 0) / fx.USDRUB;
    const extraDcaUSD = Number(opts.extraDcaUSD) || 0;

    const toPrepayUSD = bonusDelta * prepayShare + extraPrepayUSD;
    const toDcaUSD = bonusDelta * dcaShare + extraDcaUSD;
    const split = {
      broad_market_etf: toDcaUSD * getSettingNum_('TARGET_ETF', CONFIG.INVEST_SPLIT.broad_market_etf),
      growth_stocks: toDcaUSD * getSettingNum_('TARGET_STOCKS', CONFIG.INVEST_SPLIT.growth_stocks),
      crypto_assets: toDcaUSD * getSettingNum_('TARGET_CRYPTO', CONFIG.INVEST_SPLIT.crypto_assets),
    };

    const debts = DebtEngine.getDebts();
    // Досрочка направляется в самый дорогой долг (Сбербанк 11.9%)
    const target = debts.slice().sort(function (a, b) { return b.rate - a.rate; })[0];
    const toPrepayRUB = toPrepayUSD * fx.USDRUB;
    const arbitrage = DebtEngine.arbitrage(toPrepayRUB);
    const baseProjection = target ? DebtEngine.projection(target, 0) : null;
    const prepayProjection = target ? DebtEngine.projection(target, toPrepayRUB) : null;

    return {
      monthKey: fmtMonthKey_(new Date()),
      fx: fx,
      income: income,
      incomeCurrency: incomeCur,
      incomeUSD: incomeUSD,
      baseIncomeUSD: baseIncome,
      registry: reg,
      livingCapRUB: capRUB,
      livingUSD: livingUSD,
      weeklyBudgetRUB: weeklyRUB,
      surplusUSD: surplusUSD,
      bonusDeltaUSD: bonusDelta,
      toPrepayUSD: toPrepayUSD,
      toDcaUSD: toDcaUSD,
      split: split,
      prepayTargetName: target ? target.name : '',
      arbitrage: arbitrage,
      baseProjection: baseProjection,
      prepayProjection: prepayProjection,
      debts: debts,
    };
  },

  /** Текстовое представление для бота (HTML). */
  renderText: function (w) {
    const L = [];
    L.push('📊 <b>План-водопад на ' + w.monthKey + '</b>');
    L.push('💵 Доход: <b>' + fmtMoney_(w.incomeUSD, 'USD') + '</b>' +
      (w.incomeCurrency !== 'USD' ? ' (' + fmtMoney_(w.income, w.incomeCurrency) + ')' : '') +
      ' · база ' + fmtMoney_(w.baseIncomeUSD, 'USD'));
    L.push('🧾 Обязательства (реестр): −' + fmtMoney_(w.registry.total, 'USD'));
    L.push('     • жильё/подписки: ' + fmtMoney_(w.registry.otherNonRub, 'USD') +
      ' · RUB-позиции: ' + fmtMoney_(w.registry.rubItems, 'USD'));
    L.push('     • ипотеки: ' + fmtMoney_(w.registry.mortgages, 'USD'));
    L.push('🍽 Лимит жизни: −' + fmtMoney_(w.livingUSD, 'USD') + ' (' + fmtMoney_(w.livingCapRUB, 'RUB') + ')');
    L.push('➖➖➖➖➖➖➖➖➖➖➖➖');
    L.push('💚 <b>Свободный профицит: ' + fmtMoney_(w.surplusUSD, 'USD') + '</b>');
    if (w.bonusDeltaUSD > 0) {
      L.push('🎁 Дельта бонуса: +' + fmtMoney_(w.bonusDeltaUSD, 'USD'));
      L.push('     → досрочка/вклад (50%): <b>' + fmtMoney_(w.toPrepayUSD, 'USD') + '</b>');
      L.push('     → DCA (50%): <b>' + fmtMoney_(w.toDcaUSD, 'USD') + '</b>');
    }
    L.push('📈 DCA-расклад: ETF ' + fmtMoney_(w.split.broad_market_etf, 'USD') +
      ' · Акции ' + fmtMoney_(w.split.growth_stocks, 'USD') +
      ' · Крипта ' + fmtMoney_(w.split.crypto_assets, 'USD'));
    if (w.arbitrage.amountRUB > 0) {
      L.push('⚖️ ' + (w.arbitrage.depositWins ? '⚠️ ' : '✅ ') + w.arbitrage.verdict);
    }
    if (w.baseProjection) {
      const monthsSaved = Math.max(0, w.baseProjection.monthsLeft - w.prepayProjection.monthsLeft);
      const interestSaved = Math.max(0, w.baseProjection.totalInterestRUB - w.prepayProjection.totalInterestRUB);
      L.push('🏦 ' + w.prepayTargetName + ': ' +
        w.prepayProjection.monthsLeft + ' мес (−' + monthsSaved.toFixed(1) + ' к сроку), экономия ' +
        fmtMoney_(interestSaved, 'RUB') + ' процентов');
    }
    return L.join('\n');
  },

  /** Создать/обновить строку месяца в Monthly_Cycles (статус proposal/applied). */
  upsertMonth: function (w, status) {
    return runWithLock_(function () {
      const sh = sheet_(SHEETS.MONTHLY);
      const last = Math.max(sh.getLastRow(), 1);
      const months = sh.getRange(2, 1, Math.max(last - 1, 1), 1).getValues();
      let row = 0;
      for (let i = 0; i < months.length; i++) {
        if (String(months[i][0]) === w.monthKey) { row = 2 + i; break; }
      }
      if (!row) {
        sh.appendRow([w.monthKey, null, null, null, null, null, null, null, null, null, null]);
        row = sh.getLastRow();
      }
      const curF = { EUR: '=B{r}*FX_and_Settings!$B$2', USD: '=B{r}', RUB: '=B{r}/FX_and_Settings!$B$3', KGS: '=B{r}/FX_and_Settings!$B$4' }[w.incomeCurrency] || '=B{r}';
      sh.getRange(row, 1, 1, 11).setValues([[
        w.monthKey, w.income, w.incomeCurrency,
        null, null, null,
        round2_(w.toPrepayUSD), round2_(w.split.broad_market_etf),
        round2_(w.split.growth_stocks), round2_(w.split.crypto_assets), status || 'proposal',
      ]]);
      sh.getRange(row, 4).setFormula(curF.replace('{r}', row));
      sh.getRange(row, 5).setFormula(
        '=SUMIFS(Commitments_Registry!$E$2:$E$100,Commitments_Registry!$G$2:$G$100,TRUE)'
      );
      sh.getRange(row, 6).setFormula('=D' + row + '-E' + row);
      return row;
    });
  },

  setMonthStatus: function (monthKey, status) {
    const sh = sheet_(SHEETS.MONTHLY);
    const last = sh.getLastRow();
    if (last < 2) return;
    const months = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < months.length; i++) {
      if (String(months[i][0]) === monthKey) {
        sh.getRange(2 + i, 11).setValue(status);
        return;
      }
    }
  },

  // ─────────────────── Недельные расходы (Weekly_Expenses) ───────────────────

  /**
   * Записать недельную трату. amount в валюте currency (KGS/RUB/USD/EUR),
   * в лист кладётся нормализовано в KGS, формулы конвертируют в ₽/$ сами.
   */
  logWeeklyExpense: function (opts) {
    const self = this;
    return runWithLock_(function () {
      const fx = getFx_();
      const amountKGS = convert_(opts.amount, opts.currency || 'KGS', 'KGS', fx);
      const rubEq = convert_(opts.amount, opts.currency || 'KGS', 'RUB', fx);
      // защита от миспарса (месячная аналитика как неделя, лишний ноль):
      if (rubEq > 1000000) {
        throw new Error('Сумма ' + fmtMoney_(opts.amount, opts.currency) + ' (≈' + fmtMoney_(rubEq, 'RUB') +
          ') выглядит нереально для недельной траты. Проверьте скриншот/сумму.');
      }
      const budget = getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB);
      const sh = sheet_(SHEETS.WEEKLY);
      sh.appendRow([
        new Date(), null, round2_(amountKGS), null, null,
        safeCellText_(opts.cat1), safeCellText_(opts.cat2), budget, null, safeCellText_(opts.note),
      ]);
      const r = sh.getLastRow();
      sh.getRange(r, 2).setFormula('=ISOWEEKNUM(A' + r + ')');
      sh.getRange(r, 4).setFormula('=IFERROR($C' + r + '/FX_and_Settings!$B$4*FX_and_Settings!$B$3,0)');
      sh.getRange(r, 5).setFormula('=IFERROR($C' + r + '/FX_and_Settings!$B$4,0)');
      sh.getRange(r, 9).setFormula('=FX_and_Settings!$B$10-D' + r);
      return self.weeklyStatus();
    });
  },

  /** Текущее состояние недельного/месячного бюджета + допустимый дневной расход. */
  weeklyStatus: function () {
    const fx = getFx_();
    const cap = getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB);
    const weekly = getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB);
    const now = new Date();
    const curWeek = isoWeek_(now);
    let weekRUB = 0, monthRUB = 0;
    readRange_(SHEETS.WEEKLY, 2).forEach(function (r) {
      const d = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
      if (isNaN(d)) return;
      const rub = Number(r[3]) || 0;
      if (d.getFullYear() === now.getFullYear() && isoWeek_(d) === curWeek) weekRUB += rub;
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) monthRUB += rub;
    });
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const dailyAllowance = Math.max(0, cap - monthRUB) / daysLeftInMonth_();
    return {
      weekRUB: weekRUB,
      weekBudgetRUB: weekly,
      weekOver: weekRUB > weekly,
      weekRemainingRUB: weekly - weekRUB,
      monthRUB: monthRUB,
      monthCapRUB: cap,
      monthRemainingRUB: cap - monthRUB,
      burnRate: monthRUB / Math.max(1, daysElapsed) / (cap / daysInMonth), // >1 = тратим быстрее плана
      dailyAllowanceRUB: dailyAllowance,
      daysLeft: daysLeftInMonth_(),
      fx: fx,
    };
  },

  renderWeeklyText: function (s) {
    const bar = s.weekOver ? '🔴' : '🟢';
    const lines = [
      '📅 <b>Недельный бюджет</b>',
      bar + ' Израсходовано: <b>' + fmtMoney_(s.weekRUB, 'RUB') + '</b> из ' + fmtMoney_(s.weekBudgetRUB, 'RUB') +
        ' (остаток ' + fmtMoney_(s.weekRemainingRUB, 'RUB') + ')',
      '🗓 Месяц: ' + fmtMoney_(s.monthRUB, 'RUB') + ' из ' + fmtMoney_(s.monthCapRUB, 'RUB') +
        ' · burn rate ' + fmtPct_(s.burnRate, 0) + (s.burnRate > 1 ? ' ⚠️ быстрее плана' : ' ✅ в плане'),
      '💵 Можно в день до конца месяца: <b>' + fmtMoney_(s.dailyAllowanceRUB, 'RUB') + '</b> (' + s.daysLeft + ' дн.)',
    ];
    return lines.join('\n');
  },
};

function round2_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ════════════════════════════════════════════════════════════════════
// DebtEngine.gs
// ════════════════════════════════════════════════════════════════════
/**
 * DebtEngine.gs — состояние ипотек, ЧДП, roll-forward, проекции.
 *
 * Источник истины — журнал событий на листе Debt_Engine (строка 19+):
 *   Date | Debt | Event ('payment'|'prepay') | Amount ₽ | Balance After | Payment After | Source
 *
 * Текущее состояние (строки 2–3) всегда выводится replay-проходом по журналу от
 * начального баланса (Initial Balance, Epoch). Это делает пересчёт
 * идемпотентным и самовосстанавливающимся.
 *
 * Математика ЧДП (сохранение срока, снижение платежа — режим банков РФ):
 *   P_new = (B − L) · r(1+r)^n / ((1+r)^n − 1),  n = n0 − payments_made,
 *   где n0 выводится инверсией аннуитета из начальных (B0, r, P0)
 *   (для Сбербанка получается 34.5 мес — совпадает с графиком банка ±50 ₽).
 */

const DebtEngine = {
  STATE_HEADER_ROW: 1,
  STATE_FIRST_ROW: 2,
  LOG_HEADER_ROW: 19,
  LOG_FIRST_ROW: 20,

  // ── базовые формулы ──

  periodsPerYear_: function (type) {
    return type === 'biweekly' ? 26 : 12;
  },

  annuityPayment_: function (balance, annualRate, ppy, periods) {
    if (periods <= 0 || balance <= 0) return 0;
    const r = annualRate / ppy;
    if (r <= 0) return balance / periods;
    return (balance * r * Math.pow(1 + r, periods)) / (Math.pow(1 + r, periods) - 1);
  },

  /** Инверсия аннуитета: сколько периодов осталось при (balance, rate, payment). */
  derivePeriods_: function (balance, annualRate, ppy, payment) {
    const r = annualRate / ppy;
    if (r <= 0) return balance / payment;
    if (payment <= balance * r) return Infinity; // платёж не покрывает проценты
    return -Math.log(1 - (balance * r) / payment) / Math.log(1 + r);
  },

  cfgById_: function (id) {
    const key = String(id || '').toUpperCase();
    return CONFIG.DEBTS.filter(function (d) { return d.id === key; })[0] ||
      CONFIG.DEBTS.filter(function (d) { return d.id.indexOf(key) === 0; })[0];
  },

  // ── чтение состояния ──

  getDebts: function () {
    const sh = sheet_(SHEETS.DEBTS);
    // Блок состояния строго в строках 2–3 (ниже — ЧДП-калькулятор и журнал событий)
    const values = sh.getRange(this.STATE_FIRST_ROW, 1, CONFIG.DEBTS.length, 11).getValues();
    const known = CONFIG.DEBTS.map(function (d) { return d.id; });
    const debts = [];
    values.forEach(function (r, i) {
      if (known.indexOf(String(r[0])) === -1) return;
      debts.push({
        row: DebtEngine.STATE_FIRST_ROW + i,
        id: String(r[0]),
        name: String(r[1] || ''),
        balance: Number(r[2]) || 0,
        payment: Number(r[3]) || 0,
        rate: Number(r[4]) || 0,
        type: String(r[5] || 'monthly'),
        paymentsMade: Number(r[6]) || 0,
        initialBalance: Number(r[7]) || 0,
        epoch: r[8] instanceof Date ? r[8] : new Date(String(r[8])),
        maturity: r[9] ? (r[9] instanceof Date ? r[9] : new Date(String(r[9]))) : null,
      });
    });
    return debts;
  },

  getDebt: function (id) {
    const key = String(id || '').toUpperCase();
    const list = this.getDebts().filter(function (d) { return d.id === key; });
    if (!list.length) throw new Error('Ипотека не найдена: ' + id + ' (доступны SBER, TBANK)');
    return list[0];
  },

  getEvents: function () {
    const rows = readRange_(SHEETS.DEBTS, this.LOG_FIRST_ROW);
    const events = [];
    rows.forEach(function (r) {
      if (!r[0] || !r[1]) return;
      events.push({
        date: r[0] instanceof Date ? r[0] : new Date(String(r[0])),
        debt: String(r[1]),
        event: String(r[2]),
        amount: Number(r[3]) || 0,
      });
    });
    events.sort(function (a, b) { return a.date - b.date; });
    return events;
  },

  initialPayment_: function (debtId) {
    const cfg = this.cfgById_(debtId);
    return cfg ? cfg.payment_amount_rub : 0;
  },

  // ── replay: журнал → живое состояние ──

  replayAll: function () {
    const events = this.getEvents();
    const debts = this.getDebts();
    const sh = sheet_(SHEETS.DEBTS);
    const now = fmtISO_(new Date());

    debts.forEach(function (debt) {
      const ppy = DebtEngine.periodsPerYear_(debt.type);
      const r = debt.rate / ppy;
      let balance = debt.initialBalance;
      let payment = DebtEngine.initialPayment_(debt.id);
      let made = 0;
      const n0 = DebtEngine.derivePeriods_(debt.initialBalance, debt.rate, ppy, payment);
      let n0Eff = n0; // эффективно смещается событиями reconcile

      events.forEach(function (ev) {
        if (ev.debt !== debt.id || !ev.amount) return;
        if (ev.event === 'payment') {
          const interest = balance * r;
          balance = Math.max(0, balance - Math.max(0, ev.amount - interest));
          made += 1;
        } else if (ev.event === 'prepay') {
          balance = Math.max(0, balance - ev.amount);
          const nLeft = Math.max(0, n0Eff - made);
          payment = DebtEngine.annuityPayment_(balance, debt.rate, ppy, nLeft); // срок сохраняется
        } else if (ev.event === 'reconcile') {
          // сверка с банком: факт главнее; платёж не меняется, срок пересчитывается
          balance = Math.max(0, ev.amount);
          n0Eff = made + DebtEngine.derivePeriods_(balance, debt.rate, ppy, payment);
        }
      });

      sh.getRange(debt.row, 3).setValue(balance);
      sh.getRange(debt.row, 4).setValue(payment);
      sh.getRange(debt.row, 7).setValue(made);
      sh.getRange(debt.row, 11).setValue(now);
      debt.balance = balance;
      debt.payment = payment;
      debt.paymentsMade = made;
      debt.periodsPerYear = ppy;
      debt.remainingPeriods = n0 - made;
    });

    this.refreshDerivedState_();
    return this.getDebts();
  },

  /** Обновляет ячейку B7 (n) ЧДП-калькулятора и возвращает долги с полями проекций. */
  refreshDerivedState_: function () {
    const debts = this.getDebts();
    const sber = debts.filter(function (d) { return d.id === 'SBER'; })[0];
    if (sber) {
      // оставшийся срок = инверсия аннуитета от текущего (баланс, ставка, платёж):
      // консистентно и после ЧДП, и после reconcile
      const n = this.derivePeriods_(sber.balance, sber.rate, 12, sber.payment);
      sheet_(SHEETS.DEBTS).getRange('B7').setValue(Math.round(n * 10) / 10);
    }
  },

  // ── операции ──

  appendEvent_: function (debtId, event, amountRUB, source, dateOverride) {
    const when = dateOverride instanceof Date ? dateOverride : new Date();
    sheet_(SHEETS.DEBTS).appendRow([
      when, debtId, event, Number(amountRUB) || 0, '', '', source || 'manual',
    ]);
    return when;
  },

  /** ЧДП: списание из тела + пересчёт платежа с сохранением срока. Возвращает сводку. */
  registerPrepay: function (debtId, amountRUB) {
    const self = this;
    return runWithLock_(function () {
      const debt = self.getDebt(debtId);
      const amount = Number(amountRUB);
      if (!isFinite(amount) || amount <= 0) throw new Error('Сумма ЧДП должна быть положительным числом');
      if (amount > debt.balance) throw new Error('Сумма ЧДП (' + fmtMoney_(amount, 'RUB') + ') больше остатка долга (' + fmtMoney_(debt.balance, 'RUB') + ')');

      const paymentBefore = debt.payment;
      const balanceBefore = debt.balance;

      // сразу пишем событие, затем журнал-обложка: последняя строка лога получает after-значения
      self.appendEvent_(debt.id, 'prepay', amount, 'manual');
      self.replayAll();
      const after = self.getDebt(debt.id);

      // дозаполняем Balance After / Payment After в строке события
      const sh = sheet_(SHEETS.DEBTS);
      const lastRow = sh.getLastRow();
      sh.getRange(lastRow, 5, 1, 2).setValues([[after.balance, after.payment]]);

      return {
        id: debt.id,
        name: debt.name,
        amount: amount,
        balanceBefore: balanceBefore,
        balanceAfter: after.balance,
        paymentBefore: paymentBefore,
        paymentAfter: after.payment,
        paymentSaved: paymentBefore - after.payment,
      };
    });
  },

  /** Ручная отметка планового платежа (если авто-ролл не сработал или сумма иная). */
  logPayment: function (debtId, amountRUB) {
    const self = this;
    return runWithLock_(function () {
      const debt = self.getDebt(debtId);
      const amount = amountRUB === undefined || amountRUB === null || amountRUB === ''
        ? debt.payment
        : Number(amountRUB);
      self.appendEvent_(debt.id, 'payment', amount, 'manual');
      self.replayAll();
      const after = self.getDebt(debt.id);
      const sh = sheet_(SHEETS.DEBTS);
      sh.getRange(sh.getLastRow(), 5, 1, 2).setValues([[after.balance, after.payment]]);
      return after;
    });
  },

  /**
   * Сверка с банком (P1 + Vision): установить ФАКТИЧЕСКИЙ остаток долга из
   * приложения банка. Платёж не меняется — срок пересчитывается.
   * Возвращает { before, after, drift, projection }.
   */
  reconcile: function (debtId, actualBalanceRUB) {
    const self = this;
    return runWithLock_(function () {
      const debt = self.getDebt(debtId);
      const actual = Number(actualBalanceRUB);
      if (!isFinite(actual) || actual < 0) throw new Error('Остаток должен быть неотрицательным числом');
      const before = debt.balance;
      if (Math.abs(before - actual) < 1) {
        return { id: debt.id, name: debt.name, before: before, after: before, drift: 0, unchanged: true };
      }
      self.appendEvent_(debt.id, 'reconcile', actual, 'vision-reconcile');
      self.replayAll();
      const after = self.getDebt(debt.id);
      const sh = sheet_(SHEETS.DEBTS);
      sh.getRange(sh.getLastRow(), 5, 1, 2).setValues([[after.balance, after.payment]]);
      const proj = self.projection(after, 0);
      const bigDrift = Math.abs(actual - before) > before * 0.2; // >20% — подозрительно много
      MetricsEngine.log('recon_drift:' + debt.id + ':' + fmtMonthKey_(new Date()), Math.round(Math.abs(before - actual)));
      logOps_(bigDrift ? 'WARN' : 'INFO', 'reconcile',
        debt.id + ': ' + Math.round(before) + ' → ' + Math.round(actual) + ' ₽' + (bigDrift ? ' (расхождение >20%)' : ''));
      return {
        id: debt.id,
        name: debt.name,
        before: before,
        after: after.balance,
        drift: actual - before,
        unchanged: false,
        bigDrift: bigDrift,
        monthsLeft: proj.monthsLeft,
        payoffISO: proj.payoffISO,
      };
    });
  },

  // ── roll-forward: автопостановка наступивших плановых платежей ──

  checkDuePayments: function () {
    const self = this;
    return runWithLock_(function () {
      const posted = [];
      const events = self.getEvents();
      const today = new Date();

      self.getDebts().forEach(function (debt) {
        if (debt.type === 'monthly') {
          const dueDay = self.cfgById_(debt.id) ? self.cfgById_(debt.id).due_day : 25;
          const alreadyThisMonth = events.some(function (ev) {
            return ev.debt === debt.id && ev.event === 'payment' &&
              ev.date.getFullYear() === today.getFullYear() && ev.date.getMonth() === today.getMonth();
          });
          if (today.getDate() >= dueDay && !alreadyThisMonth) {
            self.appendEvent_(debt.id, 'payment', debt.payment, 'auto');
            posted.push(debt.id);
          }
        } else {
          // biweekly: каждые 14 дней от Epoch (первый платёж через 2 недели)
          const days = Math.floor((today - debt.epoch) / 86400000);
          const expected = Math.floor(days / 14);
          const logged = events.filter(function (ev) {
            return ev.debt === debt.id && ev.event === 'payment';
          }).length;
          let catchUp = Math.min(Math.max(expected - logged, 0), 2); // без пачки задним числом
          while (catchUp-- > 0) {
            self.appendEvent_(debt.id, 'payment', debt.payment, 'auto');
            posted.push(debt.id);
          }
        }
      });

      if (posted.length) {
        self.replayAll();
        const sh = sheet_(SHEETS.DEBTS);
        const from = sh.getLastRow() - posted.length + 1;
        const debts = self.getDebts();
        posted.forEach(function (id, i) {
          const d = debts.filter(function (x) { return x.id === id; })[0];
          sh.getRange(from + i, 5, 1, 2).setValues([[d.balance, d.payment]]);
        });
      }
      return posted;
    });
  },

  // ── агрегаты и проекции ──

  normalizedMonthlyRUB: function (debt) {
    return debt.type === 'biweekly' ? debt.payment * 26 / 12 : debt.payment;
  },

  totalDebtRUB: function (debts) {
    return (debts || this.getDebts()).reduce(function (s, d) { return s + d.balance; }, 0);
  },

  /** Проекция до полного погашения. extraMonthlyRUB — дополнительная досрочка в месяц. */
  projection: function (debt, extraMonthlyRUB) {
    const ppy = this.periodsPerYear_(debt.type);
    const r = debt.rate / ppy;
    const pmt = debt.payment + (Number(extraMonthlyRUB) || 0) * (12 / ppy); // нормализуем в период
    let balance = debt.balance;
    let totalInterest = 0;
    let periods = 0;
    while (balance > 0.01 && periods < 1200) {
      const interest = balance * r;
      totalInterest += interest;
      balance -= Math.max(0, pmt - interest);
      periods += 1;
    }
    const months = periods * (12 / ppy);
    const payoff = new Date();
    payoff.setMonth(payoff.getMonth() + Math.ceil(months));
    return {
      periodsLeft: periods,
      monthsLeft: Math.round(months * 10) / 10,
      payoffISO: fmtISO_(payoff),
      totalInterestRUB: Math.round(totalInterest),
      monthlyPaymentRUB: pmt,
    };
  },

  /** Арбитраж: сумма на вкладе против досрочки Сбербанка. */
  arbitrage: function (amountRUB) {
    const deposit = getSettingNum_('DEPOSIT_RATE_ANNUAL', CONFIG.ARBITRAGE.DEPOSIT_RATE_ANNUAL);
    const debts = this.getDebts();
    const bestRate = debts.reduce(function (m, d) { return Math.max(m, d.rate); }, 0);
    const best = debts.filter(function (d) { return d.rate === bestRate; })[0];
    const delta = amountRUB * (deposit - bestRate);
    return {
      depositRate: deposit,
      bestMortgageRate: bestRate,
      bestMortgageName: best ? best.name : '',
      amountRUB: amountRUB,
      depositYieldRUB: amountRUB * deposit,
      interestSavedRUB: amountRUB * bestRate,
      deltaRUB: delta,
      depositWins: delta > 0,
      verdict: delta > 0
        ? 'Deposit arbitrage active: ' + (deposit * 100).toFixed(1) + '% deposit yields +' +
          fmtMoney_(delta, 'RUB') + '/yr more than paying ' + (best ? best.name : 'mortgage') + ' early.'
        : 'Досрочное погашение выгоднее вклада (+' + fmtMoney_(-delta, 'RUB') + '/yr).',
    };
  },
};

// ════════════════════════════════════════════════════════════════════
// VisionParser.gs
// ════════════════════════════════════════════════════════════════════
/**
 * VisionParser.gs — мультимодальный парсер скриншотов банковских приложений.
 *
 * Провайдеры (авто-fallback):
 *   1) Google Gemini 2.0 Flash (AI Studio, free tier 15 RPM) — основной;
 *   2) Groq (console.groq.com, free tier) — резерв, если Gemini недоступен
 *      или его ключ не задан. Ключ GROQ_API_KEY в Script Properties (опционален).
 *
 * Различает типы экранов (screen_type):
 *   • expense_analytics — аналитика расходов за период (неделя/месяц) → Weekly_Expenses;
 *   • debt_balance      — экран остатка ипотеки → сверка Debt_Engine (кнопкой);
 *   • other             — не то и не другое.
 *
 * Алиасы категорий (P2): /alias "кафе" Питание — переименование применяется
 * к ответам модели до записи (словарь CAT_ALIAS_* в FX_and_Settings).
 */

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' +
  GEMINI_MODEL + ':generateContent';

/** Строгая JSON-схема: расходы (Workflow B) + остаток долга (сверка). */
const VISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    screen_type: { type: 'STRING', enum: ['expense_analytics', 'debt_balance', 'other'], description: 'Тип экрана на скриншоте' },
    period: { type: 'STRING', description: 'Период аналитики расходов, например "неделя" или "октябрь"' },
    total_spent: { type: 'NUMBER', description: 'Общая сумма расходов за период в исходной валюте' },
    currency: { type: 'STRING', enum: ['KGS', 'RUB', 'USD'] },
    top_categories: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          category: { type: 'STRING', description: 'Категория расходов, например Продукты, Кафе, Транспорт' },
          amount: { type: 'NUMBER', description: 'Сумма по категории в исходной валюте' },
        },
        required: ['category', 'amount'],
      },
    },
    is_full_month_analytics: { type: 'BOOLEAN', description: 'true, если аналитика за весь месяц, а не за неделю' },
    bank: { type: 'STRING', description: 'Банк приложения, если определим: Сбербанк/Sber, Т-Банк/T-Bank/Тинькофф, MBANK/Мбанк, другой' },
    debt_balance_rub: { type: 'NUMBER', description: 'Остаток основного долга (тела) по ипотеке/кредиту в RUB' },
  },
  required: ['screen_type'],
};

const VISION_PROMPT =
  'Ты — парсер финансовых скриншотов. Это скриншот мобильного банковского приложения ' +
  '(Сбербанк, Т-Банк, MBANK/Мбанк Кыргызстан или другое).\n' +
  'Сначала определи ТИП экрана:\n' +
  '• expense_analytics — экран аналитики/истории РАСХОДОВ за период;\n' +
  '• debt_balance — экран кредита/ипотеки с ОСТАТКОМ ДОЛГА;\n' +
  '• other — всё остальное (перевод, баланс карты, настройки).\n' +
  'Для аналитики расходов: найди общую сумму за период и разбивку по категориям. ' +
  'Валюта по символам: сом/с/KGS — KGS, ₽/руб — RUB, $ — USD.\n' +
  'Для остатка долга: найди «Остаток основного долга» или аналогичное поле (не платёж, не проценты!) и банк.\n' +
  'Не выдумывай числа: если поля нет — верни 0 или пустой массив. Отвечай строго JSON по схеме.';

/** Словарь переименований категорий (P2): /alias "из" "в" → CAT_ALIAS_из=в. */
function categoryAliases_() {
  const out = {};
  const settings = getSettings_();
  Object.keys(settings).forEach(function (k) {
    if (k.indexOf('CAT_ALIAS_') === 0) out[k.slice('CAT_ALIAS_'.length).toLowerCase()] = String(settings[k]);
  });
  return out;
}

function applyAliases_(categories) {
  const aliases = categoryAliases_();
  return categories.map(function (c) {
    const mapped = aliases[String(c.category || '').toLowerCase()];
    return mapped ? { category: mapped, amount: c.amount } : c;
  });
}

/**
 * Главная точка: скриншот → структурированный JSON.
 * Пробует Gemini, при неудаче — Groq. Бросает понятную ошибку, если оба недоступны.
 * @returns {{screen_type:string, period:string, total_spent:number, currency:string,
 *            top_categories:Array, is_full_month_analytics:boolean, bank:string,
 *            debt_balance_rub:number, provider:string}}
 */
function parseExpenseScreenshot_(base64, mime) {
  const errors = [];
  mime = mime || 'image/jpeg';

  const geminiKey = getProp_(PROP.GEMINI_KEY, '');
  if (geminiKey) {
    try {
      return parseWithGemini_(base64, mime, geminiKey);
    } catch (e) {
      errors.push('Gemini: ' + e.message);
    }
  } else {
    errors.push('Gemini: ключ не задан');
  }

  const groqKey = getProp_(PROP.GROQ_KEY, '');
  if (groqKey) {
    try {
      return parseWithGroq_(base64, mime, groqKey);
    } catch (e) {
      errors.push('Groq: ' + e.message);
    }
  }

  throw new Error('Разбор скриншота не удался. ' + errors.join('; '));
}

// ─────────────────────────── Gemini ───────────────────────────

function parseWithGemini_(base64, mime, key) {
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: VISION_PROMPT },
        { inline_data: { mime_type: mime, data: base64 } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      response_mime_type: 'application/json',
      response_schema: VISION_SCHEMA,
    },
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = UrlFetchApp.fetch(GEMINI_URL + '?key=' + key, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
        deadline: CONFIG.HTTP_TIMEOUT_MS / 1000,
      });
      const code = resp.getResponseCode();
      const text = resp.getContentText();
      if (code === 429 || code >= 500) {
        lastErr = new Error('временно недоступен (HTTP ' + code + ')');
        Utilities.sleep(1500);
        continue;
      }
      if (code !== 200) throw new Error('HTTP ' + code + ': ' + text.slice(0, 150));
      const json = JSON.parse(text);
      const part = json.candidates && json.candidates[0] && json.candidates[0].content &&
        json.candidates[0].content.parts && json.candidates[0].content.parts[0];
      if (!part || !part.text) throw new Error('пустой ответ модели');
      return sanitizeVision_(JSON.parse(part.text), 'gemini');
    } catch (e) {
      lastErr = e;
      if (String(e.message).indexOf('временно недоступен') === -1) break; // ретраим только 429/5xx
    }
  }
  throw lastErr || new Error('Gemini: неизвестная ошибка');
}

// ─────────────────────────── Groq (резерв) ───────────────────────────

function parseWithGroq_(base64, mime, key) {
  // Модель переопределяется свойством GROQ_MODEL (напр., на maverick) без правки кода
  const model = getProp_(PROP.GROQ_MODEL, '') || CONFIG.GROQ.MODEL;
  const body = {
    model: model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: VISION_PROMPT + '\nВерни JSON с полями: screen_type, period, total_spent, currency, top_categories[{category,amount}], is_full_month_analytics, bank, debt_balance_rub.' },
        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + base64 } },
      ],
    }],
  };

  const resp = UrlFetchApp.fetch(CONFIG.GROQ.URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
    deadline: CONFIG.HTTP_TIMEOUT_MS / 1000,
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code !== 200) throw new Error('HTTP ' + code + ': ' + text.slice(0, 150));
  const json = JSON.parse(text);
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('пустой ответ модели');
  return sanitizeVision_(JSON.parse(content), 'groq');
}

// ─────────────────────────── Санитайзинг ───────────────────────────

function sanitizeVision_(parsed, provider) {
  const screenType = ['expense_analytics', 'debt_balance', 'other'].indexOf(parsed.screen_type) >= 0
    ? parsed.screen_type : 'other';
  let total = Number(parsed.total_spent);
  // защита от миспарса: нереальные суммы (лишний ноль, копейки как рубли) → не trusting
  if (!isFinite(total) || total <= 0 || total > 5000000) total = 0;
  const balance = Number(parsed.debt_balance_rub);
  const cleanTotal = total;
  const categories = Array.isArray(parsed.top_categories)
    ? applyAliases_(parsed.top_categories
          .filter(function (c) { return c && isFinite(Number(c.amount)) && Number(c.amount) > 0 && Number(c.amount) <= cleanTotal * 1.5; })
          .slice(0, 5)
          .map(function (c) { return { category: String(c.category || '—'), amount: Number(c.amount) }; }))
      : [];
  return {
    provider: provider,
    screen_type: screenType,
    period: String(parsed.period || ''),
    total_spent: total,
    currency: ['KGS', 'RUB', 'USD'].indexOf(parsed.currency) >= 0 ? parsed.currency : 'KGS',
    top_categories: categories,
    is_full_month_analytics: parsed.is_full_month_analytics === true,
    bank: String(parsed.bank || ''),
    debt_balance_rub: isFinite(balance) && balance > 1000 && balance < 100000000 ? balance : 0,
  };
}

/** Определение ипотеки по названию банка из ответа модели. */
function debtIdFromBank_(bank) {
  const s = String(bank || '').toLowerCase();
  if (/(сбер|sber)/.test(s)) return 'SBER';
  if (/(т[-\s]?банк|tbank|тинькофф|t-bank)/.test(s)) return 'TBANK';
  return null;
}

/** Разбор введённого текста: "3200", "5 500 ₽", "5000 kgs". */
function parseTypedExpense_(text) {
  const amount = parseAmount_(text);
  if (amount === null || amount <= 0) return null;
  return { total_spent: amount, currency: detectCurrency_(text, 'RUB'), top_categories: [], period: 'текст' };
}

// ════════════════════════════════════════════════════════════════════
// InvestNetWorth.gs
// ════════════════════════════════════════════════════════════════════
/**
 * InvestNetWorth.gs — портфель (GOOGLEFINANCE) и Net Worth = (Cash + Portfolio) − Debt(USD).
 * Целевые доли: broad_market_etf 58% / growth_stocks 23% / crypto_assets 19%.
 */

const InvestNetWorth = {

  getPortfolio: function () {
    const rows = readRange_(SHEETS.PORTFOLIO, 2);
    const holdings = [];
    rows.forEach(function (r) {
      if (!r[0]) return;
      holdings.push({
        ticker: String(r[0]),
        assetClass: String(r[1] || ''),
        units: Number(r[2]) || 0,
        avgCost: Number(r[3]) || 0,
        price: Number(r[4]) || 0,
        valueUSD: Number(r[5]) || 0,
        pnlUSD: Number(r[6]) || 0,
        sharePct: Number(r[8]) || 0,
        targetPct: Number(r[9]) || 0,
        rebalanceUSD: Number(r[10]) || 0,
      });
    });
    const total = holdings.reduce(function (s, h) { return s + h.valueUSD; }, 0);

    const byClass = { broad_market_etf: 0, growth_stocks: 0, crypto_assets: 0 };
    holdings.forEach(function (h) {
      if (byClass[h.assetClass] !== undefined) byClass[h.assetClass] += h.valueUSD;
    });
    const target = {
      broad_market_etf: getSettingNum_('TARGET_ETF', CONFIG.INVEST_SPLIT.broad_market_etf),
      growth_stocks: getSettingNum_('TARGET_STOCKS', CONFIG.INVEST_SPLIT.growth_stocks),
      crypto_assets: getSettingNum_('TARGET_CRYPTO', CONFIG.INVEST_SPLIT.crypto_assets),
    };
    const drift = {};
    Object.keys(byClass).forEach(function (k) {
      drift[k] = { valueUSD: byClass[k], currentPct: total > 0 ? byClass[k] / total : 0, targetPct: target[k], deltaUSD: target[k] * total - byClass[k] };
    });
    return { holdings: holdings, totalUSD: total, byClass: byClass, target: target, drift: drift };
  },

  renderText: function () {
    const p = this.getPortfolio();
    const name = { broad_market_etf: 'ETF (broad market)', growth_stocks: 'Акции роста', crypto_assets: 'Крипта' };
    const L = ['💼 <b>Портфель</b>', 'Итого: <b>' + fmtMoney_(p.totalUSD, 'USD') + '</b>'];
    Object.keys(p.drift).forEach(function (k) {
      const d = p.drift[k];
      const arrow = Math.abs(d.deltaUSD) < 1 ? '✅' : (d.deltaUSD > 0 ? '⬆️ докупить ' + fmtMoney_(d.deltaUSD, 'USD') : '⬇️ лишние ' + fmtMoney_(-d.deltaUSD, 'USD'));
      L.push('• ' + name[k] + ': ' + fmtMoney_(d.valueUSD, 'USD') + ' (' + fmtPct_(d.currentPct) +
        ' / цель ' + fmtPct_(d.targetPct) + ') ' + arrow);
    });
    const top = p.holdings.filter(function (h) { return h.valueUSD > 0; })
      .sort(function (a, b) { return b.valueUSD - a.valueUSD; }).slice(0, 8);
    if (top.length) {
      L.push('Топ позиций:');
      top.forEach(function (h) {
        L.push('  ' + h.ticker + ': ' + fmtMoney_(h.valueUSD, 'USD') + ' (PnL ' + fmtMoney_(h.pnlUSD, 'USD') + ')');
      });
    } else {
      L.push('ℹ️ Заполните Units и Avg Buy в листе Portfolio — цены подтягиваются GOOGLEFINANCE.');
    }
    return L.join('\n');
  },

  /** Мультивалютный кэш: CASH_USD + CASH_EUR + CASH_RUB + CASH_KGS → USD. */
  cashBreakdown_: function (fx) {
    fx = fx || getFx_();
    const raw = {
      USD: getSettingNum_('CASH_USD', 0),
      EUR: getSettingNum_('CASH_EUR', 0),
      RUB: getSettingNum_('CASH_RUB', 0),
      KGS: getSettingNum_('CASH_KGS', 0),
    };
    const usd = {
      USD: raw.USD,
      EUR: raw.EUR * fx.EURUSD,
      RUB: raw.RUB / fx.USDRUB,
      KGS: raw.KGS / fx.USDKGS,
    };
    return { raw: raw, usd: usd, totalUSD: usd.USD + usd.EUR + usd.RUB + usd.KGS };
  },

  /** Вклады как актив (лист Deposits): только Active. */
  depositsSummary: function () {
    const fx = getFx_();
    let totalUSD = 0, weighted = 0, sumOriginal = 0, count = 0;
    const names = [];
    readRange_(SHEETS.DEPOSITS, 2).forEach(function (r) {
      const active = r[6] === true || String(r[6]).toUpperCase() === 'TRUE';
      if (!active) return;
      const amount = Number(r[2]) || 0;
      const cur = String(r[3] || 'RUB').toUpperCase();
      const rate = Number(r[4]) || 0;
      totalUSD += convert_(amount, cur, 'USD', fx);
      weighted += amount * rate;
      sumOriginal += amount;
      count += 1;
      if (names.length < 3) names.push(String(r[1] || 'Вклад'));
    });
    return {
      count: count,
      totalUSD: totalUSD,
      avgRate: sumOriginal > 0 ? weighted / sumOriginal : 0,
      names: names,
    };
  },

  netWorth: function () {
    const fx = getFx_();
    const cash = this.cashBreakdown_(fx);
    const deposits = this.depositsSummary();
    const portfolio = this.getPortfolio().totalUSD;
    const debtRUB = DebtEngine.totalDebtRUB();
    const debtUSD = debtRUB / fx.USDRUB;
    return {
      date: fmtISO_(new Date()),
      cashUSD: cash.totalUSD,
      cashRaw: cash.raw,
      depositsUSD: deposits.totalUSD,
      portfolioUSD: portfolio,
      debtRUB: debtRUB,
      debtUSD: debtUSD,
      netWorthUSD: cash.totalUSD + deposits.totalUSD + portfolio - debtUSD,
      fx: fx,
    };
  },

  renderNetWorthText: function (nw) {
    const cash = this.cashBreakdown_(nw.fx);
    const parts = [];
    if (cash.raw.EUR) parts.push(fmtMoney_(cash.raw.EUR, 'EUR'));
    if (cash.raw.RUB) parts.push(fmtMoney_(cash.raw.RUB, 'RUB'));
    if (cash.raw.KGS) parts.push(fmtMoney_(cash.raw.KGS, 'KGS'));
    if (cash.raw.USD) parts.push(fmtMoney_(cash.raw.USD, 'USD'));
    const dep = this.depositsSummary();
    return '🧮 <b>Net Worth</b>\n' +
      '💵 Cash: ' + fmtMoney_(nw.cashUSD, 'USD') +
      (parts.length > 1 ? ' (' + parts.join(' · ') + ')' : '') + '\n' +
      '🏦 Вклады: ' + (dep.count ? fmtMoney_(dep.totalUSD, 'USD') + ' (' + dep.count + ' шт.)' : 'нет — учтите в листе Deposits') + '\n' +
      '💼 Portfolio: ' + fmtMoney_(nw.portfolioUSD, 'USD') + '\n' +
      '🏚 Долг: −' + fmtMoney_(nw.debtUSD, 'USD') + ' (' + fmtMoney_(nw.debtRUB, 'RUB') + ')\n' +
      '➖➖➖➖➖➖➖➖➖➖\n' +
      (nw.netWorthUSD >= 0 ? '🟢' : '🔴') + ' <b>' + fmtMoney_(nw.netWorthUSD, 'USD') + '</b>';
  },

  /** Ежедневный снапшот (upsert по дате). Колонки: Cash | Deposits | Portfolio | Debt ₽ | Debt $ | NetWorth. */
  takeSnapshot: function () {
    const self = this;
    return runWithLock_(function () {
      const nw = self.netWorth();
      const sh = sheet_(SHEETS.NETWORTH);
      const today = fmtISO_(new Date());
      const last = sh.getLastRow();
      if (last >= 2) {
        const dates = sh.getRange(2, 1, last - 1, 1).getValues();
        for (let i = 0; i < dates.length; i++) {
          const d = dates[i][0];
          const iso = d instanceof Date ? fmtISO_(d) : String(d);
          if (iso === today) {
            sh.getRange(2 + i, 2, 1, 6).setValues([[
              round2_(nw.cashUSD), round2_(nw.depositsUSD), round2_(nw.portfolioUSD),
              round2_(nw.debtRUB), round2_(nw.debtUSD), round2_(nw.netWorthUSD),
            ]]);
            return nw;
          }
        }
      }
      sh.appendRow([new Date(), round2_(nw.cashUSD), round2_(nw.depositsUSD), round2_(nw.portfolioUSD),
        round2_(nw.debtRUB), round2_(nw.debtUSD), round2_(nw.netWorthUSD)]);
      return nw;
    });
  },

  /** История для графика Mini App (последние limit записей). */
  history: function (limit) {
    const rows = readRange_(SHEETS.NETWORTH, 2)
      .filter(function (r) { return r[0]; })
      .map(function (r) {
        const d = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
        // NetWorth в колонке F (6); при новых 7-колоночных строках — G (7)
        const net = Number(r[6]) || Number(r[5]) || 0;
        return { date: fmtISO_(d), netWorthUSD: net };
      });
    return rows.slice(-(limit || 90));
  },

  /** Кэш в конкретной валюте: /cash 12000 kgs → CASH_KGS = 12000 (перезапись). */
  setCash: function (amount, currency) {
    const cur = (currency || 'USD').toUpperCase();
    if (['USD', 'EUR', 'RUB', 'KGS'].indexOf(cur) === -1) throw new Error('Валюта кэша: USD/EUR/RUB/KGS');
    setSetting_('CASH_' + cur, round2_(Number(amount)));
    return this.cashBreakdown_().totalUSD;
  },
};

// ════════════════════════════════════════════════════════════════════
// FXAnalytics.gs
// ════════════════════════════════════════════════════════════════════
/**
 * FXAnalytics.gs — анализ стоимости валют, статистический прогноз и
 * рекомендации по таймингу конвертаций.
 *
 * Данные: лист FX_History — 180 дней ежедневных закрытий GOOGLEFINANCE
 * (EURUSD, USDRUB, USDKGS, EURRUB). EUR/KGS считается кроссом EURUSD×USDKGS.
 *
 * Для каждой конвертации пользователя (EUR→RUB ипотеки, EUR→KGS жизнь,
 * EUR→USD инвестиции) движок отвечает на вопрос «выгодно ли менять сейчас»:
 *   • перцентиль текущего курса в 180-дневном диапазоне (0 — минимум, 100 — максимум);
 *   • RSI(14) — перекупленность/перепроданность;
 *   • SMA20/SMA50 — направление тренда;
 *   • волатильность (σ дневных доходностей, приведена к 30 дням);
 *   • прогноз на 7/30 дней: линейная регрессия ± σ√h (статистика, не гарантия).
 *
 * Логика рекомендации (продаём EUR за X — высокий курс = выгодно):
 *   перцентиль ≥ 70 → конвертировать сейчас; 45–69 → дробить 50/50;
 *   30–44 → по возможности отложить; < 30 → отложить (кроме обязательных платежей).
 */

const FXAnalytics = {

  // ── чтение серий ──

  readSeries_: function (col) {
    const sh = sheet_(SHEETS.FX_HISTORY);
    const last = sh.getLastRow();
    if (last < 4) return [];
    const vals = sh.getRange(4, col, last - 3, 2).getValues(); // строка 3 — заголовок спилла
    const out = [];
    vals.forEach(function (r) {
      if (r[0] instanceof Date && typeof r[1] === 'number' && r[1] > 0) {
        out.push({ date: fmtISO_(r[0]), v: r[1] });
      }
    });
    return out;
  },

  /** Кросс-курс a×b по совпадающим датам (напр. EURKGS = EURUSD × USDKGS). */
  cross_: function (a, b) {
    const mapB = {};
    b.forEach(function (x) { mapB[x.date] = x.v; });
    const out = [];
    a.forEach(function (x) {
      if (mapB[x.date] !== undefined) out.push({ date: x.date, v: x.v * mapB[x.date] });
    });
    return out;
  },

  // ── статистика ──

  mean_: function (a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; },

  std_: function (a) {
    if (a.length < 2) return 0;
    const m = this.mean_(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  },

  sma_: function (closes, n) {
    return this.mean_(closes.slice(-Math.min(n, closes.length)));
  },

  /** RSI(14), простое усреднение (Wilder сглаживается на длине окна 180 дней). */
  rsi_: function (closes, period) {
    period = period || 14;
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
  },

  /** Наклон линейной регрессии за последние n точек, в относительном выражении/день. */
  slopeRel_: function (closes, n) {
    const win = closes.slice(-Math.min(n, closes.length));
    const len = win.length;
    if (len < 3) return 0;
    const cur = win[len - 1];
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < len; i++) {
      sx += i; sy += win[i]; sxy += i * win[i]; sxx += i * i;
    }
    const denom = len * sxx - sx * sx;
    if (denom === 0) return 0;
    return ((len * sxy - sx * sy) / denom) / cur;
  },

  /** Прогноз: середина = тренд, границы = ±σ√h (σ — дневная доходность). */
  forecast_: function (closes, horizonDays) {
    const cur = closes[closes.length - 1];
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
    const sigma = this.std_(rets.slice(-30));
    const slope = this.slopeRel_(closes, 30);
    const h = horizonDays;
    const mid = cur * (1 + slope * h);
    const band = sigma * Math.sqrt(h);
    return {
      low: Math.round(cur * (1 + slope * h - band) * 1e4) / 1e4,
      mid: Math.round(mid * 1e4) / 1e4,
      high: Math.round(cur * (1 + slope * h + band) * 1e4) / 1e4,
    };
  },

  stats_: function (series) {
    const closes = series.map(function (x) { return x.v; });
    const n = closes.length;
    if (n < 30) return null;
    const cur = closes[n - 1];
    const sorted = closes.slice().sort(function (a, b) { return a - b; });
    const percentile = Math.round(100 * sorted.filter(function (v) { return v <= cur; }).length / n);
    const mean180 = this.mean_(closes);
    const std180 = this.std_(closes);
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
    const sigma = this.std_(rets.slice(-30));
    const slope30 = this.slopeRel_(closes, 30);
    const band30 = sigma * Math.sqrt(30);
    return {
      current: cur,
      digits: cur > 20 ? 2 : 4,
      min: sorted[0],
      max: sorted[n - 1],
      percentile: percentile,
      z180: std180 > 0 ? (cur - mean180) / std180 : 0,
      move30: slope30 * 30,        // ожидаемое смещение за 30д по тренду
      band30: band30,              // собственный шум за 30д (±σ)
      sma20: this.mean_(closes.slice(-20)),
      sma50: this.mean_(closes.slice(-50)),
      trendUp: this.sma_(closes, 20) > this.sma_(closes, 50),
      change30dPct: n > 30 ? (cur / closes[n - 31] - 1) : 0,
      rsi14: Math.round(this.rsi_(closes, 14)),
      vol30dPct: Math.round(sigma * Math.sqrt(30) * 10000) / 100,
      forecast7d: this.forecast_(closes, 7),
      forecast30d: this.forecast_(closes, 30),
      series: closes.slice(-90),
    };
  },

  /** Рекомендация: высокий курс = выгодно продавать EUR за эту валюту. */
  signal_: function (st) {
    // боковик: тренд за 30д тише собственного шума, курс у среднего —
    // тайминг не имеет смысла, всегда нейтрально
    const sideways = Math.abs(st.z180) < 0.5 ||
      (st.band30 > 0 && Math.abs(st.move30) < 0.5 * st.band30);
    if (sideways) return { signal: 'split', text: 'Нейтрально (боковик) — меняйте частями 50/50' };
    let score = st.percentile;
    if (st.rsi14 >= 65) score += 5;       // сильный импульс вверх
    if (st.rsi14 <= 35) score -= 5;       // перепроданность — вероятен откат вверх
    if (score >= 70) return { signal: 'convert', text: 'Курс высокий — конвертируйте сейчас' };
    if (score >= 45) return { signal: 'split', text: 'Нейтрально — меняйте частями 50/50' };
    if (score >= 30) return { signal: 'wait', text: 'Ниже среднего — по возможности отложите' };
    return { signal: 'hold', text: 'Низкий диапазон — отложите (кроме обязательных платежей)' };
  },

  makeAction_: function (series, key, label, purpose, emoji) {
    const st = this.stats_(series);
    if (!st) return null;
    const sig = this.signal_(st);
    return {
      key: key, label: label, purpose: purpose, emoji: emoji,
      current: st.current, digits: st.digits, min: st.min, max: st.max,
      percentile: st.percentile, rsi14: st.rsi14, change30d_pct: Math.round(st.change30dPct * 1000) / 10,
      vol30d_pct: st.vol30dPct, trend_up: st.trendUp,
      signal: sig.signal, signal_text: sig.text,
      forecast7d: st.forecast7d, forecast30d: st.forecast30d,
      series: st.series,
    };
  },

  // ── публичное API ──

  build: function () {
    const eur = this.readSeries_(1);
    const usdRub = this.readSeries_(4);
    const usdKgs = this.readSeries_(7);
    const eurRub = this.readSeries_(10);
    const eurKgs = this.cross_(eur, usdKgs);

    if (eur.length < 30 || usdRub.length < 30) {
      return { ok: false, note: 'FX_History ещё не заполнен: откройте этот лист в таблице, чтобы GOOGLEFINANCE рассчитал историю (или выполните setup()).' };
    }

    const actions = [
      this.makeAction_(eurRub, 'eur_rub', 'EUR → RUB', 'платежи по ипотекам (Сбер / Т-Банк)', '🏦'),
      this.makeAction_(eurKgs, 'eur_kgs', 'EUR → KGS', 'жизнь, MBANK', '🛒'),
      this.makeAction_(eur, 'eur_usd', 'EUR → USD', 'инвестиции (DCA) и база учёта', '📈'),
    ].filter(Boolean);

    const rawShort = function (series) {
      const st = FXAnalytics.stats_(series);
      return st ? {
        current: st.current, change30d_pct: Math.round(st.change30dPct * 1000) / 10,
        percentile: st.percentile, rsi14: st.rsi14,
      } : null;
    };

    return {
      ok: true,
      generated_at: nowTz_(),
      actions: actions,
      raw: { EURUSD: rawShort(eur), USDRUB: rawShort(usdRub), USDKGS: rawShort(usdKgs), EURRUB: rawShort(eurRub) },
      disclaimer: 'Статистическая модель (перцентиль + тренд + волатильность). Не является инвестиционной рекомендацией.',
    };
  },

  renderText: function (a) {
    if (!a.ok) return '💱 ' + a.note;
    const L = ['💱 <b>Валютный анализ</b> · ' + a.generated_at];
    a.actions.forEach(function (x) {
      const arrow = x.change30d_pct >= 0 ? '▲' : '▼';
      L.push(x.emoji + ' <b>' + x.label + '</b> (' + x.purpose + '): <b>' +
        fmtMoney_(x.current, x.label.indexOf('RUB') > -1 ? 'RUB' : x.label.indexOf('KGS') > -1 ? 'KGS' : 'USD') + '</b>');
      L.push('     ' + arrow + ' ' + (x.change30d_pct >= 0 ? '+' : '') + fmtPct_(x.change30d_pct / 100) +
        ' за 30д · ' + x.percentile + '-й перцентиль · RSI ' + x.rsi14 +
        ' · тренд ' + (x.trend_up ? 'вверх' : 'вниз'));
      L.push('     ➜ <b>' + x.signal_text + '</b>');
      L.push('     Прогноз 30д: ' + x.forecast30d.low + ' – ' + x.forecast30d.high +
        ' (±σ, модель)' + (x.signal === 'split' ? ' — вторую половину меняйте по графику' : ''));
    });
    L.push('');
    L.push('⚠️ ' + a.disclaimer);
    L.push('ℹ️ Обязательные платежи (алименты, английский, ипотека к дате) конвертируйте в срок — тайминг вторичен.');
    return L.join('\n');
  },

  /** Ежедневное обновление формул истории (форсирует пересчёт GOOGLEFINANCE). */
  refreshFormulas: function () {
    const sh = sheet_(SHEETS.FX_HISTORY);
    FX_HISTORY_BLOCKS.forEach(function (b) {
      sh.getRange(b.anchor).setFormula(
        '=GOOGLEFINANCE("CURRENCY:' + b.pair + '","price",TODAY()-180,TODAY(),"DAILY")'
      );
    });
    SpreadsheetApp.flush();
  },

  /**
   * Push-алерты по валютам (P0): вызывается из dailyMaintenance.
   * Верхняя зона (перцентиль ≥ HIGH): «выгодное окно конвертации».
   * Нижняя зона (≤ LOW): «отложите конвертации» (информационно).
   * Кулдаун COOLDOWN_DAYS дней на пару и тип, чтобы не спамить.
   */
  checkAlerts: function () {
    const cfg = CONFIG.FX_ALERTS;
    const chatId = getProp_(PROP.CHAT_ID, '');
    if (!chatId) return [];
    const a = this.build();
    if (!a.ok) return [];
    const sent = [];

    a.actions.forEach(function (action) {
      if (cfg.ACTIONS.indexOf(action.key) === -1) return;
      const kind = action.percentile >= cfg.HIGH_PERCENTILE ? 'hi' :
        (action.percentile <= cfg.LOW_PERCENTILE ? 'lo' : null);
      if (!kind) return;

      const cooldownKey = 'FXALERT_' + action.key + '_' + kind;
      const lastStr = getSetting_(cooldownKey, '');
      const last = lastStr ? new Date(String(lastStr)) : null;
      const daysSince = last && !isNaN(last) ? Math.floor((new Date() - last) / 86400000) : Infinity;
      if (daysSince < cfg.COOLDOWN_DAYS) return;

      const curLabel = action.label.indexOf('RUB') > -1 ? '₽' : action.label.indexOf('KGS') > -1 ? 'сом' : '$';
      let text;
      if (kind === 'hi') {
        text = '🟢 <b>Выгодное окно конвертации ' + action.emoji + ' ' + action.label + '</b>\n' +
          'Курс ' + fmtMoney_(action.current, curLabel === '$' ? 'USD' : action.label.indexOf('RUB') > -1 ? 'RUB' : 'KGS') +
          ' — ' + action.percentile + '-й перцентиль за 180 дней (RSI ' + action.rsi14 + ').\n' +
          (action.key === 'eur_rub' ? 'Хороший момент продать EUR против платежей по ипотекам.' :
           'Хороший момент обменять EUR на жизнь/MBANK.') + '\n\n' + action.signal_text + '\n/fx — детали';
      } else {
        text = '🔴 <b>Курс ' + action.emoji + ' ' + action.label + ' в нижней зоне</b>\n' +
          'Перцентиль ' + action.percentile + '/100 — по возможности отложите конвертацию ' +
          '(кроме обязательных платежей).\n/fx — детали';
      }
      sendMessage_(chatId, text);
      setSetting_(cooldownKey, fmtISO_(new Date()));
      MetricsEngine.log('fx_alert:' + action.key + ':' + kind, fmtISO_(new Date()));
      sent.push(action.key + ':' + kind);
    });
    return sent;
  },
};

// ════════════════════════════════════════════════════════════════════
// MetricsEngine.gs
// ════════════════════════════════════════════════════════════════════
/**
 * MetricsEngine.gs — продуктовые метрики и месячный digest «факт vs план».
 *
 * Лист Metrics: Date | Key | Value. Ключи:
 *   weekly_ask:<weekKey>     — воскресный опрос отправлен
 *   weekly_answer:<weekKey>  — пользователь ответил (число/скрин) в течение недели
 *   cascade_applied:<month>  — каскад месяца применён кнопкой Apply
 *   recon_ok:<month>         — ипотеки сверены с банком
 *   recon_drift:<id>:<month> — расхождение при сверке, Value = |Δ| ₽
 *   vision_fix:<date>        — исправление категории вручную (/alias)
 *   savings_rate:<month>     — (доход − расходы)/доход, Value = доля
 *   fx_alert:<pair>:<hi|lo>  — отправлен алерт по валюте (для кулдауна)
 *
 * Digest присылается утром последнего дня месяца: план против факта + метрики.
 */

const MetricsEngine = {

  log: function (key, value) {
    sheet_(SHEETS.METRICS).appendRow([new Date(), key, String(value)]);
  },

  /** Записать метрику, только если такой (key) ещё нет за указанный период. */
  logOnce: function (key, value) {
    const self = this;
    return runWithLock_(function () {
      const rows = readRange_(SHEETS.METRICS, 2);
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][1]) === key) {
          if (rows[i][2] !== undefined && String(rows[i][2]) !== '') return false;
        }
      }
      self.log(key, value);
      return true;
    });
  },

  /** Все значения с данным префиксом ключа. */
  byPrefix: function (prefix) {
    const out = [];
    readRange_(SHEETS.METRICS, 2).forEach(function (r) {
      const k = String(r[1] || '');
      if (k.indexOf(prefix) === 0) out.push({ key: k, value: String(r[2]), date: r[0] });
    });
    return out;
  },

  value: function (key) {
    const rows = this.byPrefix(key);
    return rows.length ? rows[rows.length - 1].value : null;
  },

  // ── Производные метрики ──

  /** % недель с ответом среди отправленных опросов. */
  weeklyResponseRate: function () {
    const asks = this.byPrefix('weekly_ask:');
    if (!asks.length) return null;
    const answered = this.byPrefix('weekly_answer:');
    const answeredWeeks = {};
    answered.forEach(function (a) { answeredWeeks[a.key.replace('weekly_answer:', 'weekly_ask:')] = 1; });
    let hit = 0;
    asks.forEach(function (a) { if (answeredWeeks[a.key]) hit++; });
    return hit / asks.length;
  },

  /** Доля ручных исправлений категорий к числу vision-записей. */
  visionAccuracy: function () {
    const fixes = this.byPrefix('vision_fix:').length;
    let visionRows = 0;
    readRange_(SHEETS.WEEKLY, 2).forEach(function (r) {
      if (String(r[9] || '').indexOf('vision') === 0) visionRows++;
    });
    if (!visionRows) return null;
    return { fixes: fixes, visionRows: visionRows, fixRate: fixes / (fixes + visionRows) };
  },

  // ── Digest «факт vs план» (последний день месяца) ──

  buildMonthDigest: function () {
    const now = new Date();
    const monthKey = fmtMonthKey_(now);
    const fx = getFx_();
    const fxWarn = fx.FALLBACK_USED ? '\n⚠️ Курсы резервные — цифры примерные.' : '';

    // План: строка месяца в Monthly_Cycles
    let plan = null;
    readRange_(SHEETS.MONTHLY, 2).forEach(function (r) {
      if (String(r[0]) === monthKey) {
        plan = { incomeUSD: Number(r[3]) || 0, mandatoryUSD: Number(r[4]) || 0, surplusUSD: Number(r[5]) || 0, status: String(r[10] || '') };
      }
    });

    // Факт: траты месяца (Weekly_Expenses в ₽) + автоплатежи ипотек (журнал Debt_Engine)
    let livingRUB = 0;
    readRange_(SHEETS.WEEKLY, 2).forEach(function (r) {
      const d = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
      if (!isNaN(d) && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
        livingRUB += Number(r[3]) || 0;
      }
    });
    let mortgagesRUB = 0;
    DebtEngine.getEvents().forEach(function (ev) {
      if (ev.event === 'payment' && ev.date.getFullYear() === now.getFullYear() && ev.date.getMonth() === now.getMonth()) {
        mortgagesRUB += ev.amount;
      }
    });

    const L = ['📌 <b>Digest месяца ' + monthKey + '</b> (факт против плана)'];

    if (!plan) {
      L.push('⚠️ Строка месяца не найдена в Monthly_Cycles — доход не был записан через /income.');
    } else {
      const livingActualUSD = livingRUB / fx.USDRUB;
      const livingPlannedUSD = getSettingNum_('MONTHLY_CAP_RUB', 60000) / fx.USDRUB;
      // В листе Free Surplus = доход − обязательства (без лимита жизни).
      // Сравниваем «профицит после жизни» с планом «после жизни» — иначе
      // дайджест каждый месяц показывал бы ложное отставание на весь лимит.
      const surplusActual = plan.incomeUSD - plan.mandatoryUSD - livingActualUSD;
      const plannedAfterLiving = plan.surplusUSD - livingPlannedUSD;
      const surplusDelta = surplusActual - plannedAfterLiving;
      const savingsRate = plan.incomeUSD > 0 ? surplusActual / plan.incomeUSD : 0;

      L.push('💵 Доход: ' + fmtMoney_(plan.incomeUSD, 'USD') + (plan.status === 'applied' ? ' · каскад применён ✅' : ' · каскад НЕ применён ⚠️'));
      L.push('🧾 Обязательства (план): ' + fmtMoney_(plan.mandatoryUSD, 'USD'));
      L.push('🍽 Жизнь: план ' + fmtMoney_(livingPlannedUSD, 'USD') +
        ' → факт ' + fmtMoney_(livingActualUSD, 'USD') + ' (' + fmtMoney_(livingRUB, 'RUB') + ')' +
        (livingRUB > getSettingNum_('MONTHLY_CAP_RUB', 60000) ? ' ⚠️ перерасход' : ' ✅'));
      L.push('🏦 Ипотеки выплачено: ' + fmtMoney_(mortgagesRUB, 'RUB') + ' (' + fmtMoney_(mortgagesRUB / fx.USDRUB, 'USD') + ')');
      L.push('💚 Профицит (после жизни): план ' + fmtMoney_(plannedAfterLiving, 'USD') +
        ' → факт <b>' + fmtMoney_(surplusActual, 'USD') + '</b>' +
        ' (' + (surplusDelta >= 0 ? '+' : '') + fmtMoney_(surplusDelta, 'USD') + ')');
      L.push('📉 <b>Savings rate: ' + fmtPct_(savingsRate) + '</b>');

      this.logOnce('savings_rate:' + monthKey, Math.round(savingsRate * 1000) / 1000);
      this.logOnce('cascade_applied:' + monthKey + ':observed', plan.status === 'applied' ? 1 : 0);
    }

    // Метрики продукта
    const wrr = this.weeklyResponseRate();
    const va = this.visionAccuracy();
    const Lm = ['\n📊 <b>Метрики</b>'];
    Lm.push('Воскресные опросы: ответов ' + (wrr === null ? '—' : fmtPct_(wrr, 0)) +
      ' из отправленных (' + this.byPrefix('weekly_ask:').length + ' нед.)' + (wrr !== null && wrr < 0.8 ? ' ⚠️ цель >80%' : ''));
    if (va) Lm.push('Vision: исправлений категорий ' + va.fixes + ' из ' + (va.fixes + va.visionRows) + ' записей (' + fmtPct_(va.fixRate, 0) + ', цель <10%)');
    const reconCount = this.byPrefix('recon_ok:').filter(function (r) { return r.key === 'recon_ok:' + monthKey; }).length;
    Lm.push('Сверка ипотек в этом месяце: ' + (reconCount ? '✅ была' : 'не было'));

    return L.concat(Lm).join('\n') + fxWarn + '\n\n🗓 Завтра — новый месяц: запишите доход /income 6200 eur';
  },
};

/** Тест digest из редактора. */
function testDigest() {
  const chatId = getProp_(PROP.CHAT_ID, '');
  const text = MetricsEngine.buildMonthDigest();
  console.log(text.replace(/<[^>]+>/g, ''));
  if (chatId) sendMessage_(chatId, text);
}

// ════════════════════════════════════════════════════════════════════
// AnomalyEngine.gs
// ════════════════════════════════════════════════════════════════════
/**
 * AnomalyEngine.gs — детектор невозможных/подозрительных цифр.
 *
 * Зачем: за месяцы работы накапливаются ручные правки, слипшиеся формулы,
 * сбои GOOGLEFINANCE и опечатки в Quantity/суммах. Движок ежедневно проверяет
 * бизнес-инварианты и присылает владельцу только НОВЫЕ аномалии (кулдаун —
 * одни сутки на правило, чтобы не спамить), а всё пишет в Ops_Log.
 *
 * Правила:
 *   D1 crit  остаток ипотеки < 0 или > начального баланса (replay сломан)
 *   D2 crit  платёж Сбербанка вырос >5% без ЧДП/сверок (аннуитет «поплыл»)
 *   D3 warn  |расхождение при сверке| > 20% остатка (возможно, взяли не тот остаток)
 *   T1 warn  >3 событий Т-Банка за месяц (накопились авторолл-платежи)
 *   W1 warn  недельная трата > 4× недельного бюджета (месячную аналитику записали как неделю)
 *   W2 warn  расход жизни за месяц > 2× месячного лимита
 *   M1 warn  доход месяца < 0.3× или > 3× базового (опечатка 62000)
 *   M2 warn  профицит месяца (после жизни) хуже −$500 — дефицит
 *   N1 warn  Net Worth прыгнул >40% между снапшотами (сбой курса/опечатка в Quantity)
 *   P1 crit  позиция портфеля дороже $10 млн (опечатка в Units)
 *   F1 crit  текущий курс отклоняется >25% от медианы 30 дней (глюк GOOGLEFINANCE/кэша)
 *   X1 warn  история FX не обновлялась >5 дней (лист не открывали/формула мертва)
 */

const AnomalyEngine = {

  median_: function (arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  },

  /** Все проверки: [{id, sev:'crit'|'warn', text}] */
  run: function () {
    const out = [];
    const now = new Date();
    const monthKey = fmtMonthKey_(now);
    const push = function (id, sev, text) { out.push({ id: id, sev: sev, text: text }); };

    // ── Ипотеки ──
    try {
      const events = DebtEngine.getEvents();
      const hasAdjust = events.some(function (ev) {
        return ev.event === 'prepay' || ev.event === 'reconcile';
      });
      DebtEngine.getDebts().forEach(function (d) {
        if (d.balance < 0 || d.balance > d.initialBalance * 1.001) {
          push('D1', 'crit', d.name + ': остаток ' + fmtMoney_(d.balance, 'RUB') +
            ' вне диапазона [0; ' + fmtMoney_(d.initialBalance, 'RUB') + '] — проверьте журнал Debt_Engine');
        }
        const initialPmt = DebtEngine.initialPayment_(d.id);
        if (d.payment > initialPmt * 1.05 && !hasAdjust) {
          push('D2', 'crit', d.name + ': платёж ' + fmtMoney_(d.payment, 'RUB') +
            ' вырос против исходного ' + fmtMoney_(initialPmt, 'RUB') + ' без событий ЧДП/сверки');
        }
      });
      const tbankThisMonth = events.filter(function (ev) {
        return ev.debt === 'TBANK' && ev.event === 'payment' &&
          ev.date.getFullYear() === now.getFullYear() && ev.date.getMonth() === now.getMonth();
      }).length;
      if (tbankThisMonth > 3) {
        push('T1', 'warn', 'Т-Банк: ' + tbankThisMonth + ' платежей за месяц (норма 2–3) — проверьте Epoch/журнал');
      }
    } catch (e) { push('DX', 'warn', 'Ипотеки не проверены: ' + e.message); }

    // ── Расходы ──
    try {
      const weeklyBudget = getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB);
      const cap = getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB);
      let monthRUB = 0;
      readRange_(SHEETS.WEEKLY, 2).forEach(function (r) {
        const d = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
        if (isNaN(d)) return;
        const rub = Number(r[3]) || 0;
        if (rub > weeklyBudget * 4) {
          push('W1', 'warn', 'Трата ' + fmtISO_(d) + ': ' + fmtMoney_(rub, 'RUB') +
            ' > 4× недельного бюджета — похоже, месячную аналитику записали как недельную');
        }
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) monthRUB += rub;
      });
      if (monthRUB > cap * 2) {
        push('W2', 'warn', 'Расход жизни за месяц ' + fmtMoney_(monthRUB, 'RUB') +
          ' > 2× лимита (' + fmtMoney_(cap, 'RUB') + ') — проверьте записи Weekly_Expenses');
      }
    } catch (e) { push('WX', 'warn', 'Расходы не проверены: ' + e.message); }

    // ── Месяц ──
    try {
      const base = getSettingNum_('BASE_INCOME_USD', CONFIG.PROFILE.BASE_INCOME_USD);
      const cap = getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB);
      const fx = getFx_();
      readRange_(SHEETS.MONTHLY, 2).forEach(function (r) {
        if (String(r[0]) !== monthKey) return;
        const incomeUSD = Number(r[3]) || 0;
        const mandatory = Number(r[4]) || 0;
        if (incomeUSD > 0 && (incomeUSD < base * 0.3 || incomeUSD > base * 3)) {
          push('M1', 'warn', 'Доход месяца ' + fmtMoney_(incomeUSD, 'USD') +
            ' вне диапазона 0.3–3× базы (' + fmtMoney_(base, 'USD') + ') — опечатка в /income?');
        }
        const surplusAfterLiving = incomeUSD - mandatory - cap / fx.USDRUB;
        if (surplusAfterLiving < -500) {
          push('M2', 'warn', 'Профицит месяца после жизни: ' + fmtMoney_(surplusAfterLiving, 'USD') +
            ' (дефицит) — доход не покрывает обязательства');
        }
      });
    } catch (e) { push('MX', 'warn', 'Месяц не проверен: ' + e.message); }

    // ── Net Worth и портфель ──
    try {
      const hist = InvestNetWorth.history(2);
      if (hist.length === 2) {
        const prev = hist[0].netWorthUSD, last = hist[1].netWorthUSD;
        if (Math.abs(prev) > 100 && Math.abs(last - prev) / Math.abs(prev) > 0.4) {
          push('N1', 'warn', 'Net Worth прыгнул ' + fmtMoney_(prev, 'USD') + ' → ' + fmtMoney_(last, 'USD') +
            ' (>40% за день) — сбой курса или опечатка в Quantity/CASH');
        }
      }
      InvestNetWorth.getPortfolio().holdings.forEach(function (h) {
        if (h.valueUSD > 1e7) {
          push('P1', 'crit', 'Позиция ' + h.ticker + ': ' + fmtMoney_(h.valueUSD, 'USD') +
            ' — похоже, опечатка в Units');
        }
      });
    } catch (e) { push('NX', 'warn', 'Net Worth не проверен: ' + e.message); }

    // ── Курсы ──
    try {
      const fx = getFx_();
      const live = [
        { name: 'EUR/USD', cur: fx.EURUSD, series: FXAnalytics.readSeries_(1) },
        { name: 'USD/RUB', cur: fx.USDRUB, series: FXAnalytics.readSeries_(4) },
        { name: 'USD/KGS', cur: fx.USDKGS, series: FXAnalytics.readSeries_(7) },
      ];
      live.forEach(function (p) {
        if (p.series.length < 10) return;
        const med = AnomalyEngine.median_(p.series.slice(-30).map(function (x) { return x.v; }));
        if (med > 0 && Math.abs(p.cur - med) / med > 0.25) {
          push('F1', 'crit', p.name + ': текущий ' + p.cur + ' отклоняется >25% от медианы 30д (' +
            med.toFixed(p.cur > 20 ? 2 : 4) + ') — глюк GOOGLEFINANCE/резервных курсов, конвертации неверны');
        }
        const lastDate = new Date(p.series[p.series.length - 1].date);
        if ((now - lastDate) / 86400000 > 5) {
          push('X1', 'warn', p.name + ': история не обновлялась с ' + p.series[p.series.length - 1].date +
            ' (>5 дней) — откройте лист FX_History / проверьте формулы');
        }
      });
      if (fx.FALLBACK_USED) {
        push('F1', 'crit', 'Курсы идут на резервных значениях (GOOGLEFINANCE недоступен) — все конвертации примерные');
      }
    } catch (e) { push('FX', 'warn', 'Курсы не проверены: ' + e.message); }

    return out;
  },

  /** Проверить, записать в Ops_Log и уведомить о НОВЫХ (кулдаун 1 день на правило). */
  runAndNotify: function () {
    const chatId = getProp_(PROP.CHAT_ID, '');
    const found = this.run();
    const today = fmtISO_(new Date());
    found.forEach(function (f) {
      logOps_(f.sev === 'crit' ? 'ERROR' : 'WARN', 'anomaly', f.id + ': ' + f.text.replace(/<[^>]+>/g, ''));
      const key = 'ANOM_' + f.id;
      if (getSetting_(key, '') !== today) {
        setSetting_(key, today);
        if (chatId) {
          sendMessage_(chatId,
            (f.sev === 'crit' ? '🚫 <b>КРИТИЧНАЯ аномалия</b>' : '⚠️ <b>Аномалия</b>') + ' [' + f.id + ']\n' + f.text +
            '\n\nДетали: /anomalies · журнал: лист Ops_Log');
        }
      }
    });
    return found;
  },

  renderText: function () {
    const found = this.run();
    if (!found.length) return '✅ <b>Аномалий нет</b> — все инварианты соблюдены (' + nowTz_() + ').';
    return '🩺 <b>Проверка аномалий</b> · ' + nowTz_() + '\n\n' +
      found.map(function (f) {
        return (f.sev === 'crit' ? '🚫' : '⚠️') + ' <b>[' + f.id + ']</b> ' + f.text;
      }).join('\n\n');
  },
};

/** Ручной запуск проверки из редактора/бота. */
function testAnomalies() {
  const text = AnomalyEngine.renderText();
  console.log(text.replace(/<[^>]+>/g, ''));
  return text;
}

// ════════════════════════════════════════════════════════════════════
// TmaApi.gs
// ════════════════════════════════════════════════════════════════════
/**
 * TmaApi.gs — REST для Telegram Mini App.
 *
 * GET  ?action=overview            — полный срез данных (чтение, без авторизации)
 * GET  ?action=scenario&income=&cur=&extra_prepay_rub=&extra_dca_usd= — водопад сценария
 * POST {action, init_data, ...}    — записи (ЧДП, трата, кэш); требует валидный initData
 *
 * POST приходит с content-type text/plain (Mini App), чтобы избежать CORS-preflight,
 * который Apps Script не обслуживает. Тело парсится как JSON в doPost.
 */

function doGet(e) {
  const action = String((e && e.parameter && e.parameter.action) || 'health');
  try {
    // Чтение финансовых данных: если задан TMA_READ_TOKEN — требуем его или подпись initData
    if (action !== 'health' && !checkReadAccess_(e)) {
      return json_({ ok: false, error: 'unauthorized: нужен read_token (или откройте из Telegram)' });
    }
    if (action === 'overview') return json_(buildOverview_());
    if (action === 'scenario') {
      const p = e.parameter;
      const w = CashflowEngine.computeWaterfall({
        incomeAmount: p.income !== undefined && p.income !== '' ? Number(p.income) : null,
        incomeCurrency: p.cur || undefined,
        extraPrepayRUB: Number(p.extra_prepay_rub) || 0,
        extraDcaUSD: Number(p.extra_dca_usd) || 0,
      });
      return json_(waterfallPayload_(w));
    }
    if (action === 'health') {
      return json_({ ok: true, app: CONFIG.APP_NAME, version: CONFIG.VERSION, time: nowTz_() });
    }
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/**
 * Доступ на чтение: OPEN, если TMA_READ_TOKEN не задан (демо-режим);
 * иначе — совпадение read_token ИЛИ валидная подпись Mini App (initData).
 */
function checkReadAccess_(e) {
  const required = getProp_('TMA_READ_TOKEN', '');
  if (!required) return true;
  const provided = String((e && e.parameter && e.parameter.read_token) || '');
  if (provided && provided === required) return true;
  const init = String((e && e.parameter && e.parameter.init_data) || '');
  if (init && validateInitData_(init)) return true;
  return false;
}

function tmaHandlePost_(e, body) {
  try {
    if (!body || !body.action) return json_({ ok: false, error: 'no action' });
    if (!validateInitData_(body.init_data || '')) {
      return json_({ ok: false, error: 'unauthorized: записи доступны только из Telegram (initData)' });
    }
    let result;
    switch (String(body.action)) {
      case 'apply_prepay':
        result = DebtEngine.registerPrepay(body.debt_id, Number(body.amount_rub));
        return json_({ ok: true, prepay: result });
      case 'log_week': {
        const st = CashflowEngine.logWeeklyExpense({
          amount: Number(body.amount), currency: body.currency || 'KGS', note: 'mini app', source: 'tma',
        });
        return json_({ ok: true, weekly: st });
      }
      case 'set_cash':
        InvestNetWorth.setCash(Number(body.amount), body.currency || 'USD');
        return json_({ ok: true, net_worth: InvestNetWorth.netWorth() });
      default:
        return json_({ ok: false, error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────── Данные ───────────────────────────

function debtPayload_(d) {
  const ppy = DebtEngine.periodsPerYear_(d.type);
  const proj = DebtEngine.projection(d, 0);
  // оставшийся срок = инверсия аннуитета от текущего состояния (консистентно после reconcile)
  const remaining = DebtEngine.derivePeriods_(d.balance, d.rate, ppy, d.payment);
  return {
    id: d.id,
    name: d.name,
    balance_rub: round2_(d.balance),
    payment_rub: round2_(d.payment),
    payment_type: d.type,
    normalized_monthly_rub: round2_(DebtEngine.normalizedMonthlyRUB(d)),
    periods_per_year: ppy,
    rate_annual: d.rate,
    remaining_periods: isFinite(remaining) ? Math.round(remaining * 10) / 10 : 0,
    initial_balance_rub: d.initialBalance,
    months_left: proj.monthsLeft,
    payoff_date: proj.payoffISO,
    total_interest_rub: proj.totalInterestRUB,
  };
}

function waterfallPayload_(w) {
  return {
    month_key: w.monthKey,
    income_usd: round2_(w.incomeUSD),
    income: w.income,
    income_currency: w.incomeCurrency,
    base_income_usd: w.baseIncomeUSD,
    commitments_usd: {
      total: round2_(w.registry.total),
      non_mortgage: round2_(w.registry.other),
      mortgages: round2_(w.registry.mortgages),
    },
    living_usd: round2_(w.livingUSD),
    living_cap_rub: w.livingCapRUB,
    surplus_usd: round2_(w.surplusUSD),
    bonus_delta_usd: round2_(w.bonusDeltaUSD),
    to_prepay_usd: round2_(w.toPrepayUSD),
    to_dca_usd: round2_(w.toDcaUSD),
    dca_split_usd: {
      etf: round2_(w.split.broad_market_etf),
      stocks: round2_(w.split.growth_stocks),
      crypto: round2_(w.split.crypto_assets),
    },
    arbitrage: w.arbitrage,
    prepay_target: w.prepayTargetName,
    base_projection: w.baseProjection,
    prepay_projection: w.prepayProjection,
  };
}

function buildOverview_() {
  const debts = DebtEngine.replayAll();
  const w = CashflowEngine.computeWaterfall({});
  const portfolio = InvestNetWorth.getPortfolio();
  const nw = InvestNetWorth.takeSnapshot();
  const weekly = CashflowEngine.weeklyStatus();
  return {
    ok: true,
    generated_at: nowTz_(),
    version: CONFIG.VERSION,
    fx: {
      EURUSD: Math.round(w.fx.EURUSD * 10000) / 10000,
      USDRUB: Math.round(w.fx.USDRUB * 10000) / 10000,
      USDKGS: Math.round(w.fx.USDKGS * 10000) / 10000,
    },
    net_worth: {
      cash_usd: round2_(nw.cashUSD),
      deposits_usd: round2_(nw.depositsUSD),
      portfolio_usd: round2_(nw.portfolioUSD),
      debt_rub: round2_(nw.debtRUB),
      debt_usd: round2_(nw.debtUSD),
      total_usd: round2_(nw.netWorthUSD),
    },
    net_worth_history: InvestNetWorth.history(90),
    fx_analytics: FXAnalytics.build(),
    weekly: {
      week_rub: round2_(weekly.weekRUB),
      week_budget_rub: weekly.weekBudgetRUB,
      month_rub: round2_(weekly.monthRUB),
      month_cap_rub: weekly.monthCapRUB,
      burn_rate: Math.round(weekly.burnRate * 100) / 100,
      daily_allowance_rub: round2_(weekly.dailyAllowanceRUB),
      days_left: weekly.daysLeft,
    },
    waterfall: waterfallPayload_(w),
    debts: debts.map(debtPayload_),
    portfolio: {
      total_usd: round2_(portfolio.totalUSD),
      by_class: {
        broad_market_etf: round2_(portfolio.byClass.broad_market_etf),
        growth_stocks: round2_(portfolio.byClass.growth_stocks),
        crypto_assets: round2_(portfolio.byClass.crypto_assets),
      },
      target: portfolio.target,
      holdings: portfolio.holdings.map(function (h) {
        return {
          ticker: h.ticker, asset_class: h.assetClass, units: h.units,
          price_usd: round2_(h.price), value_usd: round2_(h.valueUSD), pnl_usd: round2_(h.pnlUSD),
        };
      }),
    },
    settings: {
      base_income_usd: getSettingNum_('BASE_INCOME_USD', CONFIG.PROFILE.BASE_INCOME_USD),
      weekly_budget_rub: getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB),
      monthly_cap_rub: getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB),
      deposit_rate: getSettingNum_('DEPOSIT_RATE_ANNUAL', CONFIG.ARBITRAGE.DEPOSIT_RATE_ANNUAL),
      bonus_prepay_share: getSettingNum_('BONUS_PREPAY_SHARE', CONFIG.SURPLUS.BONUS_PREPAY_SHARE),
      bonus_dca_share: getSettingNum_('BONUS_DCA_SHARE', CONFIG.SURPLUS.BONUS_DCA_SHARE),
      income_currency: getSetting_('INCOME_CURRENCY', CONFIG.PROFILE.INCOME_CURRENCY),
    },
  };
}

// ─────────────────────────── Валидация initData (HMAC-SHA256) ───────────────────────────

/**
 * Проверка подписи Telegram Mini App:
 * secret = HMAC_SHA256(key=bot_token, msg="WebAppData")
 * hash   = HMAC_SHA256(key=secret, msg=data_check_string)
 */
function validateInitData_(initData) {
  if (!initData) return false;
  try {
    const params = new URLSearchParams(String(initData));
    const hash = (params.get('hash') || '').toLowerCase();
    if (!hash) return false;

    const keys = [];
    params.forEach(function (v, k) { if (k !== 'hash') keys.push(k); });
    keys.sort();
    const checkString = keys.map(function (k) { return k + '=' + params.get(k); }).join('\n');

    const secretBytes = Utilities.computeHmacSha256Signature('WebAppData', tgToken_());
    const computed = Utilities.computeHmacSha256Signature(checkString, secretBytes)
      .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
      .join('');

    if (computed !== hash) return false;

    const authDate = Number(params.get('auth_date')) || 0;
    if (authDate && Date.now() / 1000 - authDate > 86400) return false; // старше суток
    return true;
  } catch (e) {
    console.warn('initData: ' + e.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════
// Triggers.gs
// ════════════════════════════════════════════════════════════════════
/**
 * Triggers.gs — cron-расписание Apps Script.
 *
 * • weeklySundayAsk   — каждое воскресенье 20:00: вопрос о недельных тратах (Workflow B)
 * • mondayNudge       — понедельник 09:00: мягкое напоминание, если опрос без ответа (P0)
 * • dailyMaintenance  — каждый день ~07:00: roll-forward платежей, replay, снапшот Net Worth,
 *                       FX-алерты (P0), напоминания о списаниях за 2 дня (P0),
 *                       digest «факт vs план» в последний день месяца (P1)
 * • monthlyPlanLog    — 1-го числа ~09:00: план месяца + сверка ипотек с банком (P1)
 *
 * Установка: installTriggers_() вызывается из setup(). Повторный вызов не дублирует.
 */

const TRIGGER_HANDLERS = ['weeklySundayAsk', 'mondayNudge', 'dailyMaintenance', 'monthlyPlanLog'];

function installTriggers_() {
  uninstallTriggers_();

  ScriptApp.newTrigger('weeklySundayAsk')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[CONFIG.WEEKLY_ASK.weekday]) // SUNDAY
    .atHour(CONFIG.WEEKLY_ASK.hour)                          // 20:00 (близко к указанному часу)
    .create();

  ScriptApp.newTrigger('mondayNudge')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .create();

  ScriptApp.newTrigger('dailyMaintenance')
    .timeBased()
    .atHour(7)
    .everyDays(1)
    .create();

  ScriptApp.newTrigger('monthlyPlanLog')
    .timeBased()
    .onMonthDay(1)
    .atHour(9)
    .create();

  return 'installed:' + TRIGGER_HANDLERS.join(',');
}

function uninstallTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ─────────────────────────── Handlers ───────────────────────────

/** Workflow B: воскресенье 20:00 — спросить про траты за неделю. */
function weeklySundayAsk() {
  const chatId = getProp_(PROP.CHAT_ID, '');
  if (!chatId) { console.warn('TELEGRAM_CHAT_ID не задан — воскресный опрос пропущен'); return; }
  try {
    setBotState_({ mode: 'await_week', asked_at: nowTz_() });
    MetricsEngine.logOnce('weekly_ask:' + weekKey_(new Date()), 'sent');
    sendMessage_(
      chatId,
      '📅 <b>Неделя заканчивается</b>\n' +
      'Пришлите скриншот аналитики расходов из MBANK — Gemini разберёт суммы и категории.\n' +
      'Или напишите итог цифрой, например <code>4350</code> или <code>3500 kgs</code> (можно «0», если трат не было).'
    );
  } catch (e) {
    console.error('weeklySundayAsk: ' + e.message);
  }
}

/** P0: понедельник 09:00 — опрос воскресенья остался без ответа? */
function mondayNudge() {
  try {
    const state = getBotState_();
    if (state.mode !== 'await_week') return;
    const chatId = getProp_(PROP.CHAT_ID, '');
    if (!chatId) return;
    sendMessage_(
      chatId,
      '👋 Небольшое напоминание: итог прошлой недели ещё не записан.\n' +
      'Пришлите скриншот MBANK или сумму цифрой — займёт 15 секунд.'
    );
  } catch (e) {
    console.error('mondayNudge: ' + e.message);
  }
}

/** Ежедневно: roll-forward, снапшоты, FX-алерты, напоминания о списаниях, аномалии, digest. */
function dailyMaintenance() {
  try {
    const posted = DebtEngine.checkDuePayments(); // roll-forward
    DebtEngine.replayAll();
    InvestNetWorth.takeSnapshot();
    try { FXAnalytics.refreshFormulas(); } catch (fxErr) { console.warn('fx refresh: ' + fxErr.message); }
    try { FXAnalytics.checkAlerts(); } catch (alertErr) { console.warn('fx alerts: ' + alertErr.message); }
    try { checkBillReminders_(); } catch (billErr) { console.warn('bills: ' + billErr.message); }
    try { AnomalyEngine.runAndNotify(); } catch (anomErr) { console.warn('anomalies: ' + anomErr.message); }
    try { maybeSendMonthDigest_(); } catch (dErr) { console.warn('digest: ' + dErr.message); }
    logOps_('INFO', 'daily', 'maintenance ok; auto-posted: ' + (posted.length ? posted.join(',') : 'none'));
    console.log('dailyMaintenance ok; auto-posted: ' + JSON.stringify(posted));
  } catch (e) {
    logOps_('ERROR', 'daily', e.message);
    console.error('dailyMaintenance: ' + e.message);
  }
}

/**
 * P0: напоминания о списаниях за 2 дня.
 * Месячные позиции — из Commitments_Registry (due_day), ипотеки —
 * Сбер по due_day из Config, Т-Банк каждые 14 дней от Epoch.
 */
function checkBillReminders_() {
  const chatId = getProp_(PROP.CHAT_ID, '');
  if (!chatId) return;
  const fx = getFx_();
  const now = new Date();
  const items = [];

  const daysUntil = function (d) {
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((d - a) / 86400000);
  };
  const dueThisCycle = function (dueDay) {
    let d = new Date(now.getFullYear(), now.getMonth(), dueDay);
    if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      d = new Date(now.getFullYear(), now.getMonth() + 1, dueDay);
    }
    return d;
  };

  // Реестр обязательств (кроме ипотек — они ниже с точными датами)
  readRange_(SHEETS.COMMITMENTS, 2).forEach(function (r) {
    const active = r[6] === true || String(r[6]).toUpperCase() === 'TRUE';
    const dueDay = Number(r[5]);
    if (!active || !dueDay || String(r[0]) === 'Mortgages') return;
    if (daysUntil(dueThisCycle(dueDay)) === 2) {
      const cur = String(r[3] || 'USD').toUpperCase();
      const rub = convert_(Number(r[2]) || 0, cur, 'RUB', fx);
      items.push('«' + r[1] + '» — ' + fmtMoney_(Number(r[2]) || 0, cur) +
        ' (≈' + fmtMoney_(rub, 'RUB') + '), списание ' + fmtISO_(dueThisCycle(dueDay)));
    }
  });

  // Ипотеки
  DebtEngine.getDebts().forEach(function (debt) {
    if (debt.type === 'monthly') {
      const dueDay = DebtEngine.cfgById_(debt.id) ? DebtEngine.cfgById_(debt.id).due_day : 25;
      if (daysUntil(dueThisCycle(dueDay)) === 2) {
        items.push(debt.name + ' — ' + fmtMoney_(debt.payment, 'RUB') + ', списание ' + fmtISO_(dueThisCycle(dueDay)));
      }
    } else {
      // biweekly: следующий платёж через кратное 14 число дней от Epoch
      const elapsed = Math.ceil((now - debt.epoch) / 86400000 / 14);
      const next = new Date(debt.epoch.getTime() + elapsed * 14 * 86400000);
      if (daysUntil(next) === 2) {
        items.push(debt.name + ' — ' + fmtMoney_(debt.payment, 'RUB') + ' (раз в 2 недели), списание ' + fmtISO_(next));
      }
    }
  });

  if (items.length) {
    sendMessage_(
      chatId,
      '🔔 <b>Списания через 2 дня</b>\n• ' + items.join('\n• ') +
      '\n\nПроверьте остаток на счёте; при необходимости конвертируйте: /fx'
    );
  }
  return items;
}

/** P1: digest в последний день месяца (завтра 1-е число). */
function maybeSendMonthDigest_() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return false;
  const chatId = getProp_(PROP.CHAT_ID, '');
  const text = MetricsEngine.buildMonthDigest();
  console.log(text.replace(/<[^>]+>/g, ''));
  if (chatId) sendMessage_(chatId, text);
  return true;
}

/** 1-го числа: план месяца + сверка ипотек с банком (P1) + автобэкап. */
function monthlyPlanLog() {
  const chatId = getProp_(PROP.CHAT_ID, '');
  try {
    try { backupNow(); } catch (bErr) { console.warn('backup: ' + bErr.message); }
    const w = CashflowEngine.computeWaterfall({});
    CashflowEngine.upsertMonth(w, 'proposal');
    if (chatId) {
      sendMessage_(
        chatId,
        '🗓 <b>Новый месяц ' + w.monthKey + '</b>\n' +
        'Запишите факт дохода: /income 6200 ' + w.incomeCurrency.toLowerCase() + '\n\n' +
        CashflowEngine.renderText(w),
        monthButtons_(w.monthKey)
      );
      sendReconciliationPrompt_(fmtMonthKey_(new Date()));
    }
  } catch (e) {
    console.error('monthlyPlanLog: ' + e.message);
  }
}

/** P1: сверка балансов ипотек с приложением банка. */
function sendReconciliationPrompt_(monthKey) {
  const chatId = getProp_(PROP.CHAT_ID, '');
  if (!chatId) return;
  const debts = DebtEngine.getDebts();
  const lines = debts.map(function (d) {
    return '• ' + d.name + ': <b>' + fmtMoney_(d.balance, 'RUB') + '</b>';
  });
  sendMessage_(
    chatId,
    '🏦 <b>Сверка с банком</b> (' + monthKey + ')\n' +
    'Балансы в движке:\n' + lines.join('\n') + '\n\n' +
    'Откройте приложения Сбербанк/Т-Банк и сверьте остатки ипотек.',
    [
      { text: '✅ Всё совпадает', callback_data: 'recon_ok:' + monthKey },
      { text: '📸 Пришлю скрины', callback_data: 'recon_how' },
    ]
  );
}

/** Ручной тест воскресного вопроса (из редактора). */
function testWeeklyAsk() {
  weeklySundayAsk();
}

// ════════════════════════════════════════════════════════════════════
// SecurityAudit.gs
// ════════════════════════════════════════════════════════════════════
/**
 * SecurityAudit.gs — рантайм-аудит безопасности и «здоровья» продукта.
 * Запускать из редактора Apps Script: функция securityAudit().
 * Отчёт дублируется владельцу в Telegram (если задан TELEGRAM_CHAT_ID).
 *
 * Проверяет «молчаливые убийцы» продукта:
 *   • webhook указывает на старое развёртывание (URL меняется при новом деплое);
 *   • пропавшие cron-триггеры (воскресная петля, roll-forward, месячный план);
 *   • курсы GOOGLEFINANCE не рассчитались (#N/A) — расчёты идут на резервных;
 *   • Net Worth не снапшотился >2 дней (умер daily-триггер).
 *
 * Статическая часть аудита — SECURITY.md репозитория.
 */

function securityAudit() {
  const L = [];
  const add = function (mark, text) { L.push(mark + ' ' + text); };

  // 1. Наличие и качество секретов (хранятся только в Script Properties)
  const props = PropertiesService.getScriptProperties().getProperties();
  const token = props[PROP.BOT_TOKEN] || '';
  const chatId = props[PROP.CHAT_ID] || '';
  const gemini = props[PROP.GEMINI_KEY] || '';
  const groq = props[PROP.GROQ_KEY] || '';
  const secret = props[PROP.WEBHOOK_SECRET] || '';
  const readToken = props[PROP.TMA_READ_TOKEN] || '';

  add(token ? '✅' : '❌', 'TELEGRAM_BOT_TOKEN: ' + (token ? 'задан' : 'ОТСУТСТВУЕТ'));
  add(chatId ? '✅' : '❌', 'TELEGRAM_CHAT_ID (whitelist): ' + (chatId ? 'задан' : 'ОТСУТСТВУЕТ — бот будет отвечать подсказкой любому'));
  if (gemini && groq) add('✅', 'Vision: Gemini + резерв Groq (двойное покрытие)');
  else if (gemini) add('✅', 'GEMINI_API_KEY: задан (резерв Groq не настроен — опционально)');
  else if (groq) add('⚠️', 'Vision: только Groq (GEMINI_API_KEY не задан — скриншоты пойдут через резервный провайдер)');
  else add('❌', 'Vision: нет ни GEMINI_API_KEY, ни GROQ_API_KEY — разбор скриншотов работать не будет');
  add(secret.length >= 32 ? '✅' : '⚠️', 'WEBHOOK_SECRET: ' + (secret ? secret.length + ' симв. (рекомендуется 32+)' : 'ОТСУТСТВУЕТ — webhook открыт для подделки'));
  add(readToken ? '✅' : '⚠️', 'TMA_READ_TOKEN: ' + (readToken ? 'чтение API защищено токеном' : 'не задан — чтение финансовых данных по URL Web App открыто (запустите setup(), он создаст токен)'));

  // 2. Валидность токена бота
  try {
    const me = tgCall_('getMe', {});
    add('✅', 'Токен бота валиден: @' + me.username);
  } catch (e) {
    add('❌', 'Токен бота невалиден: ' + e.message);
  }

  // 3. Валидность ключа Gemini (дешёвый GET списка моделей)
  try {
    const resp = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + gemini,
      { muteHttpExceptions: true, deadline: 15 });
    add(resp.getResponseCode() === 200 ? '✅' : '❌',
      'GEMINI_API_KEY: HTTP ' + resp.getResponseCode() + (resp.getResponseCode() === 200 ? ' — валиден' : ' — проверьте ключ'));
  } catch (e) {
    add('❌', 'GEMINI_API_KEY не удалось проверить: ' + e.message);
  }

  // 4. Webhook: привязка, ошибки доставки, и главное — тот ли это URL развёртывания
  try {
    const info = tgCall_('getWebhookInfo', {});
    add(info.url ? '✅' : '⚠️', 'Webhook: ' + (info.url ? 'привязан' : 'не привязан (запустите setupWebhook)'));
    if (info.last_error_message) add('⚠️', 'Последняя ошибка доставки webhook: ' + info.last_error_message);
    if ((info.pending_update_count || 0) > 10) add('⚠️', 'Накопилось ' + info.pending_update_count + ' необработанных апдейтов');
    const current = String(ScriptApp.getService().getUrl() || '').split('?')[0];
    const hooked = String(info.url || '').split('?')[0];
    if (current && hooked && current !== hooked) {
      add('❌', 'Webhook смотрит на ДРУГОЕ развёртывание (' + hooked + ' ≠ ' + current +
        '). Бот мог молча замолчать — перепустите setupWebhook()');
    }
  } catch (e) {
    add('⚠️', 'Webhook не проверен: ' + e.message);
  }

  // 5. Cron-триггеры: воскресный опрос, пн-надж, ежедневный roll-forward, месячный план
  try {
    const need = ['weeklySundayAsk', 'mondayNudge', 'dailyMaintenance', 'monthlyPlanLog'];
    const installed = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    need.forEach(function (h) {
      add(installed.indexOf(h) >= 0 ? '✅' : '❌',
        'Триггер ' + h + (installed.indexOf(h) >= 0 ? ' — установлен' : ' — ОТСУТСТВУЕТ (перепустите setup())'));
    });
  } catch (e) {
    add('⚠️', 'Триггеры не проверены: ' + e.message);
  }

  // 6. Свежесть данных: последний снапшот Net Worth
  try {
    const hist = InvestNetWorth.history(2);
    if (!hist.length) {
      add('⚠️', 'Net Worth: снапшотов нет ни одного — выполните /sync (daily-триггер ещё не отрабатывал)');
    } else {
      const last = hist[hist.length - 1].date;
      const age = Math.round(
        (new Date(fmtISO_(new Date()) + 'T00:00:00') - new Date(last + 'T00:00:00')) / 86400000);
      add(age <= 2 ? '✅' : '❌', 'Net Worth: снапшот ' + last + ' (' + age + ' дн. назад)' +
        (age > 2 ? ' — похоже, daily-триггер не работает' : ''));
    }
  } catch (e) {
    add('⚠️', 'Net Worth история не проверена: ' + e.message);
  }

  // 7. Курсы: живой GOOGLEFINANCE или резервные значения
  try {
    add(getFx_().FALLBACK_USED ? '⚠️' : '✅',
      'Курсы: ' + (getFx_().FALLBACK_USED
        ? 'GOOGLEFINANCE недоступен (B2:B4 = #N/A/пусто) — расчёты на резервных значениях из Config.gs'
        : 'GOOGLEFINANCE рассчитан, конвертации живые'));
  } catch (e) {
    add('⚠️', 'Курсы не проверены: ' + e.message);
  }

  // 8. Доступ к таблице
  try {
    const ss = ss_();
    add('✅', 'Таблица: «' + ss.getName() + '» (доступ из скрипта есть)');
  } catch (e) {
    add('❌', 'Таблица недоступна: ' + e.message);
  }

  // 9. Математика: лист ↔ код (формулы аннуитета и кросс-курса дублируются
  //    намеренно — аудит ловит расхождение, если что-то рассинхронизировалось)
  try {
    const dsh = sheet_(SHEETS.DEBTS);
    const L = Number(dsh.getRange('B6').getValue()) || 0;
    const sheetNewPmt = Number(dsh.getRange('B8').getValue());
    const balance = Number(dsh.getRange('C2').getValue());
    const rate = Number(dsh.getRange('E2').getValue());
    const n = Number(dsh.getRange('B7').getValue());
    if (L > 0 && balance > 0 && n > 0 && isFinite(sheetNewPmt)) {
      const codeNewPmt = DebtEngine.annuityPayment_(balance - L, rate, 12, n);
      add(Math.abs(codeNewPmt - sheetNewPmt) <= 1 ? '✅' : '❌',
        'Математика ЧДП (лист B8 vs код): ' + Math.round(sheetNewPmt) + ' ₽ vs ' +
        Math.round(codeNewPmt) + ' ₽' + (Math.abs(codeNewPmt - sheetNewPmt) <= 1 ? ' — совпадают' : ' — РАСХОЖДЕНИЕ формулы'));
    }
    const fsh = sheet_(SHEETS.FX_SETTINGS);
    const cross = Number(fsh.getRange('B5').getValue());
    const fx = getFx_();
    if (isFinite(cross) && cross > 0) {
      const ok = Math.abs(cross - fx.EURUSD * fx.USDRUB) / cross < 0.005;
      add(ok ? '✅' : '⚠️', 'Кросс EUR/RUB (лист B5 vs код): ' + cross.toFixed(2) + ' vs ' +
        (fx.EURUSD * fx.USDRUB).toFixed(2) + (ok ? '' : ' — расхождение >0.5%'));
    }
  } catch (e) {
    add('⚠️', 'Математика не сверена: ' + e.message);
  }

  // 10. Аномалии цифр (детектор невозможных значений)
  try {
    const anomalies = AnomalyEngine.run();
    const crit = anomalies.filter(function (a) { return a.sev === 'crit'; }).length;
    if (!anomalies.length) add('✅', 'Аномалии цифр: не обнаружены (инварианты D/W/M/N/P/F соблюдены)');
    else anomalies.forEach(function (a) {
      add(a.sev === 'crit' ? '❌' : '⚠️', 'Аномалия [' + a.id + ']: ' + a.text);
    });
  } catch (e) {
    add('⚠️', 'Аномалии не проверены: ' + e.message);
  }

  const report = '🔐 <b>Аудит безопасности и здоровья</b>\n' + nowTz_() + '\n\n' + L.join('\n');
  console.log(report.replace(/<[^>]+>/g, ''));
  if (chatId) {
    try { sendMessage_(chatId, report); } catch (e) { /* отчёт уже в логе */ }
  }
  return report;
}
