/**
 * tma/api.ts — REST API Mini App (шаг 5, паритет бота).
 * Все роуты за Bearer-JWT middleware; доступ только через scoped(user.id);
 * суммы в minor units на границах; ошибки {error:{code,message}}.
 * Парсинг/математика НЕ дублируются — переиспользуются bot/parse, domain/*,
 * resolveIncome (features), weeklyStatus, computeWaterfall.
 */
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { UserRow } from '../db/repo';
import type { FxResult } from '../fx/service';
import type { FxProvider } from '../fx/provider';
import { computeWaterfall } from '../domain/cashflow';
import { weeklyStatus } from '../domain/budget';
import { dayOfMonth, daysInMonth } from '../domain/dates';
import { convert, round2, toMinor } from '../domain/money';

const usd = (amount: number, ccy: string, pu: Record<string, number>) => convert(amount, ccy, 'USD', { perUsd: pu });
import { resolveIncome } from '../bot/features';
import { monthInTz, todayInTz, weekStartInTz } from '../bot/parse';
import { buildUserReport } from '../services/report';
import { baselineIncome } from '../services/baseline';
import type { Period } from '../domain/report';
import { debtViews } from '../services/debts';
import { dueDateFor } from '../services/reminders';
import { cadenceLabel, isOccurrencePaid, monthlyAmount, occurrencesInRange } from '../domain/schedule';
import {
  bad,
  CCY_RE,
  fail,
  fxGet,
  LIMITS,
  needProfile,
  notOnboarded,
  okJson,
  profile,
  repoOf,
  type TmaContext as C,
} from './common';

export { LIMITS };

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
      // «подушка»: остаток в валюте бюджета vs месячная потребность
      // (обязательные + повседневные) — покрытие в месяцах, цель 3
      const needUsd = mandatoryUsd + w.livingUsd;
      const cushionMinor = p.cushion_minor ?? 0;
      const cushionUsd = usd(cushionMinor / 100, p.living_currency, fxr.perUsd);
      // целевая досрочка каскада — активный кредит с макс. ставкой
      const prepayTarget =
        p.bonus_prepay_share + p.bonus_dca_share > 0 && w.bonusDeltaUsd > 0 && w.toPrepayUsd > 0
          ? (await repo.listDebts()).results.reduce<{ name: string; rate: number } | null>(
              (m, d) => (d.rate > 0 && (m === null || d.rate > m.rate) ? d : m),
              null,
            )?.name ?? null
          : null;
      return okJson(c, {
        month,
        today: todayInTz(p.timezone, now),
        income_minor: Math.round(inc.amount * 100),
        income_currency: inc.currency,
        income_source: inc.source,
        income_entries_count: inc.count,
        mandatory_usd_minor: toMinor(round2(mandatoryUsd)),
        living_usd_minor: toMinor(round2(w.livingUsd)),
        surplus_usd_minor: toMinor(round2(w.surplusUsd)),
        cushion: {
          minor: cushionMinor,
          currency: p.living_currency,
          months: needUsd > 0 ? Math.round((cushionUsd / needUsd) * 10) / 10 : 0,
          goal_months: 3,
        },
        bonus:
          p.bonus_prepay_share + p.bonus_dca_share > 0 && w.bonusDeltaUsd > 0
            ? {
                delta_usd_minor: toMinor(round2(w.bonusDeltaUsd)),
                prepay_usd_minor: toMinor(round2(w.toPrepayUsd)),
                dca_usd_minor: toMinor(round2(w.toDcaUsd)),
                prepay_target: prepayTarget,
              }
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
        cat: e.category_id as number | null,
      }));
      const s = weeklyStatus({
        expenses: inLiving,
        today,
        monthlyCap: p.living_cap_minor / 100,
        weeklyBudget: p.weekly_budget_minor / 100,
      });
      const wEnd = new Date(`${wStart}T00:00:00Z`);
      wEnd.setUTCDate(wEnd.getUTCDate() + 6);
      // дневные траты месяца — для графика темпа (накопленные vs идеал);
      // заодно — суммы по категориям для совета «что резать»
      const dim = daysInMonth(today);
      const curMonth = today.slice(0, 7);
      const daily = new Array<number>(dim).fill(0);
      const byCat = new Map<number | null, number>();
      for (const e of inLiving) {
        if (e.date.slice(0, 7) === curMonth) {
          const d = Number(e.date.slice(8, 10));
          if (d >= 1 && d <= dim) daily[d - 1]! += e.amount;
          byCat.set(e.cat, (byCat.get(e.cat) ?? 0) + e.amount);
        }
      }
      // топ-3 категории месяца → имена из реестра категорий юзера
      const cats = new Map((await repo.listCategories(true)).results.map((x) => [x.id, x]));
      const month_top = [...byCat.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, sum]) => ({
          name: (id !== null && cats.get(id)?.name) || 'Без категории',
          emoji: (id !== null && cats.get(id)?.emoji) || '📦',
          spent_minor: toMinor(round2(sum)),
          share: s.monthSpent > 0 ? round2(sum / s.monthSpent) : 0,
        }));
      return okJson(c, {
        currency: p.living_currency,
        week_from: wStart,
        week_to: wEnd.toISOString().slice(0, 10),
        // день недели «сегодня» 1=пн..7=вс — шкала «дни недели» в гонке
        week_day: ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1,
        week_spent_minor: toMinor(round2(s.weekSpent)),
        week_budget_minor: toMinor(round2(s.weekBudget)),
        week_over: s.weekOver,
        week_remaining_minor: toMinor(round2(s.weekRemaining)),
        month_spent_minor: toMinor(round2(s.monthSpent)),
        month_cap_minor: toMinor(round2(s.monthCap)),
        month_day: dayOfMonth(today),
        month_days: daysInMonth(today),
        month_daily_minor: daily.map((v) => toMinor(round2(v))),
        month_top,
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

}
