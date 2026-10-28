/**
 * api.ts — контракты REST Mini App и fetch-клиент.
 *
 * Контракты отзеркалены с apps/api/src/tma/api.ts и tma/overview.ts:
 * суммы везде INTEGER minor units, ошибки {error:{code,message}}.
 * JWT живёт только в памяти (никаких localStorage/cookie). При 401 —
 * один повторный auth (reauth) и ровно один повтор запроса; повторный
 * 401/403 пробрасывается наверх (экран «Нет доступа»).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** 401/403 → фатальный экран «Нет доступа». */
export const isAuthError = (e: unknown): boolean =>
  e instanceof ApiError && (e.status === 401 || e.status === 403);

// ── контракты ответов (поля — как в apps/api/src/tma/*.ts) ──

export interface AuthResponse {
  ok: boolean;
  token?: string;
  user?: { name: string | null };
}

export type IncomeSource = 'actual' | 'typical' | 'none' | 'override';

export interface OverviewCommitment {
  name: string;
  amount_minor: number;
  currency: string;
  due_day: number | null;
}
export interface Overview {
  month: string;
  base_currency: string;
  income_month_minor: number;
  income_month_currency: string;
  income_month_source: 'actual' | 'typical' | 'none';
  income_entries_count: number;
  commitments: OverviewCommitment[];
  weekly_budget_minor: number;
  living_currency: string;
  spent_week_minor: number;
  week_remaining_minor: number;
  spent_month_minor: number;
  month_cap_minor: number;
  fx_as_of: string;
  fx_note?: string;
}

export interface WeekStatus {
  currency: string;
  week_spent_minor: number;
  week_budget_minor: number;
  week_over: boolean;
  week_remaining_minor: number;
  month_spent_minor: number;
  month_cap_minor: number;
  /** >1 — тратим быстрее плана (форматировать через fmtPct). */
  burn_rate: number;
  daily_allowance_minor: number;
  days_left: number;
  fx_as_of: string;
}

export interface PlanData {
  month: string;
  income_minor: number;
  income_currency: string;
  income_source: IncomeSource;
  income_entries_count: number;
  mandatory_usd_minor: number;
  living_usd_minor: number;
  surplus_usd_minor: number;
  bonus: { delta_usd_minor: number; prepay_usd_minor: number; dca_usd_minor: number } | null;
  commitments: OverviewCommitment[];
  fx_as_of: string;
}

export interface ExpenseItem {
  id: number;
  spent_on: string;
  amount_minor: number;
  currency: string;
  note: string | null;
}
export interface ExpensesList {
  week_start: string;
  expenses: ExpenseItem[];
}

export interface IncomeEntry {
  id: number;
  amount_minor: number;
  currency: string;
  note: string | null;
}
export interface IncomeList {
  month: string;
  total_minor: number;
  currency: string;
  entries: IncomeEntry[];
}

/** GET /profile: без онбординга приходит только {onboarded:false}. */
export interface Profile {
  onboarded: boolean;
  typical_income_minor?: number;
  income_currency?: string;
  living_cap_minor?: number;
  living_currency?: string;
  weekly_budget_minor?: number;
  base_currency?: string;
  timezone?: string;
  reminders_weekly?: number;
  reminders_payments?: number;
}

export interface Commitment {
  id: number;
  name: string;
  amount_minor: number;
  currency: string;
  due_day: number | null;
  active: number;
  paid_this_month: boolean;
  last_paid_on: string | null;
}
export interface CommitmentsList {
  commitments: Commitment[];
}
export interface CommitmentPayment {
  id: number;
  amount_minor: number;
  currency: string;
  paid_on: string;
  source: 'manual' | 'auto';
}
export interface CommitmentPaymentsList {
  payments: CommitmentPayment[];
}

// ── кредиты /api/tma/debts* ──

export type DebtEventKind = 'payment' | 'prepay' | 'reconcile';
export type PrepayMode = 'reduce_payment' | 'reduce_term';

