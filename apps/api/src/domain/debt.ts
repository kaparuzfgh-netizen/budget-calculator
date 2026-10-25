/**
 * debt.ts — математика долгов (порт DebtEngine.gs, чистые функции).
 * Деньги — float; события уже отсортированы вызывающим кодом.
 */
import { DomainError, num } from './errors';
import { addMonths } from './dates';

export type PaymentFrequency = 'monthly' | 'biweekly';

export function periodsPerYear(freq: PaymentFrequency): number {
  if (freq === 'monthly') return 12;
  if (freq === 'biweekly') return 26;
  throw new DomainError('BAD_FREQUENCY', `Неизвестная периодичность платежей '${freq}'`);
}

function periodRate(annualRate: number, ppy: number): number {
  num(annualRate, 'annualRate', { nonNegative: true });
  return annualRate / ppy;
}

export function annuityPayment(balance: number, annualRate: number, ppy: number, periods: number): number {
  num(balance, 'balance', { nonNegative: true });
  num(periods, 'periods', { nonNegative: true });
  if (periods <= 0 || balance <= 0) return 0;
  const r = periodRate(annualRate, ppy);
  if (r <= 0) return balance / periods;
  return (balance * r * Math.pow(1 + r, periods)) / (Math.pow(1 + r, periods) - 1);
}

/** Инверсия аннуитета: сколько периодов осталось при (balance, rate, payment). */
export function derivePeriods(balance: number, annualRate: number, ppy: number, payment: number): number {
  num(balance, 'balance', { nonNegative: true });
  num(payment, 'payment', { positive: true });
  const r = periodRate(annualRate, ppy);
  if (r <= 0) return balance / payment;
  if (payment <= balance * r) return Infinity; // платёж не покрывает проценты
  return -Math.log(1 - (balance * r) / payment) / Math.log(1 + r);
}

// ── replay: журнал событий → состояние ──

export type DebtEventKind = 'payment' | 'prepay' | 'reconcile';

export interface DebtEvent {
  kind: DebtEventKind;
  amount: number;
}

export interface DebtParams {
  rate: number; // годовая, доля (0.119)
  frequency: PaymentFrequency;
  initialBalance: number;
  initialPayment: number;
}

export interface DebtState {
  balance: number;
  payment: number;
  paymentsMade: number;
  initialPeriods: number; // n0 из начальных параметров
  effectivePeriods: number; // n0, смещённый reconcile-событиями
  remainingPeriods: number;
}

export function replay(params: DebtParams, events: DebtEvent[]): DebtState {
  num(params.rate, 'rate', { nonNegative: true });
  num(params.initialBalance, 'initialBalance', { nonNegative: true });
  num(params.initialPayment, 'initialPayment', { nonNegative: true });
  const ppy = periodsPerYear(params.frequency);
  const r = params.rate / ppy;
  let balance = params.initialBalance;
  let payment = params.initialPayment;
  let made = 0;
  const n0 = derivePeriods(params.initialBalance, params.rate, ppy, payment);
  let n0Eff = n0;

  for (const ev of events) {
    if (!ev.amount) continue; // как в legacy: нулевые/пустые суммы пропускаются
    num(ev.amount, 'event.amount');
    if (ev.kind === 'payment') {
      const interest = balance * r;
      balance = Math.max(0, balance - Math.max(0, ev.amount - interest));
      made += 1;
    } else if (ev.kind === 'prepay') {
      balance = Math.max(0, balance - ev.amount);
      const nLeft = Math.max(0, n0Eff - made);
      payment = annuityPayment(balance, params.rate, ppy, nLeft); // срок сохраняется
    } else if (ev.kind === 'reconcile') {
      // сверка с банком: факт главнее; платёж не меняется, срок пересчитывается
      balance = Math.max(0, ev.amount);
      n0Eff = made + derivePeriods(balance, params.rate, ppy, payment);
    }
  }

  return {
    balance,
    payment,
    paymentsMade: made,
    initialPeriods: n0,
    effectivePeriods: n0Eff,
    // Намеренное отличие от legacy replayAll (там n0 − made): остаточный срок —
    // инверсия аннуитета от текущего состояния; консистентно после ЧДП/reconcile
    // и совпадает с тем, что показывал Mini App (B7 ЧДП-калькулятора).
    remainingPeriods: derivePeriods(balance, params.rate, ppy, payment),
  };
}

/** Долг в виде, достаточном для предпросмотров/проекций. */
export interface DebtSnapshot {
  rate: number;
  frequency: PaymentFrequency;
  balance: number;
  payment: number;
  paymentsMade?: number;
  effectivePeriods?: number;
}

function effPeriods(s: DebtSnapshot): number {
  return s.effectivePeriods ?? derivePeriods(s.balance, s.rate, periodsPerYear(s.frequency), s.payment);
}

