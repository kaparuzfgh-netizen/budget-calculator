/**
 * FX-сервис: D1-кэш (TTL 6ч) поверх провайдера. При падении провайдера —
 * устаревший кэш со stale:true; без данных вообще → FxUnavailable.
 */
import { fxRepo } from '../db/repo';
import { FxUnavailable, type FxProvider } from './provider';

const TTL_MS = 6 * 3600 * 1000;

export interface FxResult {
  perUsd: Record<string, number>;
  asOf: string;
  stale: boolean;
}

export async function getFxRates(
  db: D1Database,
  provider: FxProvider,
  currencies: string[],
  now: Date,
): Promise<FxResult> {
  const repo = fxRepo(db);
  const wanted = [...new Set(currencies.map((c) => c.toUpperCase()).filter((c) => c !== 'USD'))];
  const perUsd: Record<string, number> = { USD: 1 };
  const stale: string[] = [];
  let asOf = '';

  for (const c of wanted) {
    const row = await repo.get(c);
    if (row && now.getTime() - Date.parse(row.fetched_at) < TTL_MS) {
      perUsd[c] = row.per_usd;
      asOf = row.as_of;
    } else {
      stale.push(c);
    }
  }
  if (stale.length === 0) return { perUsd, asOf, stale: false };

  try {
    const fresh = await provider.latest(stale);
    for (const c of stale) {
      perUsd[c] = fresh.perUsd[c]!;
      asOf = fresh.asOf || asOf;
      await repo.upsert(c, perUsd[c]!, fresh.asOf, now.toISOString());
    }
    return { perUsd, asOf, stale: false };
  } catch (e) {
    // fallback на устаревший кэш
    const missing: string[] = [];
    for (const c of stale) {
      const row = await repo.get(c);
      if (row) {
        perUsd[c] = row.per_usd;
        asOf = asOf || row.as_of;
      } else missing.push(c);
    }
    if (missing.length) {
      throw new FxUnavailable('Курсы временно недоступны, попробуйте позже', missing[0]);
    }
    if (e instanceof FxUnavailable && e.currency && !(e.currency in perUsd)) throw e;
    return { perUsd, asOf, stale: true };
  }
}
