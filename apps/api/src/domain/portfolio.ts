/**
 * portfolio.ts — оценка ручного инвест-портфеля (T3a). Чистые функции: без I/O,
 * «сегодня» — параметром. Количество/цены — десятичные строки (domain/decimal),
 * деньги позиции — minor units её валюты; в базовую валюту — convert() (float)
 * с округлением до minor на границе (AGENTS.md №11). Это учёт, не рекомендация.
 */
import { DomainError } from './errors';
import { mulToMinor } from './decimal';
import { convert, toMinor } from './money';

export const HOLDING_KINDS = ['deposit', 'bond', 'crypto', 'stock', 'other'] as const;
export type HoldingKind = (typeof HOLDING_KINDS)[number];

/** Через сколько дней ручная цена считается устаревшей. */
export const PRICE_STALE_DAYS = 30;

export interface HoldingLike {
  kind: HoldingKind;
  currency: string;
  quantity: string | null;
  avg_price: string | null;
  price: string | null;
  price_on: string | null;
  amount_minor: number | null;
  rate: number | null; // % годовых
  opened_on: string | null;
  matures_on: string | null;
}

const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/** Текущая стоимость в minor единицах валюты позиции: qty×price, иначе amount_minor, иначе 0. */
export function holdingValueMinor(h: Pick<HoldingLike, 'quantity' | 'price' | 'amount_minor'>): number {
  if (h.quantity && h.price) return mulToMinor(h.quantity, h.price);
  return h.amount_minor ?? 0;
}

/** Результат к цене покупки: qty×(price−avg); null без avg/qty/price. */
export function pnlMinor(h: Pick<HoldingLike, 'quantity' | 'price' | 'avg_price'>): number | null {
  if (!h.quantity || !h.price || !h.avg_price) return null;
  return mulToMinor(h.quantity, h.price) - mulToMinor(h.quantity, h.avg_price);
}

/** Цене больше PRICE_STALE_DAYS дней (или даты нет при наличии цены). */
export function priceStale(h: Pick<HoldingLike, 'price' | 'price_on'>, today: string): boolean {
  if (!h.price) return false;
  if (!h.price_on) return true;
  return dayNum(today) - dayNum(h.price_on) > PRICE_STALE_DAYS;
}

/**
 * «≈ начислено» по вкладу: простые проценты amount×rate×дни/365 с opened_on
 * до min(today, matures_on). null — нет суммы/ставки/даты открытия.
 */
export function depositAccrued(
  h: Pick<HoldingLike, 'kind' | 'amount_minor' | 'rate' | 'opened_on' | 'matures_on'>,
  today: string,
): number | null {
  if (h.kind !== 'deposit' || !h.amount_minor || h.rate === null || !h.opened_on) return null;
  const end = h.matures_on && h.matures_on < today ? h.matures_on : today;
  const days = dayNum(end) - dayNum(h.opened_on);
  if (days <= 0) return 0;
  return Math.round((h.amount_minor * (h.rate / 100) * days) / 365);
}

export interface PortfolioTotals {
  /** Сумма в базовой валюте (minor); позиции без курса не входят. */
  totalMinor: number;
  byKind: Partial<Record<HoldingKind, number>>;
  /** Валюты позиций, для которых нет курса (без дублей). */
  missing: string[];
}

export function portfolioTotals(
  items: { kind: HoldingKind; currency: string; valueMinor: number }[],
  perUsd: Record<string, number>,
  baseCcy: string,
): PortfolioTotals {
  const byKind: Partial<Record<HoldingKind, number>> = {};
  const missing = new Set<string>();
  let total = 0;
  for (const it of items) {
    let v: number;
    if (it.currency === baseCcy) v = it.valueMinor;
    else {
      try {
        v = toMinor(convert(it.valueMinor / 100, it.currency, baseCcy, { perUsd }));
      } catch {
        missing.add(it.currency);
        continue;
      }
    }
    total += v;
    byKind[it.kind] = (byKind[it.kind] ?? 0) + v;
  }
  return { totalMinor: total, byKind, missing: [...missing].sort() };
}

