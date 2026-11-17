/**
 * tma/holdings.ts — REST «💼 Инвестиции» Mini App (T3a): ручной портфель.
 * Только scoped(user.id); user_id — никогда не вход клиента; мутации по id —
 * WHERE id=? AND user_id=? (чужой id → 404). Количество/цены — строки
 * (domain/decimal), без float. Партнёру по household ничего не отдаётся.
 * Это учёт, а не инвестиционная рекомендация.
 */
import { z } from 'zod';
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { HoldingRow, UserRow } from '../db/repo';
import type { FxProvider } from '../fx/provider';
import { toMinor } from '../domain/money';
import { mulToMinor } from '../domain/decimal';
import { HOLDING_KINDS } from '../domain/portfolio';
import { todayInTz } from '../bot/parse';
import { portfolioView } from '../services/portfolio';
import {
  bad,
  dayInRange,
  dupResult,
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
  zDec,
  zIso,
  type TmaContext as C,
} from './common';

const zTicker = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9.-]{1,12}$/, 'тикер');
const zName = z.string().trim().min(1).max(LIMITS.maxName);
const zNoteN = z.string().trim().max(LIMITS.maxNote);

const createSchema = z.object({
  kind: z.enum(HOLDING_KINDS),
  name: zName,
  ticker: zTicker.nullable().optional(),
  currency: zCcy,
  quantity: zDec.optional(),
  avg_price: zDec.nullable().optional(),
  price: zDec.optional(),
  price_on: zIso.optional(),
  amount: zAmount.optional(), // major units → toMinor
  rate: z.number().finite().min(0).max(100).nullable().optional(),
  opened_on: zIso.nullable().optional(),
  matures_on: zIso.nullable().optional(),
  note: zNoteN.nullable().optional(),
  client_id: zClientId,
});
// вид и client_id не правятся; null допустим для необязательных полей
const patchSchema = z.object({
  name: zName.optional(),
  ticker: zTicker.nullable().optional(),
  currency: zCcy.optional(),
  quantity: zDec.optional(),
  avg_price: zDec.nullable().optional(),
  price: zDec.optional(),
  price_on: zIso.optional(),
  amount: zAmount.optional(),
  rate: z.number().finite().min(0).max(100).nullable().optional(),
  opened_on: zIso.nullable().optional(),
  matures_on: zIso.nullable().optional(),
  note: zNoteN.nullable().optional(),
});

type Shape = {
  kind: HoldingRow['kind'];
  quantity: string | null;
  avg_price: string | null;
  price: string | null;
  amount_minor: number | null;
  opened_on: string | null;
  matures_on: string | null;
};

/** Одна модель оценки на вид: qty×price (crypto/stock/bond) либо сумма (deposit/other). */
function shapeError(h: Shape): string | null {
  if (h.kind === 'crypto' || h.kind === 'stock' || h.kind === 'bond') {
    if (!h.quantity || !h.price) return 'нужны количество и цена';
    if (h.amount_minor !== null) return 'для этого вида сумма не используется';
  } else {
    if (h.amount_minor === null) return 'нужна сумма';
    if (h.quantity || h.avg_price || h.price) return 'для этого вида количество и цена не используются';
  }
  if (h.opened_on && h.matures_on && h.matures_on < h.opened_on) return 'окончание раньше открытия';
  return null;
}

