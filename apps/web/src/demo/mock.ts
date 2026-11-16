/**
 * mock.ts — фикстуры в формате контрактов /api/tma/* (типы из ../api).
 * Демо (?demo=<экран>) рендерит НАСТОЯЩИЕ экраны поверх stub-Api
 * (demo/tw.tsx) — без Telegram и auth. Значения подобраны связными:
 * неделя/месяц в KGS, доход в EUR, платежи/кредит — в своих валютах.
 */
import type {
  CategoriesList,
  CommitmentsList,
  ExpensesList,
  IncomeList,
  Overview,
  PlanData,
  Profile,
  Upcoming,
  WeekStatus,
} from '../api';

export const OVERVIEW: Overview = {
  month: '2026-03',
  base_currency: 'USD',
  income_month_minor: 216402,
  income_month_currency: 'EUR',
  income_month_source: 'actual',
  income_entries_count: 2,
  commitments: [
    { name: 'Аренда', amount_minor: 50000, currency: 'USD', due_day: 1 },
    { name: 'Интернет', amount_minor: 60000, currency: 'KGS', due_day: 5 },
    { name: 'Нетфликс', amount_minor: 999, currency: 'USD', due_day: 15 },
  ],
  weekly_budget_minor: 1384615,
  living_currency: 'KGS',
  spent_week_minor: 214000,
  week_remaining_minor: 1170615,
  spent_month_minor: 2350000,
  month_cap_minor: 6000000,
  fx_as_of: '2026-03-18',
};

