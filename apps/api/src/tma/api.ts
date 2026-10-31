/**
 * tma/api.ts — REST API Mini App (шаг 5, паритет бота).
 * Все роуты за Bearer-JWT middleware; доступ только через scoped(user.id);
 * суммы в minor units на границах; ошибки {error:{code,message}}.
 * Парсинг/математика НЕ дублируются — переиспользуются bot/parse, domain/*,
 * resolveIncome (features), weeklyStatus, computeWaterfall.
 */
import { z } from 'zod';
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { ScopedRepo, UserRow } from '../db/repo';
import type { FxResult } from '../fx/service';
import type { FxProvider } from '../fx/provider';
import { computeWaterfall } from '../domain/cashflow';
import { weeklyStatus } from '../domain/budget';
import { convert, round2, toMinor } from '../domain/money';

const usd = (amount: number, ccy: string, pu: Record<string, number>) => convert(amount, ccy, 'USD', { perUsd: pu });
import { resolveIncome } from '../bot/features';
import { isValidTimezone, monthInTz, todayInTz, weekStartInTz } from '../bot/parse';
import { matchCategory } from '../domain/categories';
import { buildUserReport } from '../services/report';
import { baselineIncome } from '../services/baseline';
import type { Period } from '../domain/report';
import { debtViews } from '../services/debts';
import { dueDateFor } from '../services/reminders';
import { cadenceLabel, isOccurrencePaid, monthlyAmount, nextDueOn, occurrencesInRange } from '../domain/schedule';
import {
  bad,
  CCY_RE,
  dayInRange,
  err,
  fail,
  fxGet,
  idOf,
  LIMITS,
  needProfile,
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
  zNote,
  type TmaContext as C,
} from './common';

export { LIMITS };

const moneySchema = z.object({
  amount: zAmount,
  currency: zCcy.optional(),
  note: zNote,
  client_id: zClientId,
  category_id: z.number().int().positive().nullable().optional(),
  /** 'YYYY-MM-DD' — spent_on для расходов, received_on для доходов (ниже по коду). */
  spent_on: zIso.optional(),
  received_on: zIso.optional(),
});
const expensePatchSchema = z.object({
  amount: zAmount.optional(),
  currency: zCcy.optional(),
  note: z.string().trim().max(LIMITS.maxNote).nullable().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  spent_on: zIso.optional(),
});
const incomePatchSchema = z.object({
  received_on: zIso.optional(),
  note: z.string().trim().max(LIMITS.maxNote).nullable().optional(),
});
const categorySchema = z.object({
  name: z.string().trim().min(1).max(32),
  emoji: z.string().max(8).optional(),
  client_id: zClientId,
});
const categoryPatchSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  emoji: z.string().max(8).optional(),
  archived: z.boolean().optional(),
  sort: z.number().int().optional(),
});
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
const profilePatchSchema = z.object({
  typical_income: z.number().min(0).max(LIMITS.maxAmount).optional(),
  income_currency: zCcy.optional(),
  living_cap: zAmount.optional(),
  living_currency: zCcy.optional(),
  /** Валюта повседневных трат по умолчанию; null — вернуться к living_currency. */
  expense_currency: zCcy.nullable().optional(),
  timezone: z.string().optional(),
  // переключатели напоминаний/фич — все 4, как в боте
  reminders_weekly: z.boolean().optional(),
  reminders_payments: z.boolean().optional(),
  fx_alerts_enabled: z.boolean().optional(),
  vision_enabled: z.boolean().optional(),
});

