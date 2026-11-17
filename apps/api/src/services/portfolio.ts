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
  effectivePrice,
  holdingValueMinor,
  parseTargets,
  pnlMinor,
  portfolioTotals,
  type EffectivePrice,
  type HoldingKind,
} from '../domain/portfolio';
import { SUPPORTED_TICKERS, coinIdFor } from '../domain/coins';
import { COINGECKO_ATTRIBUTION } from '../prices/coingecko';
import { quoteKey, type PriceSource, type QuoteRef, type QuoteResult } from '../prices/service';
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
  /** Действующая цена устарела (авто: >24ч; ручная: >30 дней). */
  price_stale: boolean;
  /** Откуда действующая цена: автоцена или ручная. */
  price_source: 'auto' | 'manual';
  effective_price: string | null;
  effective_price_on: string | null;
  /** ISO-время авто-котировки (null у ручной). */
  effective_price_at: string | null;
  /** Флаг позиции «обновлять автоматически». */
  auto_price: boolean;
  /** Тикер крипты есть в белом списке — автоцена возможна. */
  auto_supported: boolean;
  /** Почему автоцены нет, когда она включена и поддерживается. */
  auto_note: 'no_quote' | 'ccy_unsupported' | null;
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
  auto: {
    enabled: boolean;
    available: boolean;
    /** Самое старое fetched_at использованных котировок (ISO). */
    as_of: string | null;
    stale: boolean;
    attribution: { text: string; url: string };
    supported_tickers: string[];
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

export const toHoldingItem = (
  h: HoldingRow,
  today: string,
  eff: EffectivePrice = effectivePrice(h, null, today, '', false),
  autoNote: HoldingItem['auto_note'] = null,
): HoldingItem => ({
  id: h.id,
  kind: h.kind,
  name: h.name,
  ticker: h.ticker,
  currency: h.currency,
  quantity: h.quantity,
  avg_price: h.avg_price,
  price: h.price,
  price_on: h.price_on,
  price_stale: eff.stale,
  price_source: eff.source,
  effective_price: eff.price,
  effective_price_on: eff.on,
  effective_price_at: eff.at,
  auto_price: h.auto_price !== 0,
  auto_supported: coinIdFor(h.kind, h.ticker) !== null,
  auto_note: autoNote,
  amount_minor: h.amount_minor,
  rate: h.rate,
  opened_on: h.opened_on,
  matures_on: h.matures_on,
  note: h.note,
  value_minor: holdingValueMinor({ ...h, price: eff.price }),
  pnl_minor: pnlMinor({ ...h, price: eff.price }),
  accrued_minor: depositAccrued(h, today),
});

export async function portfolioView(
  repo: ScopedRepo,
  p: ProfileRow,
  fxGet: (ccys: string[]) => Promise<FxResult>,
  today: string,
  prices?: PriceSource | null,
  now: Date = new Date(),
): Promise<PortfolioView> {
  const rows = (await repo.listHoldings()).results;
  const autoEnabled = p.auto_prices_enabled === 1;
  // Автоцены: только при флаге профиля и настроенном провайдере (иначе ноль запросов).
  let quotes: QuoteResult | null = null;
  if (autoEnabled && prices?.available) {
    const refs: QuoteRef[] = [];
    for (const h of rows) {
      const id = h.auto_price !== 0 ? coinIdFor(h.kind, h.ticker) : null;
      if (id) refs.push({ id, vs: h.currency.toUpperCase() });
    }
    if (refs.length) quotes = await prices.get(refs);
  }
  const nowIso = now.toISOString();
  const items = rows.map((h) => {
    const id = h.auto_price !== 0 ? coinIdFor(h.kind, h.ticker) : null;
    const q = quotes && id ? (quotes.map.get(quoteKey(id, h.currency)) ?? null) : null;
    const eff = effectivePrice(h, q, today, nowIso, autoEnabled && !!quotes);
    const note: HoldingItem['auto_note'] =
      quotes && id && !q ? (quotes.failed ? 'no_quote' : 'ccy_unsupported') : null;
    return toHoldingItem(h, today, eff, note);
  });
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
    auto: {
      enabled: autoEnabled,
      available: !!prices?.available,
      as_of: quotes?.fetchedAt ?? null,
      stale: quotes?.stale ?? false,
      attribution: { ...COINGECKO_ATTRIBUTION },
      supported_tickers: SUPPORTED_TICKERS,
    },
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
