/**
 * report.ts — периодные отчёты (неделя/месяц/квартал/полгода/год).
 * Чистые функции: календарные диапазоны + агрегация всех денежных потоков
 * в целевую валюту через convert (текущие курсы — fx_as_of).
 */
import { convert, toMinor } from './money';
import type { Currency } from './money';

export type Period = 'week' | 'month' | 'quarter' | 'half' | 'year';

export interface Bucket {
  key: string;
  label: string;
  from: string;
  to: string;
}
export interface Range {
  from: string;
  to: string; // inclusive
  label: string;
  buckets: Bucket[];
}

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const ROMAN = ['I', 'II', 'III', 'IV'];

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (t: Date) => t.toISOString().slice(0, 10);
const addDays = (t: Date, n: number) => new Date(t.getTime() + n * 86400e3);
const pad = (n: number) => String(n).padStart(2, '0');
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)); // m 0-based

const mondayOf = (t: Date) => {
  const dow = (t.getUTCDay() + 6) % 7; // пн=0
  return addDays(t, -dow);
};

const dayBucket = (t: Date): Bucket => ({ key: iso(t), label: String(t.getUTCDate()), from: iso(t), to: iso(t) });
const monthBucket = (y: number, m: number): Bucket => ({
  key: `${y}-${pad(m + 1)}`,
  label: MONTHS_SHORT[m]!,
  from: `${y}-${pad(m + 1)}-01`,
  to: iso(monthEnd(y, m)),
});

/** Календарный диапазон: offset ≤ 0 сдвигает на целые периоды назад (кросс-год ок). */
export function periodRange(period: Period, todayIso: string, offset = 0): Range {
  const t = d(todayIso);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  if (period === 'week') {
    const start = mondayOf(addDays(t, offset * 7));
    const end = addDays(start, 6);
    const buckets = Array.from({ length: 7 }, (_, i) => dayBucket(addDays(start, i)));
    return {
      from: iso(start),
      to: iso(end),
      label: `${start.getUTCDate()} ${MONTHS_SHORT[start.getUTCMonth()]} – ${end.getUTCDate()} ${MONTHS_SHORT[end.getUTCMonth()]} ${end.getUTCFullYear()}`,
      buckets,
    };
  }
  if (period === 'month') {
    const mm = m + offset;
    const yy = y + Math.floor(mm / 12);
    const mn = ((mm % 12) + 12) % 12;
    const end = monthEnd(yy, mn);
    const buckets = Array.from({ length: end.getUTCDate() }, (_, i) =>
      dayBucket(new Date(Date.UTC(yy, mn, i + 1))),
    );
    return { from: `${yy}-${pad(mn + 1)}-01`, to: iso(end), label: `${MONTHS[mn]} ${yy}`, buckets };
  }
  if (period === 'quarter') {
    const q = Math.floor(m / 3) + offset;
    const yy = y + Math.floor(q / 4);
    const qq = ((q % 4) + 4) % 4;
    const m0 = qq * 3;
    const buckets = [0, 1, 2].map((i) => monthBucket(yy, m0 + i));
    return {
      from: buckets[0]!.from,
      to: buckets[2]!.to,
      label: `${ROMAN[qq]} кв. ${yy}`,
      buckets,
    };
  }
  if (period === 'half') {
    const h = Math.floor(m / 6) + offset;
    const yy = y + Math.floor(h / 2);
    const hh = ((h % 2) + 2) % 2;
    const m0 = hh * 6;
    const buckets = Array.from({ length: 6 }, (_, i) => monthBucket(yy, m0 + i));
    return {
      from: buckets[0]!.from,
      to: buckets[5]!.to,
      label: `${hh + 1}-е полугодие ${yy}`,
      buckets,
    };
  }
  // year
  const yy = y + offset;
  const buckets = Array.from({ length: 12 }, (_, i) => monthBucket(yy, i));
  return { from: buckets[0]!.from, to: buckets[11]!.to, label: String(yy), buckets };
}

export interface ReportInput {
  period: Period;
  offset: number;
  range: Range;
  prevRange: Range;
  currency: Currency; // целевая валюта отчёта
  perUsd: Record<string, number>;
  fx_as_of: string;
  livingCapMajor: number; // месячный бюджет повседневных, major (уже в currency)
  weeklyBudgetMajor: number; // недельный бюджет, major
  categories: { id: number; name: string; emoji: string }[];
  expenses: { id: number; spent_on: string; amount_minor: number; currency: string; note: string | null; category_id: number | null }[];
  commitPays: { paid_on: string; amount_minor: number; currency: string }[];
  debtEvents: { event_on: string; amount_minor: number; currency: string; kind: string }[];
  loanEvents: { event_on: string; amount_minor: number; currency: string; direction: 'owe' | 'owed' }[];
  income: { received_on: string; amount_minor: number; currency: string }[];
}

