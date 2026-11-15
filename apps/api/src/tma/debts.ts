/**
 * tma/debts.ts — REST «🏦 Кредиты» и «🤝 Долги» для Mini App (веха H3).
 *
 * Состояние — только replay через services/debts.ts + services/loans.ts
 * (тот же код, что и у бота; никакой своей математики). Запись событий —
 * scoped-repo с идемпотентностью по client_id ('tma:<client_id>'),
 * как у /expenses и /income. Все id — WHERE user_id на стороне repo.
 */
import { z } from 'zod';
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { DebtEventRow, DebtRow, LoanEventRow, LoanRow, UserRow } from '../db/repo';
import type { FxProvider } from '../fx/provider';
import { previewPrepay, previewPrepayShortenTerm } from '../domain/debt';
import { round2, toMinor } from '../domain/money';
import { todayInTz } from '../bot/parse';
import { buildDebtCtx, debtView, type DebtView } from '../services/debts';
import { buildLoanCtx, loanView, type LoanView } from '../services/loans';
import {
  bad,
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
  zDay,
  zIso,
  type TmaContext as C,
} from './common';

// ── zod-схемы ──

const debtCreateSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.maxName),
  amount: zAmount, // текущий остаток/тело
  currency: zCcy,
  rate: z.number().finite().min(0).max(100), // % годовых
  payment: zAmount, // платёж за период
  frequency: z.enum(['monthly', 'biweekly']).default('monthly'),
  due_day: zDay,
  epoch: zIso.optional(), // старт графика; по умолчанию — сегодня в тз юзера
  client_id: zClientId, // идемпотентность создания (P2-3) → debts.source_key
});
const debtPatchSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.maxName).optional(),
  rate: z.number().finite().min(0).max(100).optional(),
  payment: zAmount.optional(),
  due_day: z.number().int().min(1).max(31).nullable().optional(),
});
const debtEventSchema = z.object({
  kind: z.enum(['payment', 'prepay', 'reconcile']),
  amount: zAmount,
  event_on: zIso.optional(),
  mode: z.enum(['reduce_payment', 'reduce_term']).optional(), // только для prepay
  client_id: zClientId,
});
const debtEventPatchSchema = z.object({
  amount: zAmount.optional(),
  event_on: zIso.optional(),
  mode: z.enum(['reduce_payment', 'reduce_term']).nullable().optional(),
});
const loanCreateSchema = z.object({
  counterparty: z.string().trim().min(1).max(LIMITS.maxName),
  direction: z.enum(['owe', 'owed']),
  amount: zAmount,
  currency: zCcy,
  due_on: zIso.nullable().optional(),
  note: z.string().trim().max(LIMITS.maxNote).nullable().optional(),
  client_id: zClientId, // идемпотентность создания (P2-3) → loans.source_key
});
const loanPatchSchema = z.object({
  due_on: zIso.nullable().optional(),
  note: z.string().trim().max(LIMITS.maxNote).nullable().optional(),
});
const loanEventSchema = z.object({
  amount: zAmount,
  event_on: zIso.optional(),
  client_id: zClientId,
});
const loanEventPatchSchema = z.object({
  amount: zAmount.optional(),
  event_on: zIso.optional(),
});

// ── DTO-мапперы (minor units на границе) ──

