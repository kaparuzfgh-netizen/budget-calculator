/**
 * decimal.ts — точная десятичная арифметика на BigInt (T3a, инвестиции).
 * Количество и цены хранятся КАНОНИЧЕСКОЙ строкой (до 12 цифр целой части и
 * до 8 дробных, >0, без лишних нулей): float потерял бы 8-й знак, а
 * toMinor() обнулил бы цену мелких токенов. Чистые функции, без I/O.
 */
import { DomainError } from './errors';

const MAX_INT_DIGITS = 12;
const MAX_FRAC_DIGITS = 8;
/** Потолок суммы в major units — как LIMITS.maxAmount в tma/common. */
const MAX_MAJOR = 1_000_000_000n;
const CANON_RE = /^(0|[1-9]\d{0,11})(\.\d{0,7}[1-9])?$/;

export interface Dec {
  /** Значение × 10^scale. */
  units: bigint;
  scale: number;
}

/** Каноническая ли строка (для zod refine): >0, без ведущих/хвостовых нулей. */
export function isCanonicalDec(s: string): boolean {
  if (!CANON_RE.test(s)) return false;
  return /[1-9]/.test(s);
}

/** Привести ввод пользователя к каноническому виду: запятая → точка, срез нулей. Иначе — DomainError. */
export function normalizeDec(raw: string): string {
  const t = String(raw).trim().replace(',', '.');
  const m = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(t);
  if (!m) throw new DomainError('BAD_DECIMAL', 'Число: до 12 цифр до точки и до 8 после');
  const int = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  if (!/[1-9]/.test(out)) throw new DomainError('BAD_DECIMAL', 'Число должно быть больше нуля');
  return out;
}

export function parseDec(s: string): Dec {
  const c = normalizeDec(s);
  const [int = '0', frac = ''] = c.split('.');
  if (int.length > MAX_INT_DIGITS || frac.length > MAX_FRAC_DIGITS) throw new DomainError('BAD_DECIMAL', 'Слишком длинное число');
  return { units: BigInt(int + frac), scale: frac.length };
}

export function formatDec(d: Dec): string {
  const neg = d.units < 0n;
  const s = (neg ? -d.units : d.units).toString().padStart(d.scale + 1, '0');
  const int = s.slice(0, s.length - d.scale);
  const frac = d.scale ? s.slice(s.length - d.scale).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Сравнение a<b → -1, = → 0, > → 1. */
export function compareDec(a: Dec, b: Dec): -1 | 0 | 1 {
  const s = Math.max(a.scale, b.scale);
  const x = a.units * 10n ** BigInt(s - a.scale);
  const y = b.units * 10n ** BigInt(s - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * round_half_up(qty × price × 100) → целые minor units (точно, в BigInt).
 * price/qty — канонические строки. > 1e9 major → DomainError('TOO_LARGE').
 */
export function mulToMinor(qty: string, price: string): number {
  const q = parseDec(qty);
  const p = parseDec(price);
  const scale = BigInt(q.scale + p.scale);
  const num = q.units * p.units * 100n;
  const den = 10n ** scale;
  const minor = (num + den / 2n) / den;
  if (minor > MAX_MAJOR * 100n) throw new DomainError('TOO_LARGE', 'Сумма позиции слишком велика');
  return Number(minor);
}
