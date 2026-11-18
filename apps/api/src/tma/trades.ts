/**
 * tma/trades.ts — журнал покупок/продаж позиции Mini App (T3d1).
 * Только scoped(user.id); user_id и holding_id из тела не принимаются (strict);
 * чужая позиция/сделка → 404. Количества и суммы — строки (domain/decimal), без float.
 * В логи — только коды ошибок (правило 10). Это учёт, а не рекомендация.
 */
import { z } from 'zod';
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { UserRow } from '../db/repo';
import { mulToMinor } from '../domain/decimal';
import { todayInTz } from '../bot/parse';
import { addTrade, removeTrade, tradesView } from '../services/trades';
import {
  bad,
  dayInRange,
  fail,
  idOf,
  needProfile,
  notFound,
  okJson,
  repoOf,
  zClientId,
  zDec,
  zIso,
  LIMITS,
  type TmaContext as C,
} from './common';

const tradeSchema = z
  .object({
    side: z.enum(['buy', 'sell']),
    quantity: zDec,
    amount: zDec,
    traded_on: zIso.optional(),
    note: z.string().trim().max(LIMITS.maxNote).nullable().optional(),
    client_id: zClientId,
  })
  .strict();

export function registerTmaTrades(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
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
    '/api/tma/holdings/:id/trades',
    tmaAuth,
    wrap(async (c) => {
      const id = idOf(c);
      if (!id) return c.json(notFound().body, 404);
      await needProfile(c);
      const v = await tradesView(repoOf(c), id);
      if (!v) return c.json(notFound().body, 404);
      return okJson(c, v);
    }),
  );

  app.post(
    '/api/tma/holdings/:id/trades',
    tmaAuth,
    wrap(async (c) => {
      const id = idOf(c);
      if (!id) return c.json(notFound().body, 404);
      const parsed = tradeSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json(bad('проверьте поля: покупка/продажа, количество и сумма (строкой), дата').body, 400);
      const p = await needProfile(c);
      const b = parsed.data;
      const today = todayInTz(p.timezone, new Date());
      const tradedOn = b.traded_on ?? today;
      if (!dayInRange(tradedOn, today)) return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
      mulToMinor(b.amount, '1'); // переполнение суммы → DomainError → 400
      const r = await addTrade(repoOf(c), id, {
        side: b.side,
        quantity: b.quantity,
        amount: b.amount,
        traded_on: tradedOn,
        note: b.note ? b.note : null,
        ...(b.client_id ? { client_id: b.client_id } : {}),
      });
      if (r.duplicate) return okJson(c, { id: r.id, duplicate: true });
      return okJson(c, { id: r.id, holding: r.holding }, 201);
    }),
  );

  app.delete(
    '/api/tma/holdings/:id/trades/:tradeId',
    tmaAuth,
    wrap(async (c) => {
      const id = idOf(c);
      const tid = Number(c.req.param('tradeId'));
      if (!id || !Number.isInteger(tid) || tid <= 0) return c.json(notFound().body, 404);
      await needProfile(c);
      const r = await removeTrade(repoOf(c), id, tid);
      return okJson(c, { ok: true, holding: r.holding });
    }),
  );
}
