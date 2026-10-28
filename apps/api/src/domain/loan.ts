/**
 * loan.ts — личные займы («я должен» / «мне должны»), чистые функции.
 * Деньги — float; события уже отсортированы вызывающим кодом.
 */
import { DomainError, num } from './errors';

export type LoanDirection = 'owe' | 'owed';
export type LoanStatus = 'open' | 'partial' | 'closed';

export interface LoanEvent {
  kind: 'repay';
  amount: number;
}

export interface LoanReplay {
  repaid: number; // внесено всего (может быть > amount при переплате)
  remaining: number; // сколько ещё вернуть (0 при закрытии)
  status: LoanStatus;
}

/**
 * Остаток займа = amount − Σ repay. Закрытый вручную (closedAt) — остаток 0
 * независимо от внесённого (остаток прощён).
 */
export function replayLoan(amount: number, events: LoanEvent[], closedAt: string | null): LoanReplay {
  num(amount, 'amount', { positive: true });
  let repaid = 0;
  for (const e of events) {
    num(e.amount, 'event.amount', { nonNegative: true });
    if (e.kind !== 'repay') throw new DomainError('BAD_LOAN_EVENT', `Неизвестное событие '${e.kind}'`);
    repaid += e.amount;
  }
  const remaining = closedAt !== null ? 0 : Math.max(0, amount - repaid);
  const status: LoanStatus = closedAt !== null || remaining <= 0 ? 'closed' : repaid > 0 ? 'partial' : 'open';
  return { repaid, remaining, status };
}

/** Проверка суммы возврата: >0 и не больше остатка (копейки на границе). */
export function checkRepay(remaining: number, amount: number): void {
  num(amount, 'amount');
  if (amount <= 0) throw new DomainError('REPAY_NOT_POSITIVE', 'Сумма возврата должна быть положительной');
  if (amount > remaining + 0.005)
    throw new DomainError('REPAY_EXCEEDS', 'Сумма больше остатка — введите меньше или закройте долг кнопкой');
}