/** Текущие доли по видам, % с одним знаком. Пустой портфель → {}. */
export function allocation(byKind: Partial<Record<HoldingKind, number>>): Partial<Record<HoldingKind, number>> {
  const sum = Object.values(byKind).reduce((s, v) => s + (v ?? 0), 0);
  const out: Partial<Record<HoldingKind, number>> = {};
  if (sum <= 0) return out;
  for (const k of HOLDING_KINDS) {
    const v = byKind[k];
    if (v) out[k] = Math.round((v / sum) * 1000) / 10;
  }
  return out;
}

/** Цели распределения: целые 0..100, сумма 100, ключи ⊂ видов. Возвращает без нулей. */
export function validateTargets(t: Record<string, number>): Partial<Record<HoldingKind, number>> {
  const out: Partial<Record<HoldingKind, number>> = {};
  let sum = 0;
  for (const [k, v] of Object.entries(t)) {
    if (!(HOLDING_KINDS as readonly string[]).includes(k)) throw new DomainError('BAD_TARGETS', `Неизвестный вид '${k}'`);
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new DomainError('BAD_TARGETS', 'Доля — целое от 0 до 100');
    sum += v;
    if (v > 0) out[k as HoldingKind] = v;
  }
  if (sum !== 100) throw new DomainError('BAD_TARGETS', 'Сумма целей должна быть 100%');
  return out;
}

/** Веса DCA для computeWaterfall: без целей — {USD:1} (прежнее поведение). */
export function dcaTargetsFrom(targets: Partial<Record<HoldingKind, number>> | null | undefined): Record<string, number> {
  if (!targets) return { USD: 1 };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(targets)) if (v && v > 0) out[k] = v / 100;
  return Object.keys(out).length ? out : { USD: 1 };
}

/** Безопасно разобрать JSON целей из профиля (битое/невалидное → null). */
export function parseTargets(json: string | null | undefined): Partial<Record<HoldingKind, number>> | null {
  if (!json) return null;
  try {
    return validateTargets(JSON.parse(json) as Record<string, number>);
  } catch {
    return null;
  }
}

// ── Автоцены (T3b) ──

/** Автоцена моложе этого (часы) побеждает ручную. */
export const AUTO_FRESH_HOURS = 24;
/** Котировка старше (дни) не используется совсем. */
export const QUOTE_MAX_AGE_DAYS = 7;

export interface AutoQuote {
  /** Каноническая десятичная строка. */
  price: string;
  /** ISO-время котировки у провайдера. */
  asOf: string;
}

export interface EffectivePrice {
  price: string | null;
  /** 'YYYY-MM-DD' — дата цены (авто: дата котировки). */
  on: string | null;
  source: 'auto' | 'manual';
  /** Авто: котировке больше суток; ручная: старше PRICE_STALE_DAYS. */
  stale: boolean;
  /** ISO-время авто-котировки (null у ручной). */
  at: string | null;
}

/**
 * Действующая цена позиции: свежая автоцена (≤24ч) побеждает ручную; автоцена
 * 1–7 дней — только если новее ручной; иначе ручная. Ручную цену не меняет.
 * `enabled` — флаг профиля; `today`/`nowIso` — параметрами (без I/O).
 */
export function effectivePrice(
  h: Pick<HoldingLike, 'kind' | 'price' | 'price_on'> & { auto_price?: number },
  quote: AutoQuote | null,
  today: string,
  nowIso: string,
  enabled = true,
): EffectivePrice {
  const manual: EffectivePrice = {
    price: h.price,
    on: h.price_on,
    source: 'manual',
    stale: priceStale(h, today),
    at: null,
  };
  if (!enabled || h.auto_price === 0 || h.kind !== 'crypto' || !quote) return manual;
  const ageMs = Date.parse(nowIso) - Date.parse(quote.asOf);
  if (!Number.isFinite(ageMs) || ageMs > QUOTE_MAX_AGE_DAYS * 86_400_000) return manual;
  const auto: EffectivePrice = {
    price: quote.price,
    on: quote.asOf.slice(0, 10),
    source: 'auto',
    stale: ageMs > AUTO_FRESH_HOURS * 3_600_000,
    at: quote.asOf,
  };
  if (ageMs <= AUTO_FRESH_HOURS * 3_600_000) return auto;
  // 1–7 дней: берём более свежую из двух (ручная новее или равна → ручная)
  if (h.price && h.price_on && h.price_on >= auto.on!) return manual;
  return auto;
}
