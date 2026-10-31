/**
 * fmt.ts — форматирование чисел и клиентская валидация.
 *
 * fmtMoney / fmtPct — копия fmtMoney из apps/api/src/bot/format.ts:
 * импорт из apps/api тянул бы серверный код (scoped-repo, hono),
 * поэтому держим маленькое чистое зеркало. Менять только вместе с ботом.
 */

const SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', RUB: '₽', KGS: 'с', KZT: '₸', UAH: '₴', GEL: '₾',
  AMD: '֏', AZN: '₼', BYN: 'Br', TRY: '₺', GBP: '£', JPY: '¥', CNY: '¥',
  KRW: '₩', INR: '₹', THB: '฿', VND: '₫', PLN: 'zł', CZK: 'Kč', HUF: 'Ft',
};

/** копия fmtMoney: «44 282 ₽» · «1 234,50 $» — тысячи NBSP, 0 или 2 знака. */
export function fmtMoney(amount: number, currency: string): string {
  const c = currency.toUpperCase();
  const sym = SYMBOLS[c] ?? c;
  const dec = Number.isInteger(amount) ? 0 : 2;
  const [int, frac] = Math.abs(amount).toFixed(dec).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = amount < 0 ? '−' : '';
  return `${sign}${grouped}${frac ? ',' + frac : ''} ${sym}`;
}

/** копия fmtPct из bot/format.ts. */
export function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** minor units (копейки, как в D1) → fmtMoney. */
export const fmtMinor = (minor: number, currency: string): string => fmtMoney(minor / 100, currency);

/** Большие суммы компактно: «182,4 млн ₫», «1,2 млрд ₽» — для плиток и строк. */
export function fmtCompact(amount: number, currency: string): string {
  const c = currency.toUpperCase();
  const sym = SYMBOLS[c] ?? c;
  const a = Math.abs(amount);
  const [v, unit] = a >= 1e9 ? [amount / 1e9, 'млрд'] : [amount / 1e6, 'млн'];
  const rounded = (Math.round(v * 10) / 10).toFixed(1).replace('.', ',');
  return `${rounded} ${unit} ${sym}`;
}

/** fmtMoney, но |amount| ≥ 1 млн — компактно (млн/млрд), чтобы не ломать вёрстку. */
export const fmtAuto = (amount: number, currency: string): string =>
  Math.abs(amount) >= 1e6 ? fmtCompact(amount, currency) : fmtMoney(amount, currency);

/** minor units → fmtAuto (компактные миллионы). */
export const fmtMinorAuto = (minor: number, currency: string): string => fmtAuto(minor / 100, currency);

/** 'YYYY-MM-DD' → 'ДД.ММ'. */
export const fmtDay = (iso: string): string => {
  const [, m, d] = iso.split('-');
  return m && d ? `${d}.${m}` : iso;
};

/** Сегодня в локальной таймзоне устройства — 'YYYY-MM-DD' для input[type=date]. */
export const todayIso = (): string => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

// ── клиентская валидация — те же лимиты, что LIMITS в apps/api/src/tma/api.ts ──

export const LIMITS = { maxAmount: 1e9, maxNote: 200, maxName: 60 } as const;
export const CCY_RE = /^[A-Z]{3,5}$/;

/**
 * Список валют для селектов (~30 ходовых кодов). Не в списке →
 * опция «Другое…» открывает свободный ввод (валидация currencyError).
 */
export const CCY_LIST: readonly string[] = [
  'USD',
  'EUR',
  'RUB',
  'KGS',
  'KZT',
  'UAH',
  'UZS',
  'GEL',
  'AMD',
  'AZN',
  'BYN',
  'TRY',
  'GBP',
  'CHF',
  'JPY',
  'CNY',
  'AED',
  'INR',
  'THB',
  'VND',
  'KRW',
  'PLN',
  'CZK',
  'HUF',
  'CAD',
  'AUD',
  'NZD',
  'SEK',
  'NOK',
  'DKK',
];

/** «1 234,56» / «1234.56» → number | null (null — не число). */
export function parseAmount(raw: string): number | null {
  const s = raw
    .trim()
    .replace(/[\s ]/g, '')
    .replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** сумма >0 и ≤ 1e9 — иначе текст ошибки для пользователя. */
export function amountError(raw: string): string | null {
  const n = parseAmount(raw);
  if (n === null) return 'Введите сумму числом, например «320» или «49,90»';
  if (n <= 0) return 'Сумма должна быть больше нуля';
  if (n > LIMITS.maxAmount) return 'Слишком большая сумма';
  return null;
}

export function currencyError(raw: string): string | null {
  return CCY_RE.test(raw.trim().toUpperCase())
    ? null
    : 'Валюта — 3–5 латинских буквы (USD, EUR, RUB, KGS…)';
}

/** день платежа: пусто → null (необязателен), иначе целое 1–31. */
export function dayError(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 31) return 'День — целое число от 1 до 31';
  return null;
}

export function nameError(raw: string): string | null {
  const s = raw.trim();
  if (!s) return 'Название обязательно';
  if (s.length > LIMITS.maxName) return `Название — не длиннее ${LIMITS.maxName} символов`;
  return null;
}

export function noteError(raw: string): string | null {
  return raw.length > LIMITS.maxNote ? `Заметка — не длиннее ${LIMITS.maxNote} символов` : null;
}

/** Проверка IANA-таймзоны через Intl (бросает RangeError на невалидной). */
export function timezoneError(raw: string): string | null {
  const s = raw.trim();
  if (!s) return 'Укажите таймзону';
  try {
    new Intl.DateTimeFormat('en', { timeZone: s });
    return null;
  } catch {
    return 'Неизвестная таймзона — формат IANA, например Europe/Moscow';
  }
}
