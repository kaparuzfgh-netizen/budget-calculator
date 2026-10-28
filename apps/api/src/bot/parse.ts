/** parse.ts — чистые парсеры пользовательского ввода бота. */
import { DomainError } from '../domain/errors';

const CCY_RE = /^[A-Za-z]{3,5}$/;

/**
 * Разговорные обозначения валют → ISO-код (ключи — lowercase).
 * Покрывает кириллицу («руб», «сом», «тенге»…), символы ($, ₽, €…) и
 * короткие сокращения («р», «тг», «грн»). Неизвестный токен — НЕ валюта,
 * уходит обратно в заметку.
 */
const CCY_ALIAS: Record<string, string> = {
  usd: 'USD',
  dollar: 'USD',
  bucks: 'USD',
  $: 'USD',
  доллар: 'USD',
  доллара: 'USD',
  долларов: 'USD',
  бакс: 'USD',
  бакса: 'USD',
  баксов: 'USD',
  баксы: 'USD',
  eur: 'EUR',
  euro: 'EUR',
  '€': 'EUR',
  евро: 'EUR',
  rub: 'RUB',
  rur: 'RUB',
  '₽': 'RUB',
  руб: 'RUB',
  рубль: 'RUB',
  рубля: 'RUB',
  рубли: 'RUB',
  рублей: 'RUB',
  р: 'RUB',
  kgs: 'KGS',
  сом: 'KGS',
  сома: 'KGS',
  сомы: 'KGS',
  сомов: 'KGS',
  kzt: 'KZT',
  тенге: 'KZT',
  тг: 'KZT',
  '₸': 'KZT',
  uah: 'UAH',
  грн: 'UAH',
  гривна: 'UAH',
  гривны: 'UAH',
  гривен: 'UAH',
  '₴': 'UAH',
  gel: 'GEL',
  лари: 'GEL',
  '₾': 'GEL',
  uzs: 'UZS',
  сум: 'UZS',
  сума: 'UZS',
  сумов: 'UZS',
  amd: 'AMD',
  драм: 'AMD',
  драма: 'AMD',
  драмов: 'AMD',
  '֏': 'AMD',
  azn: 'AZN',
  манат: 'AZN',
  маната: 'AZN',
  манатов: 'AZN',
  '₼': 'AZN',
  byn: 'BYN',
  cny: 'CNY',
  юань: 'CNY',
  юаня: 'CNY',
  юаней: 'CNY',
  '¥': 'CNY',
  jpy: 'JPY',
  йена: 'JPY',
  иены: 'JPY',
  иен: 'JPY',
  gbp: 'GBP',
  фунт: 'GBP',
  фунта: 'GBP',
  фунтов: 'GBP',
  '£': 'GBP',
  try: 'TRY',
  лира: 'TRY',
  лиры: 'TRY',
  лир: 'TRY',
  '₺': 'TRY',
  pln: 'PLN',
  злотый: 'PLN',
  злотых: 'PLN',
  chf: 'CHF',
  франк: 'CHF',
  франка: 'CHF',
  франков: 'CHF',
};
/**
 * Поддерживаемые ISO-коды валют — значения таблицы алиасов.
 * Vision-санитайзинг валидирует код из ответа модели по этому набору.
 */
export const SUPPORTED_CCYS = new Set(Object.values(CCY_ALIAS));
const CCY_WORD = '[A-Za-zА-Яа-яЁё]{1,15}|[$€₽£¥₸₴₾֏₼₺]';

export interface ParsedAmount {
  amount: number;
  currency?: string | undefined;
  note?: string | undefined;
}

/**
 * "<amount> [currency] [note…]" — сумма: "1 234,50" | "1234.5" | "3200 kgs кофе".
 * Валюта — токен сразу после числа (слитно «500р» тоже ок): ISO-код, русское
 * название («руб», «сом»…) или символ. Неузнанный токен уходит в заметку.
 */
