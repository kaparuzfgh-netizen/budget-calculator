/**
 * tma/profile.ts — доход, профиль и экспорт данных Mini App
 * (паритет бота /income, /profile, /export). Bearer-JWT, только scoped(user.id).
 */
import { z } from 'zod';
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { ScopedRepo, UserRow } from '../db/repo';
import type { FxProvider } from '../fx/provider';
import { convert, round2, toMinor } from '../domain/money';
import { isValidTimezone, monthInTz, todayInTz } from '../bot/parse';
import { baselineIncome } from '../services/baseline';
import {
  bad,
  dayInRange,
  dupResult,
  fail,
  fxGet,
  idOf,
  LIMITS,
  notFound,
  notOnboarded,
  okJson,
  profile,
  repoOf,
  moneySchema,
  zAmount,
  zCcy,
  zIso,
  type TmaContext as C,
} from './common';

const incomePatchSchema = z.object({
  received_on: zIso.optional(),
  note: z.string().trim().max(LIMITS.maxNote).nullable().optional(),
});
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
  /** Свой час начала окна напоминаний 0–23; null — легаси (платежи 10:00, итог вс 20:00). */
  reminder_hour: z.number().int().min(0).max(23).nullable().optional(),
  /** «Подушка безопасности» в валюте бюджета (major); 0 — сброс. */
  cushion: z.number().finite().min(0).max(LIMITS.maxAmount).optional(),
  /** Каскад бонуса: доли дельты дохода → досрочка / DCA (0..1, сумма ≤ 1). */
  bonus_prepay_share: z.number().finite().min(0).max(1).optional(),
  bonus_dca_share: z.number().finite().min(0).max(1).optional(),
});

export function registerTmaProfile(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
  fx: FxProvider,
): void {
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
      return dupResult(c, dup);
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
      reminder_hour: p.reminder_hour,
      fx_alerts_enabled: p.fx_alerts_enabled,
      vision_enabled: p.vision_enabled,
      cushion_minor: p.cushion_minor,
      bonus_prepay_share: p.bonus_prepay_share,
      bonus_dca_share: p.bonus_dca_share,
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
    if (b.reminder_hour !== undefined) patch.reminder_hour = b.reminder_hour;
    if (b.fx_alerts_enabled !== undefined) patch.fx_alerts_enabled = b.fx_alerts_enabled ? 1 : 0;
    if (b.vision_enabled !== undefined) patch.vision_enabled = b.vision_enabled ? 1 : 0;
    if (b.cushion !== undefined) patch.cushion_minor = toMinor(b.cushion);
    if (b.bonus_prepay_share !== undefined) patch.bonus_prepay_share = b.bonus_prepay_share;
    if (b.bonus_dca_share !== undefined) patch.bonus_dca_share = b.bonus_dca_share;
    // сумма долей каскада ≤ 1 — по слитым с текущими значениям
    const preSum = (patch.bonus_prepay_share ?? p0.bonus_prepay_share) + (patch.bonus_dca_share ?? p0.bonus_dca_share);
    if (preSum > 1 + 1e-9) return c.json(bad('сумма долей каскада больше 100%').body, 400);
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

}
