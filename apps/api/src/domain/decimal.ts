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

/**
 * Единственная граница float у внешних цен (T3b): число из JSON провайдера →
 * каноническая десятичная строка (half-up до 8 знаков). null — котировки нет:
 * не число, ≤0, ≥1e12, округлилось в 0 или не влезло в 12 цифр целой части.
 */
export function decFromProviderNumber(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n >= 1e12) return null;
  const s = n.toFixed(MAX_FRAC_DIGITS);
  const [int = '0', frac = ''] = s.split('.');
  const f = frac.replace(/0+$/, '');
  const out = f ? `${int}.${f}` : int;
  return isCanonicalDec(out) ? out : null;
}

// ── Арифметика цен (T3c): строка × строка без float ──

/** Разбор неотрицательной десятичной строки (допускает 0, в отличие от parseDec). */
function parseNonNeg(s: string): Dec | null {
  const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(s.trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  return { units: BigInt(m[1]! + frac), scale: frac.length };
}

/** units×10^-scale → каноническая строка (half-up до 8 знаков); null — ≤0 или не влезло в 12 цифр. */
function canonFromUnits(units: bigint, scale: number): string | null {
  let u = units;
  let sc = scale;
  if (sc > MAX_FRAC_DIGITS) {
    const den = 10n ** BigInt(sc - MAX_FRAC_DIGITS);
    u = (u + den / 2n) / den;
    sc = MAX_FRAC_DIGITS;
  }
  if (u <= 0n) return null;
  const out = formatDec({ units: u, scale: sc });
  return isCanonicalDec(out) ? out : null;
}

/** a × b (канонические/неотрицательные строки), half-up до 8 знаков; null — результат ≤0 или переполнение. */
export function mulDec(a: string, b: string): string | null {
  const x = parseNonNeg(a);
  const y = parseNonNeg(b);
  if (!x || !y) return null;
  return canonFromUnits(x.units * y.units, x.scale + y.scale);
}

/** a + b; null — переполнение/кривой ввод (сумма двух неотрицательных, хотя бы одно >0). */
export function addDec(a: string, b: string): string | null {
  const x = parseNonNeg(a);
  const y = parseNonNeg(b);
  if (!x || !y) return null;
  const s = Math.max(x.scale, y.scale);
  return canonFromUnits(x.units * 10n ** BigInt(s - x.scale) + y.units * 10n ** BigInt(s - y.scale), s);
}

/** a / 10^n (сдвиг масштаба), half-up до 8 знаков. */
export function divDecPow10(a: string, n: number): string | null {
  const x = parseNonNeg(a);
  if (!x || !Number.isInteger(n) || n < 0) return null;
  return canonFromUnits(x.units, x.scale + n);
}

// ── Журнал сделок (T3d1): вычитание и деление без float ──

/** a − b; при равенстве '0' (единственный неканонический результат); null — результат < 0 или кривой ввод. */
export function subDec(a: string, b: string): string | null {
  const x = parseNonNeg(a);
  const y = parseNonNeg(b);
  if (!x || !y) return null;
  const s = Math.max(x.scale, y.scale);
  const d = x.units * 10n ** BigInt(s - x.scale) - y.units * 10n ** BigInt(s - y.scale);
  if (d < 0n) return null;
  if (d === 0n) return '0';
  return canonFromUnits(d, s);
}

/** Деление units/den с half-up (оба > 0) → каноническая строка до 8 знаков. */
function divUnits(num: bigint, scale: number, den: bigint): string | null {
  if (den <= 0n || num < 0n) return null;
  // num×10^(8−scale)/den с запасом: считаем сразу в 8 знаках после точки
  const shift = MAX_FRAC_DIGITS - scale;
  const n = shift >= 0 ? num * 10n ** BigInt(shift) : num;
  const d = shift >= 0 ? den : den * 10n ** BigInt(-shift);
  const q = (n * 2n + d) / (d * 2n);
  return canonFromUnits(q, MAX_FRAC_DIGITS);
}

/** a / b, half-up до 8 знаков; null — b = 0, результат округлился в 0 или > 12 цифр целой части. */
export function divDec(a: string, b: string): string | null {
  const x = parseNonNeg(a);
  const y = parseNonNeg(b);
  if (!x || !y || y.units === 0n) return null;
  // (xu/10^xs) / (yu/10^ys) = xu×10^ys / (yu×10^xs)
  return divUnits(x.units * 10n ** BigInt(y.scale), 0, y.units * 10n ** BigInt(x.scale));
}

/** a × b / c одним округлением (half-up до 8 знаков); null — c = 0, результат 0 или переполнение. */
export function mulDivDec(a: string, b: string, c: string): string | null {
  const x = parseNonNeg(a);
  const y = parseNonNeg(b);
  const z = parseNonNeg(c);
  if (!x || !y || !z || z.units === 0n) return null;
  // (xu×yu/10^(xs+ys)) / (zu/10^zs) = xu×yu×10^zs / (zu×10^(xs+ys))
  return divUnits(x.units * y.units * 10n ** BigInt(z.scale), 0, z.units * 10n ** BigInt(x.scale + y.scale));
}

/** Сравнение двух неотрицательных десятичных строк (0 допустим): -1 | 0 | 1; кривой ввод → 1. */
export function compareDecStr(a: string, b: string): -1 | 0 | 1 {
  const x = parseNonNeg(a);
  const y = parseNonNeg(b);
  if (!x || !y) return 1;
  return compareDec(x, y);
}
