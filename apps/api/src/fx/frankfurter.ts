import { z } from 'zod';
import { FxUnavailable, type FxHistory, type FxLatest, type FxProvider } from './provider';

// GET https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR,RUB,KGS
// → массив [{date, base:'USD', quote:'EUR', rate:1.09}, ...]
// История — тот же endpoint с &from=YYYY-MM-DD&to=YYYY-MM-DD (по строке на день
// и валюту; выходные/праздники в ответе просто отсутствуют — не заполняем).
const ratesSchema = z.array(z.object({ date: z.string(), base: z.string(), quote: z.string(), rate: z.number() }));

/** Один запрос rates endpoint → провалидированный массив строк. */
async function fetchRates(fetchImpl: typeof fetch, url: string) {
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
  return rows.data;
}

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
        for (const r of await fetchRates(fetchImpl, url)) {
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
    /**
     * Один запрос на диапазон дат (не по дню): массив строк {date,quote,rate}
     * группируется по quote → отсортированные ряды. Пустая валюта → её ключа нет.
     */
    async history(base: string, quotes: string[], from: string, to: string): Promise<FxHistory> {
      const qs = quotes.map((q) => q.toUpperCase()).filter((q) => q !== base.toUpperCase());
      const out: FxHistory = {};
      if (!qs.length) return out;
      const url =
        `https://api.frankfurter.dev/v2/rates?base=${encodeURIComponent(base.toUpperCase())}` +
        `&quotes=${qs.map(encodeURIComponent).join(',')}&from=${from}&to=${to}`;
      const rows = await fetchRates(fetchImpl, url);
      const byQuote = new Map<string, { date: string; v: number }[]>();
      for (const r of rows) {
        if (!Number.isFinite(r.rate) || r.rate <= 0) continue; // пропускаем мусорные точки
        const q = r.quote.toUpperCase();
        if (!byQuote.has(q)) byQuote.set(q, []);
        byQuote.get(q)!.push({ date: r.date, v: r.rate });
      }
      for (const [q, pts] of byQuote) out[q] = pts.sort((a, b) => (a.date < b.date ? -1 : 1));
      return out;
    },
  };
}