export interface DebtEvent {
  id: number;
  kind: DebtEventKind;
  amount_minor: number;
  event_on: string; // 'YYYY-MM-DD'
  mode: PrepayMode | null; // только у prepay
}
/** replay-состояние кредита (считает сервер — как в боте). */
export interface DebtItem {
  id: number;
  name: string;
  currency: string;
  rate: number; // % годовых
  frequency: 'monthly' | 'biweekly';
  due_day: number | null;
  balance_minor: number;
  payment_minor: number;
  monthly_payment_minor: number;
  payments_made: number;
  months_left: number;
  payoff_date: string;
  total_interest_minor: number;
}
export interface DebtDetail extends DebtItem {
  events: DebtEvent[];
}
export interface DebtsList {
  debts: DebtItem[];
  total_usd_minor: number | null;
}
/** GET /debts/:id/prepay-preview?amount= — оба режима ЧДП. */
export interface PrepayPreview {
  balance_before_minor: number;
  balance_after_minor: number;
  payment_before_minor: number;
  payment_after_minor: number;
  payment_saved_minor: number;
  months_saved: number;
}

// ── займы /api/tma/loans* ──

export interface LoanEvent {
  id: number;
  amount_minor: number;
  event_on: string;
}
export type LoanStatus = 'open' | 'partial' | 'closed';
export interface LoanItem {
  id: number;
  counterparty: string;
  direction: 'owe' | 'owed';
  currency: string;
  amount_minor: number;
  repaid_minor: number;
  remaining_minor: number;
  status: LoanStatus;
  due_on: string | null;
  note: string | null;
  closed: boolean;
  last_event_on: string | null;
}
export interface LoanDetail extends LoanItem {
  events: LoanEvent[];
}
export interface LoansList {
  owe: LoanItem[];
  owed: LoanItem[];
  owe_usd_minor: number | null;
  owed_usd_minor: number | null;
}

// ── курсы /api/tma/fx* (шаг 8) ──

export interface FxForecast {
  low: number;
  mid: number;
  high: number;
}
export type FxSignalKind = 'convert' | 'split' | 'wait' | 'hold';
/** Одна пара конвертации — поля 1:1 с FxAction из services/fx.ts. */
export interface FxActionItem {
  key: string;
  label: string; // 'EUR → RUB'
  purpose: string;
  emoji: string;
  current: number;
  digits: number;
  min: number;
  max: number;
  percentile: number;
  rsi14: number;
  change30d_pct: number;
  vol30d_pct: number;
  trend_up: boolean;
  signal: FxSignalKind;
  signal_text: string;
  forecast7d: FxForecast;
  forecast30d: FxForecast;
  series: number[]; // последние ≤90 закрытий — для спарклайна
}
export interface FxAnalysisData {
  ok: boolean;
  note?: string;
  generated_at: string;
  actions: FxActionItem[];
  skipped: string[];
  disclaimer: string;
}
export interface ExchangeItem {
  id: number;
  from_ccy: string;
  to_ccy: string;
  amount_from_minor: number;
  amount_to_minor: number;
  rate: number; // to за 1 from
  market_rate: number | null;
  spent_on: string; // 'YYYY-MM-DD'
  note: string;
  created_at: string;
}
/** GET /api/tma/fx — экран целиком: анализ + журнал. */
export interface FxScreenData {
  analysis: FxAnalysisData;
  exchanges: ExchangeItem[];
}

// ── клиент ──

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

interface ApiOpts {
  /** текущий JWT (обновляется reauth'ом). */
  getToken: () => string;
  /** повторный POST /api/tma/auth → новый токен; бросает при провале. */
  reauth: () => Promise<string>;
}

export function createApi(opts: ApiOpts): Api {
  let reauthing: Promise<string> | null = null; // дедуп параллельных 401

  const raw = (method: string, path: string, body: unknown, token: string): Promise<Response> =>
    fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const req = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res = await raw(method, path, body, opts.getToken());
    if (res.status === 401) {
      // Сессия протухла — один reauth и один повтор; дальше не мучаем.
      reauthing ??= opts.reauth().finally(() => {
        reauthing = null;
      });
      await reauthing;
      res = await raw(method, path, body, opts.getToken());
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(res.status, 'forbidden', 'Нет доступа');
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    if (!res.ok) {
      throw new ApiError(
        res.status,
        data.error?.code ?? 'error',
        data.error?.message ?? `Сервер ответил ${res.status}`,
      );
    }
    return data as T;
  };

  return {
    get: (path) => req('GET', path),
    post: (path, body) => req('POST', path, body),
    patch: (path, body) => req('PATCH', path, body),
    del: (path) => req('DELETE', path),
  };
}
