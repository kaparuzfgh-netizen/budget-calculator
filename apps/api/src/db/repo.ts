/**
 * repo.ts — ЕДИНСТВЕННАЯ точка доступа к данным (ADR-0001, находка S5).
 *
 * Правило изоляции: все чтения/записи пользовательских данных идут через
 * `scoped(env.DB, userId)` — каждый метод обязан добавлять `WHERE user_id = ?`
 * (или эквивалент через связанную таблицу). Сырые `db.prepare(...)` вне этого
 * модуля — запрещены. Тест «A не видит B» — обязателен (test/repo.test.ts).
 *
 * Таблицы access-контура (users, invites, processed_updates, audit_log) —
 * глобальные, но доступ к ним тоже только отсюда (функции accessRepo(db)).
 */
import type { Env } from '../env';
import { FIELDS, decRow, decRows, decStr, encNum, encStr } from './crypto';

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
  /** Согласие на отправку скриншотов во внешний vision-провайдер (миграция 0012). */
  vision_enabled: number;
  /** Валютные алерты (миграция 0013): окно ≥85 / ≤15 перцентиля, 1/нед на пару. */
  fx_alerts_enabled: number;
}

export interface CommitmentRow {
  id: number;
  user_id: number;
  name: string;
  amount_minor: number;
  currency: string;
  due_day: number | null;
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

/** Репозиторий, привязанный к конкретному пользователю. */
export function scoped(db: Env['DB'], userId: number) {
  /** Шифрование поля по FIELDS-спеку; колонки вне спека — plaintext. */
  const en = (table: string, col: string, v: unknown): Promise<string | number | null> => {
    const spec = FIELDS[table]?.[col];
    if (!spec || v === undefined) return Promise.resolve((v ?? null) as string | number | null);
    return spec === 'num'
      ? encNum(userId, table, col, v as number)
      : encStr(userId, table, col, v as string);
  };
  return {
    /** Согласия пользователя (vision/экспорт и т.п.). */
    listConsents() {
      return db
        .prepare('SELECT kind, granted, created_at FROM consents WHERE user_id = ? ORDER BY kind')
        .bind(userId)
        .all<ConsentRow>();
    },
    grantConsent(kind: string) {
      return db
        .prepare('INSERT OR REPLACE INTO consents (user_id, kind, granted) VALUES (?, ?, 1)')
        .bind(userId, kind)
        .run();
    },
    hasConsent(kind: string) {
      return db
        .prepare('SELECT granted FROM consents WHERE user_id = ? AND kind = ?')
        .bind(userId, kind)
        .first<{ granted: number }>();
    },

    // ── профиль ──
    getProfile() {
      return db.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(userId).first<ProfileRow>().then((r) => decRow('profiles', r));
    },
    async upsertProfile(
      p: Omit<
        ProfileRow,
        'user_id' | 'reminders_weekly' | 'reminders_payments' | 'vision_enabled' | 'fx_alerts_enabled' | 'expense_currency'
      > & {
        reminders_weekly?: number;
        reminders_payments?: number;
      },
    ) {
      return db
        .prepare(
          `INSERT INTO profiles (user_id, base_currency, income_currency, living_currency, timezone,
            income_minor, living_cap_minor, weekly_budget_minor, bonus_prepay_share, bonus_dca_share, onboarded_at,
            reminders_weekly, reminders_payments)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), COALESCE(?, 1))
           ON CONFLICT(user_id) DO UPDATE SET base_currency=excluded.base_currency,
             income_currency=excluded.income_currency, living_currency=excluded.living_currency,
             timezone=excluded.timezone, income_minor=excluded.income_minor,
             living_cap_minor=excluded.living_cap_minor, weekly_budget_minor=excluded.weekly_budget_minor,
             bonus_prepay_share=excluded.bonus_prepay_share, bonus_dca_share=excluded.bonus_dca_share,
             onboarded_at=excluded.onboarded_at, updated_at=datetime('now')`,
        )
        .bind(
          userId,
          p.base_currency,
          p.income_currency,
          p.living_currency,
          p.timezone,
          await en('profiles', 'income_minor', p.income_minor),
          await en('profiles', 'living_cap_minor', p.living_cap_minor),
          await en('profiles', 'weekly_budget_minor', p.weekly_budget_minor),
          p.bonus_prepay_share,
          p.bonus_dca_share,
          p.onboarded_at,
          p.reminders_weekly ?? null,
          p.reminders_payments ?? null,
        )
        .run();
    },

    // ── обязательные платежи ──
    listCommitments(activeOnly = true) {
      return db
        .prepare(`SELECT * FROM commitments WHERE user_id = ?${activeOnly ? ' AND active = 1' : ''} ORDER BY id`)
        .bind(userId)
        .all<CommitmentRow>().then((r) => decRows('commitments', r));
    },
    /** Один платёж — строго свой (WHERE id AND user_id). */
    getCommitment(id: number) {
      return db
        .prepare('SELECT * FROM commitments WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .first<CommitmentRow>().then((r) => decRow('commitments', r));
    },
    async addCommitment(c: { name: string; amount_minor: number; currency: string; due_day: number | null }) {
      return db
        .prepare('INSERT INTO commitments (user_id, name, amount_minor, currency, due_day) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, await en('commitments', 'name', c.name), await en('commitments', 'amount_minor', c.amount_minor), c.currency, c.due_day)
        .run();
    },
    /** Точечные правки — все WHERE id=? AND user_id=? (чужие id молча игнорируются). */
    async patchCommitment(
      id: number,
      patch: { amount_minor?: number; currency?: string; due_day?: number | null; active?: number; name?: string },
    ) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      if (patch.name !== undefined) {
        sets.push('name = ?');
        binds.push(await en('commitments', 'name', patch.name));
      }
      if (patch.amount_minor !== undefined) {
        sets.push('amount_minor = ?');
        binds.push(await en('commitments', 'amount_minor', patch.amount_minor));
      }
      if (patch.currency !== undefined) {
        sets.push('currency = ?');
        binds.push(patch.currency);
      }
      if (patch.due_day !== undefined) {
        sets.push('due_day = ?');
        binds.push(patch.due_day);
      }
      if (patch.active !== undefined) {
        sets.push('active = ?');
        binds.push(patch.active);
      }
      binds.push(id, userId);
      return db
        .prepare(`UPDATE commitments SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
        .bind(...binds)
        .run();
    },
    /** Удаление платежа вместе с журналом оплат (batch = одна транзакция). */
    deleteCommitment(id: number) {
      return db.batch([
        db.prepare('DELETE FROM commitment_payments WHERE user_id = ? AND commitment_id = ?').bind(userId, id),
        db.prepare('DELETE FROM commitments WHERE id = ? AND user_id = ?').bind(id, userId),
      ]);
    },
    countCommitments() {
      return db
        .prepare('SELECT COUNT(*) AS n FROM commitments WHERE user_id = ? AND active = 1')
        .bind(userId)
        .first<{ n: number }>();
    },
    deactivateAllCommitments() {
      return db.prepare('UPDATE commitments SET active = 0 WHERE user_id = ?').bind(userId).run();
    },

    // ── журнал оплат регулярных платежей ──
    /** Оплаты одного платежа в порядке даты (paid_on, id). */
    listCommitmentPayments(commitmentId: number) {
      return db
        .prepare('SELECT * FROM commitment_payments WHERE user_id = ? AND commitment_id = ? ORDER BY paid_on, id')
        .bind(userId, commitmentId)
        .all<CommitmentPaymentRow>().then((r) => decRows('commitment_payments', r));
    },
    /** Все оплаты юзера с paid_on >= isoDate («оплачено в этом месяце» без N запросов). */
    listCommitmentPaymentsSince(isoDate: string) {
      return db
        .prepare('SELECT * FROM commitment_payments WHERE user_id = ? AND paid_on >= ? ORDER BY paid_on, id')
        .bind(userId, isoDate)
        .all<CommitmentPaymentRow>().then((r) => decRows('commitment_payments', r));
    },
    /** INSERT OR IGNORE — идемпотентность по (user_id, source_key);
     *  commitment_id пишется только если платёж принадлежит юзеру (EXISTS). */
    async addCommitmentPayment(e: {
      commitment_id: number;
      amount_minor: number;
      currency: string;
      paid_on: string;
      source: 'manual' | 'auto';
      source_key: string | null;
    }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO commitment_payments (user_id, commitment_id, amount_minor, currency, paid_on, source, source_key)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM commitments WHERE id = ? AND user_id = ?)`,
        )
        .bind(
          userId,
          e.commitment_id,
          await en('commitment_payments', 'amount_minor', e.amount_minor),
          e.currency,
          e.paid_on,
          e.source,
          e.source_key,
          e.commitment_id,
          userId,
        )
        .run();
    },
    findCommitmentPaymentByKey(sourceKey: string) {
      return db
        .prepare('SELECT * FROM commitment_payments WHERE user_id = ? AND source_key = ?')
        .bind(userId, sourceKey)
        .first<CommitmentPaymentRow>().then((r) => decRow('commitment_payments', r));
    },
    getCommitmentPayment(id: number) {
      return db
        .prepare('SELECT * FROM commitment_payments WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .first<CommitmentPaymentRow>().then((r) => decRow('commitment_payments', r));
    },
    /** Точечная правка оплаты — только своей записи (чужие id молча). */
    async updateCommitmentPayment(id: number, patch: { amount_minor?: number; paid_on?: string }) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['amount_minor', 'paid_on'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('commitment_payments', k, patch[k]));
        }
      if (!sets.length) return Promise.resolve({ success: true, meta: { changes: 0 } } as D1Result);
      binds.push(id, userId);
      return db
        .prepare(`UPDATE commitment_payments SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
        .bind(...binds)
        .run();
    },
    deleteCommitmentPayment(id: number) {
      return db.prepare('DELETE FROM commitment_payments WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },

    // ── факт дохода по месяцам ──
    async addIncomeEntry(e: {
      month: string;
      amount_minor: number;
      currency: string;
      note: string | null;
      source_key: string;
      received_on?: string | null;
    }) {
      return db
        .prepare(
          'INSERT OR IGNORE INTO income_entries (user_id, month, amount_minor, currency, note, source_key, received_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(userId, e.month, await en('income_entries', 'amount_minor', e.amount_minor), e.currency, await en('income_entries', 'note', e.note), e.source_key, e.received_on ?? null)
        .run();
    },
    listIncomeEntries(month: string) {
      return db
        .prepare('SELECT * FROM income_entries WHERE user_id = ? AND month = ? ORDER BY id')
        .bind(userId, month)
        .all<IncomeEntryRow>().then((r) => decRows('income_entries', r));
    },
    getIncomeEntry(id: number) {
      return db
        .prepare('SELECT * FROM income_entries WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .first<IncomeEntryRow>().then((r) => decRow('income_entries', r));
    },
    /** Правка записи дохода — только своей (чужие id молча). month — derived от received_on. */
    async patchIncomeEntry(id: number, patch: { received_on?: string; month?: string; note?: string | null }) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['received_on', 'month', 'note'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('income_entries', k, patch[k]));
        }
      if (!sets.length) return db.prepare('SELECT 1').run();
      return db
        .prepare(`UPDATE income_entries SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
        .bind(...binds, id, userId)
        .run();
    },
    deleteIncomeEntry(id: number) {
      return db.prepare('DELETE FROM income_entries WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },

    // ── категории расходов (миграция 0014) ──
    /** Все категории юзера: сначала активные по sort, потом архивные. */
    listCategories(includeArchived = false) {
      return db
        .prepare(`SELECT * FROM categories WHERE user_id = ?${includeArchived ? '' : ' AND archived = 0'} ORDER BY archived, sort, id`)
        .bind(userId)
        .all<CategoryRow>()
        .then((r) => decRows('categories', r));
    },
    getCategory(id: number) {
      return db
        .prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .first<CategoryRow>()
        .then((r) => decRow('categories', r));
    },
    /** Пресеты: если у юзера нет ни одной категории — засеваем все (идемпотентно). */
    async ensureCategories() {
      const n = await db
        .prepare('SELECT COUNT(*) AS n FROM categories WHERE user_id = ?')
        .bind(userId)
        .first<{ n: number }>();
      if (n && n.n > 0) return;
      const { PRESETS } = await import('../domain/categories');
      const stmts = [];
      for (let i = 0; i < PRESETS.length; i++) {
        stmts[i] = db
          .prepare('INSERT OR IGNORE INTO categories (user_id, name, emoji, preset_key, sort) VALUES (?, ?, ?, ?, ?)')
          .bind(
            userId,
            (await encStr(userId, 'categories', 'name', PRESETS[i]!.name))!,
            (await encStr(userId, 'categories', 'emoji', PRESETS[i]!.emoji))!,
            PRESETS[i]!.key,
            i,
          );
      }
      await db.batch(stmts);
    },
    async addCategory(c: { name: string; emoji: string; sort: number }) {
      return db
        .prepare('INSERT INTO categories (user_id, name, emoji, sort) VALUES (?, ?, ?, ?)')
        .bind(userId, await en('categories', 'name', c.name), await en('categories', 'emoji', c.emoji), c.sort)
        .run();
    },
    countCategories() {
      return db
        .prepare('SELECT COUNT(*) AS n FROM categories WHERE user_id = ? AND archived = 0')
        .bind(userId)
        .first<{ n: number }>();
    },
    async patchCategory(id: number, patch: { name?: string; emoji?: string; archived?: number; sort?: number }) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['name', 'emoji', 'archived', 'sort'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('categories', k, patch[k]));
        }
      if (!sets.length) return db.prepare('SELECT 1').run();
      return db
        .prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
        .bind(...binds, id, userId)
        .run();
    },
    /** Удаление: сначала обнуляем ссылки у трат, потом строку (batch). */
    deleteCategory(id: number) {
      return db.batch([
        db.prepare('UPDATE weekly_expenses SET category_id = NULL WHERE user_id = ? AND category_id = ?').bind(userId, id),
        db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?').bind(id, userId),
      ]);
    },

    // ── range-чтения для отчётов (даты plaintext, BETWEEN) ──
    listExpensesBetween(from: string, to: string) {
      return db
        .prepare('SELECT * FROM weekly_expenses WHERE user_id = ? AND spent_on BETWEEN ? AND ? ORDER BY spent_on, id')
        .bind(userId, from, to)
        .all<ExpenseRow>()
        .then((r) => decRows('weekly_expenses', r));
    },
    listCommitmentPaymentsBetween(from: string, to: string) {
      return db
        .prepare('SELECT * FROM commitment_payments WHERE user_id = ? AND paid_on BETWEEN ? AND ? ORDER BY paid_on, id')
        .bind(userId, from, to)
        .all<CommitmentPaymentRow>()
        .then((r) => decRows('commitment_payments', r));
    },
    /** События долгов: только платежи/ЧДП (reconcile в отчёт не идёт). */
    listDebtEventsBetween(from: string, to: string) {
      return db
        .prepare(
          "SELECT * FROM debt_events WHERE user_id = ? AND event_on BETWEEN ? AND ? AND kind IN ('payment','prepay') ORDER BY event_on, id",
        )
        .bind(userId, from, to)
        .all<DebtEventRow>()
        .then((r) => decRows('debt_events', r));
    },
    listLoanEventsBetween(from: string, to: string) {
      return db
        .prepare('SELECT * FROM loan_events WHERE user_id = ? AND event_on BETWEEN ? AND ? ORDER BY event_on, id')
        .bind(userId, from, to)
        .all<LoanEventRow>()
        .then((r) => decRows('loan_events', r));
    },
    /** Доходы по фактической дате (received_on, fallback — 1-е число месяца). */
    listIncomeBetween(from: string, to: string) {
      return db
        .prepare(
          "SELECT * FROM income_entries WHERE user_id = ? AND COALESCE(received_on, month || '-01') BETWEEN ? AND ? ORDER BY id",
        )
        .bind(userId, from, to)
        .all<IncomeEntryRow>()
        .then((r) => decRows('income_entries', r));
    },

    // ── reminder_log: идемпотентность отправки и рейт-лимит /export ──
    claimReminder(kind: string, key: string) {
      return db
        .prepare('INSERT OR IGNORE INTO reminder_log (user_id, kind, key) VALUES (?, ?, ?)')
        .bind(userId, kind, key)
        .run();
    },
    releaseReminder(kind: string, key: string) {
      return db
        .prepare('DELETE FROM reminder_log WHERE user_id = ? AND kind = ? AND key = ?')
        .bind(userId, kind, key)
        .run();
    },
    /** /export — только собственные строки пользователя, без секретов/хэшей. */
    async exportUserData() {
      const [profile, commitments, commitPays, expenses, income, debts, debtEvents, loans, loanEvents, exchanges, categories] =
        await Promise.all([
          this.getProfile(),
          this.listCommitments(false),
          db.prepare('SELECT * FROM commitment_payments WHERE user_id = ? ORDER BY id').bind(userId).all<CommitmentPaymentRow>().then((r) => decRows('commitment_payments', r)),
          this.listExpenses(),
          db.prepare('SELECT * FROM income_entries WHERE user_id = ? ORDER BY id').bind(userId).all<IncomeEntryRow>().then((r) => decRows('income_entries', r)),
          this.listDebts(false),
          db.prepare('SELECT * FROM debt_events WHERE user_id = ? ORDER BY id').bind(userId).all<DebtEventRow>().then((r) => decRows('debt_events', r)),
          this.listLoans(),
          db.prepare('SELECT * FROM loan_events WHERE user_id = ? ORDER BY id').bind(userId).all<LoanEventRow>().then((r) => decRows('loan_events', r)),
          this.listExchanges(),
          this.listCategories(true),
        ]);
      const strip = <T extends Record<string, unknown>>(r: T) => {
        const { source_key, ...rest } = r; // update_id-идемпотентность не экспортируем
        void source_key;
        return rest;
      };
      return {
        schema_version: 5,
        exported_at: new Date().toISOString(),
        profile: profile ? strip(profile as unknown as Record<string, unknown>) : null,
        commitments: commitments.results.map((c) => strip(c as unknown as Record<string, unknown>)),
        commitment_payments: commitPays.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        weekly_expenses: expenses.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        income_entries: income.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        debts: debts.results.map((d) => strip(d as unknown as Record<string, unknown>)),
        debt_events: debtEvents.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        loans: loans.results.map((l) => strip(l as unknown as Record<string, unknown>)),
        loan_events: loanEvents.results.map((e) => strip(e as unknown as Record<string, unknown>)),
        exchanges: exchanges.results.map((x) => strip(x as unknown as Record<string, unknown>)),
        categories: categories.results.map((x) => strip(x as unknown as Record<string, unknown>)),
      };
    },
    /** /delete_me — все строки пользователя во всех таблицах с user_id (children first). */
    deleteAllUserData() {
      const tables = [
        'conversation_state',
        'income_entries',
        'weekly_expenses',
        'categories',
        'loan_events',
        'loans',
        'exchanges',
        'debt_events',
        'debts',
        'commitment_payments',
        'commitments',
        'profiles',
        'consents',
        'reminder_log',
        'audit_log',
      ];
      const stmts = tables.map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId));
      stmts.push(db.prepare('DELETE FROM users WHERE id = ?').bind(userId));
      return db.batch(stmts);
    },

    /** Точечная правка профиля — whitelist полей, всегда WHERE user_id. */
    async patchProfile(patch: {
      income_minor?: number;
      living_cap_minor?: number;
      weekly_budget_minor?: number;
      income_currency?: string;
      living_currency?: string;
      expense_currency?: string | null;
      timezone?: string;
      reminders_weekly?: number;
      reminders_payments?: number;
      vision_enabled?: number;
      fx_alerts_enabled?: number;
    }) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      const FIELDS = [
        'income_minor',
        'living_cap_minor',
        'weekly_budget_minor',
        'income_currency',
        'living_currency',
        'expense_currency',
        'timezone',
        'reminders_weekly',
        'reminders_payments',
        'vision_enabled',
        'fx_alerts_enabled',
      ] as const;
      for (const f of FIELDS) {
        if (patch[f] !== undefined) {
          sets.push(`${f} = ?`);
          binds.push(await en('profiles', f, patch[f]));
        }
      }
      binds.push(userId);
      return db
        .prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = ?`)
        .bind(...binds)
        .run();
    },

    // ── траты ──
    async addExpense(e: {
      spent_on: string;
      amount_minor: number;
      currency: string;
      note: string | null;
      source: string;
      source_key: string;
      category_id?: number | null;
    }) {
      // category_id пишется только если категория принадлежит юзеру (CASE+EXISTS).
      return db
        .prepare(
          `INSERT OR IGNORE INTO weekly_expenses (user_id, spent_on, amount_minor, currency, note, source, source_key, category_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL
             WHEN EXISTS(SELECT 1 FROM categories WHERE id=? AND user_id=?) THEN ? END)`,
        )
        .bind(userId, e.spent_on, await en('weekly_expenses', 'amount_minor', e.amount_minor), e.currency, await en('weekly_expenses', 'note', e.note), e.source, e.source_key, e.category_id ?? null, e.category_id ?? null, userId, e.category_id ?? null)
        .run();
    },
    findExpenseByKey(sourceKey: string) {
      return db.prepare('SELECT * FROM weekly_expenses WHERE user_id = ? AND source_key = ?').bind(userId, sourceKey).first<ExpenseRow>().then((r) => decRow('weekly_expenses', r));
    },
    findIncomeByKey(sourceKey: string) {
      return db.prepare('SELECT * FROM income_entries WHERE user_id = ? AND source_key = ?').bind(userId, sourceKey).first<IncomeEntryRow>().then((r) => decRow('income_entries', r));
    },
    getExpense(id: number) {
      return db
        .prepare('SELECT * FROM weekly_expenses WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .first<ExpenseRow>().then((r) => decRow('weekly_expenses', r));
    },
    /** Правка траты — только своей записи. */
    async patchExpense(id: number, patch: { amount_minor?: number; currency?: string; note?: string | null; category_id?: number | null; spent_on?: string }) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['amount_minor', 'currency', 'note', 'spent_on'] as const)
        if (k in patch) {
          sets.push(`${k} = ?`);
          binds.push(await en('weekly_expenses', k, patch[k]));
        }
      if (patch.category_id !== undefined) {
        // чужая категория не записывается никогда: ELSE — оставить как было
        sets.push(
          'category_id = CASE WHEN ? IS NULL THEN NULL WHEN EXISTS(SELECT 1 FROM categories WHERE id=? AND user_id=?) THEN ? ELSE category_id END',
        );
        binds.push(patch.category_id, patch.category_id, userId, patch.category_id);
      }
      if (!sets.length) return db.prepare('SELECT 1').run();
      return db
        .prepare(`UPDATE weekly_expenses SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
        .bind(...binds, id, userId)
        .run();
    },
    deleteExpense(id: number) {
      return db.prepare('DELETE FROM weekly_expenses WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },
    listExpenses(sinceIsoDate?: string) {
      return db
        .prepare(
          `SELECT * FROM weekly_expenses WHERE user_id = ?${sinceIsoDate ? ' AND spent_on >= ?' : ''} ORDER BY spent_on, id`,
        )
        .bind(...(sinceIsoDate ? [userId, sinceIsoDate] : [userId]))
        .all<ExpenseRow>().then((r) => decRows('weekly_expenses', r));
    },

    // ── журнал обменов валют (шаг 8) ──
    /** Последние обмены (свежие первыми), верхняя граница — limit. */
    listExchanges(limit = 50) {
      return db
        .prepare('SELECT * FROM exchanges WHERE user_id = ? ORDER BY spent_on DESC, id DESC LIMIT ?')
        .bind(userId, limit)
        .all<ExchangeRow>().then((r) => decRows('exchanges', r));
    },
    getExchange(id: number) {
      return db.prepare('SELECT * FROM exchanges WHERE id = ? AND user_id = ?').bind(id, userId).first<ExchangeRow>().then((r) => decRow('exchanges', r));
    },
    /**
     * Запись обмена. rate считается здесь (to/from), INSERT OR IGNORE —
     * идемпотентность по partial UNIQUE (user_id, source_key); NULL-ключи
     * ручных повторных записей не конфликтуют (как debts/loans).
     */
    async addExchange(e: {
      from_ccy: string;
      to_ccy: string;
      amount_from_minor: number;
      amount_to_minor: number;
      market_rate: number | null;
      spent_on: string;
      note: string;
      source: string;
      source_key: string | null;
    }) {
      const rate = e.amount_to_minor / e.amount_from_minor;
      return db
        .prepare(
          `INSERT OR IGNORE INTO exchanges
            (user_id, from_ccy, to_ccy, amount_from_minor, amount_to_minor, rate, market_rate, spent_on, note, source, source_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          e.from_ccy,
          e.to_ccy,
          await en('exchanges', 'amount_from_minor', e.amount_from_minor),
          await en('exchanges', 'amount_to_minor', e.amount_to_minor),
          await en('exchanges', 'rate', rate),
          e.market_rate,
          e.spent_on,
          await en('exchanges', 'note', e.note),
          e.source,
          e.source_key,
        )
        .run();
    },
    findExchangeByKey(sourceKey: string) {
      return db
        .prepare('SELECT * FROM exchanges WHERE user_id = ? AND source_key = ?')
        .bind(userId, sourceKey)
        .first<ExchangeRow>().then((r) => decRow('exchanges', r));
    },
    /**
     * Правка обмена — только своей записи (чужие id молча).
     * При смене любой суммы вызывающий ОБЯЗАН передать пересчитанный rate
     * (to/from по новым значениям) — инвариант держится на границе repo.
     */
    async patchExchange(
      id: number,
      patch: {
        amount_from_minor?: number;
        amount_to_minor?: number;
        rate?: number;
        spent_on?: string;
        note?: string;
        market_rate?: number | null;
      },
    ) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      for (const k of ['amount_from_minor', 'amount_to_minor', 'rate', 'spent_on', 'note', 'market_rate'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('exchanges', k, patch[k]));
        }
      binds.push(id, userId);
      return db.prepare(`UPDATE exchanges SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    deleteExchange(id: number) {
      return db.prepare('DELETE FROM exchanges WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },

    // ── долги (кредиты/ипотеки, шаг 6) ──
    listDebts(activeOnly = true) {
      return db
        .prepare(`SELECT * FROM debts WHERE user_id = ?${activeOnly ? ' AND active = 1' : ''} ORDER BY id`)
        .bind(userId)
        .all<DebtRow>().then((r) => decRows('debts', r));
    },
    /** Один долг — строго свой (WHERE id AND user_id). */
    getDebt(id: number) {
      return db.prepare('SELECT * FROM debts WHERE id = ? AND user_id = ?').bind(id, userId).first<DebtRow>().then((r) => decRow('debts', r));
    },
    /**
     * Создание долга. source_key ('tma:<client_id>') — только REST Mini App;
     * partial UNIQUE(user_id, source_key) молча игнорирует NULL-ключи бота.
     * INSERT OR IGNORE: при гонке повторный запрос даёт changes=0 —
     * вызывающий достаёт существующую строку через findDebtByKey.
     */
    async addDebt(d: {
      name: string;
      currency: string;
      rate: number;
      frequency: 'monthly' | 'biweekly';
      initial_balance_minor: number;
      initial_payment_minor: number;
      epoch: string;
      due_day: number | null;
      source_key?: string | null;
    }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO debts (user_id, name, currency, rate, frequency,
            initial_balance_minor, initial_payment_minor, epoch, due_day, source_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          await en('debts', 'name', d.name),
          d.currency,
          await en('debts', 'rate', d.rate),
          d.frequency,
          await en('debts', 'initial_balance_minor', d.initial_balance_minor),
          await en('debts', 'initial_payment_minor', d.initial_payment_minor),
          d.epoch,
          d.due_day,
          d.source_key ?? null,
        )
        .run();
    },
    findDebtByKey(sourceKey: string) {
      return db.prepare('SELECT * FROM debts WHERE user_id = ? AND source_key = ?').bind(userId, sourceKey).first<DebtRow>().then((r) => decRow('debts', r));
    },
    /** Активные долги — верхняя граница лимита (P2-2). */
    async countDebts(): Promise<number> {
      const r = await db
        .prepare('SELECT COUNT(*) AS n FROM debts WHERE user_id = ? AND active = 1')
        .bind(userId)
        .first<{ n: number }>();
      return r?.n ?? 0;
    },
    /** Точечные правки — все WHERE id=? AND user_id=? (чужие id молча игнорируются). */
    async patchDebt(
      id: number,
      patch: {
        name?: string;
        rate?: number;
        initial_payment_minor?: number;
        due_day?: number | null;
        active?: number;
      },
    ) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      for (const k of ['name', 'rate', 'initial_payment_minor', 'due_day', 'active'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('debts', k, patch[k]));
        }
      binds.push(id, userId);
      return db.prepare(`UPDATE debts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    /** Удаление долга вместе с его журналом (batch = одна транзакция). */
    deleteDebt(id: number) {
      return db.batch([
        db.prepare('DELETE FROM debt_events WHERE user_id = ? AND debt_id = ?').bind(userId, id),
        db.prepare('DELETE FROM debts WHERE id = ? AND user_id = ?').bind(id, userId),
      ]);
    },
    /** Журнал долга в порядке replay (дата, затем порядок записи). */
    listDebtEvents(debtId: number) {
      return db
        .prepare('SELECT * FROM debt_events WHERE user_id = ? AND debt_id = ? ORDER BY event_on, id')
        .bind(userId, debtId)
        .all<DebtEventRow>().then((r) => decRows('debt_events', r));
    },
    /** Все журналы разом — для plural-вью без N+1 (P2-2). Порядок: по долгу, дальше replay. */
    listDebtEventsAll() {
      return db
        .prepare('SELECT * FROM debt_events WHERE user_id = ? ORDER BY debt_id, event_on, id')
        .bind(userId)
        .all<DebtEventRow>().then((r) => decRows('debt_events', r));
    },
    /** INSERT OR IGNORE — идемпотентность по (user_id, source_key);
     *  debt_id пишется только если долг принадлежит юзеру (EXISTS). */
    async addDebtEvent(e: {
      debt_id: number;
      kind: 'payment' | 'prepay' | 'reconcile';
      amount_minor: number;
      event_on: string;
      mode?: 'reduce_payment' | 'reduce_term' | null;
      source: 'manual' | 'auto';
      source_key: string;
    }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO debt_events (user_id, debt_id, kind, amount_minor, event_on, mode, source, source_key)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM debts WHERE id = ? AND user_id = ?)`,
        )
        .bind(
          userId,
          e.debt_id,
          e.kind,
          await en('debt_events', 'amount_minor', e.amount_minor),
          e.event_on,
          e.mode ?? null,
          e.source,
          e.source_key,
          e.debt_id,
          userId,
        )
        .run();
    },
    findDebtEventByKey(sourceKey: string) {
      return db
        .prepare('SELECT * FROM debt_events WHERE user_id = ? AND source_key = ?')
        .bind(userId, sourceKey)
        .first<DebtEventRow>().then((r) => decRow('debt_events', r));
    },
    getDebtEvent(id: number) {
      return db.prepare('SELECT * FROM debt_events WHERE id = ? AND user_id = ?').bind(id, userId).first<DebtEventRow>().then((r) => decRow('debt_events', r));
    },
    /** Точечная правка события — реplay пересчитает состояние. Чужие id молча. */
    async updateDebtEvent(
      id: number,
      patch: { amount_minor?: number; event_on?: string; mode?: 'reduce_payment' | 'reduce_term' | null },
    ) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['amount_minor', 'event_on', 'mode'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('debt_events', k, patch[k]));
        }
      if (!sets.length) return Promise.resolve({ success: true, meta: { changes: 0 } } as D1Result);
      binds.push(id, userId);
      return db.prepare(`UPDATE debt_events SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    deleteDebtEvent(id: number) {
      return db.prepare('DELETE FROM debt_events WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },

    // ── личные займы («Долги людям») ──
    /** Все займы: сначала открытые, внутри — по id. */
    listLoans() {
      return db
        .prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY closed_at IS NOT NULL, id')
        .bind(userId)
        .all<LoanRow>().then((r) => decRows('loans', r));
    },
    getLoan(id: number) {
      return db.prepare('SELECT * FROM loans WHERE id = ? AND user_id = ?').bind(id, userId).first<LoanRow>().then((r) => decRow('loans', r));
    },
    /**
     * Создание займа. source_key ('tma:<client_id>') — только REST Mini App
     * (см. addDebt): OR IGNORE + partial UNIQUE игнорирует NULL-ключи бота.
     */
    async addLoan(l: {
      counterparty: string;
      direction: 'owe' | 'owed';
      amount_minor: number;
      currency: string;
      due_on: string | null;
      note: string | null;
      source_key?: string | null;
    }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO loans (user_id, counterparty, direction, amount_minor, currency, due_on, note, source_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, await en('loans', 'counterparty', l.counterparty), l.direction, await en('loans', 'amount_minor', l.amount_minor), l.currency, l.due_on, await en('loans', 'note', l.note), l.source_key ?? null)
        .run();
    },
    findLoanByKey(sourceKey: string) {
      return db.prepare('SELECT * FROM loans WHERE user_id = ? AND source_key = ?').bind(userId, sourceKey).first<LoanRow>().then((r) => decRow('loans', r));
    },
    /** Открытые займы (closed_at IS NULL) — верхняя граница лимита (P2-2). */
    async countLoans(): Promise<number> {
      const r = await db
        .prepare('SELECT COUNT(*) AS n FROM loans WHERE user_id = ? AND closed_at IS NULL')
        .bind(userId)
        .first<{ n: number }>();
      return r?.n ?? 0;
    },
    /** Точечная правка займа — все WHERE id=? AND user_id=? (чужие id молча). */
    async patchLoan(id: number, patch: { due_on?: string | null; note?: string | null }) {
      const sets: string[] = ["updated_at = datetime('now')"];
      const binds: (number | string | null)[] = [];
      for (const k of ['due_on', 'note'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('loans', k, patch[k]));
        }
      binds.push(id, userId);
      return db.prepare(`UPDATE loans SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    /** Закрыть вручную (остаток прощается). Уже закрытый — no-op (changes=0). */
    closeLoan(id: number) {
      return db
        .prepare(`UPDATE loans SET closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ? AND closed_at IS NULL`)
        .bind(id, userId)
        .run();
    },
    /** Удаление займа с журналом (batch = одна транзакция). */
    deleteLoan(id: number) {
      return db.batch([
        db.prepare('DELETE FROM loan_events WHERE user_id = ? AND loan_id = ?').bind(userId, id),
        db.prepare('DELETE FROM loans WHERE id = ? AND user_id = ?').bind(id, userId),
      ]);
    },
    listLoanEvents(loanId: number) {
      return db
        .prepare('SELECT * FROM loan_events WHERE user_id = ? AND loan_id = ? ORDER BY event_on, id')
        .bind(userId, loanId)
        .all<LoanEventRow>().then((r) => decRows('loan_events', r));
    },
    /** Все журналы возвратов разом — для plural-вью без N+1 (P2-2). */
    listLoanEventsAll() {
      return db
        .prepare('SELECT * FROM loan_events WHERE user_id = ? ORDER BY loan_id, event_on, id')
        .bind(userId)
        .all<LoanEventRow>().then((r) => decRows('loan_events', r));
    },
    /** loan_id пишется только если заём принадлежит юзеру (EXISTS в INSERT). */
    async addLoanEvent(e: {
      loan_id: number;
      amount_minor: number;
      event_on: string;
      source: 'manual' | 'auto';
      source_key: string | null;
    }) {
      return db
        .prepare(
          `INSERT OR IGNORE INTO loan_events (user_id, loan_id, kind, amount_minor, event_on, source, source_key)
           SELECT ?, ?, 'repay', ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM loans WHERE id = ? AND user_id = ?)`,
        )
        .bind(userId, e.loan_id, await en('loan_events', 'amount_minor', e.amount_minor), e.event_on, e.source, e.source_key, e.loan_id, userId)
        .run();
    },
    getLoanEvent(id: number) {
      return db.prepare('SELECT * FROM loan_events WHERE id = ? AND user_id = ?').bind(id, userId).first<LoanEventRow>().then((r) => decRow('loan_events', r));
    },
    findLoanEventByKey(sourceKey: string) {
      return db
        .prepare('SELECT * FROM loan_events WHERE user_id = ? AND source_key = ?')
        .bind(userId, sourceKey)
        .first<LoanEventRow>().then((r) => decRow('loan_events', r));
    },
    /** Правка возврата — replay пересчитает остаток. Чужие id молча. */
    async updateLoanEvent(id: number, patch: { amount_minor?: number; event_on?: string }) {
      const sets: string[] = [];
      const binds: (number | string | null)[] = [];
      for (const k of ['amount_minor', 'event_on'] as const)
        if (patch[k] !== undefined) {
          sets.push(`${k} = ?`);
          binds.push(await en('loan_events', k, patch[k]));
        }
      if (!sets.length) return Promise.resolve({ success: true, meta: { changes: 0 } } as D1Result);
      binds.push(id, userId);
      return db.prepare(`UPDATE loan_events SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
    },
    deleteLoanEvent(id: number) {
      return db.prepare('DELETE FROM loan_events WHERE id = ? AND user_id = ?').bind(id, userId).run();
    },

    // ── состояние диалога ──
    getConversation() {
      return db
        .prepare('SELECT step, data, updated_at FROM conversation_state WHERE user_id = ?')
        .bind(userId)
        .first<{ step: string; data: string; updated_at: string }>()
        .then(async (r) => {
          if (r?.data) r.data = (await decStr(userId, 'conversation_state', 'data', r.data))!;
          return r;
        });
    },
    async setConversation(step: string, data: string) {
      return db
        .prepare(
          `INSERT INTO conversation_state (user_id, step, data) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET step=excluded.step, data=excluded.data, updated_at=datetime('now')`,
        )
        .bind(userId, step, await en('conversation_state', 'data', data))
        .run();
    },
    /**
     * CAS-запись: обновляет только если текущий step === expected.
     * meta.changes === 0 → состояние изменил другой апдейт → проигравший молчит.
     */
    async setConversationExpected(step: string, data: string, expected: string) {
      return db
        .prepare(
          `UPDATE conversation_state SET step = ?, data = ?, updated_at = datetime('now')
           WHERE user_id = ? AND step = ?`,
        )
        .bind(step, await en('conversation_state', 'data', data), userId, expected)
        .run();
    },
    clearConversation() {
      return db.prepare('DELETE FROM conversation_state WHERE user_id = ?').bind(userId).run();
    },
    /** CAS-очистка: удаляет только если step === expected. */
    clearConversationExpected(expected: string) {
      return db.prepare('DELETE FROM conversation_state WHERE user_id = ? AND step = ?').bind(userId, expected).run();
    },
  };
}

// ── глобальные, не user-data: курсы валют ──
export interface FxRateRow {
  currency: string;
  per_usd: number;
  as_of: string;
  fetched_at: string;
}

export function fxRepo(db: Env['DB']) {
  return {
    get(currency: string) {
      return db.prepare('SELECT * FROM fx_rates WHERE currency = ?').bind(currency).first<FxRateRow>();
    },
    list() {
      return db.prepare('SELECT * FROM fx_rates ORDER BY currency').all<FxRateRow>();
    },
    upsert(currency: string, perUsd: number, asOf: string, fetchedAt: string) {
      return db
        .prepare(
          `INSERT INTO fx_rates (currency, per_usd, as_of, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(currency) DO UPDATE SET per_usd=excluded.per_usd, as_of=excluded.as_of, fetched_at=excluded.fetched_at`,
        )
        .bind(currency, perUsd, asOf, fetchedAt)
        .run();
    },
  };
}

export type ScopedRepo = ReturnType<typeof scoped>;

// ── access-контур: users / invites / processed_updates / audit_log ──

export interface UserRow {
  id: number;
  telegram_id: number;
  display_name: string | null;
  role: 'owner' | 'member';
  created_at: string;
  deleted_at: string | null;
}

export type AuditAction =
  'owner_bootstrap' | 'invite_created' | 'invite_redeemed' | 'invite_redeem_failed' | 'id_reply';

/** Глобальные таблицы доступа — user-data здесь нет (S5 применяется к scoped). */
export function accessRepo(db: Env['DB']) {
  return {
    /** user_id онбоарденных с включёнными напоминаниями — только для cron-сервиса. */
    async listReminderCandidates(): Promise<number[]> {
      const r = await db
        .prepare(
          'SELECT user_id FROM profiles WHERE onboarded_at IS NOT NULL AND (reminders_weekly = 1 OR reminders_payments = 1 OR fx_alerts_enabled = 1)',
        )
        .all<{ user_id: number }>();
      return r.results.map((x) => x.user_id);
    },
    /** Активный пользователь по Telegram ID; удалённые не возвращаются. */
    async findUserByTelegramId(tgId: number): Promise<UserRow | undefined> {
      const r = await db
        .prepare('SELECT * FROM users WHERE telegram_id = ? AND deleted_at IS NULL')
        .bind(tgId)
        .first<UserRow>();
      return r ?? undefined;
    },
    /** Telegram ID активного пользователя по user_id (cron-рассылка); null — удалён/нет. */
    async getTelegramId(userId: number): Promise<number | null> {
      const r = await db
        .prepare('SELECT telegram_id FROM users WHERE id = ? AND deleted_at IS NULL')
        .bind(userId)
        .first<{ telegram_id: number }>();
      return r?.telegram_id ?? null;
    },

    createUser(tgId: number, displayName: string | null, role: 'owner' | 'member') {
      return db
        .prepare('INSERT INTO users (telegram_id, display_name, role) VALUES (?, ?, ?)')
        .bind(tgId, displayName, role)
        .run();
    },

    /** Одноразовый инвайт: пишется ТОЛЬКО SHA-256 хэш кода. */
    async countActiveInvites(ownerId: number, nowIso: string): Promise<number> {
      const r = await db
        .prepare('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND used_at IS NULL AND expires_at > ?')
        .bind(ownerId, nowIso)
        .first<{ n: number }>();
      return r?.n ?? 0;
    },

    createInvite(codeHash: string, ownerId: number, expiresAtIso: string) {
      return db
        .prepare('INSERT INTO invites (code_hash, created_by, expires_at) VALUES (?, ?, ?)')
        .bind(codeHash, ownerId, expiresAtIso)
        .run();
    },

    /** Состояние инвайта для причины отказа (только лог, гейт — в redeemInvite). */
    async inviteState(codeHash: string): Promise<'unknown' | 'used' | 'expired' | 'active'> {
      const row = await db
        .prepare('SELECT used_at, expires_at FROM invites WHERE code_hash = ?')
        .bind(codeHash)
        .first<{ used_at: string | null; expires_at: string }>();
      if (!row) return 'unknown';
      if (row.used_at !== null) return 'used';
      return row.expires_at > new Date().toISOString() ? 'active' : 'expired';
    },

    /**
     * Атомарное погашение инвайта — один batch = одна транзакция D1:
     *   1. INSERT пользователя (нужен его id для used_by);
     *   2. условный UPDATE — единственный гейт: used_at IS NULL И не истёк;
     *      при гонке выигрывает ровно один sender (второй получит changes=0);
     *   3. условный DELETE «сироты»: удаляет созданного в шаге 1 пользователя,
     *      если шаг 2 не привязал к нему инвайт (used_by != новому id).
     * Итог: один код никогда не даст двух пользователей, а при отказе
     * (used/expired/unknown) не остаётся полу-созданного пользователя —
     * всё внутри одной атомарной пачки.
     */
    async redeemInvite(codeHash: string, tgId: number, displayName: string | null, nowIso: string) {
      const ins = db
        .prepare("INSERT INTO users (telegram_id, display_name, role) VALUES (?, ?, 'member')")
        .bind(tgId, displayName);
      // user_id вставленной строки доступен через last_insert_rowid()
      const upd = db
        .prepare(
          'UPDATE invites SET used_by = last_insert_rowid(), used_at = ? ' +
            'WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
        )
        .bind(nowIso, codeHash, nowIso);
      const del = db
        .prepare(
          'DELETE FROM users WHERE id = last_insert_rowid() ' +
            'AND NOT EXISTS (SELECT 1 FROM invites WHERE used_by = last_insert_rowid())',
        )
        .bind();
      const [i, u] = await db.batch([ins, upd, del]);
      if (!i || !u) throw new Error('redeemInvite: пустой результат batch');
      return { redeemed: u.meta.changes === 1, userId: Number(i.meta.last_row_id) };
    },

    /** Идемпотентность webhook: true → update новый, false → дубликат. */
    async markUpdateProcessed(updateId: number): Promise<boolean> {
      const r = await db.prepare('INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)').bind(updateId).run();
      return r.meta.changes === 1;
    },

    /**
     * P2-5 хозяйственная чистка (cron, каждый тик — пустой DELETE дёшев):
     * processed_updates старше 7 дней — окно ретраев Telegram давно прошло.
     */
    cleanupProcessedUpdates() {
      return db.prepare("DELETE FROM processed_updates WHERE created_at < datetime('now','-7 days')").run();
    },
    /**
     * reminder_log старше 400 дней, кроме 'kb_removed' — этот ключ
     * «раз и навсегда», его удаление сломало бы идемпотентность миграции.
     */
    cleanupReminderLog() {
      return db
        .prepare("DELETE FROM reminder_log WHERE sent_at < datetime('now','-400 days') AND kind != 'kb_removed'")
        .run();
    },

    /**
     * Лимит частоты POST /api/tma/auth: не более 20 попыток за 10 минут с одного
     * источника (ключ — SHA-256 hex от IP). При вставке чистим окна старше часа.
     * Возвращает кол-во попыток в текущем 10-мин окне.
     */
    async bumpAuthRateLimit(ipKey: string, nowIso: string): Promise<number> {
      const now = new Date(nowIso);
      await db
        .prepare('DELETE FROM rate_limit WHERE window_start < ?')
        .bind(new Date(now.getTime() - 3600_000).toISOString())
        .run();
      const winStart = new Date(Math.floor(now.getTime() / 600_000) * 600_000).toISOString();
      await db
        .prepare(
          `INSERT INTO rate_limit (bucket, count, window_start) VALUES (?, 1, ?)
           ON CONFLICT(bucket) DO UPDATE SET
             count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
             window_start = excluded.window_start`,
        )
        .bind(ipKey, winStart)
        .run();
      const row = await db.prepare('SELECT count FROM rate_limit WHERE bucket = ?').bind(ipKey).first<{ count: number }>();
      return row?.count ?? 0;
    },

    audit(action: AuditAction, userId: number | null, meta: Record<string, unknown> = {}) {
      return db
        .prepare('INSERT INTO audit_log (user_id, action, meta) VALUES (?, ?, ?)')
        .bind(userId, action, JSON.stringify(meta))
        .run();
    },

    /** /id уже отвечали этому telegram_id? (гейт «один раз» при unset owner). */
    async idReplySent(tgId: number): Promise<boolean> {
      const r = await db
        .prepare("SELECT 1 AS x FROM audit_log WHERE action = 'id_reply' AND json_extract(meta, '$.tg') = ? LIMIT 1")
        .bind(tgId)
        .first();
      return r != null;
    },
  };
}

export type AccessRepo = ReturnType<typeof accessRepo>;

/**
 * encryptBackfill — шифрует legacy-plaintext в таблицах из FIELDS (сырой SQL
 * разрешён только здесь). Идемпотентно: выбирает только не-enc1: колонки;
 * UPDATE с CAS (`col IS ?` по старым значениям) — конкурентная правка юзера
 * не затирается. Возвращает число зашифрованных строк.
 */
export async function encryptBackfill(db: Env['DB'], limitPerTable = 200): Promise<number> {
  let done = 0;
  for (const [table, cols] of Object.entries(FIELDS)) {
    const colNames = Object.keys(cols);
    const unenc = (c: string) => `(${c} IS NOT NULL AND (typeof(${c}) != 'text' OR ${c} NOT LIKE 'enc1:%'))`;
    const userKeyed = table === 'conversation_state' || table === 'profiles'; // PK = user_id, колонки id нет
    const keyCols = userKeyed ? 'user_id' : 'id, user_id';
    const rows = await db
      .prepare(`SELECT ${keyCols}, ${colNames.join(', ')} FROM ${table} WHERE ${colNames.map(unenc).join(' OR ')} LIMIT ?`)
      .bind(limitPerTable)
      .all<Record<string, unknown>>();
    for (const row of rows.results) {
      const uid = Number(row.user_id);
      const sets: string[] = [];
      const binds: (string | number | null)[] = [];
      const cas: string[] = [];
      const casBinds: (string | number | null)[] = [];
      for (const [col, kind] of Object.entries(cols)) {
        const v = row[col];
        if (v === null || v === undefined) continue;
        if (typeof v === 'string' && v.startsWith('enc1:')) continue;
        sets.push(`${col} = ?`);
        binds.push(kind === 'num' ? await encNum(uid, table, col, v as number) : await encStr(uid, table, col, v as string));
        cas.push(`${col} IS ?`);
        casBinds.push(v as string | number);
      }
      if (!sets.length) continue;
      const where = userKeyed ? 'WHERE user_id = ?' : 'WHERE id = ? AND user_id = ?';
      const keyBinds = userKeyed ? [uid] : [row.id, uid];
      const r = await db
        .prepare(`UPDATE ${table} SET ${sets.join(', ')} ${where} AND ${cas.join(' AND ')}`)
        .bind(...binds, ...(keyBinds as (string | number)[]), ...casBinds)
        .run();
      if (r.meta?.changes) done += r.meta.changes;
    }
  }
  return done;
}
