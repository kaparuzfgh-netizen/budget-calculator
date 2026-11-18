/**
 * CoinGecko Demo API (T3b). Сверено по официальной документации (2026-11):
 *  - Demo-ключ — заголовок `x-cg-demo-api-key`, база https://api.coingecko.com/api/v3/
 *    (на pro-api.coingecko.com демо-ключ даёт ошибку 10011);
 *  - лимиты Demo: 10 000 запросов/мес, 100/мин; /simple/price: ids, vs_currencies,
 *    precision (full или 0–18), include_last_updated_at (UNIX-секунды);
 *  - АТРИБУЦИЯ обязательна: «Data provided by CoinGecko» со ссылкой на
 *    https://www.coingecko.com/en/api (COINGECKO_ATTRIBUTION).
 * Ключ — только заголовком (не в URL, не в логах). Только Web API.
 */
import { z } from 'zod';
import { decFromProviderNumber } from '../domain/decimal';
import { PriceUnavailable, type PriceProvider, type ProviderQuote } from './provider';

export const COINGECKO_ATTRIBUTION = {
  text: 'Data provided by CoinGecko',
  url: 'https://www.coingecko.com/en/api',
} as const;

const BASE = 'https://api.coingecko.com/api/v3';
const TIMEOUT_MS = 5000;
const ID_RE = /^[a-z0-9-]{1,64}$/;
const VS_RE = /^[a-z]{2,10}$/;

// { bitcoin: { usd: 64000.5, last_updated_at: 1700000000 } }
const responseSchema = z.record(z.string(), z.record(z.string(), z.number()));

export function createCoinGecko(apiKey: string, fetchImpl: typeof fetch = fetch): PriceProvider {
  return {
    source: 'coingecko',
    async latest(ids, vs = []) {
      const idList = [...new Set(ids)].filter((i) => ID_RE.test(i));
      const vsList = [...new Set(vs.map((v) => v.toLowerCase()))].filter((v) => VS_RE.test(v));
      if (!idList.length || !vsList.length) return { quotes: [] };
      const qs = new URLSearchParams({
        ids: idList.join(','),
        vs_currencies: vsList.join(','),
        include_last_updated_at: 'true',
        precision: 'full',
      });
      let res: Response;
      try {
        res = await fetchImpl(`${BASE}/simple/price?${qs}`, {
          headers: { 'x-cg-demo-api-key': apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new PriceUnavailable(); // таймаут/сеть
      }
      if (!res.ok) throw new PriceUnavailable(res.status);
      let data: z.infer<typeof responseSchema>;
      try {
        data = responseSchema.parse(await res.json());
      } catch {
        throw new PriceUnavailable(res.status);
      }
      const quotes: ProviderQuote[] = [];
      for (const id of idList) {
        const row = data[id];
        if (!row) continue;
        const ts = row['last_updated_at'];
        const asOf =
          ts !== undefined && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : new Date().toISOString();
        for (const v of vsList) {
          const price = decFromProviderNumber(row[v]);
          if (price) quotes.push({ id, vs: v.toUpperCase(), price, asOf });
        }
      }
      return { quotes };
    },
  };
}
