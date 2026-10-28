/**
 * loans.ts — личные займы («Долги людям»): replay журнала возвратов + контекст
 * экранов. Математика — domain/loan.ts (float); здесь — minor↔float на границе.
 */
import { replayLoan, type LoanEvent, type LoanStatus } from '../domain/loan';
import { convert, round2 } from '../domain/money';
import { todayInTz } from '../bot/parse';
import type { FxResult } from '../fx/service';
import type { LoanRow, LoanEventRow, ProfileRow, ScopedRepo } from '../db/repo';

/** Заём с вычисленным состоянием (в его валюте, float). */
export interface LoanView {
  loan: LoanRow;
  repaid: number; // внесено всего
  remaining: number; // остаток к возврату
  status: LoanStatus; // open | partial | closed
  lastEventOn?: string | undefined; // 'YYYY-MM-DD' последнего возврата
  events: LoanEventRow[]; // журнал (event_on, id) — для экрана истории
}

export interface LoanCtx {
  profile: ProfileRow;
  owe: LoanView[]; // я должен
  owed: LoanView[]; // мне должны
  /** Суммы остатков в USD по направлениям; 'err' — FX недоступен. */
  oweUsd?: number | 'err' | undefined;
  owedUsd?: number | 'err' | undefined;
  today: string; // 'YYYY-MM-DD' в таймзоне пользователя
}

const toView = (loan: LoanRow, events: LoanEventRow[]): LoanView => {
  const evs: LoanEvent[] = events.map((e) => ({ kind: 'repay' as const, amount: e.amount_minor / 100 }));
  const s = replayLoan(loan.amount_minor / 100, evs, loan.closed_at);
  return { loan, repaid: s.repaid, remaining: s.remaining, status: s.status, lastEventOn: events.at(-1)?.event_on, events };
};

export async function loanView(repo: ScopedRepo, loan: LoanRow): Promise<LoanView> {
  return toView(loan, (await repo.listLoanEvents(loan.id)).results);
}

export async function loanViews(repo: ScopedRepo): Promise<LoanView[]> {
  // P2-2: все журналы одним запросом (не N+1); группировка по loan_id
  // сохраняет порядок replay (ORDER BY loan_id, event_on, id).
  const [loans, events] = await Promise.all([repo.listLoans(), repo.listLoanEventsAll()]);
  const byLoan = new Map<number, LoanEventRow[]>();
  for (const e of events.results) {
    const arr = byLoan.get(e.loan_id);
    if (arr) arr.push(e);
    else byLoan.set(e.loan_id, [e]);
  }
  return loans.results.map((l) => toView(l, byLoan.get(l.id) ?? []));
}

const usdTotal = (views: LoanView[], perUsd: Record<string, number>) =>
  round2(views.reduce((s, v) => s + convert(v.remaining, v.loan.currency, 'USD', { perUsd }), 0));

/**
 * Контекст экранов займов: replay каждого + итоги «я должен / мне должны» в USD
 * (FX best-effort — при недоступности итоги опускаются).
 */
export async function buildLoanCtx(
  repo: ScopedRepo,
  profile: ProfileRow,
  fxGet: (ccys: string[]) => Promise<FxResult>,
  now: Date,
): Promise<LoanCtx> {
  const today = todayInTz(profile.timezone, now);
  const views = await loanViews(repo);
  const owe = views.filter((v) => v.loan.direction === 'owe');
  const owed = views.filter((v) => v.loan.direction === 'owed');
  let oweUsd: number | 'err' | undefined;
  let owedUsd: number | 'err' | undefined;
  if (views.length) {
    try {
      const fxr = await fxGet([...new Set(views.map((v) => v.loan.currency))]);
      oweUsd = usdTotal(owe, fxr.perUsd);
      owedUsd = usdTotal(owed, fxr.perUsd);
    } catch {
      oweUsd = 'err';
      owedUsd = 'err';
    }
  }
  return { profile, owe, owed, oweUsd, owedUsd, today };
}
