/**
 * repo.ts — ЕДИНСТВЕННАЯ точка доступа к данным (ADR-0001, находка S5).
 *
 * Правило изоляции: все чтения/записи пользовательских данных идут через
 * `scoped(env.DB, userId)` — каждый метод обязан добавлять `WHERE user_id = ?`
 * (или эквивалент через связанную таблицу). Сырые `db.prepare(...)` вне этого
 * модуля — запрещены. Тест «A не видит B» — обязателен (test/repo.test.ts).
 *
 * Пользовательские данные — db/scoped/* (части scoped-репозитория по доменам,
 * композиция в scoped/index.ts); этот файл — фасад (реэкспорт) + access-контур.
 *
 * Таблицы access-контура (users, invites, processed_updates, audit_log) —
 * глобальные, но доступ к ним тоже только отсюда (функции accessRepo(db)).
 */
import type { Env } from '../env';
import { FIELDS, decRow, encNum, encStr } from './crypto';

export * from './scoped/types';
export { scoped } from './scoped';
import { scoped } from './scoped';

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

// ── глобальные, не user-data: кэш котировок (T3b) — без user_id ──
export interface PriceQuoteRow {
  source: string;
  asset_id: string;
  vs_currency: string;
  price: string;
  as_of: string;
  fetched_at: string;
}
export interface PriceStateRow {
  source: string;
  blocked_until: string | null;
  last_status: number | null;
  updated_at: string;
}

