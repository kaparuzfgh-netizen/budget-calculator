/**
 * tma/commitments.ts — обязательные платежи (каденсы 0016/0017) и журнал
 * их оплат Mini App. Bearer-JWT, только scoped(user.id); идемпотентность client_id.
 */
import { z } from 'zod';
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { ScopedRepo, UserRow } from '../db/repo';
import { toMinor } from '../domain/money';
import { todayInTz } from '../bot/parse';
import { cadenceLabel, isOccurrencePaid, nextDueOn } from '../domain/schedule';
import {
  bad,
  dupResult,
  err,
  idOf,
  LIMITS,
  notFound,
  notOnboarded,
  okJson,
  profile,
  repoOf,
  zAmount,
  zCcy,
  zClientId,
  zDay,
  zIso,
  type TmaContext as C,
} from './common';

/** Каденс платежа (миграции 0016+0017): frequency + поля по каденсу. */
const zFrequency = z.enum(['monthly', 'interval_days', 'yearly']);
const cadenceFields = {
  frequency: zFrequency.optional(),
  interval_days: z.number().int().min(1).max(366).nullable().optional(),
  anchor_on: zIso.nullable().optional(),
  due_month: z.number().int().min(1).max(12).nullable().optional(),
  /** «каждые N месяцев» (0017): 1–24; >1 только с frequency=monthly + anchor_on + due_day. */
  every_months: z.number().int().min(1).max(24).nullable().optional(),
};
/** Явный NULL обязательного для каденса поля — сразу ошибка (superRefine на схемах). */
function cadenceNullIssues(
  v: { frequency?: 'monthly' | 'interval_days' | 'yearly' | undefined } & Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const f = v.frequency;
  if (f === 'interval_days') {
    if (v.interval_days === null) ctx.addIssue({ code: 'custom', message: 'interval_days: 1–366 обязателен' });
    if (v.anchor_on === null) ctx.addIssue({ code: 'custom', message: 'anchor_on (YYYY-MM-DD) обязателен' });
  }
  if (f === 'yearly') {
    if (v.due_day === null) ctx.addIssue({ code: 'custom', message: 'due_day: 1–31 обязателен' });
    if (v.due_month === null) ctx.addIssue({ code: 'custom', message: 'due_month: 1–12 обязателен' });
  }
  if (typeof v.every_months === 'number' && v.every_months > 1) {
    if (v.due_day === null) ctx.addIssue({ code: 'custom', message: 'due_day: 1–31 обязателен' });
    if (v.anchor_on === null) ctx.addIssue({ code: 'custom', message: 'anchor_on (YYYY-MM-DD) обязателен' });
  }
}
const commitSchema = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.maxName),
    amount: zAmount,
    currency: zCcy.optional(),
    due_day: zDay,
    ...cadenceFields,
    client_id: zClientId,
  })
  .superRefine((v, ctx) => {
    cadenceNullIssues(v, ctx);
    const f = v.frequency ?? 'monthly';
    if (f === 'interval_days') {
      if (v.interval_days == null) ctx.addIssue({ code: 'custom', message: 'interval_days: 1–366 обязателен' });
      if (!v.anchor_on) ctx.addIssue({ code: 'custom', message: 'anchor_on (YYYY-MM-DD) обязателен' });
    }
    if (f === 'yearly') {
      if (v.due_day == null) ctx.addIssue({ code: 'custom', message: 'due_day: 1–31 обязателен' });
      if (v.due_month == null) ctx.addIssue({ code: 'custom', message: 'due_month: 1–12 обязателен' });
    }
    if ((v.every_months ?? 1) > 1) {
      if (f !== 'monthly')
        ctx.addIssue({ code: 'custom', message: 'every_months > 1 — только с каденсом «каждый месяц»' });
      if (v.due_day == null) ctx.addIssue({ code: 'custom', message: 'due_day: 1–31 обязателен' });
      if (!v.anchor_on) ctx.addIssue({ code: 'custom', message: 'anchor_on (YYYY-MM-DD) обязателен' });
    }
  });
const commitPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.maxName).optional(),
    amount: zAmount.optional(),
    currency: zCcy.optional(),
    due_day: z.number().int().min(1).max(31).nullable().optional(),
    ...cadenceFields,
    active: z.boolean().optional(),
  })
  .superRefine(cadenceNullIssues);
