/**
 * portfolio.ts — вид ручного инвест-портфеля (T3a): позиции + оценка в валюте
 * бюджета (living_currency). Один источник для бота (/invest) и Mini App.
 * Курсы — ТОЛЕРАНТНО: валюта без курса исключается из итога и попадает в
 * missing_rates (позиция остаётся видна), а не валит весь экран.
 * Это учёт, а не инвестиционная рекомендация. В логи — ничего (правило 10).
 */
import {
  HOLDING_KINDS,
  allocation,
  depositAccrued,
  holdingValueMinor,
  parseTargets,
  pnlMinor,
  portfolioTotals,
  priceStale,
  type HoldingKind,
} from '../domain/portfolio';
import type { FxResult } from '../fx/service';
import { FxUnavailable } from '../fx/provider';
import type { HoldingRow, ProfileRow, ScopedRepo } from '../db/repo';

export const INVEST_DISCLAIMER = 'Это учёт, а не инвестиционная рекомендация.';

export interface HoldingItem {
  id: number;
  kind: HoldingKind;
  name: string;
  ticker: string | null;
  currency: string;
  quantity: string | null;
  avg_price: string | null;
  price: string | null;
  price_on: string | null;
  price_stale: boolean;
  amount_minor: number | null;
  rate: number | null;
  opened_on: string | null;
  matures_on: string | null;
  note: string | null;
  /** Стоимость в валюте позиции (minor). */
  value_minor: number;
  pnl_minor: number | null;
  accrued_minor: number | null;
}

export interface PortfolioView {
  items: HoldingItem[];
  total: {
    currency: string;
    minor: number | null;
    missing_rates: string[];
    fx_as_of: string | null;
    fx_stale: boolean;
  };
  byKind: Partial<Record<HoldingKind, number>>;
  allocation: {
    current: Partial<Record<HoldingKind, number>>;
    targets: Partial<Record<HoldingKind, number>> | null;
  };
  disclaimer: string;
}

/**
 * Курсы по одной валюте: сбой провайдера на одной (BTC, USDT…) не должен ронять
 * остальные (getFxRates при сбое батча сообщает лишь первую недостающую).
 * Валют ≤ числа позиций (≤50, обычно 2–4); каждая — сначала из D1-кэша 6ч.
 */
async function tolerantRates(
  get: (ccys: string[]) => Promise<FxResult>,
  ccys: string[],
): Promise<{ fxr: FxResult | null; unavailable: Set<string> }> {
  const unavailable = new Set<string>();
  const perUsd: Record<string, number> = { USD: 1 };
  let asOf = '';
  let stale = false;
  for (const c of new Set(ccys.filter((x) => x !== 'USD'))) {
    try {
      const r = await get([c]);
      perUsd[c] = r.perUsd[c]!;
      asOf = asOf || r.asOf;
      stale = stale || r.stale;
    } catch (e) {
      if (!(e instanceof FxUnavailable)) throw e;
      unavailable.add(c);
    }
  }
  return { fxr: { perUsd, asOf, stale }, unavailable };
}

export const toHoldingItem = (h: HoldingRow, today: string): HoldingItem => ({
  id: h.id,
  kind: h.kind,
  name: h.name,
  ticker: h.ticker,
  currency: h.currency,
  quantity: h.quantity,
  avg_price: h.avg_price,
  price: h.price,
  price_on: h.price_on,
  price_stale: priceStale(h, today),
  amount_minor: h.amount_minor,
  rate: h.rate,
  opened_on: h.opened_on,
  matures_on: h.matures_on,
  note: h.note,
  value_minor: holdingValueMinor(h),
  pnl_minor: pnlMinor(h),
  accrued_minor: depositAccrued(h, today),
});

export async function portfolioView(
  repo: ScopedRepo,
  p: ProfileRow,
  fxGet: (ccys: string[]) => Promise<FxResult>,
  today: string,
): Promise<PortfolioView> {
  const rows = (await repo.listHoldings()).results;
  const items = rows.map((h) => toHoldingItem(h, today));
  const base = p.living_currency;
  const foreign = items.some((i) => i.currency !== base);
  const { fxr, unavailable } = foreign
    ? await tolerantRates(fxGet, [base, ...items.map((i) => i.currency)])
    : { fxr: { perUsd: { USD: 1 }, asOf: '', stale: false } as FxResult | null, unavailable: new Set<string>() };

  const perUsd = fxr?.perUsd ?? { USD: 1 };
  const t = portfolioTotals(
    items.map((i) => ({ kind: i.kind, currency: i.currency, valueMinor: i.value_minor })),
    perUsd,
    base,
  );
  const baseUnavailable = foreign && base !== 'USD' && (unavailable.has(base) || !(base in perUsd));
  const missing = new Set([...t.missing, ...[...unavailable].filter((c) => c !== base)]);
  const targets = parseTargets(p.invest_targets);
  return {
    items,
    total: {
      currency: base,
      minor: baseUnavailable ? null : t.totalMinor,
      missing_rates: [...missing].sort(),
      fx_as_of: fxr?.asOf || null,
      fx_stale: fxr?.stale ?? false,
    },
    byKind: t.byKind,
    allocation: { current: allocation(t.byKind), targets },
    disclaimer: INVEST_DISCLAIMER,
  };
}

export const KIND_LABEL: Record<HoldingKind, string> = {
  deposit: 'Вклады',
  bond: 'Облигации',
  crypto: 'Крипта',
  stock: 'Акции',
  other: 'Другое',
};
export { HOLDING_KINDS };