export const WEEK: WeekStatus = {
  currency: 'KGS',
  week_from: '2026-03-16',
  week_to: '2026-03-22',
  week_day: 3, // 18 марта 2026 — среда
  week_spent_minor: 214000,
  week_budget_minor: 1384615,
  week_over: false,
  week_remaining_minor: 1170615,
  month_spent_minor: 2350000,
  month_cap_minor: 6000000,
  month_day: 18,
  month_days: 31,
  month_daily_minor: [
    180000, 95000, 210000, 140000, 60000, 320000, 150000, 110000, 190000,
    85000, 200000, 130000, 70000, 240000, 0, 90000, 80000, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
  month_top: [
    { name: 'Продукты', emoji: '🛒', spent_minor: 980000, share: 0.42 },
    { name: 'Кафе', emoji: '☕', spent_minor: 610000, share: 0.26 },
    { name: 'Транспорт', emoji: '🚌', spent_minor: 410000, share: 0.17 },
  ],
  burn_rate: 0.67,
  daily_allowance_minor: 195000,
  days_left: 13,
  fx_as_of: '2026-03-18',
};

export const UPCOMING: Upcoming = {
  month: '2026-03',
  currency_hint: 'KGS',
  items: [
    {
      kind: 'commitment',
      id: 1,
      name: 'Аренда',
      amount_minor: 50000,
      currency: 'USD',
      due_on: '2026-03-01',
      paid: false,
      overdue: true,
    },
    {
      kind: 'commitment',
      id: 2,
      name: 'Интернет',
      amount_minor: 60000,
      currency: 'KGS',
      due_on: '2026-03-05',
      paid: true,
      overdue: false,
    },
    {
      kind: 'commitment',
      id: 3,
      name: 'Нетфликс',
      amount_minor: 999,
      currency: 'USD',
      due_on: '2026-03-15',
      paid: false,
      overdue: false,
    },
    {
      kind: 'debt',
      id: 1,
      name: 'Автокредит',
      amount_minor: 1200000,
      currency: 'KGS',
      due_on: '2026-03-20',
      paid: false,
      overdue: false,
    },
  ],
};

/** Связные числа: доход 2164 EUR ≈ 2360 USD; обязательные ≈ 517, бюджет 60 000 с ≈ 690. */
export const PLAN: PlanData = {
  month: '2026-03',
  today: '2026-03-18',
  income_minor: 216402,
  income_currency: 'EUR',
  income_source: 'actual',
  income_entries_count: 2,
  mandatory_usd_minor: 51700,
  living_usd_minor: 69000,
  surplus_usd_minor: 115300,
  bonus: null,
  // 180 000 с ≈ 2 070 USD → ~1.7 мес от (517+690) USD потребности
  cushion: { minor: 18000000, currency: 'KGS', months: 1.7, goal_months: 3 },
  commitments: OVERVIEW.commitments,
  fx_as_of: '2026-03-18',
};

export const EXPENSES: ExpensesList = {
  week_start: '2026-03-16',
  expenses: [
    { id: 1, spent_on: '2026-03-16', amount_minor: 32000, currency: 'KGS', note: 'Продукты', category_id: 1 },
    { id: 2, spent_on: '2026-03-17', amount_minor: 45000, currency: 'KGS', note: 'Кафе с коллегами', category_id: 2 },
    { id: 3, spent_on: '2026-03-17', amount_minor: 15000, currency: 'KGS', note: null, category_id: null },
    { id: 4, spent_on: '2026-03-18', amount_minor: 122000, currency: 'KGS', note: 'Аптека', category_id: 4 },
  ],
};

export const INCOME: IncomeList = {
  month: '2026-03',
  total_minor: 216402,
  currency: 'EUR',
  entries: [
    { id: 1, amount_minor: 150000, currency: 'EUR', note: 'Аванс', received_on: '2026-03-10' },
    { id: 2, amount_minor: 66402, currency: 'EUR', note: null, received_on: '2026-03-01' },
  ],
};

export const PROFILE: Profile = {
  onboarded: true,
  typical_income_minor: 0,
  baseline_income_minor: 216402,
  baseline_source: 'computed',
  income_currency: 'EUR',
  living_cap_minor: 6000000,
  living_currency: 'KGS',
  expense_currency: 'KGS',
  weekly_budget_minor: 1384615,
  base_currency: 'USD',
  timezone: 'Asia/Bishkek',
  reminders_weekly: 1,
  reminders_payments: 1,
  reminders_digest: 1,
  fx_alerts_enabled: 1,
  vision_enabled: 0,
  cushion_minor: 18000000,
};

export const COMMITMENTS: CommitmentsList = {
  commitments: [
    { id: 1, name: 'Аренда', amount_minor: 50000, currency: 'USD', due_day: 1, frequency: 'monthly', interval_days: null, anchor_on: null, due_month: null, every_months: 1, cadence: '1 числа', next_due_on: '2026-04-01', active: 1, paid_this_month: false, last_paid_on: null },
    { id: 2, name: 'Интернет', amount_minor: 60000, currency: 'KGS', due_day: 5, frequency: 'monthly', interval_days: null, anchor_on: '2026-01-05', due_month: null, every_months: 3, cadence: 'каждые 3 мес (5-го)', next_due_on: '2026-04-05', active: 1, paid_this_month: true, last_paid_on: '2026-01-05' },
    { id: 3, name: 'Нетфликс', amount_minor: 999, currency: 'USD', due_day: 15, frequency: 'monthly', interval_days: null, anchor_on: null, due_month: null, every_months: 1, cadence: '15 числа', next_due_on: '2026-04-15', active: 1, paid_this_month: false, last_paid_on: null },
    { id: 4, name: 'Страховка', amount_minor: 120000, currency: 'USD', due_day: 20, frequency: 'yearly', interval_days: null, anchor_on: null, due_month: 9, every_months: 1, cadence: '20 сентября', next_due_on: '2026-09-20', active: 1, paid_this_month: false, last_paid_on: '2025-09-20' },
    { id: 5, name: 'Спортзал', amount_minor: 250000, currency: 'KGS', due_day: null, frequency: 'monthly', interval_days: null, anchor_on: null, due_month: null, every_months: 1, cadence: 'без даты', next_due_on: null, active: 0, paid_this_month: false, last_paid_on: null },
  ],
};

export const CATEGORIES: CategoriesList = {
  categories: [
    { id: 1, name: 'Продукты', emoji: '🛒', preset_key: 'food', archived: false, sort: 1 },
    { id: 2, name: 'Кафе', emoji: '☕', preset_key: 'cafe', archived: false, sort: 2 },
    { id: 3, name: 'Транспорт', emoji: '🚌', preset_key: 'transport', archived: false, sort: 3 },
    { id: 4, name: 'Здоровье', emoji: '💊', preset_key: 'health', archived: false, sort: 4 },
    { id: 5, name: 'Кот', emoji: '🐈', preset_key: null, archived: true, sort: 9 },
  ],
};

// ── сценарии темпа месяца для ?demo=home&pace=low|ok|over ──

const DAILY_W = [
  1.1, 0.5, 1.4, 0.8, 0.3, 2.0, 1.0, 0.7, 1.2, 0.4, 1.3, 0.9, 0.5, 1.6, 0.2, 0.9,
  0.7, 0.6, 1.5, 0.4, 1.1, 0.8, 0.3, 1.7, 0.9, 0.5, 1.3, 0.6, 1.0, 0.4, 1.2,
];

/** Дневные траты: первые `days` дней по весам, сумма = targetMinor. */
function dailyMinor(targetMinor: number, days: number, dim: number): number[] {
  const w = DAILY_W.slice(0, days);
  const sum = w.reduce((a, b) => a + b, 0);
  const out = new Array<number>(dim).fill(0);
  w.forEach((x, i) => {
    out[i] = Math.round((targetMinor * x) / sum);
  });
  return out;
}

/**
 * WeekStatus под темп месяца на произвольный день `day` (1..31):
 * pace — burn rate (low ~0.34, ok ~0.86, over ~1.38), потрачено =
 * cap × (day/dim) × rate. Неделя = Пн–Вс, содержащая «сегодня» (март 2026).
 */
export function tempoWeek(pace: 'low' | 'ok' | 'over', day = 18): WeekStatus {
  const rate = { low: 0.34, ok: 0.86, over: 1.38 }[pace];
  const wSpent = { low: 180000, ok: 640000, over: 1820000 }[pace];
  const { week_budget_minor: budget, month_cap_minor: cap } = WEEK;
  const dim = WEEK.month_days;
  const today = Math.max(1, Math.min(day, dim));
  const spent = Math.round(cap * (today / dim) * rate);
  const dow = (new Date(2026, 2, today).getDay() + 6) % 7;
  const iso = (d: number) => new Date(2026, 2, d).toISOString().slice(0, 10);
  return {
    ...WEEK,
    week_from: iso(today - dow),
    week_to: iso(today - dow + 6),
    week_day: dow + 1,
    week_spent_minor: wSpent,
    week_over: wSpent > budget,
    week_remaining_minor: budget - wSpent,
    month_spent_minor: spent,
    month_day: today,
    month_daily_minor: dailyMinor(spent, today, dim),
    // доли топ-категорий из базовой фикстуры, суммы — под сценарный итог
    month_top: WEEK.month_top.map((x) => ({ ...x, spent_minor: Math.round(spent * x.share) })),
    burn_rate: rate,
    daily_allowance_minor: Math.max(0, Math.round((cap - spent) / Math.max(1, dim - today))),
  };
}
