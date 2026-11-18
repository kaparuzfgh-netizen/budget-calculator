/**
 * MOEX ISS (T3c) — автоцены акций, фондов и облигаций Московской биржи, без ключа.
 * Сверено живыми запросами к https://iss.moex.com/iss (2026-11-18):
 *  - /iss/engines/stock/markets/{shares|bonds}/securities.json?securities=A,B без указания борда
 *    отдаёт строки по всем бордам (BOARDID есть); несуществующий SECID — пустые массивы;
 *  - у облигаций цена — % номинала (domain/moex.ts), SYSTIME — «сейчас», время котировки — UPDATETIME;
 *  - поиск /iss/securities.json?q= (от 2 символов; engine/market/is_trading/limit работают);
 *  - данные отдаются с задержкой 15 минут.
 * УСЛОВИЯ: используем отложенные данные для личного некоммерческого учёта. Перед любым
 * коммерческим использованием (платный тариф, реклама, публичное распространение котировок)
 * перечитать «Порядок использования биржевой информации» (https://fs.moex.com/files/7064/46216)
 * и, вероятно, заключить договор с биржей. Атрибуция MOEX_ATTRIBUTION показывается всегда.
 * Наружу уходят только SECID и строка поиска пользователя (без имён, сумм, количеств).
 * Только Web API; в логи — ничего (код ошибки пишет prices/service.ts).
 */
import { z } from 'zod';
import {
  MOEX_BOARDS,
  MOEX_MARKET,
  moexCcy,
  moexSecid,
  pickMoexQuote,
  type MoexKind,
  type MoexMdRow,
  type MoexSecRow,
} from '../domain/moex';
import { PriceUnavailable, type PriceProvider, type ProviderQuote } from './provider';

export const MOEX_ATTRIBUTION = {
  text: 'Цены акций и облигаций: Московская биржа, задержка 15 мин',
  url: 'https://www.moex.com',
} as const;

const BASE = 'https://iss.moex.com/iss';
const TIMEOUT_MS = 5000;
const BATCH = 10;
const SEC_COLS = 'SECID,BOARDID,CURRENCYID,FACEUNIT,FACEVALUE,ACCRUEDINT,PREVPRICE,PREVDATE';
const MD_COLS = 'SECID,BOARDID,LAST,LCURRENTPRICE,MARKETPRICE,SYSTIME,UPDATETIME';

const cell = z.union([z.string(), z.number(), z.null()]);
const block = z.object({ columns: z.array(z.string()), data: z.array(z.array(cell)) });
const quotesSchema = z.object({ securities: block, marketdata: block });
const searchSchema = z.object({ securities: block });
const securitiesOnlySchema = z.object({ securities: block });

type Row = Record<string, string | number | null>;
const toRows = (b: z.infer<typeof block>): Row[] =>
  b.data.map((r) => Object.fromEntries(b.columns.map((c, i) => [c, r[i] ?? null])));