const debtDto = (v: DebtView) => ({
  id: v.debt.id,
  name: v.debt.name,
  currency: v.debt.currency,
  rate: v.debt.rate * 100, // в D1 — доля, наружу — % годовых
  frequency: v.debt.frequency,
  due_day: v.debt.due_day,
  balance_minor: toMinor(round2(v.balance)),
  payment_minor: toMinor(round2(v.payment)),
  monthly_payment_minor: toMinor(round2(v.monthlyPayment)),
  payments_made: v.paymentsMade,
  months_left: v.monthsLeft,
  payoff_date: v.payoffDate,
  total_interest_minor: toMinor(round2(v.totalInterest)),
});
const debtEventDto = (e: DebtEventRow) => ({
  id: e.id,
  kind: e.kind,
  amount_minor: e.amount_minor,
  event_on: e.event_on,
  mode: e.mode,
});
const loanDto = (v: LoanView) => ({
  id: v.loan.id,
  counterparty: v.loan.counterparty,
  direction: v.loan.direction,
  currency: v.loan.currency,
  amount_minor: v.loan.amount_minor,
  repaid_minor: toMinor(round2(v.repaid)),
  remaining_minor: toMinor(round2(v.remaining)),
  status: v.status,
  due_on: v.loan.due_on,
  note: v.loan.note,
  closed: v.loan.closed_at !== null,
  last_event_on: v.lastEventOn ?? null,
});
const loanEventDto = (e: LoanEventRow) => ({
  id: e.id,
  amount_minor: e.amount_minor,
  event_on: e.event_on,
});

