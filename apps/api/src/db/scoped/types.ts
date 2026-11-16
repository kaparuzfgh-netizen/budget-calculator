/** Строки таблиц пользовательских данных (decrypted-вид из scoped-репозитория). */
export interface ConsentRow {
  kind: string;
  granted: number;
  created_at: string;
}

export interface ProfileRow {
  user_id: number;
  base_currency: string;
  income_currency: string;
  living_currency: string;
  /** Валюта повседневных трат по умолчанию (миграция 0015); NULL → living_currency. */
  expense_currency: string | null;
  timezone: string;
  income_minor: number;
  living_cap_minor: number;
  weekly_budget_minor: number;
  bonus_prepay_share: number;
  bonus_dca_share: number;
  onboarded_at: string | null;
  reminders_weekly: number;
  reminders_payments: number;
  /** Дайджест месяца (миграция 0022): итог в последний день месяца. */
  reminders_digest: number;
  /** Свой час начала окна напоминаний 0–23 (миграция 0018); NULL — легаси 10:00/вс 20:00. */
  reminder_hour: number | null;
  /** Согласие на отправку скриншотов во внешний vision-провайдер (миграция 0012). */
  vision_enabled: number;
  /** Валютные алерты (миграция 0013): окно ≥85 / ≤15 перцентиля, 1/нед на пару. */
  fx_alerts_enabled: number;
  /** «Подушка безопасности» — ручной остаток в living_currency (миграция 0019); NULL → не задана. */
  cushion_minor: number | null;
}

export interface CommitmentRow {
  id: number;
  user_id: number;
  name: string;
  amount_minor: number;
  currency: string;
  due_day: number | null;
  /** Периодичность (миграция 0016): monthly|interval_days|yearly. Легаси — monthly. */
  frequency: 'monthly' | 'interval_days' | 'yearly';
  /** interval_days: шаг 1–366 от якоря anchor_on; NULL у прочих каденсов. */
  interval_days: number | null;
  /** interval_days: 'YYYY-MM-DD' первого платежа (точка отсчёта сроков). */
  anchor_on: string | null;
  /** yearly: месяц платежа 1–12; NULL у прочих каденсов. */
  due_month: number | null;
  /** monthly: «каждые N месяцев» 1–24 (0017); 1 — обычный monthly, фаза — месяц anchor_on. */
  every_months: number;
  active: number;
  created_at: string;
}

export interface ExpenseRow {
  id: number;
  user_id: number;
  spent_on: string;
  amount_minor: number;
  currency: string;
  note: string | null;
  source: string;
  source_key: string | null;
  /** Категория (миграция 0014); NULL — без категории. */
  category_id: number | null;
}

export interface IncomeEntryRow {
  id: number;
  user_id: number;
  month: string; // 'YYYY-MM' в таймзоне пользователя
  amount_minor: number;
  currency: string;
  note: string | null;
  source_key: string | null;
  /** Фактическая дата получения (миграция 0014); у старых строк = первое число месяца. */
  received_on: string | null;
}

/** Категория расхода (миграция 0014); name/emoji — enc1:. */
export interface CategoryRow {
  id: number;
  user_id: number;
  name: string;
  emoji: string;
  preset_key: string | null;
  sort: number;
  archived: number;
  created_at: string;
}

export interface DebtRow {
  id: number;
  user_id: number;
  name: string;
  currency: string;
  rate: number; // годовая, доля (0.119)
  frequency: 'monthly' | 'biweekly';
  initial_balance_minor: number;
  initial_payment_minor: number;
  epoch: string; // 'YYYY-MM-DD'
  due_day: number | null;
  active: number;
  created_at: string;
  /** Идемпотентность создания из Mini App ('tma:<client_id>'); NULL у бота/вручную. */
  source_key: string | null;
}

export interface DebtEventRow {
  id: number;
  user_id: number;
  debt_id: number;
  kind: 'payment' | 'prepay' | 'reconcile';
  amount_minor: number;
  event_on: string; // 'YYYY-MM-DD' локально
  /** Режим ЧДП: 'reduce_payment' | 'reduce_term' | null (старые записи). */
  mode: 'reduce_payment' | 'reduce_term' | null;
  source: 'manual' | 'auto';
  source_key: string | null;
}

/** Личный заём («Долги людям»): 'owe' — я должен, 'owed' — мне должны. */
export interface LoanRow {
  id: number;
  user_id: number;
  counterparty: string;
  direction: 'owe' | 'owed';
  amount_minor: number;
  currency: string;
  due_on: string | null; // 'YYYY-MM-DD' или NULL
  note: string | null;
  closed_at: string | null; // закрыт вручную — остаток прощён
  /** Идемпотентность создания из Mini App ('tma:<client_id>'); NULL у бота/вручную. */
  source_key: string | null;
}

/** Оплата регулярного платежа (журнал commitments): manual/auto + source_key. */
export interface CommitmentPaymentRow {
  id: number;
  user_id: number;
  commitment_id: number;
  amount_minor: number;
  currency: string;
  paid_on: string; // 'YYYY-MM-DD' локально
  source: 'manual' | 'auto';
  source_key: string | null;
}

/** История изменений платежа (0021): old_val/new_val — строки (amount — minor units). */
export type CommitmentChangeField = 'name' | 'amount' | 'currency' | 'due_day' | 'active' | 'cadence';
export interface CommitmentChangeRow {
  id: number;
  user_id: number;
  commitment_id: number;
  field: CommitmentChangeField;
  old_val: string | null;
  new_val: string | null;
  changed_at: string;
}

export interface LoanEventRow {
  id: number;
  user_id: number;
  loan_id: number;
  kind: 'repay';
  amount_minor: number;
  event_on: string; // 'YYYY-MM-DD' локально
  source: 'manual' | 'auto';
  source_key: string | null;
}

/** Фактический обмен валют (шаг 8). rate = to за 1 from, market_rate — курс дня. */
export interface ExchangeRow {
  id: number;
  user_id: number;
  from_ccy: string;
  to_ccy: string;
  amount_from_minor: number;
  amount_to_minor: number;
  /** Курс сделки: amount_to/amount_from — пересчитывается при записи и правке. */
  rate: number;
  /** Рыночный курс на дату (to за 1 from); NULL — провайдер был недоступен. */
  market_rate: number | null;
  spent_on: string; // 'YYYY-MM-DD' локально
  note: string;
  source: string;
  source_key: string | null;
  created_at: string;
  updated_at: string;
}
