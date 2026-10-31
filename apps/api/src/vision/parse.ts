/**
 * vision/parse.ts — схема ответа модели, промпт и санитайзинг (порт v1
 * VisionParser.gs: VISION_SCHEMA / VISION_PROMPT / sanitizeVision_).
 */
import { z } from 'zod';
import { SUPPORTED_CCYS } from '../bot/parse';
import { VisionError, type VisionProvider, type VisionResult, type VisionScreenType } from './types';

/**
 * Строгая JSON-схема для Gemini (generationConfig.response_schema — имена
 * полей snake_case, как в v1). Валюта — свободной строкой: enum в v1 был
 * только KGS/RUB/USD, а поддерживаемых кодов у нас больше — валидирует
 * sanitizeVision по SUPPORTED_CCYS. Поле остатка долга в v1 —
 * debt_balance_rub; в v2 домен мультивалютный → debt_balance (валюта экрана).
 */
export const VISION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    screen_type: {
      type: 'STRING',
      enum: ['expense_analytics', 'debt_balance', 'other'],
      description: 'Тип экрана на скриншоте',
    },
    period: { type: 'STRING', description: 'Период аналитики расходов, например "неделя" или "октябрь"' },
    total_spent: { type: 'NUMBER', description: 'Общая сумма расходов за период в исходной валюте' },
    currency: { type: 'STRING', description: 'ISO-код валюты экрана (USD, EUR, RUB, KGS, KZT…)' },
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
    is_full_month_analytics: {
      type: 'BOOLEAN',
      description: 'true, если аналитика за весь месяц, а не за неделю',
    },
    bank: {
      type: 'STRING',
      description: 'Банк приложения, если определим: Сбербанк/Sber, Т-Банк/T-Bank/Тинькофф, MBANK/Мбанк, другой',
    },
    debt_balance: {
      type: 'NUMBER',
      description: 'Остаток основного долга (тела) по ипотеке/кредиту в валюте экрана',
    },
    transactions: {
      type: 'ARRAY',
      description:
        'Видимые строки истории/списка операций РАСХОДА на экране (максимум 30); ' +
        'пустой массив, если списка операций нет',
      items: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING', description: 'Дата операции YYYY-MM-DD, если читается; иначе пусто' },
          amount: { type: 'NUMBER', description: 'Сумма операции в валюте экрана' },
          note: { type: 'STRING', description: 'Мерчант/описание строки' },
          category: { type: 'STRING', description: 'Категория строки, если подписана на экране' },
        },
        required: ['amount'],
      },
    },
  },
  required: ['screen_type'],
} as const;

/**
 * Промпт — порт v1 VISION_PROMPT + строка с валютами пользователя
 * (подсказка при неоднозначных символах; фактическую валюту экрана модель
 * обязана вернуть, а не угаданную).
 */
export function visionPrompt(ccys: string[]): string {
  return (
    'Ты — парсер финансовых скриншотов. Это скриншот мобильного банковского приложения ' +
    '(Сбербанк, Т-Банк, MBANK/Мбанк Кыргызстан или другое).\n' +
    `Валюты пользователя: ${ccys.join(', ')} — но верни фактическую валюту экрана.\n` +
    'Сначала определи ТИП экрана:\n' +
    '• expense_analytics — экран аналитики/истории РАСХОДОВ за период;\n' +
    '• debt_balance — экран кредита/ипотеки с ОСТАТКОМ ДОЛГА;\n' +
    '• other — всё остальное (перевод, баланс карты, настройки).\n' +
    'Для аналитики расходов: найди общую сумму за период и разбивку по категориям. ' +
    'Валюта по символам: сом/с/KGS — KGS, ₽/руб — RUB, $ — USD.\n' +
    'Для остатка долга: найди «Остаток основного долга» или аналогичное поле ' +
    '(не платёж, не проценты!) и банк.\n' +
    'Если на экране виден список/история операций — верни каждую видимую строку ' +
    'РАСХОДА в transactions (максимум 30): date как YYYY-MM-DD (если читается), ' +
    'amount — модуль суммы, note — мерчант/описание, category — если подписана. ' +
    'Пополнения, возвраты и переводы между своими счетами не включай.\n' +
    'Не выдумывай числа: если поля нет — верни 0 или пустой массив. Отвечай строго JSON по схеме.'
  );
}

/**
 * Zod-зеркало ответа модели — граница доверия (S12). Мягкие типы + catch:
 * мусорные поля не роняют разбор — доводит sanitizeVision (как в v1, где
 * sanitize принимал произвольный объект и сам приводил типы).
 */
