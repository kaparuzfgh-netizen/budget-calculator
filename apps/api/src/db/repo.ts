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
  timezone: string;
  income_minor: number;
  living_cap_minor: number;
  weekly_budget_minor: number;
  bonus_prepay_share: number;
  bonus_dca_share: number;
  onboarded_at: string | null;
}

export interface CommitmentRow {
  id: number;
  user_id: number;
  name: string;
  amount_minor: number;
  currency: string;
  due_day: number | null;
  active: number;
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
}

/** Репозиторий, привязанный к конкретному пользователю. */
export function scoped(db: Env['DB'], userId: number) {
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
      return db.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(userId).first<ProfileRow>();
    },
    upsertProfile(p: Omit<ProfileRow, 'user_id'>) {
      return db
        .prepare(
          `INSERT INTO profiles (user_id, base_currency, income_currency, living_currency, timezone,
            income_minor, living_cap_minor, weekly_budget_minor, bonus_prepay_share, bonus_dca_share, onboarded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          p.income_minor,
          p.living_cap_minor,
          p.weekly_budget_minor,
          p.bonus_prepay_share,
          p.bonus_dca_share,
          p.onboarded_at,
        )
        .run();
    },

    // ── обязательные платежи ──
    listCommitments(activeOnly = true) {
      return db
        .prepare(`SELECT * FROM commitments WHERE user_id = ?${activeOnly ? ' AND active = 1' : ''} ORDER BY id`)
        .bind(userId)
        .all<CommitmentRow>();
    },
    addCommitment(c: { name: string; amount_minor: number; currency: string; due_day: number | null }) {
      return db
        .prepare('INSERT INTO commitments (user_id, name, amount_minor, currency, due_day) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, c.name, c.amount_minor, c.currency, c.due_day)
        .run();
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

    // ── траты ──
    addExpense(e: {
      spent_on: string;
      amount_minor: number;
      currency: string;
      note: string | null;
      source: string;
      source_key: string;
    }) {
      return db
        .prepare(
          'INSERT OR IGNORE INTO weekly_expenses (user_id, spent_on, amount_minor, currency, note, source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(userId, e.spent_on, e.amount_minor, e.currency, e.note, e.source, e.source_key)
        .run();
    },
    listExpenses(sinceIsoDate?: string) {
      return db
        .prepare(
          `SELECT * FROM weekly_expenses WHERE user_id = ?${sinceIsoDate ? ' AND spent_on >= ?' : ''} ORDER BY spent_on, id`,
        )
        .bind(...(sinceIsoDate ? [userId, sinceIsoDate] : [userId]))
        .all<ExpenseRow>();
    },

    // ── состояние диалога ──
    getConversation() {
      return db
        .prepare('SELECT step, data, updated_at FROM conversation_state WHERE user_id = ?')
        .bind(userId)
        .first<{ step: string; data: string; updated_at: string }>();
    },
    setConversation(step: string, data: string) {
      return db
        .prepare(
          `INSERT INTO conversation_state (user_id, step, data) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET step=excluded.step, data=excluded.data, updated_at=datetime('now')`,
        )
        .bind(userId, step, data)
        .run();
    },
    /**
     * CAS-запись: обновляет только если текущий step === expected.
     * meta.changes === 0 → состояние изменил другой апдейт → проигравший молчит.
     */
    setConversationExpected(step: string, data: string, expected: string) {
      return db
        .prepare(
          `UPDATE conversation_state SET step = ?, data = ?, updated_at = datetime('now')
           WHERE user_id = ? AND step = ?`,
        )
        .bind(step, data, userId, expected)
        .run();
    },
    clearConversation() {
      return db.prepare('DELETE FROM conversation_state WHERE user_id = ?').bind(userId).run();
    },
    /** CAS-очистка: удаляет только если step === expected. */
    clearConversationExpected(expected: string) {
      return db
        .prepare('DELETE FROM conversation_state WHERE user_id = ? AND step = ?')
        .bind(userId, expected)
        .run();
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
    /** Активный пользователь по Telegram ID; удалённые не возвращаются. */
    async findUserByTelegramId(tgId: number): Promise<UserRow | undefined> {
      const r = await db
        .prepare('SELECT * FROM users WHERE telegram_id = ? AND deleted_at IS NULL')
        .bind(tgId)
        .first<UserRow>();
      return r ?? undefined;
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