export function registerTmaDebts(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
  fx: FxProvider,
): void {
  /** долг вызывающего или null — отвечает 404 сам (чужой id = 404). */
  const debtOf = async (c: C): Promise<DebtRow | null> => {
    const id = idOf(c);
    if (!id) return null;
    return repoOf(c).getDebt(id);
  };
  const loanOf = async (c: C): Promise<LoanRow | null> => {
    const id = idOf(c);
    if (!id) return null;
    return repoOf(c).getLoan(id);
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

  // ── кредиты ──

  app.get(
    '/api/tma/debts',
    tmaAuth,
    wrap(async (c) => {
      const repo = repoOf(c);
      const p = await needProfile(c);
      const ctx = await buildDebtCtx(repo, p, fxGet(c, fx), new Date());
      return okJson(c, {
        debts: ctx.debts.map(debtDto),
        total_usd_minor:
          ctx.totalUsd === undefined || ctx.totalUsd === 'err' ? null : toMinor(round2(ctx.totalUsd)),
      });
    }),
  );

  app.get(
    '/api/tma/debts/:id',
    tmaAuth,
    wrap(async (c) => {
      const p = await needProfile(c);
      const d = await debtOf(c);
      if (!d) return c.json(notFound().body, 404);
      const v = await debtView(repoOf(c), d, todayInTz(p.timezone, new Date()));
      return okJson(c, { ...debtDto(v), events: v.events.map(debtEventDto) });
    }),
  );

  app.post(
    '/api/tma/debts',
    tmaAuth,
    wrap(async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = debtCreateSchema.safeParse(body);
      if (!parsed.success) return c.json(bad('нужны name, amount>0, currency, rate 0–100, payment>0').body, 400);
      const p = await needProfile(c);
      const b = parsed.data;
      const repo = repoOf(c);
      // P2-3: повтор с тем же client_id → 200 + старый id (как /expenses)
      const key = b.client_id ? `tma:${b.client_id}` : null;
      if (key) {
        const dup = await repo.findDebtByKey(key);
        if (dup) return okJson(c, { id: dup.id, duplicate: true });
      }
      // P2-2: верхняя граница активных долгов (как у commitments)
      if ((await repo.countDebts()) >= LIMITS.maxDebts)
        return c.json(err('limit', `Максимум ${LIMITS.maxDebts} кредитов`, 400).body, 400);
      const r = await repo.addDebt({
        name: b.name,
        currency: b.currency,
        rate: b.rate / 100,
        frequency: b.frequency,
        initial_balance_minor: toMinor(b.amount),
        initial_payment_minor: toMinor(b.payment),
        epoch: b.epoch ?? todayInTz(p.timezone, new Date()),
        due_day: b.due_day ?? null,
        source_key: key,
      });
      if (r.meta.changes === 0) {
        // гонка: вставку проглотил UNIQUE — отдаём существующую строку
        const dup = key ? await repo.findDebtByKey(key) : null;
        return dupResult(c, dup);
      }
      return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
    }),
  );

  app.patch(
    '/api/tma/debts/:id',
    tmaAuth,
    wrap(async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = debtPatchSchema.safeParse(body);
      if (!parsed.success || !Object.keys(parsed.data).length)
        return c.json(bad('недопустимые поля').body, 400);
      const d = await debtOf(c);
      if (!d) return c.json(notFound().body, 404);
      const b = parsed.data;
      const patch: { name?: string; rate?: number; initial_payment_minor?: number; due_day?: number | null } = {};
      if (b.name !== undefined) patch.name = b.name;
      if (b.rate !== undefined) patch.rate = b.rate / 100;
      if (b.payment !== undefined) patch.initial_payment_minor = toMinor(b.payment);
      if (b.due_day !== undefined) patch.due_day = b.due_day;
      await repoOf(c).patchDebt(d.id, patch);
      return okJson(c, { ok: true });
    }),
  );

  app.delete(
    '/api/tma/debts/:id',
    tmaAuth,
    wrap(async (c) => {
      const d = await debtOf(c);
      if (!d) return c.json(notFound().body, 404);
      await repoOf(c).deleteDebt(d.id);
      return okJson(c, { ok: true });
    }),
  );

  /** Превью ЧДП — оба режима сразу (как экран превью в боте). */
  app.get(
    '/api/tma/debts/:id/prepay-preview',
    tmaAuth,
    wrap(async (c) => {
      const p = await needProfile(c);
      const d = await debtOf(c);
      if (!d) return c.json(notFound().body, 404);
      const amount = Number(c.req.query('amount'));
      if (!Number.isFinite(amount) || amount <= 0 || amount > LIMITS.maxAmount)
        return c.json(bad('сумма недопустима').body, 400);
      const v = await debtView(repoOf(c), d, todayInTz(p.timezone, new Date()));
      if (amount > v.balance + 0.005)
        return c.json(bad('сумма ЧДП больше остатка долга').body, 400);
      const snap = {
        rate: v.debt.rate,
        frequency: v.debt.frequency,
        balance: v.balance,
        payment: v.payment,
        paymentsMade: v.paymentsMade,
        effectivePeriods: v.effectivePeriods,
      };
      const pay = previewPrepay(snap, amount); // бросает DomainError при amount > balance
      const term = previewPrepayShortenTerm(snap, amount);
      return okJson(c, {
        balance_before_minor: toMinor(round2(pay.balanceBefore)),
        balance_after_minor: toMinor(round2(pay.balanceAfter)),
        payment_before_minor: toMinor(round2(pay.paymentBefore)),
        payment_after_minor: toMinor(round2(pay.paymentAfter)),
        payment_saved_minor: toMinor(round2(pay.paymentSaved)),
        months_saved: term.monthsSaved,
      });
    }),
  );

  app.post(
    '/api/tma/debts/:id/events',
    tmaAuth,
    wrap(async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = debtEventSchema.safeParse(body);
      if (!parsed.success)
        return c.json(bad('нужны kind (payment|prepay|reconcile) и amount>0').body, 400);
      const p = await needProfile(c);
      const d = await debtOf(c);
      if (!d) return c.json(notFound().body, 404);
      const b = parsed.data;
      const repo = repoOf(c);
      // prepay не может превышать остаток — replay бы ушёл в минус
      if (b.kind === 'prepay') {
        const v = await debtView(repo, d, todayInTz(p.timezone, new Date()));
        if (b.amount > v.balance + 0.005)
          return c.json(bad('сумма ЧДП больше остатка долга').body, 400);
      }
      const key = b.client_id ? `tma:${b.client_id}` : `tma:u:${crypto.randomUUID()}`;
      if (b.client_id) {
        const dup = await repo.findDebtEventByKey(key);
        if (dup) return okJson(c, { id: dup.id, duplicate: true });
      }
      const r = await repo.addDebtEvent({
        debt_id: d.id,
        kind: b.kind,
        amount_minor: toMinor(b.amount),
        event_on: b.event_on ?? todayInTz(p.timezone, new Date()),
        mode: b.kind === 'prepay' ? (b.mode ?? 'reduce_payment') : null,
        source: 'manual',
        source_key: key,
      });
      if (r.meta.changes === 0) {
        const dup = b.client_id ? await repo.findDebtEventByKey(key) : null;
        return dupResult(c, dup);
      }
      return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
    }),
  );

  app.patch(
    '/api/tma/debt-events/:id',
    tmaAuth,
    wrap(async (c) => {
      const id = idOf(c);
      if (!id) return c.json(notFound().body, 404);
      const body = await c.req.json().catch(() => ({}));
      const parsed = debtEventPatchSchema.safeParse(body);
      if (!parsed.success || !Object.keys(parsed.data).length)
        return c.json(bad('недопустимые поля').body, 400);
      const repo = repoOf(c);
      const ev = await repo.getDebtEvent(id);
      if (!ev) return c.json(notFound().body, 404);
      const b = parsed.data;
      if (b.mode !== undefined && ev.kind !== 'prepay')
        return c.json(bad('mode применим только к ЧДП').body, 400);
      const patch: { amount_minor?: number; event_on?: string; mode?: 'reduce_payment' | 'reduce_term' | null } = {};
      if (b.amount !== undefined) patch.amount_minor = toMinor(b.amount);
      if (b.event_on !== undefined) patch.event_on = b.event_on;
      if (b.mode !== undefined) patch.mode = b.mode;
      await repo.updateDebtEvent(id, patch);
      return okJson(c, { ok: true });
    }),
  );

  app.delete(
    '/api/tma/debt-events/:id',
    tmaAuth,
    wrap(async (c) => {
      const id = idOf(c);
      if (!id) return c.json(notFound().body, 404);
      const w = await repoOf(c).deleteDebtEvent(id);
      if (w.meta.changes === 0) return c.json(notFound().body, 404);
      return okJson(c, { ok: true });
    }),
  );

  // ── личные займы ──

  app.get(
    '/api/tma/loans',
    tmaAuth,
    wrap(async (c) => {
      const repo = repoOf(c);
      const p = await needProfile(c);
      const ctx = await buildLoanCtx(repo, p, fxGet(c, fx), new Date());
      const usd = (v: number | 'err' | undefined) => (v === undefined || v === 'err' ? null : toMinor(round2(v)));
      return okJson(c, {
        owe: ctx.owe.map(loanDto),
        owed: ctx.owed.map(loanDto),
        owe_usd_minor: usd(ctx.oweUsd),
        owed_usd_minor: usd(ctx.owedUsd),
      });
    }),
  );

  app.get(
    '/api/tma/loans/:id',
    tmaAuth,
    wrap(async (c) => {
      await needProfile(c);
      const l = await loanOf(c);
      if (!l) return c.json(notFound().body, 404);
      const v = await loanView(repoOf(c), l);
      return okJson(c, { ...loanDto(v), events: v.events.map(loanEventDto) });
    }),
  );

  app.post(
    '/api/tma/loans',
    tmaAuth,
    wrap(async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = loanCreateSchema.safeParse(body);
      if (!parsed.success)
        return c.json(bad('нужны counterparty, direction (owe|owed), amount>0, currency').body, 400);
      await needProfile(c);
      const b = parsed.data;
      const repo = repoOf(c);
      // P2-3: повтор с тем же client_id → 200 + старый id
      const key = b.client_id ? `tma:${b.client_id}` : null;
      if (key) {
        const dup = await repo.findLoanByKey(key);
        if (dup) return okJson(c, { id: dup.id, duplicate: true });
      }
      // P2-2: верхняя граница открытых займов
      if ((await repo.countLoans()) >= LIMITS.maxLoans)
        return c.json(err('limit', `Максимум ${LIMITS.maxLoans} займов`, 400).body, 400);
      const r = await repo.addLoan({
        counterparty: b.counterparty,
        direction: b.direction,
        amount_minor: toMinor(b.amount),
        currency: b.currency,
        due_on: b.due_on ?? null,
        note: b.note ?? null,
        source_key: key,
      });
      if (r.meta.changes === 0) {
        const dup = key ? await repo.findLoanByKey(key) : null;
        return dupResult(c, dup);
      }
      return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
    }),
  );

  app.patch(
    '/api/tma/loans/:id',
    tmaAuth,
    wrap(async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = loanPatchSchema.safeParse(body);
      if (!parsed.success || !Object.keys(parsed.data).length)
        return c.json(bad('недопустимые поля').body, 400);
      const l = await loanOf(c);
      if (!l) return c.json(notFound().body, 404);
      const b = parsed.data;
      const patch: { due_on?: string | null; note?: string | null } = {};
      if (b.due_on !== undefined) patch.due_on = b.due_on;
      if (b.note !== undefined) patch.note = b.note;
      await repoOf(c).patchLoan(l.id, patch);
      return okJson(c, { ok: true });
    }),
  );

  /** Ручное закрытие — остаток прощается; повтор — идемпотентный ok. */
  app.post(
    '/api/tma/loans/:id/close',
    tmaAuth,
    wrap(async (c) => {
      const l = await loanOf(c);
      if (!l) return c.json(notFound().body, 404);
      await repoOf(c).closeLoan(l.id);
      return okJson(c, { ok: true });
    }),
  );

  app.delete(
    '/api/tma/loans/:id',
    tmaAuth,
    wrap(async (c) => {
      const l = await loanOf(c);
      if (!l) return c.json(notFound().body, 404);
      await repoOf(c).deleteLoan(l.id);
      return okJson(c, { ok: true });
    }),
  );

  app.post(
    '/api/tma/loans/:id/events',
    tmaAuth,
    wrap(async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const parsed = loanEventSchema.safeParse(body);
      if (!parsed.success) return c.json(bad('нужна amount>0').body, 400);
      const p = await needProfile(c);
      const l = await loanOf(c);
      if (!l) return c.json(notFound().body, 404);
      const b = parsed.data;
      const repo = repoOf(c);
      const v = await loanView(repo, l);
      if (v.status === 'closed') return c.json(err('closed', 'Заём уже закрыт', 400).body, 400);
      if (b.amount > v.remaining + 0.005)
        return c.json(bad('сумма возврата больше остатка').body, 400);
      const key = b.client_id ? `tma:${b.client_id}` : `tma:u:${crypto.randomUUID()}`;
      if (b.client_id) {
        const dup = await repo.findLoanEventByKey(key);
        if (dup) return okJson(c, { id: dup.id, duplicate: true });
      }
      const r = await repo.addLoanEvent({
        loan_id: l.id,
        amount_minor: toMinor(b.amount),
        event_on: b.event_on ?? todayInTz(p.timezone, new Date()),
        source: 'manual',
        source_key: key,
      });
      if (r.meta.changes === 0) {
        const dup = b.client_id ? await repo.findLoanEventByKey(key) : null;
        return dupResult(c, dup);
      }
      return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
    }),
  );

  app.patch(
    '/api/tma/loan-events/:id',
    tmaAuth,
    wrap(async (c) => {
      const id = idOf(c);
      if (!id) return c.json(notFound().body, 404);
      const body = await c.req.json().catch(() => ({}));
      const parsed = loanEventPatchSchema.safeParse(body);
      if (!parsed.success || !Object.keys(parsed.data).length)
        return c.json(bad('недопустимые поля').body, 400);
      const repo = repoOf(c);
      if (!(await repo.getLoanEvent(id))) return c.json(notFound().body, 404);
      const b = parsed.data;
      const patch: { amount_minor?: number; event_on?: string } = {};
      if (b.amount !== undefined) patch.amount_minor = toMinor(b.amount);
      if (b.event_on !== undefined) patch.event_on = b.event_on;
      await repo.updateLoanEvent(id, patch);
      return okJson(c, { ok: true });
    }),
  );

  app.delete(
    '/api/tma/loan-events/:id',
    tmaAuth,
    wrap(async (c) => {
      const id = idOf(c);
      if (!id) return c.json(notFound().body, 404);
      const w = await repoOf(c).deleteLoanEvent(id);
      if (w.meta.changes === 0) return c.json(notFound().body, 404);
      return okJson(c, { ok: true });
    }),
  );
}