export const visionJsonSchema = z.looseObject({
  screen_type: z.string().optional().catch(undefined),
  period: z.string().optional().catch(undefined),
  total_spent: z.coerce.number().optional().catch(undefined),
  currency: z.string().optional().catch(undefined),
  top_categories: z
    .array(
      z.looseObject({
        category: z.string().optional().catch(undefined),
        amount: z.coerce.number().optional().catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
  is_full_month_analytics: z.boolean().optional().catch(undefined),
  bank: z.string().optional().catch(undefined),
  debt_balance: z.coerce.number().optional().catch(undefined),
  transactions: z
    .array(
      // элемент-мусор → null (не роняет весь массив): фильтруется в sanitizeVision
      z
        .looseObject({
          date: z.string().nullable().optional().catch(undefined),
          amount: z.coerce.number().optional().catch(undefined),
          note: z.string().optional().catch(undefined),
          category: z.string().optional().catch(undefined),
        })
        .nullable()
        .catch(null),
    )
    .optional()
    .catch(undefined),
});

const SCREEN_TYPES = new Set<string>(['expense_analytics', 'debt_balance', 'other']);
const TX_MAX = 30; // строк истории в ответе — верхняя граница и для промпта
const TX_ITEM_MAX = 5_000_000; // абсолютный предел суммы одной строки (как у total_spent)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s: unknown): string => String(s ?? '').slice(0, 200);
const realDate = (s: unknown): string | null => {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
};

/**
 * Порт v1 sanitizeVision_ (VisionParser.gs:198):
 *  • screen_type — только whitelist, иначе 'other';
 *  • total_spent — конечный, 0 < total ≤ 5_000_000, иначе 0;
 *  • категории — ≤5, каждая конечная, >0 и ≤ total*1.5;
 *  • transactions — ≤30, amount конечная, >0, ≤ 5e6 и ≤ base*1.5, где base —
 *    total_spent, а при total=0 (у экранов истории итога часто нет) — сумма
 *    самих строк; битые строки выпадают, строки обрезаются до 200 символов;
 *  • debt_balance — только при 1 000 < bal < 100 000 000, иначе 0;
 *  • currency — из поддерживаемого набора, иначе fallbackCcy
 *    (в v1 было ['KGS','RUB','USD']→'KGS'; v2 — SUPPORTED_CCYS → living_ccy);
 *  • алиасов категорий (v1 CAT_ALIAS_*) в v2 нет — не переносим.
 */
export function sanitizeVision(parsed: unknown, provider: VisionProvider, fallbackCcy: string): VisionResult {
  const r = visionJsonSchema.safeParse(parsed);
  if (!r.success) throw new VisionError(provider, 'битый JSON модели');
  const p = r.data;
  const screenType = (SCREEN_TYPES.has(p.screen_type ?? '') ? p.screen_type : 'other') as VisionScreenType;
  let total = Number(p.total_spent);
  // защита от миспарса: нереальные суммы (лишний ноль, копейки как рубли) → 0
  if (!Number.isFinite(total) || total <= 0 || total > 5_000_000) total = 0;
  const balance = Number(p.debt_balance);
  const categories = Array.isArray(p.top_categories)
    ? p.top_categories
        .filter((c) => c && Number.isFinite(Number(c.amount)) && Number(c.amount) > 0 && Number(c.amount) <= total * 1.5)
        .slice(0, 5)
        .map((c) => ({ category: String(c.category || '—'), amount: Number(c.amount) }))
    : [];
  const txRows = Array.isArray(p.transactions) ? p.transactions : [];
  // sanity-кап как у категорий (≤total*1.5); без итога на экране базой
  // служит сумма самих строк — иначе историю без total было бы не записать
  const txSum = txRows.reduce((s, t) => {
    const a = Number(t?.amount);
    return s + (Number.isFinite(a) && a > 0 ? a : 0);
  }, 0);
  const txCap = (total > 0 ? total : txSum) * 1.5;
  const transactions = txRows
    .map((t) => {
      const a = Number(t?.amount);
      if (!t || !Number.isFinite(a) || a <= 0 || a > TX_ITEM_MAX || a > txCap) return null;
      return { date: realDate(t.date), amount: a, note: clip(t.note), category: clip(t.category) };
    })
    .filter((t) => t !== null)
    .slice(0, TX_MAX);
  const ccy = typeof p.currency === 'string' ? p.currency.toUpperCase() : '';
  return {
    provider,
    screen_type: screenType,
    period: String(p.period ?? ''),
    total_spent: total,
    currency: SUPPORTED_CCYS.has(ccy) ? ccy : fallbackCcy,
    top_categories: categories,
    is_full_month_analytics: p.is_full_month_analytics === true,
    bank: String(p.bank ?? ''),
    debt_balance: Number.isFinite(balance) && balance > 1000 && balance < 100_000_000 ? balance : 0,
    ...(transactions.length ? { transactions } : {}),
  };
}
