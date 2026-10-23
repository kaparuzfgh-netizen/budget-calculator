/**
 * VisionParser.gs — Gemini 2.0 Flash: скриншот банковского приложения → строгий JSON.
 * Free tier AI Studio: 15 RPM. Таймаут и ретрай — защита от 429/5xx.
 */

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' +
  GEMINI_MODEL + ':generateContent';

/** Строгая JSON-схема из ТЗ (Workflow B). */
const VISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    period: { type: 'STRING', description: 'Период, отображённый на скриншоте, например "неделя" или "октябрь"' },
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
    is_full_month_analytics: { type: 'BOOLEAN', description: 'true, если на скриншоте аналитика за весь месяц, а не за неделю' },
  },
  required: ['total_spent', 'currency'],
};

const VISION_PROMPT =
  'Ты — парсер финансовых скриншотов. Это скриншот мобильного банковского приложения ' +
  '(обычно MBANK / Мбанк Кыргызстан, реже — российский банк). Экран аналитики расходов.\n' +
  'Найди общую сумму расходов за отображённый период и разбивку по категориям.\n' +
  'Валюта определяется по символам: сом/с/KGS — KGS, ₽/руб — RUB, $ — USD.\n' +
  'Не выдумывай числа: если чего-то нет — верни 0 или пустой массив. Отвечай строго JSON по схеме.';

/**
 * @param {string} base64 изображение (jpeg/png)
 * @param {string} mime
 * @returns {{period:string, total_spent:number, currency:string, top_categories:Array, is_full_month_analytics:boolean}}
 */
function parseExpenseScreenshot_(base64, mime) {
  const key = getProp_(PROP.GEMINI_KEY, '');
  if (!key) throw new Error('GEMINI_API_KEY не задан в Script Properties (aistudio.google.com/apikey)');

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: VISION_PROMPT },
        { inline_data: { mime_type: mime || 'image/jpeg', data: base64 } },
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
        lastErr = new Error('Gemini временно недоступен (HTTP ' + code + '), попытка ' + (attempt + 1));
        Utilities.sleep(2000);
        continue;
      }
      if (code !== 200) throw new Error('Gemini HTTP ' + code + ': ' + text.slice(0, 200));

      const json = JSON.parse(text);
      const part = json.candidates && json.candidates[0] && json.candidates[0].content &&
        json.candidates[0].content.parts && json.candidates[0].content.parts[0];
      if (!part || !part.text) throw new Error('Gemini вернул пустой ответ');
      const parsed = JSON.parse(part.text);

      // санитайзинг по схеме
      const total = Number(parsed.total_spent);
      if (!isFinite(total) || total < 0) throw new Error('Gemini не распознал сумму расходов');
      const currency = ['KGS', 'RUB', 'USD'].indexOf(parsed.currency) >= 0 ? parsed.currency : 'KGS';
      return {
        period: String(parsed.period || 'неделя'),
        total_spent: total,
        currency: currency,
        top_categories: Array.isArray(parsed.top_categories)
          ? parsed.top_categories
              .filter(function (c) { return c && isFinite(Number(c.amount)); })
              .slice(0, 5)
              .map(function (c) { return { category: String(c.category || '—'), amount: Number(c.amount) }; })
          : [],
        is_full_month_analytics: parsed.is_full_month_analytics === true,
      };
    } catch (e) {
      lastErr = e;
      if (String(e.message).indexOf('Gemini временно') === -1) break; // ретраим только 429/5xx
    }
  }
  throw new Error('Не удалось разобрать скриншот: ' + (lastErr ? lastErr.message : 'неизвестная ошибка'));
}

/** Разбор введённого текста: "3200", "5 500 ₽", "5000 kgs". */
function parseTypedExpense_(text) {
  const amount = parseAmount_(text);
  if (amount === null || amount <= 0) return null;
  return { total_spent: amount, currency: detectCurrency_(text, 'RUB'), top_categories: [], period: 'текст' };
}
