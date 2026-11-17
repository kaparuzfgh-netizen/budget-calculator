/**
 * Сервис цен (T3b): D1-кэш (общий, без user_id) поверх провайдера.
 * Один пакетный внешний запрос на вызов, только по ненайденным/просроченным
 * монетам; при сбое — пауза провайдера и запасной кэш ≤7 дней. Никогда не
 * бросает из-за провайдера: сбой → failed:true. Без провайдера (нет ключа) —
 * ни одного внешнего запроса. В логи — только HTTP-код и число id (правило 10).
 */
import { priceRepo, type PriceQuoteRow } from '../db/repo';
import { QUOTE_MAX_AGE_DAYS, type AutoQuote } from '../domain/portfolio';
import { PriceUnavailable, type PriceProvider } from './provider';

export const QUOTE_TTL_MS = 15 * 60 * 1000;
const MAX_AGE_MS = QUOTE_MAX_AGE_DAYS * 86_400_000;

export interface QuoteRef {
  id: string;
  /** Валюта котировки, верхний регистр. */
  vs: string;
}

export const quoteKey = (id: string, vs: string) => `${id}|${vs.toUpperCase()}`;

export interface QuoteResult {
  map: Map<string, AutoQuote>;
  /** Самое старое fetched_at среди использованных котировок (ISO) или null. */
  fetchedAt: string | null;
  /** Использован устаревший кэш (сбой/пауза). */
  stale: boolean;
  /** Провайдер не ответил (или на паузе) при необходимости обновить. */
  failed: boolean;
}

/** Источник цен для portfolioView: available — настроен ли провайдер (ключ). */
export interface PriceSource {
  available: boolean;
  get(refs: QuoteRef[]): Promise<QuoteResult>;
}

const empty = (): QuoteResult => ({ map: new Map(), fetchedAt: null, stale: false, failed: false });

function pauseMs(status: number | undefined): number {
  if (status === 429) return 10 * 60_000;
  if (status === 401 || status === 403) return 6 * 3_600_000;
  return 2 * 60_000; // 5xx / таймаут / кривой ответ
}

const oldest = (xs: string[]) => (xs.length ? [...xs].sort()[0]! : null);

export async function getQuotes(
  db: D1Database,
  provider: PriceProvider | null,
  refs: QuoteRef[],
  now: Date,
): Promise<QuoteResult> {
  if (!provider || !refs.length) return empty();
  const repo = priceRepo(db);
  const wantKeys = new Set(refs.map((r) => quoteKey(r.id, r.vs)));
  const ids = [...new Set(refs.map((r) => r.id))];
  const vss = [...new Set(refs.map((r) => r.vs.toUpperCase()))];
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const cached = new Map<string, PriceQuoteRow>();
  for (const row of await repo.getMany(provider.source, vss, ids)) {
    const k = quoteKey(row.asset_id, row.vs_currency);
    if (wantKeys.has(k)) cached.set(k, row);
  }
  const fresh = (row: PriceQuoteRow) => nowMs - Date.parse(row.fetched_at) < QUOTE_TTL_MS;
  const usable = (row: PriceQuoteRow) => nowMs - Date.parse(row.fetched_at) < MAX_AGE_MS;

  const map = new Map<string, AutoQuote>();
  const fetchedAts: string[] = [];
  const take = (k: string, row: PriceQuoteRow) => {
    map.set(k, { price: row.price, asOf: row.as_of });
    fetchedAts.push(row.fetched_at);
  };

  const need = refs.filter((r) => {
    const row = cached.get(quoteKey(r.id, r.vs));
    return !row || !fresh(row);
  });
  for (const [k, row] of cached) if (fresh(row)) take(k, row);
  if (!need.length) return { map, fetchedAt: oldest(fetchedAts), stale: false, failed: false };

  // пауза провайдера → только кэш
  const state = await repo.getState(provider.source);
  let failed = false;
  if (state?.blocked_until && Date.parse(state.blocked_until) > nowMs) failed = true;
  else {
    const needIds = [...new Set(need.map((r) => r.id))];
    const needVs = [...new Set(need.map((r) => r.vs.toUpperCase()))];
    try {
      const { quotes } = await provider.latest(needIds, needVs);
      const rows: PriceQuoteRow[] = [];
      for (const q of quotes) {
        const k = quoteKey(q.id, q.vs);
        if (!wantKeys.has(k)) continue;
        const row = {
          source: provider.source,
          asset_id: q.id,
          vs_currency: q.vs.toUpperCase(),
          price: q.price,
          as_of: q.asOf,
          fetched_at: nowIso,
        };
        rows.push(row);
        take(k, row);
      }
      await repo.upsertMany(rows);
      if (state?.blocked_until) await repo.setState(provider.source, null, null, nowIso);
    } catch (e) {
      if (!(e instanceof PriceUnavailable)) throw e;
      failed = true;
      console.error(`price_fetch_failed status=${e.status ?? 'net'} ids=${needIds.length}`);
      await repo.setState(provider.source, new Date(nowMs + pauseMs(e.status)).toISOString(), e.status ?? null, nowIso);
    }
  }

  // запасной кэш (просроченный ≤7 дней) для всего, чего нет в map
  let stale = false;
  for (const r of need) {
    const k = quoteKey(r.id, r.vs);
    if (map.has(k)) continue;
    const row = cached.get(k);
    if (row && usable(row)) {
      take(k, row);
      stale = true;
    }
  }
  return { map, fetchedAt: oldest(fetchedAts), stale, failed };
}

/** Источник цен для portfolioView/бота: provider=null → available:false, ноль запросов. */
export function makePriceSource(db: D1Database, provider: PriceProvider | null, now: Date): PriceSource {
  return { available: !!provider, get: (refs) => getQuotes(db, provider, refs, now) };
}