/** ЧДП «платёж ↓»: тело уменьшается, срок сохраняется (режим банков РФ). */
export function previewPrepay(state: DebtSnapshot, amount: number) {
  num(amount, 'amount');
  if (amount <= 0) throw new DomainError('PREPAY_NOT_POSITIVE', 'Сумма ЧДП должна быть положительным числом');
  num(state.balance, 'balance');
  if (amount > state.balance) {
    throw new DomainError('PREPAY_EXCEEDS_BALANCE', 'Сумма ЧДП больше остатка долга');
  }
  const ppy = periodsPerYear(state.frequency);
  const balanceAfter = Math.max(0, state.balance - amount);
  const made = state.paymentsMade ?? 0;
  const nLeft = Math.max(0, effPeriods(state) - made);
  const paymentAfter = annuityPayment(balanceAfter, state.rate, ppy, nLeft);
  return {
    balanceBefore: state.balance,
    balanceAfter,
    paymentBefore: state.payment,
    paymentAfter,
    paymentSaved: state.payment - paymentAfter,
  };
}

/** ЧДП «срок ↓»: платёж фиксирован, пересчитывается остаточный срок. */
export function previewPrepayShortenTerm(state: DebtSnapshot, amount: number) {
  num(amount, 'amount');
  if (amount <= 0) throw new DomainError('PREPAY_NOT_POSITIVE', 'Сумма ЧДП должна быть положительным числом');
  num(state.balance, 'balance');
  if (amount > state.balance) {
    throw new DomainError('PREPAY_EXCEEDS_BALANCE', 'Сумма ЧДП больше остатка долга');
  }
  const ppy = periodsPerYear(state.frequency);
  const periodsBefore = derivePeriods(state.balance, state.rate, ppy, state.payment);
  // n' = -ln(1 − (B−L)·r / P) / ln(1+r)
  const periodsAfter = derivePeriods(Math.max(0, state.balance - amount), state.rate, ppy, state.payment);
  const periodsSaved = periodsBefore - periodsAfter;
  return {
    periodsBefore,
    periodsAfter,
    periodsSaved,
    monthsSaved: Math.round(periodsSaved * (12 / ppy) * 10) / 10,
  };
}

export function normalizedMonthly(payment: number, freq: PaymentFrequency): number {
  num(payment, 'payment', { nonNegative: true });
  return freq === 'biweekly' ? (payment * 26) / 12 : payment;
}

export interface ProjectionResult {
  periodsLeft: number;
  monthsLeft: number;
  payoffDate: string; // ISO 'YYYY-MM-DD'
  totalInterest: number;
  periodPayment: number;
  neverPaysOff: boolean;
}

/** Проекция до полного погашения; extraMonthly — доп. досрочка в месяц. */
export function projection(
  state: Pick<DebtSnapshot, 'rate' | 'frequency' | 'balance' | 'payment'>,
  extraMonthly: number,
  today: string,
): ProjectionResult {
  num(extraMonthly, 'extraMonthly', { nonNegative: true });
  const ppy = periodsPerYear(state.frequency);
  const r = state.rate / ppy;
  const pmt = state.payment + extraMonthly * (12 / ppy); // нормализуем в период
  let balance = state.balance;
  let totalInterest = 0;
  let periods = 0;
  while (balance > 0.01 && periods < 1200) {
    const interest = balance * r;
    totalInterest += interest;
    balance -= Math.max(0, pmt - interest);
    periods += 1;
  }
  const months = periods * (12 / ppy);
  return {
    periodsLeft: periods,
    monthsLeft: Math.round(months * 10) / 10,
    // addMonths удерживает конец месяца (осознанное улучшение legacy setMonth)
    payoffDate: addMonths(today, Math.ceil(months)),
    totalInterest: Math.round(totalInterest),
    periodPayment: pmt,
    neverPaysOff: balance > 0.01 && periods >= 1200,
  };
}

/** Арбитраж «вклад vs досрочка» — только числа, вердикт рисует представление. */
export function arbitrage(input: { amount: number; depositRate: number; debtRate: number }) {
  num(input.amount, 'amount', { nonNegative: true });
  num(input.depositRate, 'depositRate', { nonNegative: true });
  num(input.debtRate, 'debtRate', { nonNegative: true });
  const delta = input.amount * (input.depositRate - input.debtRate);
  return {
    depositYield: input.amount * input.depositRate,
    interestSaved: input.amount * input.debtRate,
    delta,
    depositWins: delta > 0,
  };
}

/** Цель досрочки — самый дорогой долг; при равных ставках побеждает первый. */
export function pickPrepayTarget(debts: { id: string; rate: number }[]): { id: string; rate: number } | undefined {
  let best: { id: string; rate: number } | undefined;
  for (const d of debts) {
    num(d.rate, `rate[${d.id}]`, { nonNegative: true });
    if (!best || d.rate > best.rate) best = d;
  }
  return best;
}