export function parseAmount(text: string, max = 1e9): ParsedAmount {
  const t = text.trim().replace(/[\s\u00A0]+/g, ' ');
  const m = new RegExp(`^([+-]?\\d[\\d ]*(?:[.,]\\d+)?)\\s*(${CCY_WORD})?[.]?(?:\\s+(.*))?$`).exec(t);
  if (!m) throw new DomainError('PARSE', 'Не понял сумму. Пример: 250 или 250 kgs кофе');
  const amount = Number(m[1]!.replace(/ /g, '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new DomainError('PARSE', 'Сумма должна быть положительным числом');
  }
  if (amount > max) throw new DomainError('PARSE', `Сумма слишком большая (>${max})`);
  const tok = m[2];
  let currency: string | undefined;
  let note = (m[3] ?? '').trim();
  if (tok) {
    currency = CCY_ALIAS[tok.toLowerCase()] ?? (CCY_RE.test(tok) ? tok.toUpperCase() : undefined);
    if (!currency) note = note ? `${tok} ${note}` : tok;
  }
  return {
    amount,
    currency,
    ...(note ? { note } : {}),
  };
}

export interface ParsedCommitment {
  name: string;
  amount: number;
  currency?: string | undefined;
  dueDay?: number | undefined;
}

/** "Аренда 700 usd 1" — имя, сумма, [валюта], [день 1–31]. */
export function parseCommitmentLine(line: string): ParsedCommitment {
  const t = line.trim().replace(/\s+/g, ' ');
  const m = /^(.+?)\s+(\d[\d ]*(?:[.,]\d+)?)\s*(?:([A-Za-z]{3,5})\s*)?(?:(\d{1,2})\s*)?$/.exec(t);
  if (!m) {
    throw new DomainError('PARSE', 'Формат: название сумма [валюта] [день]. Пример: Аренда 700 usd 1');
  }
  const name = m[1]!.trim().slice(0, 40);
  const amount = Number(m[2]!.replace(/ /g, '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) throw new DomainError('PARSE', 'Сумма должна быть положительной');
  if (amount > 1e9) throw new DomainError('PARSE', 'Сумма слишком большая');
  let dueDay: number | undefined;
  if (m[4] !== undefined) {
    dueDay = Number(m[4]);
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      throw new DomainError('PARSE', 'День платежа — число от 1 до 31');
    }
  }
  return { name, amount, currency: m[3] ? m[3].toUpperCase() : undefined, ...(dueDay !== undefined ? { dueDay } : {}) };
}

/** Код валюты 3–5 букв → UPPER или DomainError. */
export function parseCurrencyCode(text: string): string {
  const t = text.trim().toUpperCase();
  if (!CCY_RE.test(t)) throw new DomainError('PARSE', 'Код валюты — 3–5 латинских букв, например USD');
  return t;
}

/** IANA timezone — проверка через Intl (синхронно, без I/O). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 'YYYY-MM' по таймзоне — для месячных записей дохода. */
export function monthInTz(tz: string, now: Date): string {
  return todayInTz(tz, now).slice(0, 7);
}

/** 'YYYY-MM-DD' по таймзоне — все «сегодня» вычисляем через Intl. */
/**
 * Понедельник ISO-недели, содержащей локальную дату 'YYYY-MM-DD' —
 * то же правило (dow+6)%7, что и weekStartInTz, но вход уже локальный
 * (таймзона не нужна). P2-1: нижняя граница выборки трат.
 */
export function weekStartOfIso(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Понедельник текущей недели (ISO) в таймзоне пользователя. */
export function weekStartInTz(tz: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: isValidTimezone(tz) ? tz : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(now);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[m.weekday as 'Sun'] ?? 0;
  const local = new Date(Date.UTC(Number(m.year), Number(m.month) - 1, Number(m.day)));
  local.setUTCDate(local.getUTCDate() - ((dow + 6) % 7));
  return local.toISOString().slice(0, 10);
}

export function todayInTz(tz: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
