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
  MOEX_POLICY,
  CRYPTO_POLICY,
  effectivePrice,
  valuation,
  investedMinor,
  parseTargets,
  portfolioTotals,
  type EffectivePrice,
  type HoldingKind,
} from '../domain/portfolio';
import { SUPPORTED_TICKERS } from '../domain/coins';
import { priceRefFor, type PriceRef } from '../domain/price-ref';
import { COINGECKO_ATTRIBUTION } from '../prices/coingecko';
import { MOEX_ATTRIBUTION } from '../prices/moex';
import { mapKey, type PriceSources, type QuoteRef, type QuoteResult } from '../prices/service';
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
  /** «Потрачено всего» (десятичная строка); у старых строк — qty×avg_price. */
  invested: string | null;
  price: string | null;
  price_on: string | null;
  /** Действующая цена устарела (авто: >24ч; ручная: >30 дней). */
  price_stale: boolean;
  /** Откуда действующая цена: автоцена или ручная. */
  price_source: 'auto' | 'manual';
  /** Источник автоцены (null у ручной). */
  price_provider: 'coingecko' | 'moex' | null;
  /** 'with_aci' — цена облигации включает НКД. */
  price_note: 'with_aci' | null;
  effective_price: string | null;
  effective_price_on: string | null;
  /** ISO-время авто-котировки (null у ручной). */
  effective_price_at: string | null;
  /** Флаг позиции «обновлять автоматически». */
  auto_price: boolean;
  /** Для позиции есть источник автоцены (крипта из белого списка; акция/облигация с кодом). */
  auto_supported: boolean;
  /** Почему автоцены нет, когда она включена и поддерживается. */
  auto_note: 'no_quote' | 'ccy_unsupported' | 'ccy_mismatch' | 'not_found' | null;
  amount_minor: number | null;
  rate: number | null;
  opened_on: string | null;
  matures_on: string | null;
  note: string | null;
  /** Стоимость в валюте позиции (minor). */
  value_minor: number;
  pnl_minor: number | null;
  /** Цены нет — оценено по «потрачено», результат 0. */
  valued_at_cost: boolean;
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
    /** Какие источники настроены на сервере. */
    sources: { coingecko: boolean; moex: boolean };
    /** Самое старое fetched_at использованных котировок (ISO). */
    as_of: string | null;
    stale: boolean;
    /** Подписи источников, цены которых могут быть на экране (по позициям портфеля). */
    attributions: { text: string; url: string }[];
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

/** «Потрачено» для отдачи: своё значение либо qty×avg_price старых строк (десятичная строка). */
function investedStr(h: HoldingRow): string | null {
  if (h.invested) return h.invested;
  const m = investedMinor(h);
  if (m === null) return null;
  return `${Math.trunc(m / 100)}.${String(m % 100).padStart(2, '0')}`.replace(/.00$/, '').replace(/(.d)0$/, '$1');
}

export const toHoldingItem = (
  h: HoldingRow,
  today: string,
  eff: EffectivePrice = effectivePrice(h, null, today, '', false),
  autoNote: HoldingItem['auto_note'] = null,
  provider: PriceRef['source'] | null = null,
): HoldingItem => {
  const val = valuation({ ...h, price: eff.price });
  return {
  id: h.id,
  kind: h.kind,
  name: h.name,
  ticker: h.ticker,
  currency: h.currency,
  quantity: h.quantity,
  avg_price: h.avg_price,
  invested: investedStr(h),
  price: h.price,
  price_on: h.price_on,
  price_stale: eff.stale,
  price_source: eff.source,
  price_provider: eff.source === 'auto' ? provider : null,
  price_note: eff.source === 'auto' && provider === 'moex' && h.kind === 'bond' ? 'with_aci' : null,
  effective_price: eff.price,
  effective_price_on: eff.on,
  effective_price_at: eff.at,
  auto_price: h.auto_price !== 0,
  auto_supported: priceRefFor(h.kind, h.ticker) !== null,
  auto_note: autoNote,
  amount_minor: h.amount_minor,
  rate: h.rate,
  opened_on: h.opened_on,
  matures_on: h.matures_on,
  note: h.note,
  value_minor: val.valueMinor,
  pnl_minor: val.pnlMinor,
  valued_at_cost: val.atCost,
  accrued_minor: depositAccrued(h, today),
  };
};

export async function portfolioView(
  repo: ScopedRepo,
  p: ProfileRow,
  fxGet: (ccys: string[]) => Promise<FxResult>,
  today: string,
  prices?: Partial<PriceSources> | null,
  now: Date = new Date(),
): Promise<PortfolioView> {
  const rows = (await repo.listHoldings()).results;
  const autoEnabled = p.auto_prices_enabled === 1;
  const refOf = (h: HoldingRow): PriceRef | null => (h.auto_price !== 0 ? priceRefFor(h.kind, h.ticker) : null);
  // Автоцены: только при флаге профиля и настроенном провайдере (иначе ноль запросов).
  const quotes: Partial<Record<PriceRef['source'], QuoteResult>> = {};
  if (autoEnabled) {
    for (const src of ['coingecko', 'moex'] as const) {
      const source = prices?.[src];
      if (!source?.available) continue;
      const refs: QuoteRef[] = [];
      for (const h of rows) {
        const ref = refOf(h);
        if (ref?.source !== src) continue;
        refs.push({ id: ref.id, vs: h.currency.toUpperCase(), ...(ref.source === 'moex' ? { hint: `${ref.kind}:${ref.id}` } : {}) });
      }
      if (refs.length) quotes[src] = await source.get(refs);
    }
  }
  const nowIso = now.toISOString();
  const items = rows.map((h) => {
    const ref = refOf(h);
    const qr = ref ? quotes[ref.source] : undefined;
    let q = qr && ref ? (qr.map.get(mapKey(prices?.[ref.source]?.native ?? false, ref.id, h.currency)) ?? null) : null;
    let note: HoldingItem['auto_note'] = null;
    if (qr && ref) {
      if (q && q.vs && q.vs.toUpperCase() !== h.currency.toUpperCase()) {
        // MOEX: цена в родной валюте бумаги, в другую не переводим (float на цене запрещён, правило 21)
        q = null;
        note = 'ccy_mismatch';
      } else if (!q) {
        note = qr.failed ? 'no_quote' : ref.source === 'moex' ? 'not_found' : 'ccy_unsupported';
      }
    }
    const eff = effectivePrice(h, q, today, nowIso, autoEnabled && !!qr, ref?.source === 'moex' ? MOEX_POLICY : CRYPTO_POLICY);
    return toHoldingItem(h, today, eff, note, ref?.source ?? null);
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
      available: !!(prices?.coingecko?.available || prices?.moex?.available),
      sources: { coingecko: !!prices?.coingecko?.available, moex: !!prices?.moex?.available },
      as_of: Object.values(quotes).map((x) => x.fetchedAt).filter((x): x is string => !!x).sort()[0] ?? null,
      stale: Object.values(quotes).some((x) => x.stale),
      attributions: (['coingecko', 'moex'] as const)
        .filter((src) => autoEnabled && !!prices?.[src]?.available && rows.some((h) => refOf(h)?.source === src))
        .map((src) => ({ ...(src === 'moex' ? MOEX_ATTRIBUTION : COINGECKO_ATTRIBUTION) })),
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
