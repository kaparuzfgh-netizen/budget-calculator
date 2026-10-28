/**
 * debts.ts — состояние долгов (шаг 6): replay журнала событий + проекции.
 * Математика — только domain/debt.ts (float); здесь — конверсия minor↔float
 * на границе и сборка контекста для экранов бота.
 */
import { normalizedMonthly, projection, replay, type DebtEvent } from '../domain/debt';
import { convert, round2 } from '../domain/money';
import { todayInTz } from '../bot/parse';
import type { FxResult } from '../fx/service';
import type { DebtRow, DebtEventRow, ProfileRow, ScopedRepo } from '../db/repo';

/** Долг с вычисленным состоянием (в его валюте, float). */
export interface DebtView {
  debt: DebtRow;
  balance: number; // текущий остаток
  payment: number; // текущий платёж за период
  paymentsMade: number;
  remainingPeriods: number;
  effectivePeriods: number; // n0, смещённый reconcile-событиями (для превью ЧДП)
  monthlyPayment: number; // нормализованный в месяц (biweekly ×26/12)
  monthsLeft: number;
  payoffDate: string; // 'YYYY-MM-DD'
  totalInterest: number; // проценты до полного погашения по текущему графику
  events: DebtEventRow[]; // журнал (event_on, id) — для экрана истории
}

export interface DebtCtx {
  profile: ProfileRow;
  debts: DebtView[];
  /** Сумма остатков в USD; 'err' — FX недоступен; undefined — долгов нет. */
  totalUsd?: number | 'err' | undefined;
  today: string; // 'YYYY-MM-DD' в таймзоне пользователя
}

const toView = (debt: DebtRow, events: DebtEventRow[], today: string): DebtView => {
  const evs: DebtEvent[] = events.map((e) => ({
    kind: e.kind,
    amount: e.amount_minor / 100,
    // старые записи без mode трактуются как «платёж↓» (см. replay)
    ...(e.kind === 'prepay' ? { mode: e.mode ?? 'reduce_payment' } : {}),
  }));
  const s = replay(
    {
      rate: debt.rate,
      frequency: debt.frequency,
      initialBalance: debt.initial_balance_minor / 100,
      initialPayment: debt.initial_payment_minor / 100,
    },
    evs,
  );
  const proj = projection(
    { rate: debt.rate, frequency: debt.frequency, balance: s.balance, payment: s.payment },
    0,
    today,
  );
  return {
    debt,
    balance: s.balance,
    payment: s.payment,
    paymentsMade: s.paymentsMade,
    remainingPeriods: s.remainingPeriods,
    effectivePeriods: s.effectivePeriods,
    monthlyPayment: normalizedMonthly(s.payment, debt.frequency),
    monthsLeft: proj.monthsLeft,
    payoffDate: proj.payoffDate,
    totalInterest: proj.totalInterest,
    events,
  };
};

export async function debtView(repo: ScopedRepo, debt: DebtRow, today: string): Promise<DebtView> {
  return toView(debt, (await repo.listDebtEvents(debt.id)).results, today);
}

export async function debtViews(repo: ScopedRepo, today: string): Promise<DebtView[]> {
  const out: DebtView[] = [];
  for (const d of (await repo.listDebts()).results) out.push(await debtView(repo, d, today));
  return out;
}

/**
 * Контекст экранов долгов: replay каждого долга + итог в USD
 * (FX best-effort — при недоступности итог опускается).
 */
export async function buildDebtCtx(
  repo: ScopedRepo,
  profile: ProfileRow,
  fxGet: (ccys: string[]) => Promise<FxResult>,
  now: Date,
): Promise<DebtCtx> {
  const today = todayInTz(profile.timezone, now);
  const debts = await debtViews(repo, today);
  let totalUsd: number | 'err' | undefined;
  if (debts.length) {
    try {
      const fxr = await fxGet([...new Set(debts.map((v) => v.debt.currency))]);
      totalUsd = round2(debts.reduce((s, v) => s + convert(v.balance, v.debt.currency, 'USD', { perUsd: fxr.perUsd }), 0));
    } catch {
      totalUsd = 'err';
    }
  }
  return { profile, debts, totalUsd, today };
}
