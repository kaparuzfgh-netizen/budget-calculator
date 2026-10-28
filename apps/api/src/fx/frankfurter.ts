import { z } from 'zod';
import { FxUnavailable, type FxLatest, type FxProvider } from './provider';

// GET https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR,RUB,KGS
// → массив [{date, base:'USD', quote:'EUR', rate:1.09}, ...]
const ratesSchema = z.array(z.object({ date: z.string(), base: z.string(), quote: z.string(), rate: z.number() }));

/** P2-4: внешний запрос не должен висеть до лимита рантайма (в cron пользователи идут последовательно). */
const FETCH_TIMEOUT_MS = 8000;

export function createFrankfurter(fetchImpl: typeof fetch = fetch): FxProvider {
  return {
    async latest(currencies: string[]): Promise<FxLatest> {
      const quotes = currencies.filter((c) => c !== 'USD');
      const perUsd: Record<string, number> = { USD: 1 };
      let asOf = '';
      if (quotes.length) {
        const url = `https://api.frankfurter.dev/v2/rates?base=USD&quotes=${quotes.join(',')}`;
        let json: unknown;
        try {
          // таймаут = обычная ошибка → FxUnavailable ниже (TimeoutError — instanceof Error)
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          json = await res.json();
        } catch (e) {
          throw new FxUnavailable(`FX API недоступен (${e instanceof Error ? e.message : e})`);
        }
        const rows = ratesSchema.safeParse(json);
        if (!rows.success) throw new FxUnavailable('FX API: неожиданный формат ответа');
        for (const r of rows.data) {
          if (!Number.isFinite(r.rate) || r.rate <= 0) {
            throw new FxUnavailable(`FX API: невалидный курс ${r.quote}`, r.quote);
          }
          perUsd[r.quote.toUpperCase()] = r.rate;
          asOf = r.date;
        }
        for (const c of quotes) {
          const cu = c.toUpperCase();
          if (!(cu in perUsd)) throw new FxUnavailable(`Валюта ${cu} не поддерживается`, cu);
        }
      }
      return { perUsd, asOf };
    },
  };
}