/** Итоговый каденс после merge патча со строкой — не должен быть битым. */
function cadenceMergeError(m: {
  frequency: 'monthly' | 'interval_days' | 'yearly';
  interval_days: number | null;
  anchor_on: string | null;
  due_month: number | null;
  due_day: number | null;
  every_months: number;
}): string | null {
  if (m.frequency === 'interval_days' && (m.interval_days == null || !m.anchor_on))
    return 'для «каждые N дней» нужны interval_days (1–366) и anchor_on (YYYY-MM-DD)';
  if (m.frequency === 'yearly' && (m.due_day == null || m.due_month == null))
    return 'для «раз в год» нужны due_day (1–31) и due_month (1–12)';
  if (m.every_months > 1) {
    if (m.frequency !== 'monthly') return '«каждые N месяцев» — только с каденсом «каждый месяц»';
    if (m.due_day == null || !m.anchor_on)
      return 'для «каждые N месяцев» нужны due_day (1–31) и anchor_on (YYYY-MM-DD)';
  }
  return null;
}
const cpayPostSchema = z.object({
  amount: zAmount.optional(),
  paid_on: zIso.optional(),
  client_id: zClientId,
});
const cpayPatchSchema = z.object({ amount: zAmount.optional(), paid_on: zIso.optional() });

