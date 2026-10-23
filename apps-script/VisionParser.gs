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
  const total = Number(parsed.total_spent);
  const balance = Number(parsed.debt_balance_rub);
  return {
    provider: provider,
    screen_type: screenType,
    period: String(parsed.period || ''),
    total_spent: isFinite(total) && total > 0 ? total : 0,
    currency: ['KGS', 'RUB', 'USD'].indexOf(parsed.currency) >= 0 ? parsed.currency : 'KGS',
    top_categories: Array.isArray(parsed.top_categories)
      ? applyAliases_(parsed.top_categories
          .filter(function (c) { return c && isFinite(Number(c.amount)); })
          .slice(0, 5)
          .map(function (c) { return { category: String(c.category || '—'), amount: Number(c.amount) }; }))
      : [],
    is_full_month_analytics: parsed.is_full_month_analytics === true,
    bank: String(parsed.bank || ''),
    debt_balance_rub: isFinite(balance) && balance > 1000 ? balance : 0,
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
