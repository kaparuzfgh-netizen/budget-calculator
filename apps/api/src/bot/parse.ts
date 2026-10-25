/** parse.ts — чистые парсеры пользовательского ввода бота. */
import { DomainError } from '../domain/errors';

const CCY_RE = /^[A-Za-z]{3,5}$/;

export interface ParsedAmount {
  amount: number;
  currency?: string | undefined;
  note?: string | undefined;
}

/**
 * "<amount> [currency] [note…]" — сумма: "1 234,50" | "1234.5" | "3200 kgs кофе".
 * Валюта — 3–5 букв сразу после числа. Остальной хвост — заметка.
 */
export function parseAmount(text: string, max = 1e9): ParsedAmount {
  const t = text.trim().replace(/[\s\u00A0]+/g, ' ');
  const m = /^([+-]?\d[\d ]*(?:[.,]\d+)?)(?:\s+([A-Za-z]{3,5}))?(?:\s+(.*))?$/.exec(t);
  if (!m) throw new DomainError('PARSE', 'Не понял сумму. Пример: 250 или 250 kgs кофе');
  const amount = Number(m[1]!.replace(/ /g, '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new DomainError('PARSE', 'Сумма должна быть положительным числом');
  }
  if (amount > max) throw new DomainError('PARSE', `Сумма слишком большая (>${max})`);
  const note = (m[3] ?? '').trim();
  return {
    amount,
    currency: m[2] ? m[2].toUpperCase() : undefined,
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

/** 'YYYY-MM-DD' по таймзоне — все «сегодня» вычисляем через Intl. */
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
