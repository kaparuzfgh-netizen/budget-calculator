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
  | 'owner_bootstrap'
  | 'invite_created'
  | 'invite_redeemed'
  | 'invite_redeem_failed'
  | 'id_reply';

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
      const r = await db
        .prepare('INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)')
        .bind(updateId)
        .run();
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