export function registerTmaCommitments(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
): void {
  // ── commitments ──
  app.get('/api/tma/commitments', tmaAuth, async (c) => {
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const today = todayInTz(p.timezone, new Date());
    const month = today.slice(0, 7);
    const rows = (await repo.listCommitments(false)).results;
    // оплаты за ~год одним запросом: статус срока + last_paid_on без N запросов
    const since = `${Number(month.slice(0, 4)) - 1}${month.slice(4)}-01`;
    const pays = (await repo.listCommitmentPaymentsSince(since)).results;
    return okJson(c, {
      commitments: rows.map((x) => {
        const mine = pays.filter((e) => e.commitment_id === x.id);
        const last = mine.at(-1) ?? null;
        const next = nextDueOn(x, today);
        // «оплачен»: срок текущего периода оплачен своим периодом; у monthly
        // без даты — легаси-проверка по месяцу (как раньше)
        const paid = next
          ? isOccurrencePaid(x, next, mine.map((e) => e.paid_on))
          : mine.some((e) => e.paid_on.startsWith(month));
        return {
          id: x.id,
          name: x.name,
          amount_minor: x.amount_minor,
          currency: x.currency,
          due_day: x.due_day,
          frequency: x.frequency,
          interval_days: x.interval_days,
          anchor_on: x.anchor_on,
          due_month: x.due_month,
          every_months: x.every_months,
          cadence: cadenceLabel(x),
          next_due_on: next,
          active: x.active,
          paid_this_month: paid,
          last_paid_on: last ? last.paid_on : null,
        };
      }),
    });
  });
  app.post('/api/tma/commitments', tmaAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = commitSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        bad(parsed.error.issues[0]?.message ?? 'нужны name, amount (>0) и корректный каденс').body,
        400,
      );
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const existing = (await repo.listCommitments(false)).results;
    if (existing.length >= LIMITS.maxCommitments) return c.json(err('limit', `Максимум ${LIMITS.maxCommitments} платежей`, 400).body, 400);
    const b = parsed.data;
    const r = await repo.addCommitment({
      name: b.name,
      amount_minor: toMinor(b.amount),
      currency: b.currency ?? p.income_currency,
      due_day: b.due_day ?? null,
      frequency: b.frequency ?? 'monthly',
      interval_days: b.interval_days ?? null,
      anchor_on: b.anchor_on ?? null,
      due_month: b.due_month ?? null,
      every_months: b.every_months ?? 1,
    });
    return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
  });
  app.patch('/api/tma/commitments/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = commitPatchSchema.safeParse(body);
    if (!parsed.success)
      return c.json(bad(parsed.error.issues[0]?.message ?? 'недопустимые поля').body, 400);
    const repo = repoOf(c);
    const cur = await repo.getCommitment(id);
    if (!cur) return c.json(notFound().body, 404);
    const b = parsed.data;
    // каденс после merge со строкой не должен остаться битым
    const merged = {
      frequency: b.frequency ?? cur.frequency,
      interval_days: b.interval_days !== undefined ? b.interval_days : cur.interval_days,
      anchor_on: b.anchor_on !== undefined ? b.anchor_on : cur.anchor_on,
      due_month: b.due_month !== undefined ? b.due_month : cur.due_month,
      due_day: b.due_day !== undefined ? b.due_day : cur.due_day,
      every_months: b.every_months !== undefined ? (b.every_months ?? 1) : cur.every_months,
    };
    const cadErr = cadenceMergeError(merged);
    if (cadErr) return c.json(bad(cadErr).body, 400);
    const patch: Parameters<ScopedRepo['patchCommitment']>[1] = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.amount !== undefined) patch.amount_minor = toMinor(b.amount);
    if (b.currency !== undefined) patch.currency = b.currency;
    if (b.due_day !== undefined) patch.due_day = b.due_day;
    if (b.frequency !== undefined) patch.frequency = b.frequency;
    if (b.interval_days !== undefined) patch.interval_days = b.interval_days;
    if (b.anchor_on !== undefined) patch.anchor_on = b.anchor_on;
    if (b.due_month !== undefined) patch.due_month = b.due_month;
    if (b.every_months !== undefined) patch.every_months = b.every_months ?? 1;
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    await repo.patchCommitment(id, patch);
    return okJson(c, { ok: true });
  });
  app.delete('/api/tma/commitments/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const repo = repoOf(c);
    if (!(await repo.getCommitment(id))) return c.json(notFound().body, 404);
    await repo.deleteCommitment(id);
    return okJson(c, { ok: true });
  });

  // ── журнал оплат платежей (commitment_payments) ──
  app.get('/api/tma/commitments/:id/payments', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    if (!(await repo.getCommitment(id))) return c.json(notFound().body, 404);
    const rows = (await repo.listCommitmentPayments(id)).results;
    return okJson(c, {
      payments: rows.map((e) => ({ id: e.id, amount_minor: e.amount_minor, currency: e.currency, paid_on: e.paid_on, source: e.source })),
    });
  });
  app.post('/api/tma/commitments/:id/payments', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = cpayPostSchema.safeParse(body);
    if (!parsed.success) return c.json(bad('недопустимые amount/paid_on/client_id').body, 400);
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const commit = await repo.getCommitment(id);
    if (!commit) return c.json(notFound().body, 404);
    const b = parsed.data;
    const key = b.client_id ? `tma:${b.client_id}` : `tma:u:${crypto.randomUUID()}`;
    if (b.client_id) {
      const dup = await repo.findCommitmentPaymentByKey(key);
      if (dup) return okJson(c, { id: dup.id, duplicate: true });
    }
    const r = await repo.addCommitmentPayment({
      commitment_id: commit.id,
      amount_minor: b.amount !== undefined ? toMinor(b.amount) : commit.amount_minor,
      currency: commit.currency,
      paid_on: b.paid_on ?? todayInTz(p.timezone, new Date()),
      source: 'manual',
      source_key: key,
    });
    if (r.meta.changes === 0) {
      const dup = b.client_id ? await repo.findCommitmentPaymentByKey(key) : null;
      return dupResult(c, dup);
    }
    return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
  });
  app.patch('/api/tma/commitment-payments/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = cpayPatchSchema.safeParse(body);
    if (!parsed.success || !Object.keys(parsed.data).length) return c.json(bad('недопустимые поля').body, 400);
    const repo = repoOf(c);
    if (!(await repo.getCommitmentPayment(id))) return c.json(notFound().body, 404);
    const b = parsed.data;
    const patch: { amount_minor?: number; paid_on?: string } = {};
    if (b.amount !== undefined) patch.amount_minor = toMinor(b.amount);
    if (b.paid_on !== undefined) patch.paid_on = b.paid_on;
    await repo.updateCommitmentPayment(id, patch);
    return okJson(c, { ok: true });
  });
  app.delete('/api/tma/commitment-payments/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const repo = repoOf(c);
    const w = await repo.deleteCommitmentPayment(id);
    if (w.meta.changes === 0) return c.json(notFound().body, 404);
    return okJson(c, { ok: true });
  });
}
