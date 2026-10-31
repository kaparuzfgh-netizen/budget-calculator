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

export type IncomeSource = 'actual' | 'typical' | 'computed' | 'none' | 'override';

export interface OverviewCommitment {
  name: string;
  amount_minor: number;
  currency: string;
  due_day: number | null;
  /** Подпись каденса («1 числа», «каждые 14 дн», «15 марта») — есть в /plan. */
  cadence?: string;
}
export interface Overview {
  month: string;
  base_currency: string;
  income_month_minor: number;
  income_month_currency: string;
  income_month_source: 'actual' | 'typical' | 'computed' | 'none';
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
  category_id: number | null;
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
  received_on: string | null; // 'YYYY-MM-DD'; у старых записей — 1-е число месяца
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
  /** хранимый базовый доход (0 — вычисляется из обязательств). */
  typical_income_minor?: number;
  /** фактический базовый доход: при income_minor=0 — вычисленная сумма. */
  baseline_income_minor?: number;
  baseline_source?: 'explicit' | 'computed' | 'none';
  income_currency?: string;
  living_cap_minor?: number;
  living_currency?: string;
  /** Валюта повседневных трат по умолчанию; null → living_currency. */
  expense_currency?: string | null;
  weekly_budget_minor?: number;
  base_currency?: string;
  timezone?: string;
  reminders_weekly?: number;
  reminders_payments?: number;
  /** Свой час начала окна напоминаний 0–23; null/отсутствует — легаси 10:00/вс 20:00. */
  reminder_hour?: number | null;
  fx_alerts_enabled?: number;
  vision_enabled?: number;
}

export type CommitmentFrequency = 'monthly' | 'interval_days' | 'yearly';
export interface Commitment {
  id: number;
  name: string;
  amount_minor: number;
  currency: string;
  due_day: number | null;
  /** Каденс (миграция 0016); легаси-строки — 'monthly'. */
  frequency: CommitmentFrequency;
  interval_days: number | null;
  anchor_on: string | null; // 'YYYY-MM-DD' первый платёж interval_days / фаза «каждые N мес»
  due_month: number | null;
  /** «каждые N месяцев» 1–24 (миграция 0017); 1 — обычный monthly. */
  every_months: number;
  /** Подпись каденса: «1 числа» · «каждые 3 мес (31-го)» · «каждые 14 дн» · «15 марта» · «без даты». */
  cadence: string;
  /** Ближайший срок 'YYYY-MM-DD'; null — платёж без расписания. */
  next_due_on: string | null;
  active: number;
  /** Текущий период/срок уже оплачен (для monthly без даты — «в этом месяце»). */
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

// ── vision /api/tma/vision/analyze ──

/** Строка истории трат, распознанная на скриншоте (major units, как у API). */
export interface VisionTxItem {
  date: string | null;
  amount: number;
  note: string;
  category: string;
}
export interface VisionAnalysis {
  provider: 'gemini' | 'groq';
  screen_type: 'expense_analytics' | 'debt_balance' | 'other';
  period: string;
  total_spent: number;
  currency: string;
  top_categories: { category: string; amount: number }[];
  is_full_month_analytics: boolean;
  bank: string;
  debt_balance: number;
  transactions?: VisionTxItem[];
}
export interface VisionAnalyzeResponse {
  ok: boolean;
  result: VisionAnalysis;
}

// ── клиент ──

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  /** Бинарный POST (загрузка скриншота): сырые байты + свой Content-Type. */
  postRaw<T>(path: string, body: ArrayBuffer, contentType: string): Promise<T>;
  /** Бинарный ответ (экспорт JSON): Bearer + один reauth — как у req. */
  getBlob(path: string): Promise<Blob>;
}

interface ApiOpts {
  /** текущий JWT (обновляется reauth'ом). */
  getToken: () => string;
  /** повторный POST /api/tma/auth → новый токен; бросает при провале. */
  reauth: () => Promise<string>;
}