async function getJson(path: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  const qs = new URLSearchParams({ 'iss.meta': 'off', ...params });
  let res: Response;
  try {
    res = await fetchImpl(`${BASE}${path}?${qs}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new PriceUnavailable(); // таймаут/сеть
  }
  if (!res.ok) throw new PriceUnavailable(res.status);
  try {
    return await res.json();
  } catch {
    throw new PriceUnavailable(res.status);
  }
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new PriceUnavailable(200); // кривой ответ — как сбой (без тел в логах)
  return r.data;
}

export interface MoexSearchItem {
  secid: string;
  isin: string | null;
  name: string;
  kind: MoexKind;
  currency: string;
  board: string;
}

export interface MoexProvider extends PriceProvider {
  /** Поиск бумаг для формы (≤2 внешних запроса). Сбой → PriceUnavailable. */
  search(q: string, kind: MoexKind, fetchLimit?: number): Promise<MoexSearchItem[]>;
}

/**
 * Идентификаторы для latest(): 'stock:SBER' / 'bond:SU26238RMFS4' (рынок — часть id,
 * ключ кэша и ответа — чистый SECID). Остальные — молча отбрасываются.
 */
export function createMoex(fetchImpl: typeof fetch = fetch): MoexProvider {
  return {
    source: 'moex',
    quoteCurrency: 'native',
    ttlMs: 15 * 60 * 1000,
    fallbackMaxAgeDays: 14,

    async latest(ids) {
      const byKind: Record<MoexKind, string[]> = { stock: [], bond: [] };
      for (const raw of ids) {
        const [k, id] = raw.split(':');
        const secid = moexSecid(id);
        if ((k === 'stock' || k === 'bond') && secid && !byKind[k].includes(secid)) byKind[k].push(secid);
      }
      const quotes: ProviderQuote[] = [];
      for (const kind of ['stock', 'bond'] as const) {
        const list = byKind[kind];
        for (let i = 0; i < list.length; i += BATCH) {
          const batch = list.slice(i, i + BATCH);
          const data = parse(
            quotesSchema,
            await getJson(
              `/engines/stock/markets/${MOEX_MARKET[kind]}/securities.json`,
              {
                securities: batch.join(','),
                'iss.only': 'securities,marketdata',
                'securities.columns': SEC_COLS,
                'marketdata.columns': MD_COLS,
              },
              fetchImpl,
            ),
          );
          const secs = toRows(data.securities) as MoexSecRow[];
          const mds = toRows(data.marketdata) as MoexMdRow[];
          for (const secid of batch) {
            const p = pickMoexQuote(kind, secid, secs, mds);
            if (p) quotes.push({ id: secid, vs: p.vs, price: p.price, asOf: p.asOf });
          }
        }
      }
      return { quotes };
    },

    async search(q, kind, limit = 10) {
      const market = MOEX_MARKET[kind];
      const boards = MOEX_BOARDS[market];
      const found = parse(
        searchSchema,
        await getJson(
          '/securities.json',
          {
            q,
            engine: 'stock',
            market,
            is_trading: '1',
            limit: String(limit),
            'iss.only': 'securities',
            'securities.columns': 'secid,isin,shortname,name,primary_boardid,group',
          },
          fetchImpl,
        ),
      );
      const hits = toRows(found.securities).filter(
        (r) => typeof r.secid === 'string' && !!moexSecid(r.secid) && boards.includes(String(r.primary_boardid)),
      );
      if (!hits.length) return [];
      const cur = parse(
        securitiesOnlySchema,
        await getJson(
          `/engines/stock/markets/${market}/securities.json`,
          {
            securities: hits.map((h) => String(h.secid).toUpperCase()).join(','),
            'iss.only': 'securities',
            'securities.columns': 'SECID,BOARDID,CURRENCYID,FACEUNIT',
          },
          fetchImpl,
        ),
      );
      const secs = toRows(cur.securities) as MoexSecRow[];
      const out: MoexSearchItem[] = [];
      for (const h of hits) {
        const secid = String(h.secid).toUpperCase();
        let currency: string | null = null;
        let board = String(h.primary_boardid);
        for (const b of boards) {
          const s = secs.find((r) => r.SECID === secid && r.BOARDID === b);
          if (!s) continue;
          const settle = moexCcy(s.CURRENCYID);
          const ccy = kind === 'bond' ? (moexCcy(s.FACEUNIT) ?? settle) : settle;
          if (ccy && (kind === 'stock' || !settle || settle === ccy)) {
            currency = ccy;
            board = b;
            break;
          }
        }
        if (!currency) continue; // нет подходящего борда — автоцены не будет, не предлагаем
        out.push({
          secid,
          isin: typeof h.isin === 'string' ? h.isin : null,
          name: String(h.shortname ?? h.name ?? secid).slice(0, 60),
          kind,
          currency,
          board,
        });
      }
      return out;
    },
  };
}