const inRange = (dt: string, r: { from: string; to: string }) => dt >= r.from && dt <= r.to;

export function buildReport(inp: ReportInput) {
  const { range: R, prevRange: P, currency, perUsd } = inp;
  const fx = { perUsd };
  const liv = (minor: number, ccy: string) => toMinor(convert(minor / 100, ccy as Currency, currency, fx));

  const agg = (r: { from: string; to: string }) => {
    const living = inp.expenses.filter((e) => inRange(e.spent_on, r)).reduce((s, e) => s + liv(e.amount_minor, e.currency), 0);
    const commitments = inp.commitPays.filter((e) => inRange(e.paid_on, r)).reduce((s, e) => s + liv(e.amount_minor, e.currency), 0);
    const credits = inp.debtEvents.filter((e) => inRange(e.event_on, r)).reduce((s, e) => s + liv(e.amount_minor, e.currency), 0);
    const owed = inp.loanEvents.filter((e) => e.direction === 'owed' && inRange(e.event_on, r)).reduce((s, e) => s + liv(e.amount_minor, e.currency), 0);
    const owe = inp.loanEvents.filter((e) => e.direction === 'owe' && inRange(e.event_on, r)).reduce((s, e) => s + liv(e.amount_minor, e.currency), 0);
    const income = inp.income.filter((e) => inRange(e.received_on, r)).reduce((s, e) => s + liv(e.amount_minor, e.currency), 0);
    return { living, commitments, credits, owed, owe, income };
  };

  const cur = agg(R);
  const prev = agg(P);
  const spentTotal = cur.living + cur.commitments + cur.credits + cur.owe;
  const receivedTotal = cur.income + cur.owed;

  const limitMajor =
    inp.period === 'week'
      ? inp.weeklyBudgetMajor
      : inp.livingCapMajor * { month: 1, quarter: 3, half: 6, year: 12 }[inp.period as 'month'];
  const capMinor = toMinor(limitMajor);

  // категории: только повседневные траты
  const catMap = new Map<number | null, { amount: number; count: number }>();
  for (const e of inp.expenses.filter((x) => inRange(x.spent_on, R))) {
    const k = e.category_id;
    const v = catMap.get(k) ?? { amount: 0, count: 0 };
    v.amount += liv(e.amount_minor, e.currency);
    v.count += 1;
    catMap.set(k, v);
  }
  const catMeta = new Map(inp.categories.map((c) => [c.id, c]));
  const categories = [...catMap.entries()]
    .map(([id, v]) => {
      const meta = id === null ? { name: 'Без категории', emoji: '❔' } : catMeta.get(id) ?? { name: '—', emoji: '❔' };
      return { id, name: meta.name, emoji: meta.emoji, amount: v.amount, share: cur.living > 0 ? v.amount / cur.living : 0, count: v.count };
    })
    .sort((a, b) => b.amount - a.amount);

  const buckets = R.buckets.map((b) => {
    const a = agg(b);
    return {
      key: b.key,
      label: b.label,
      living: a.living,
      other: a.commitments + a.credits + a.owe,
      received: a.income + a.owed,
    };
  });

  const top_expenses = inp.expenses
    .filter((e) => inRange(e.spent_on, R))
    .map((e) => ({ id: e.id, spent_on: e.spent_on, amount: liv(e.amount_minor, e.currency), note: e.note, category_id: e.category_id }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  return {
    period: inp.period,
    offset: inp.offset,
    from: R.from,
    to: R.to,
    label: R.label,
    currency,
    fx_as_of: inp.fx_as_of,
    received: { income: cur.income, loans_returned: cur.owed, total: receivedTotal },
    spent: { living: cur.living, commitments: cur.commitments, credits: cur.credits, loans_repaid: cur.owe, total: spentTotal },
    net: receivedTotal - spentTotal,
    living_limit: { cap: capMinor, used_pct: capMinor > 0 ? cur.living / capMinor : 0 },
    categories,
    buckets,
    prev: {
      label: P.label,
      spent_total: prev.living + prev.commitments + prev.credits + prev.owe,
      received_total: prev.income + prev.owed,
      living: prev.living,
    },
    top_expenses,
  };
}

export type Report = ReturnType<typeof buildReport>;