export function registerTmaApi(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
  fx: FxProvider,
): void {

  // ── GET /plan ──
  app.get('/api/tma/plan', tmaAuth, async (c) => {
    try {
      const repo = repoOf(c);
      const p = await needProfile(c);
      const q = c.req.query();
      const override =
        q.income !== undefined && q.income !== ''
          ? { amount: Number(q.income), currency: (q.currency ?? p.income_currency).toUpperCase() }
          : undefined;
      if (override && (!Number.isFinite(override.amount) || override.amount <= 0 || override.amount > LIMITS.maxAmount))
        return c.json(bad('сумма дохода недопустима').body, 400);
      if (override && !CCY_RE.test(override.currency)) return c.json(bad('валюта недопустима').body, 400);
      const now = new Date();
      const month = monthInTz(p.timezone, now);
      const commits = (await repo.listCommitments()).results;
      const entries = (await repo.listIncomeEntries(month)).results;
      // базовый доход: явный (income_minor>0) или вычисленный из обязательств
      const base = await baselineIncome(repo, p, { get: fxGet(c, fx) }, todayInTz(p.timezone, now));
      const fxr: FxResult = await fxGet(c, fx)([
        p.income_currency,
        p.living_currency,
        base.currency,
        ...(override ? [override.currency] : []),
        ...entries.map((e) => e.currency),
        ...commits.map((x) => x.currency),
      ]);
      const inc = resolveIncome({
        entries,
        typicalMinor: p.income_minor,
        incomeCcy: p.income_currency,
        perUsd: fxr.perUsd,
        ...(override ? { override } : {}),
        ...(base.source === 'computed' ? { baseline: { amount: base.amount, currency: base.currency } } : {}),
      });
      // месячный эквивалент по каденсу: interval → ×30.4375/n, yearly → /12
      const mandatoryUsd = commits.reduce((s, x) => s + usd(monthlyAmount(x), x.currency, fxr.perUsd), 0);
      const w = computeWaterfall({
        income: { amount: inc.amount, currency: inc.currency },
        baseIncomeUsd: usd(base.amount, base.currency, fxr.perUsd),
        mandatoryUsd,
        livingCap: { amount: p.living_cap_minor / 100, currency: p.living_currency },
        bonusPrepayShare: p.bonus_prepay_share,
        bonusDcaShare: p.bonus_dca_share,
        dcaTargets: { USD: 1 },
        fx: { perUsd: fxr.perUsd },
      });
      return okJson(c, {
        month,
        income_minor: Math.round(inc.amount * 100),
        income_currency: inc.currency,
        income_source: inc.source,
        income_entries_count: inc.count,
        mandatory_usd_minor: toMinor(round2(mandatoryUsd)),
        living_usd_minor: toMinor(round2(w.livingUsd)),
        surplus_usd_minor: toMinor(round2(w.surplusUsd)),
        bonus:
          p.bonus_prepay_share + p.bonus_dca_share > 0 && w.bonusDeltaUsd > 0
            ? { delta_usd_minor: toMinor(round2(w.bonusDeltaUsd)), prepay_usd_minor: toMinor(round2(w.toPrepayUsd)), dca_usd_minor: toMinor(round2(w.toDcaUsd)) }
            : null,
        commitments: commits.map((x) => ({
          name: x.name,
          amount_minor: x.amount_minor,
          currency: x.currency,
          due_day: x.due_day,
          cadence: cadenceLabel(x),
        })),
        fx_as_of: fxr.asOf,
      });
    } catch (e) {
      const f = fail(e);
      if (!f) throw e;
      return c.json(f.body, f.status as 400);
    }
  });

  // ── GET /week ──
  app.get('/api/tma/week', tmaAuth, async (c) => {
    try {
      const repo = repoOf(c);
      const p = await needProfile(c);
      const now = new Date();
      const today = todayInTz(p.timezone, now);
      // P2-1: weeklyStatus нужны только текущие неделя и месяц — нижняя граница
      // min(понедельник недели, начало месяца) в таймзоне пользователя.
      const wStart = weekStartInTz(p.timezone, now);
      const mStart = `${monthInTz(p.timezone, now)}-01`;
      const expenses = (await repo.listExpenses(wStart < mStart ? wStart : mStart)).results;
      const fxr = await fxGet(c, fx)([p.living_currency, ...expenses.map((e) => e.currency)]);
      const inLiving = expenses.map((e) => ({
        date: e.spent_on,
        amount: convert(e.amount_minor / 100, e.currency, p.living_currency, { perUsd: fxr.perUsd }),
      }));
      const s = weeklyStatus({
        expenses: inLiving,
        today,
        monthlyCap: p.living_cap_minor / 100,
        weeklyBudget: p.weekly_budget_minor / 100,
      });
      return okJson(c, {
        currency: p.living_currency,
        week_spent_minor: toMinor(round2(s.weekSpent)),
        week_budget_minor: toMinor(round2(s.weekBudget)),
        week_over: s.weekOver,
        week_remaining_minor: toMinor(round2(s.weekRemaining)),
        month_spent_minor: toMinor(round2(s.monthSpent)),
        month_cap_minor: toMinor(round2(s.monthCap)),
        burn_rate: s.burnRate,
        daily_allowance_minor: toMinor(round2(s.dailyAllowance)),
        days_left: s.daysLeft,
        fx_as_of: fxr.asOf,
      });
    } catch (e) {
      const f = fail(e);
      if (!f) throw e;
      return c.json(f.body, f.status as 400);
    }
  });

  // ── expenses ──
  app.get('/api/tma/expenses', tmaAuth, async (c) => {
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const start = weekStartInTz(p.timezone, new Date());
    const rows = (await repo.listExpenses(start)).results.slice(-50).reverse();
    return okJson(c, { week_start: start, expenses: rows.map((e) => ({ id: e.id, spent_on: e.spent_on, amount_minor: e.amount_minor, currency: e.currency, note: e.note, category_id: e.category_id })) });
  });
  app.post('/api/tma/expenses', tmaAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = moneySchema.safeParse(body);
    if (!parsed.success) return c.json(bad('нужны amount (>0) и допустимые currency/note').body, 400);
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const b = parsed.data;
    const today = todayInTz(p.timezone, new Date());
    if (b.spent_on !== undefined && !dayInRange(b.spent_on, today))
      return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
    const key = b.client_id ? `tma:${b.client_id}` : `tma:u:${crypto.randomUUID()}`;
    if (b.client_id) {
      const dup = await repo.findExpenseByKey(key);
      if (dup) return okJson(c, { id: dup.id, duplicate: true });
    }
    let categoryId = b.category_id ?? null;
    if (categoryId !== null && !(await repo.getCategory(categoryId)))
      return c.json(bad('категория не найдена').body, 400);
    let note = b.note ?? null;
    if (categoryId === null) {
      // автокатегория по заметке (совпавшее первое слово вырезается)
      await repo.ensureCategories();
      const m = matchCategory(note, (await repo.listCategories()).results);
      categoryId = m.categoryId;
      note = m.note;
    }
    const r = await repo.addExpense({
      spent_on: b.spent_on ?? today,
      amount_minor: toMinor(b.amount),
      currency: b.currency ?? p.expense_currency ?? p.living_currency,
      note,
      source: 'manual',
      source_key: key,
      category_id: categoryId,
    });
    if (r.meta.changes === 0) {
      const dup = b.client_id ? await repo.findExpenseByKey(key) : null;
      return okJson(c, { id: dup?.id ?? 0, duplicate: true });
    }
    return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
  });
  app.patch('/api/tma/expenses/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = expensePatchSchema.safeParse(body);
    if (!parsed.success) return c.json(bad('недопустимые поля').body, 400);
    const repo = repoOf(c);
    if (!(await repo.getExpense(id))) return c.json(notFound().body, 404);
    const p = await repo.getProfile();
    if (parsed.data.spent_on !== undefined && !dayInRange(parsed.data.spent_on, todayInTz(p?.timezone ?? 'UTC', new Date())))
      return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
    const patch: { amount_minor?: number; currency?: string; note?: string | null; category_id?: number | null; spent_on?: string } = {};
    if (parsed.data.amount !== undefined) patch.amount_minor = toMinor(parsed.data.amount);
    if (parsed.data.currency !== undefined) patch.currency = parsed.data.currency;
    if (parsed.data.note !== undefined) patch.note = parsed.data.note;
    if (parsed.data.spent_on !== undefined) patch.spent_on = parsed.data.spent_on;
    if (parsed.data.category_id !== undefined) {
      if (parsed.data.category_id !== null && !(await repo.getCategory(parsed.data.category_id)))
        return c.json(bad('категория не найдена').body, 400);
      patch.category_id = parsed.data.category_id;
    }
    await repo.patchExpense(id, patch);
    return okJson(c, { ok: true });
  });
  app.delete('/api/tma/expenses/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const repo = repoOf(c);
    const w = await repo.deleteExpense(id);
    if (w.meta.changes === 0) return c.json(notFound().body, 404);
    return okJson(c, { ok: true });
  });

  // ── categories ──
  app.get('/api/tma/categories', tmaAuth, async (c) => {
    const repo = repoOf(c);
    await repo.ensureCategories();
    const all = c.req.query('all') === '1';
    const rows = (await repo.listCategories(all)).results;
    return okJson(c, {
      categories: rows.map((x) => ({ id: x.id, name: x.name, emoji: x.emoji, preset_key: x.preset_key, archived: !!x.archived, sort: x.sort })),
    });
  });
  app.post('/api/tma/categories', tmaAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = categorySchema.safeParse(body);
    if (!parsed.success) return c.json(bad('нужны name (1..32) и допустимый emoji').body, 400);
    const repo = repoOf(c);
    const cnt = await repo.countCategories();
    if ((cnt?.n ?? 0) >= 50) return c.json(bad('не больше 50 активных категорий').body, 400);
    const r = await repo.addCategory({
      name: parsed.data.name,
      emoji: parsed.data.emoji ?? '',
      sort: (cnt?.n ?? 0) + 100,
    });
    return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
  });
  app.patch('/api/tma/categories/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = categoryPatchSchema.safeParse(body);
    if (!parsed.success) return c.json(bad('недопустимые поля').body, 400);
    const repo = repoOf(c);
    if (!(await repo.getCategory(id))) return c.json(notFound().body, 404);
    const patch: { name?: string; emoji?: string; archived?: number; sort?: number } = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.emoji !== undefined) patch.emoji = parsed.data.emoji;
    if (parsed.data.archived !== undefined) patch.archived = parsed.data.archived ? 1 : 0;
    if (parsed.data.sort !== undefined) patch.sort = parsed.data.sort;
    await repo.patchCategory(id, patch);
    return okJson(c, { ok: true });
  });
  app.delete('/api/tma/categories/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const repo = repoOf(c);
    if (!(await repo.getCategory(id))) return c.json(notFound().body, 404);
    await repo.deleteCategory(id);
    return okJson(c, { ok: true });
  });

  // ── report ──
  app.get('/api/tma/report', tmaAuth, async (c) => {
    const q = c.req.query();
    const period = (q.period ?? 'month') as Period;
    if (!['week', 'month', 'quarter', 'half', 'year'].includes(period))
      return c.json(bad('period: week|month|quarter|half|year').body, 400);
    const offset = q.offset === undefined || q.offset === '' ? 0 : Number(q.offset);
    if (!Number.isInteger(offset) || offset > 0 || offset < -60)
      return c.json(bad('offset: целое −60..0').body, 400);
    const ccy = q.ccy === undefined || q.ccy === '' ? undefined : q.ccy.toUpperCase();
    if (ccy !== undefined && !CCY_RE.test(ccy))
      return c.json(bad('ccy: код валюты (USD, EUR…)').body, 400);
    try {
      const repo = repoOf(c);
      const rep = await buildUserReport(repo, fxGet(c, fx), period, offset, new Date(), ccy);
      if (!rep) return c.json(notOnboarded().body, 403);
      return okJson(c, rep);
    } catch (e) {
      const f = fail(e);
      if (f) return c.json(f.body, f.status as 400);
      throw e;
    }
  });

  // ── upcoming: сроки текущего локального месяца ──
  // commitment-строка — ближайший НЕОПЛАЧЕННЫЙ срок месяца, иначе последний
  // оплаченный. «Оплачен» — по периоду срока: paid_on ∈ (prevDue, occurrence].
  app.get('/api/tma/upcoming', tmaAuth, async (c) => {
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const today = todayInTz(p.timezone, new Date());
    const month = today.slice(0, 7);
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const iso = (dd: { y: number; m: number; d: number }) =>
      `${dd.y}-${String(dd.m).padStart(2, '0')}-${String(dd.d).padStart(2, '0')}`;
    const monthEnd = iso(dueDateFor(31, y, m));
    const [commits, cpays, dvs] = await Promise.all([
      repo.listCommitments(),
      // окно ~год: период срока любого каденса (у yearly — до 12 мес.) покрыт
      repo.listCommitmentPaymentsSince(`${y - 1}${month.slice(4)}-01`),
      debtViews(repo, today),
    ]);
    const paidOns = new Map<number, string[]>();
    for (const x of cpays.results) {
      const a = paidOns.get(x.commitment_id) ?? [];
      a.push(x.paid_on);
      paidOns.set(x.commitment_id, a);
    }
    const items: {
      kind: 'commitment' | 'debt';
      id: number;
      name: string;
      amount_minor: number;
      currency: string;
      due_on: string;
      paid: boolean;
      overdue: boolean;
      cadence?: string;
    }[] = [];
    for (const cm of commits.results) {
      const occs = occurrencesInRange(cm, `${month}-01`, monthEnd);
      if (!occs.length) continue; // в этом месяце сроков нет (без даты / yearly не этот месяц)
      const mine = paidOns.get(cm.id) ?? [];
      const unpaid = occs.filter((o) => !isOccurrencePaid(cm, o, mine));
      const due = unpaid[0] ?? occs[occs.length - 1]!;
      items.push({
        kind: 'commitment',
        id: cm.id,
        name: cm.name,
        amount_minor: cm.amount_minor,
        currency: cm.currency,
        due_on: due,
        paid: !unpaid.length,
        overdue: !!unpaid.length && due < today,
        cadence: cadenceLabel(cm),
      });
    }
    for (const v of dvs) {
      const d = v.debt;
      if (!d.due_day || d.frequency !== 'monthly') continue; // biweekly — вне месячного списка
      const due = iso(dueDateFor(d.due_day, y, m));
      const paid = v.events.some((e) => e.kind === 'payment' && e.event_on.startsWith(month));
      items.push({
        kind: 'debt',
        id: d.id,
        name: d.name,
        amount_minor: toMinor(round2(v.payment)),
        currency: d.currency,
        due_on: due,
        paid,
        overdue: !paid && due < today,
      });
    }
    items.sort((a, b) => (a.paid === b.paid ? a.due_on.localeCompare(b.due_on) : a.paid ? 1 : -1));
    return okJson(c, { month, currency_hint: p.living_currency, items });
  });

  // ── income ──
  app.get('/api/tma/income', tmaAuth, async (c) => {
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const month = monthInTz(p.timezone, new Date());
    const entries = (await repo.listIncomeEntries(month)).results;
    const fxr = await fxGet(c, fx)([p.income_currency, ...entries.map((e) => e.currency)]);
    const total = entries.reduce((s, e) => s + convert(e.amount_minor / 100, e.currency, p.income_currency, { perUsd: fxr.perUsd }), 0);
    return okJson(c, {
      month,
      total_minor: toMinor(round2(total)),
      currency: p.income_currency,
      entries: entries.map((e) => ({ id: e.id, amount_minor: e.amount_minor, currency: e.currency, note: e.note, received_on: e.received_on })),
    });
  });
  app.post('/api/tma/income', tmaAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = moneySchema.safeParse(body);
    if (!parsed.success) return c.json(bad('нужны amount (>0) и допустимые currency/note').body, 400);
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const b = parsed.data;
    const today = todayInTz(p.timezone, new Date());
    if (b.received_on !== undefined && !dayInRange(b.received_on, today))
      return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
    const receivedOn = b.received_on ?? today;
    const key = b.client_id ? `tma:${b.client_id}` : `tma:u:${crypto.randomUUID()}`;
    if (b.client_id) {
      const dup = await repo.findIncomeByKey(key);
      if (dup) return okJson(c, { id: dup.id, duplicate: true });
    }
    const r = await repo.addIncomeEntry({
      // месяц — из фактической даты получения (received_on ≤ today)
      month: receivedOn.slice(0, 7),
      amount_minor: toMinor(b.amount),
      currency: b.currency ?? p.income_currency,
      note: b.note ?? null,
      source_key: key,
      received_on: receivedOn,
    });
    if (r.meta.changes === 0) {
      const dup = b.client_id ? await repo.findIncomeByKey(key) : null;
      return okJson(c, { id: dup?.id ?? 0, duplicate: true });
    }
    return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
  });
  app.patch('/api/tma/income/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = incomePatchSchema.safeParse(body);
    if (!parsed.success || !Object.keys(parsed.data).length) return c.json(bad('недопустимые поля').body, 400);
    const repo = repoOf(c);
    if (!(await repo.getIncomeEntry(id))) return c.json(notFound().body, 404);
    const p = await repo.getProfile();
    if (parsed.data.received_on !== undefined && !dayInRange(parsed.data.received_on, todayInTz(p?.timezone ?? 'UTC', new Date())))
      return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
    const patch: { received_on?: string; month?: string; note?: string | null } = {};
    if (parsed.data.received_on !== undefined) {
      patch.received_on = parsed.data.received_on;
      patch.month = parsed.data.received_on.slice(0, 7); // месяц следует за датой
    }
    if (parsed.data.note !== undefined) patch.note = parsed.data.note;
    await repo.patchIncomeEntry(id, patch);
    return okJson(c, { ok: true });
  });
  app.delete('/api/tma/income/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const repo = repoOf(c);
    const w = await repo.deleteIncomeEntry(id);
    if (w.meta.changes === 0) return c.json(notFound().body, 404);
    return okJson(c, { ok: true });
  });

  // ── profile ──
  app.get('/api/tma/profile', tmaAuth, async (c) => {
    const p = await repoOf(c).getProfile();
    if (!p) return c.json({ onboarded: false }, 200);
    // базовый доход: хранимое значение + источник (explicit/computed/none);
    // при income_minor=0 — вычисленное значение для отображения
    let baselineMinor = p.income_minor;
    let baselineSource: 'explicit' | 'computed' | 'none' = p.income_minor > 0 ? 'explicit' : 'none';
    try {
      const base = await baselineIncome(repoOf(c), p, { get: fxGet(c, fx) }, todayInTz(p.timezone, new Date()));
      baselineSource = base.source;
      if (base.source === 'computed') baselineMinor = toMinor(base.amount);
    } catch (e) {
      const f = fail(e);
      if (!f) throw e;
      return c.json(f.body, f.status as 400);
    }
    return okJson(c, {
      onboarded: !!p.onboarded_at,
      typical_income_minor: p.income_minor,
      baseline_income_minor: baselineMinor,
      baseline_source: baselineSource,
      income_currency: p.income_currency,
      living_cap_minor: p.living_cap_minor,
      living_currency: p.living_currency,
      expense_currency: p.expense_currency,
      weekly_budget_minor: p.weekly_budget_minor,
      base_currency: p.base_currency,
      timezone: p.timezone,
      reminders_weekly: p.reminders_weekly,
      reminders_payments: p.reminders_payments,
      fx_alerts_enabled: p.fx_alerts_enabled,
      vision_enabled: p.vision_enabled,
    });
  });
  app.patch('/api/tma/profile', tmaAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = profilePatchSchema.safeParse(body);
    if (!parsed.success) return c.json(bad('недопустимые поля профиля').body, 400);
    const repo = repoOf(c);
    const p0 = await profile(repo);
    if (!p0) return c.json(notOnboarded().body, 403);
    const b = parsed.data;
    if (b.timezone !== undefined && !isValidTimezone(b.timezone)) return c.json(bad('таймзона недопустима').body, 400);
    const patch: Parameters<ScopedRepo['patchProfile']>[0] = {};
    if (b.typical_income !== undefined) patch.income_minor = toMinor(b.typical_income);
    if (b.income_currency !== undefined) patch.income_currency = b.income_currency;
    if (b.living_currency !== undefined) patch.living_currency = b.living_currency;
    if (b.expense_currency !== undefined) patch.expense_currency = b.expense_currency;
    if (b.living_cap !== undefined) {
      const minor = toMinor(b.living_cap);
      patch.living_cap_minor = minor;
      patch.weekly_budget_minor = Math.round((minor * 12) / 52);
    }
    if (b.timezone !== undefined) patch.timezone = b.timezone;
    if (b.reminders_weekly !== undefined) patch.reminders_weekly = b.reminders_weekly ? 1 : 0;
    if (b.reminders_payments !== undefined) patch.reminders_payments = b.reminders_payments ? 1 : 0;
    if (b.fx_alerts_enabled !== undefined) patch.fx_alerts_enabled = b.fx_alerts_enabled ? 1 : 0;
    if (b.vision_enabled !== undefined) patch.vision_enabled = b.vision_enabled ? 1 : 0;
    if (!Object.keys(patch).length) return c.json(bad('нет полей для изменения').body, 400);
    await repo.patchProfile(patch);
    const np = await repo.getProfile();
    return okJson(c, { ok: true, weekly_budget_minor: np!.weekly_budget_minor });
  });

  // ── export: все данные пользователя JSON-файлом (паритет бота /export) ──
  app.get('/api/tma/export', tmaAuth, async (c) => {
    const data = await repoOf(c).exportUserData();
    const today = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="budget-export-${today}.json"`,
      },
    });
  });

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
      return okJson(c, { id: dup?.id ?? 0, duplicate: true });
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
