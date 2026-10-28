/**
 * tma/fx.ts — REST «💱 Курсы» и журнал обменов для Mini App (шаг 8).
 *
 * Анализ — тот же services/fx.ts, что и у бота (один запрос истории на пару,
 * кросс через USD как в v1). Запись — scoped-repo с идемпотентностью по
 * client_id ('tma:<client_id>'). market_rate — текущий рынок через
 * getFxRates (D1-кэш); провайдер молчит → null. Все id — WHERE user_id.
 * Деньги на границе — minor units; в теле запросов — major (как debts/loans).
 */
import { z } from 'zod';
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { ExchangeRow, UserRow } from '../db/repo';
import type { FxProvider } from '../fx/provider';
import { todayInTz } from '../bot/parse';
import { buildAnalysis, fxPairDefs, histOf, localStamp } from '../services/fx';
import {
  bad,
  err,
  fail,
  fxGet,
  idOf,
  LIMITS,
  needProfile,
  notFound,
  okJson,
  repoOf,
  zAmount,
  zCcy,
  zClientId,
  zIso,
  type TmaContext as C,
} from './common';
import { toMinor } from '../domain/money';

// ── zod-схемы ──

const exchangeCreateSchema = z.object({
  from: zCcy,
  to: zCcy,
  amount_from: zAmount, // major units
  amount_to: zAmount,
  spent_on: zIso.optional(),
  note: z.string().trim().max(LIMITS.maxNote).optional().default(''),
  client_id: zClientId, // идемпотентность создания (P2-3) → exchanges.source_key
});
const exchangePatchSchema = z.object({
  amount_from: zAmount.optional(),
  amount_to: zAmount.optional(),
  spent_on: zIso.optional(),
  note: z.string().trim().max(LIMITS.maxNote).optional(),
});

/** Лимит журнала — как maxLoans/maxDebts (P2-2): экранный список не разрастается. */
const MAX_EXCHANGES = 200;

// ── DTO-маппер (minor units наружу) ──

const exchangeDto = (x: ExchangeRow) => ({
  id: x.id,
  from_ccy: x.from_ccy,
  to_ccy: x.to_ccy,
  amount_from_minor: x.amount_from_minor,
  amount_to_minor: x.amount_to_minor,
  rate: x.rate,
  market_rate: x.market_rate,
  spent_on: x.spent_on,
  note: x.note,
  created_at: x.created_at,
});

export function registerTmaFx(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
  fx: FxProvider,
): void {
  const exchangeOf = async (c: C): Promise<ExchangeRow | null> => {
    const id = idOf(c);
    if (!id) return null;
    return repoOf(c).getExchange(id);
  };
  const wrap = (fn: (c: C) => Promise<Response>) => async (c: C) => {
    try {
      return await fn(c);
    } catch (e) {
      const f = fail(e);
      if (!f) throw e;
      return c.json(f.body, f.status as 400);
    }
  };

  /** Пары + один прогон анализа (история на пару, кросс USD — как в боте). */
  const analysisOf = async (c: C) => {
    const repo = repoOf(c);
    const p = await needProfile(c);
    const debts = await repo.listDebts();
    const pairs = fxPairDefs(p, debts.results.map((d) => d.currency));
    const now = new Date();
    return buildAnalysis(histOf(fx), pairs, now, localStamp(p.timezone, now));
  };

  /** Экран /fx: анализ + журнал обменов одним ответом. */
  app.get(
    '/api/tma/fx',
    tmaAuth,
    wrap(async (c) => {
      const repo = repoOf(c);
      const [analysis, ex] = await Promise.all([analysisOf(c), repo.listExchanges(50)]);
      return okJson(c, { analysis, exchanges: ex.results.map(exchangeDto) });
    }),
  );

  app.get(
    '/api/tma/exchanges',
    tmaAuth,
    wrap(async (c) => {
      await needProfile(c);
      const ex = await repoOf(c).listExchanges(50);
      return okJson(c, { exchanges: ex.results.map(exchangeDto) });
    }),
  );

  app.post(
    '/api/tma/exchanges',
    tmaAuth,
    wrap(async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = exchangeCreateSchema.safeParse(body);
      if (!parsed.success)
        return c.json(bad('нужны from, to (валюты), amount_from>0, amount_to>0').body, 400);
      const b = parsed.data;
      if (b.from === b.to) return c.json(bad('валюты должны отличаться').body, 400);
      const p = await needProfile(c);
      const repo = repoOf(c);
      // P2-3: повтор с тем же client_id → 200 + старый id
      const key = b.client_id ? `tma:${b.client_id}` : `tma:u:${crypto.randomUUID()}`;
      if (b.client_id) {
        const dup = await repo.findExchangeByKey(key);
        if (dup) return okJson(c, { id: dup.id, duplicate: true });
      }
      if ((await repo.listExchanges(500)).results.length >= MAX_EXCHANGES)
        return c.json(err('limit', `Максимум ${MAX_EXCHANGES} записей журнала`, 400).body, 400);
      // market_rate — текущий рынок; провайдер молчит → null (как в боте)
      let market: number | null = null;
      try {
        const r = await fxGet(c, fx)([b.from, b.to]);
        market = r.perUsd[b.to]! / r.perUsd[b.from]!;
      } catch {
        market = null;
      }
      const r = await repo.addExchange({
        from_ccy: b.from,
        to_ccy: b.to,
        amount_from_minor: toMinor(b.amount_from),
        amount_to_minor: toMinor(b.amount_to),
        market_rate: market,
        spent_on: b.spent_on ?? todayInTz(p.timezone, new Date()),
        note: b.note,
        source: 'manual',
        source_key: key,
      });
      if (r.meta.changes === 0) {
        // гонка: вставку проглотил UNIQUE — отдаём существующую строку
        const dup = await repo.findExchangeByKey(key);
        return okJson(c, { id: dup?.id ?? 0, duplicate: true });
      }
      return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
    }),
  );

  app.patch(
    '/api/tma/exchanges/:id',
    tmaAuth,
    wrap(async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = exchangePatchSchema.safeParse(body);
      if (!parsed.success || !Object.keys(parsed.data).length)
        return c.json(bad('недопустимые поля').body, 400);
      const x = await exchangeOf(c);
      if (!x) return c.json(notFound().body, 404);
      const b = parsed.data;
      const patch: {
        amount_from_minor?: number;
        amount_to_minor?: number;
        spent_on?: string;
        note?: string;
        rate?: number;
      } = {};
      if (b.amount_from !== undefined) patch.amount_from_minor = toMinor(b.amount_from);
      if (b.amount_to !== undefined) patch.amount_to_minor = toMinor(b.amount_to);
      if (b.spent_on !== undefined) patch.spent_on = b.spent_on;
      if (b.note !== undefined) patch.note = b.note;
      // инвариант rate = to/from по новым значениям (граница repo)
      if (patch.amount_from_minor !== undefined || patch.amount_to_minor !== undefined) {
        const af = patch.amount_from_minor ?? x.amount_from_minor;
        const at = patch.amount_to_minor ?? x.amount_to_minor;
        if (af > 0) patch.rate = at / af;
      }
      await repoOf(c).patchExchange(x.id, patch);
      return okJson(c, { ok: true });
    }),
  );

  app.delete(
    '/api/tma/exchanges/:id',
    tmaAuth,
    wrap(async (c) => {
      const x = await exchangeOf(c);
      if (!x) return c.json(notFound().body, 404);
      await repoOf(c).deleteExchange(x.id);
      return okJson(c, { ok: true });
    }),
  );
}