export function priceRepo(db: Env['DB']) {
  return {
    /** Один SELECT по набору монет и валют (PRIMARY KEY покрывает выборку). */
    async getMany(source: string, vs: string[], ids: string[]): Promise<PriceQuoteRow[]> {
      if (!ids.length || !vs.length) return [];
      const ph = (n: number) => Array(n).fill('?').join(',');
      const r = await db
        .prepare(
          `SELECT * FROM price_quotes WHERE source = ? AND vs_currency IN (${ph(vs.length)}) AND asset_id IN (${ph(ids.length)})`,
        )
        .bind(source, ...vs, ...ids)
        .all<PriceQuoteRow>();
      return r.results;
    },
    /** Идемпотентная запись пачкой (db.batch + ON CONFLICT). */
    async upsertMany(rows: PriceQuoteRow[]): Promise<void> {
      if (!rows.length) return;
      const stmt = db.prepare(
        `INSERT INTO price_quotes (source, asset_id, vs_currency, price, as_of, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, asset_id, vs_currency) DO UPDATE SET price=excluded.price, as_of=excluded.as_of, fetched_at=excluded.fetched_at`,
      );
      await db.batch(rows.map((r) => stmt.bind(r.source, r.asset_id, r.vs_currency, r.price, r.as_of, r.fetched_at)));
    },
    getState(source: string) {
      return db.prepare('SELECT * FROM price_provider_state WHERE source = ?').bind(source).first<PriceStateRow>();
    },
    setState(source: string, blockedUntil: string | null, status: number | null, now: string) {
      return db
        .prepare(
          `INSERT INTO price_provider_state (source, blocked_until, last_status, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(source) DO UPDATE SET blocked_until=excluded.blocked_until, last_status=excluded.last_status, updated_at=excluded.updated_at`,
        )
        .bind(source, blockedUntil, status, now)
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

export interface HouseholdRow {
  id: number;
  living_cap_minor: number;
  living_currency: string;
  weekly_budget_minor: number;
  created_by: number;
  created_at: string;
}

export interface HouseholdMemberRow {
  user_id: number;
  role: 'owner' | 'member';
  joined_at: string;
  display_name: string | null;
  telegram_id: number;
}

export type AuditAction =
  | 'owner_bootstrap'
  | 'invite_created'
  | 'invite_redeemed'
  | 'invite_redeem_failed'
  | 'id_reply'
  | 'household_created'
  | 'household_invite_created'
  | 'household_joined'
  | 'household_join_failed'
  | 'household_left';

/** Глобальные таблицы доступа — user-data здесь нет (S5 применяется к scoped). */
export function accessRepo(db: Env['DB']) {
  /** display_name — enc1:; uid = users.id до вставки неизвестен → всегда UPDATE. */
  const setDisplayName = async (userId: number, name: string) =>
    db
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .bind(await encStr(userId, 'users', 'display_name', name), userId)
      .run();
  return {
    /** user_id онбоарденных с включёнными напоминаниями — только для cron-сервиса. */
    async listReminderCandidates(): Promise<number[]> {
      const r = await db
        .prepare(
          'SELECT user_id FROM profiles WHERE onboarded_at IS NOT NULL AND (reminders_weekly = 1 OR reminders_payments = 1 OR reminders_digest = 1 OR fx_alerts_enabled = 1)',
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
      return (await decRow('users', r)) ?? undefined;
    },
    /** Telegram ID активного пользователя по user_id (cron-рассылка); null — удалён/нет. */
    async getTelegramId(userId: number): Promise<number | null> {
      const r = await db
        .prepare('SELECT telegram_id FROM users WHERE id = ? AND deleted_at IS NULL')
        .bind(userId)
        .first<{ telegram_id: number }>();
      return r?.telegram_id ?? null;
    },

    async createUser(tgId: number, displayName: string | null, role: 'owner' | 'member') {
      // uid (=users.id) — ключ шифрования и до вставки неизвестен → insert + UPDATE
      const r = await db
        .prepare('INSERT INTO users (telegram_id, display_name, role) VALUES (?, NULL, ?)')
        .bind(tgId, role)
        .run();
      if (displayName !== null) await setDisplayName(Number(r.meta.last_row_id), displayName);
      return r;
    },

    /**
     * Refresh-on-change: имя в Telegram меняется — свежий first_name при
     * расхождении пишем зашифрованно (и в объект). null/undefined — данных о
     * новом имени нет, не трогаем (first_name в Telegram обязателен).
     */
    async refreshDisplayName(user: UserRow, fresh: string | null | undefined): Promise<void> {
      if (fresh == null || fresh === user.display_name) return;
      await setDisplayName(user.id, fresh);
      user.display_name = fresh;
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
        .prepare("INSERT INTO users (telegram_id, display_name, role) VALUES (?, NULL, 'member')")
        .bind(tgId);
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
      const userId = Number(i.meta.last_row_id);
      // имя — отдельным UPDATE: uid=users.id неизвестен до вставки; при сбое
      // допишет следующий апдейт со свежим first_name (refresh-on-change)
      if (u.meta.changes === 1 && displayName !== null) await setDisplayName(userId, displayName);
      return { redeemed: u.meta.changes === 1, userId };
    },

    // ── households: общий бюджет пары (access-контур, как users/invites) ──

    /** Household пользователя или null (row — с дешифрованными enc1-полями). */
    async householdFor(userId: number): Promise<HouseholdRow | null> {
      const r = await db
        .prepare(
          'SELECT h.* FROM households h JOIN household_members m ON m.household_id = h.id WHERE m.user_id = ?',
        )
        .bind(userId)
        .first<HouseholdRow>();
      return decRow('households', r);
    },

    /** Члены пары: user_id + роль + имя/tg из users (имя дешифруется per-user). */
    async householdMembers(householdId: number): Promise<HouseholdMemberRow[]> {
      const r = await db
        .prepare(
          'SELECT m.user_id, m.role, m.joined_at, u.display_name, u.telegram_id ' +
            'FROM household_members m JOIN users u ON u.id = m.user_id ' +
            'WHERE m.household_id = ? ORDER BY m.joined_at',
        )
        .bind(householdId)
        .all<HouseholdMemberRow>();
      await Promise.all(r.results.map((x) => decRow('users', x)));
      return r.results;
    },

    /**
     * Создать household (лимит enc1: ключ — id, как у users → insert + UPDATE)
     * и вписать создателя owner'ом. Возвращает id household.
     */
    async createHousehold(createdBy: number, capMinor: number, ccy: string, weeklyMinor: number): Promise<number> {
      const r = await db
        .prepare('INSERT INTO households (living_cap_minor, living_currency, weekly_budget_minor, created_by) VALUES (0, ?, 0, ?)')
        .bind(ccy, createdBy)
        .run();
      const id = Number(r.meta.last_row_id);
      await db
        .prepare('UPDATE households SET living_cap_minor = ?, weekly_budget_minor = ? WHERE id = ?')
        .bind(
          await encNum(id, 'households', 'living_cap_minor', capMinor),
          await encNum(id, 'households', 'weekly_budget_minor', weeklyMinor),
          id,
        )
        .run();
      await db
        .prepare("INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, 'owner')")
        .bind(id, createdBy)
        .run();
      return id;
    },

    /**
     * Вступить: атомарно — место < 2 и юзер ещё не в household
     * (страховка поверх UNIQUE: гонка двух инвайтов одного юзера).
     */
    async joinHousehold(householdId: number, userId: number, nowIso: string): Promise<boolean> {
      const r = await db
        .prepare(
          'INSERT INTO household_members (household_id, user_id, role, joined_at) ' +
            'SELECT ?, ?, ?, ? ' +
            'WHERE (SELECT COUNT(*) FROM household_members WHERE household_id = ?) < 2 ' +
            'AND NOT EXISTS (SELECT 1 FROM household_members WHERE user_id = ?)',
        )
        .bind(householdId, userId, 'member', nowIso, householdId, userId)
        .run();
      return r.meta.changes === 1;
    },

    /**
     * Выйти из пары: один batch — удалить членство, затем снести опустевший
     * household (ON DELETE CASCADE добьёт его членство — члена уже нет).
     * Возвращает id покинутого household или null (не был в паре).
     */
    async leaveHousehold(userId: number): Promise<number | null> {
      const mine = await db
        .prepare('SELECT household_id FROM household_members WHERE user_id = ?')
        .bind(userId)
        .first<{ household_id: number }>();
      if (!mine) return null;
      await db.batch([
        db.prepare('DELETE FROM household_members WHERE user_id = ?').bind(userId),
        // invites.household_id — FK на удаляемый household: зануляем (строка-история остаётся)
        db.prepare('UPDATE invites SET household_id = NULL WHERE household_id = ?').bind(mine.household_id),
        // только ЕГО опустевший household — чужую новую пару без членов не сносим
        db
          .prepare('DELETE FROM households WHERE id = ? AND NOT EXISTS (SELECT 1 FROM household_members WHERE household_id = ?)')
          .bind(mine.household_id, mine.household_id),
      ]);
      return mine.household_id;
    },

    /** Общий лимит пары (enc1: по household.id) — вызывающий проверил членство. */
    async updateHouseholdCap(householdId: number, capMinor: number, ccy: string, weeklyMinor: number) {
      return db
        .prepare('UPDATE households SET living_cap_minor = ?, living_currency = ?, weekly_budget_minor = ? WHERE id = ?')
        .bind(
          await encNum(householdId, 'households', 'living_cap_minor', capMinor),
          ccy,
          await encNum(householdId, 'households', 'weekly_budget_minor', weeklyMinor),
          householdId,
        )
        .run();
    },

    createHouseholdInvite(codeHash: string, createdBy: number, householdId: number, expiresAtIso: string) {
      return db
        .prepare("INSERT INTO invites (code_hash, created_by, expires_at, kind, household_id) VALUES (?, ?, ?, 'household', ?)")
        .bind(codeHash, createdBy, expiresAtIso, householdId)
        .run();
    },

    /**
     * Погасить household-инвайт — batch из двух условных шагов:
     *   1. INSERT члена — только если инвайт kind='household', не использован,
     *      не истёк, в паре есть место и юзер ещё ни в одной паре;
     *   2. UPDATE инвайта — только если член реально появился (инвайт не
     *      сгорает при отказе «место занято»/«уже в паре»).
     * redeemed = членство создано.
     */
    async redeemHouseholdInvite(codeHash: string, userId: number, nowIso: string) {
      const ins = db
        .prepare(
          'INSERT INTO household_members (household_id, user_id, role, joined_at) ' +
            "SELECT i.household_id, ?, 'member', ? FROM invites i " +
            "WHERE i.code_hash = ? AND i.kind = 'household' AND i.used_at IS NULL AND i.expires_at > ? " +
            'AND (SELECT COUNT(*) FROM household_members m WHERE m.household_id = i.household_id) < 2 ' +
            'AND NOT EXISTS (SELECT 1 FROM household_members m WHERE m.user_id = ?)',
        )
        .bind(userId, nowIso, codeHash, nowIso, userId);
      const upd = db
        .prepare(
          'UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL ' +
            'AND EXISTS (SELECT 1 FROM household_members m WHERE m.user_id = ? AND m.household_id = invites.household_id)',
        )
        .bind(userId, nowIso, codeHash, userId);
      const [i] = await db.batch([ins, upd]);
      if (!i) throw new Error('redeemHouseholdInvite: пустой результат batch');
      return { redeemed: i.meta.changes === 1 };
    },

    /**
     * Погасить household-инвайт НОВЫМ пользователем — atomic batch, как
     * redeemInvite: юзер создаётся, членство и погашение — только если
     * инвайт валиден и есть место; сирота-юзер удаляется при отказе.
     */
    async redeemHouseholdInviteNewUser(codeHash: string, tgId: number, displayName: string | null, nowIso: string) {
      const insUser = db
        .prepare("INSERT INTO users (telegram_id, display_name, role) VALUES (?, NULL, 'member')")
        .bind(tgId);
      const insMember = db
        .prepare(
          'INSERT INTO household_members (household_id, user_id, role, joined_at) ' +
            "SELECT i.household_id, last_insert_rowid(), 'member', ? FROM invites i " +
            "WHERE i.code_hash = ? AND i.kind = 'household' AND i.used_at IS NULL AND i.expires_at > ? " +
            'AND (SELECT COUNT(*) FROM household_members m WHERE m.household_id = i.household_id) < 2',
        )
        .bind(nowIso, codeHash, nowIso);
      // фаза 1: юзер + членство (last_insert_rowid() в insMember = users.id).
      // Дальше last_insert_rowid уже затирается rowid household_members —
      // поэтому погашение/удаление — второй фазой с явным userId.
      const [u, m] = await db.batch([insUser, insMember]);
      if (!u || !m) throw new Error('redeemHouseholdInviteNewUser: пустой результат batch');
      const userId = Number(u.meta.last_row_id);
      if (m.meta.changes === 1) {
        await db
          .prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL')
          .bind(userId, nowIso, codeHash)
          .run();
        // имя — отдельным UPDATE: uid=users.id неизвестен до вставки
        if (displayName !== null) await setDisplayName(userId, displayName);
      } else {
        // членство не вставилось (инвайт мёртв/занят) → сироту-юзера сносим
        await db
          .prepare('DELETE FROM users WHERE id = ? AND NOT EXISTS (SELECT 1 FROM household_members WHERE user_id = ?)')
          .bind(userId, userId)
          .run();
      }
      return { redeemed: m.meta.changes === 1, userId };
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
     * audit_log старше 400 дней, кроме 'id_reply' — этот action гейтит
     * «/id отвечаем один раз» (при unset owner), удаление сломало бы его.
     */
    cleanupAuditLog() {
      return db
        .prepare("DELETE FROM audit_log WHERE created_at < datetime('now','-400 days') AND action != 'id_reply'")
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
    // PK-варианты: user_id (profiles/conversation_state) / id=uid (users, households) / id+user_id (остальные)
    const userKeyed = table === 'conversation_state' || table === 'profiles';
    const selfKeyed = table === 'users' || table === 'households';
    const keyCols = userKeyed ? 'user_id' : selfKeyed ? 'id' : 'id, user_id';
    const rows = await db
      .prepare(`SELECT ${keyCols}, ${colNames.join(', ')} FROM ${table} WHERE ${colNames.map(unenc).join(' OR ')} LIMIT ?`)
      .bind(limitPerTable)
      .all<Record<string, unknown>>();
    for (const row of rows.results) {
      const uid = Number(selfKeyed ? row.id : row.user_id);
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
      const where = userKeyed ? 'WHERE user_id = ?' : selfKeyed ? 'WHERE id = ?' : 'WHERE id = ? AND user_id = ?';
      const keyBinds = userKeyed || selfKeyed ? [uid] : [row.id, uid];
      const r = await db
        .prepare(`UPDATE ${table} SET ${sets.join(', ')} ${where} AND ${cas.join(' AND ')}`)
        .bind(...binds, ...(keyBinds as (string | number)[]), ...casBinds)
        .run();
      if (r.meta?.changes) done += r.meta.changes;
    }
  }
  return done;
}