export function registerTmaHoldings(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
  fx: FxProvider,
): void {
  const wrap =
    (h: (c: C) => Promise<Response>) =>
    async (c: C) => {
      try {
        return await h(c);
      } catch (e) {
        const f = fail(e);
        if (!f) throw e;
        return c.json(f.body, f.status as 400);
      }
    };

  app.get(
    '/api/tma/holdings',
    tmaAuth,
    wrap(async (c) => {
      const p = await needProfile(c);
      const v = await portfolioView(repoOf(c), p, fxGet(c, fx), todayInTz(p.timezone, new Date()));
      return okJson(c, { items: v.items, total: v.total, allocation: v.allocation, disclaimer: v.disclaimer });
    }),
  );

  app.post(
    '/api/tma/holdings',
    tmaAuth,
    wrap(async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = createSchema.safeParse(body);
      if (!parsed.success)
        return c.json(bad('проверьте поля: вид, название, валюта, количество/цена (строкой) или сумма').body, 400);
      const p = await needProfile(c);
      const b = parsed.data;
      const repo = repoOf(c);
      const today = todayInTz(p.timezone, new Date());
      const row = {
        kind: b.kind,
        name: b.name,
        ticker: b.ticker ?? null,
        currency: b.currency,
        quantity: b.quantity ?? null,
        avg_price: b.avg_price ?? null,
        price: b.price ?? null,
        price_on: b.price !== undefined ? (b.price_on ?? today) : null,
        amount_minor: b.amount !== undefined ? toMinor(b.amount) : null,
        rate: b.rate ?? null,
        opened_on: b.opened_on ?? null,
        matures_on: b.matures_on ?? null,
        note: b.note ?? null,
      };
      const msg = shapeError(row);
      if (msg) return c.json(bad(msg).body, 400);
      for (const d of [row.price_on, row.opened_on])
        if (d && !dayInRange(d, today)) return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
      // переполнение qty×price → DomainError('TOO_LARGE') → 400 (fail)
      if (row.quantity && row.price) mulToMinor(row.quantity, row.price);
      if (row.quantity && row.avg_price) mulToMinor(row.quantity, row.avg_price);

      const key = b.client_id ? `tma:${b.client_id}` : null;
      if (key) {
        const dup = await repo.findHoldingByKey(key);
        if (dup) return okJson(c, { id: dup.id, duplicate: true });
      }
      if ((await repo.countHoldings()) >= LIMITS.maxHoldings)
        return c.json(err('limit', `Максимум ${LIMITS.maxHoldings} позиций`, 409).body, 409);
      const r = await repo.addHolding({ ...row, source_key: key });
      if (r.meta.changes === 0) return dupResult(c, key ? await repo.findHoldingByKey(key) : null);
      return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
    }),
  );

  app.patch(
    '/api/tma/holdings/:id',
    tmaAuth,
    wrap(async (c) => {
      const id = idOf(c);
      if (!id) return c.json(notFound().body, 404);
      const body = await c.req.json().catch(() => ({}));
      const parsed = patchSchema.safeParse(body);
      if (!parsed.success || !Object.keys(parsed.data).length) return c.json(bad('недопустимые поля').body, 400);
      const p = await needProfile(c);
      const repo = repoOf(c);
      const cur = await repo.getHolding(id);
      if (!cur) return c.json(notFound().body, 404);
      const b = parsed.data;
      const today = todayInTz(p.timezone, new Date());
      const patch: Parameters<typeof repo.patchHolding>[1] = {};
      if (b.name !== undefined) patch.name = b.name;
      if (b.ticker !== undefined) patch.ticker = b.ticker;
      if (b.currency !== undefined) patch.currency = b.currency;
      if (b.quantity !== undefined) patch.quantity = b.quantity;
      if (b.avg_price !== undefined) patch.avg_price = b.avg_price;
      if (b.price !== undefined) {
        patch.price = b.price;
        patch.price_on = b.price_on ?? today; // новая цена — «на сегодня»
      } else if (b.price_on !== undefined) patch.price_on = b.price_on;
      if (b.amount !== undefined) patch.amount_minor = toMinor(b.amount);
      if (b.rate !== undefined) patch.rate = b.rate;
      if (b.opened_on !== undefined) patch.opened_on = b.opened_on;
      if (b.matures_on !== undefined) patch.matures_on = b.matures_on;
      if (b.note !== undefined) patch.note = b.note;
      const merged = { ...cur, ...patch };
      const msg = shapeError(merged);
      if (msg) return c.json(bad(msg).body, 400);
      for (const d of [patch.price_on, patch.opened_on])
        if (d && !dayInRange(d, today)) return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
      if (merged.quantity && merged.price) mulToMinor(merged.quantity, merged.price);
      if (merged.quantity && merged.avg_price) mulToMinor(merged.quantity, merged.avg_price);
      const w = await repo.patchHolding(id, patch);
      if (w.meta.changes === 0) return c.json(notFound().body, 404);
      return okJson(c, { ok: true });
    }),
  );

  app.delete(
    '/api/tma/holdings/:id',
    tmaAuth,
    wrap(async (c) => {
      const id = idOf(c);
      if (!id) return c.json(notFound().body, 404);
      const w = await repoOf(c).deleteHolding(id);
      if (w.meta.changes === 0) return c.json(notFound().body, 404);
      return okJson(c, { ok: true });
    }),
  );
}