export function createApi(opts: ApiOpts): Api {
  let reauthing: Promise<string> | null = null; // дедуп параллельных 401

  interface Send {
    body?: BodyInit | undefined;
    contentType?: string | undefined;
  }

  const raw = (method: string, path: string, send: Send, token: string): Promise<Response> =>
    fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(send.contentType ? { 'Content-Type': send.contentType } : {}),
      },
      ...(send.body !== undefined ? { body: send.body } : {}),
    });

  /** send → fetch с одним reauth при 401; тело ответа → JSON-контракт/ApiError. */
  const req = async <T>(method: string, path: string, send: Send): Promise<T> => {
    let res = await raw(method, path, send, opts.getToken());
    if (res.status === 401) {
      // Сессия протухла — один reauth и один повтор; дальше не мучаем.
      reauthing ??= opts.reauth().finally(() => {
        reauthing = null;
      });
      await reauthing;
      res = await raw(method, path, send, opts.getToken());
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

  /**
   * Бинарный POST — как req, но 403 сохраняет код ошибки тела: у
   * /vision/analyze легальный {error:{code:'disabled'}} ≠ «нет доступа».
   */
  const postRaw = async <T>(path: string, body: ArrayBuffer, contentType: string): Promise<T> => {
    const send = { body, contentType };
    let res = await raw('POST', path, send, opts.getToken());
    if (res.status === 401) {
      reauthing ??= opts.reauth().finally(() => {
        reauthing = null;
      });
      await reauthing;
      res = await raw('POST', path, send, opts.getToken());
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    if (res.status === 401 || (res.status === 403 && !data.error?.code)) {
      throw new ApiError(res.status, 'forbidden', 'Нет доступа');
    }
    if (!res.ok) {
      throw new ApiError(
        res.status,
        data.error?.code ?? 'error',
        data.error?.message ?? `Сервер ответил ${res.status}`,
      );
    }
    return data as T;
  };

  /** Скачивание файла (Bearer, один reauth) — blob уходит в <a download>. */
  const getBlob = async (path: string): Promise<Blob> => {
    let res = await raw('GET', path, {}, opts.getToken());
    if (res.status === 401) {
      reauthing ??= opts.reauth().finally(() => {
        reauthing = null;
      });
      await reauthing;
      res = await raw('GET', path, {}, opts.getToken());
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(res.status, 'forbidden', 'Нет доступа');
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new ApiError(res.status, data.error?.code ?? 'error', data.error?.message ?? `Сервер ответил ${res.status}`);
    }
    return res.blob();
  };

  return {
    get: (path) => req('GET', path, {}),
    post: (path, body) =>
      req('POST', path, {
        body: body !== undefined ? JSON.stringify(body) : undefined,
        contentType: body !== undefined ? 'application/json' : undefined,
      }),
    patch: (path, body) =>
      req('PATCH', path, {
        body: body !== undefined ? JSON.stringify(body) : undefined,
        contentType: body !== undefined ? 'application/json' : undefined,
      }),
    del: (path) => req('DELETE', path, {}),
    postRaw,
    getBlob,
  };
}

// ── категории / отчёты / upcoming (фаза 1b) ──

export interface Category {
  id: number;
  name: string;
  emoji: string;
  preset_key: string | null;
  archived: boolean;
  sort: number;
}
export interface CategoriesList {
  categories: Category[];
}
export interface UpcomingItem {
  kind: 'commitment' | 'debt';
  id: number;
  name: string;
  amount_minor: number;
  currency: string;
  due_on: string;
  paid: boolean;
  overdue: boolean;
  /** Подпись каденса платежа («каждые 14 дн»…); только kind='commitment'. */
  cadence?: string;
}
export interface Upcoming {
  month: string;
  currency_hint: string;
  items: UpcomingItem[];
}
export type ReportPeriod = 'week' | 'month' | 'quarter' | 'half' | 'year';
export interface ReportCategory {
  id: number | null;
  name: string;
  emoji: string;
  amount: number;
  share: number;
  count: number;
}
export interface ReportBucket {
  key: string;
  label: string;
  living: number;
  other: number;
  received: number;
}
export interface ReportTopExpense {
  id: number;
  spent_on: string;
  amount: number;
  note: string | null;
  category_id: number | null;
}
export interface Report {
  period: string;
  offset: number;
  from: string;
  to: string;
  label: string;
  currency: string;
  fx_as_of: string;
  received: { income: number; loans_returned: number; total: number };
  spent: { living: number; commitments: number; credits: number; loans_repaid: number; total: number };
  net: number;
  living_limit: { cap: number; used_pct: number };
  categories: ReportCategory[];
  buckets: ReportBucket[];
  prev: { label: string; spent_total: number; received_total: number; living: number };
  top_expenses: ReportTopExpense[];
}
