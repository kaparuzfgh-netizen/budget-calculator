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
  fx_alerts_enabled: 1,
  vision_enabled: 0,
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

const DAILY_W = [1.1, 0.5, 1.4, 0.8, 0.3, 2.0, 1.0, 0.7, 1.2, 0.4, 1.3, 0.9, 0.5, 1.6, 0.2, 0.9, 0.7, 0.6];

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
 * WeekStatus под темп месяца: low — далеко под идеалом (rate ~0.34),
 * ok — по графику (~0.86), over — перегрев (~1.38, прогноз выше бюджета).
 * Бюджет недели/месяца и «сегодня» — как в базовой фикстуре WEEK.
 */
export function tempoWeek(pace: 'low' | 'ok' | 'over'): WeekStatus {
  const spent = { low: 1200000, ok: 3000000, over: 4800000 }[pace];
  const wSpent = { low: 180000, ok: 640000, over: 1820000 }[pace];
  const { week_budget_minor: budget, month_cap_minor: cap, month_day, month_days, days_left } = WEEK;
  return {
    ...WEEK,
    week_spent_minor: wSpent,
    week_over: wSpent > budget,
    week_remaining_minor: budget - wSpent,
    month_spent_minor: spent,
    month_daily_minor: dailyMinor(spent, month_day, month_days),
    burn_rate: spent / cap / (month_day / month_days),
    daily_allowance_minor: Math.max(0, Math.round((cap - spent) / days_left)),
  };
}
