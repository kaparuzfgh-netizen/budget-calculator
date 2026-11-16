/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRow, decRows } from '../crypto';
import type { CommitmentRow, CommitmentPaymentRow, CommitmentChangeField, CommitmentChangeRow } from './types';
import type { Ctx } from './ctx';

export function commitmentsRepo({ db, userId, en }: Ctx) {
  return {
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
    async addCommitment(c: {
      name: string;
      amount_minor: number;
      currency: string;
      due_day: number | null;
      /** Каденс (0016); без аргументов — monthly (дефолт миграции). */
      frequency?: 'monthly' | 'interval_days' | 'yearly';
      interval_days?: number | null;
      anchor_on?: string | null;
      due_month?: number | null;
      every_months?: number;
    }) {
      return db
        .prepare(
          `INSERT INTO commitments
             (user_id, name, amount_minor, currency, due_day, frequency, interval_days, anchor_on, due_month, every_months)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          await en('commitments', 'name', c.name),
          await en('commitments', 'amount_minor', c.amount_minor),
          c.currency,
          c.due_day,
          c.frequency ?? 'monthly',
          c.interval_days ?? null,
          c.anchor_on ?? null,
          c.due_month ?? null,
          c.every_months ?? 1,
        )
        .run();
    },
    /** Точечные правки — все WHERE id=? AND user_id=? (чужие id молча игнорируются). */
    async patchCommitment(
      id: number,
      patch: {
        amount_minor?: number;
        currency?: string;
        due_day?: number | null;
        active?: number;
        name?: string;
        /** Каденс (0016) — plaintext-колонки планирования. */
        frequency?: 'monthly' | 'interval_days' | 'yearly';
        interval_days?: number | null;
        anchor_on?: string | null;
        due_month?: number | null;
        every_months?: number;
      },
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
      if (patch.frequency !== undefined) {
        sets.push('frequency = ?');
        binds.push(patch.frequency);
      }
      if (patch.interval_days !== undefined) {
        sets.push('interval_days = ?');
        binds.push(patch.interval_days);
      }
      if (patch.anchor_on !== undefined) {
        sets.push('anchor_on = ?');
        binds.push(patch.anchor_on);
      }
      if (patch.due_month !== undefined) {
        sets.push('due_month = ?');
        binds.push(patch.due_month);
      }
      if (patch.every_months !== undefined) {
        sets.push('every_months = ?');
        binds.push(patch.every_months);
      }
      binds.push(id, userId);
      // История «было → стало»: только реально изменившиеся поля (сравнение после дешифровки).
      const cur = await this.getCommitment(id);
      const stmts = [
        db
          .prepare(`UPDATE commitments SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
          .bind(...binds),
      ];
      if (cur) {
        const cad = (c: {
          frequency: string;
          interval_days: number | null;
          anchor_on: string | null;
          due_month: number | null;
          every_months: number;
        }) => [c.frequency, c.interval_days ?? '', c.anchor_on ?? '', c.due_month ?? '', c.every_months].join('|');
        const next = {
          frequency: patch.frequency ?? cur.frequency,
          interval_days: patch.interval_days !== undefined ? patch.interval_days : cur.interval_days,
          anchor_on: patch.anchor_on !== undefined ? patch.anchor_on : cur.anchor_on,
          due_month: patch.due_month !== undefined ? patch.due_month : cur.due_month,
          every_months: patch.every_months ?? cur.every_months,
        };
        const diffs: [CommitmentChangeField, string | null, string | null][] = [];
        const s2 = (v: string | number | null) => (v === null ? null : String(v));
        const add = (f: CommitmentChangeField, o: string | number | null, n: string | number | null | undefined) => {
          if (n !== undefined && s2(o) !== s2(n)) diffs.push([f, s2(o), s2(n)]);
        };
        add('name', cur.name, patch.name);
        add('amount', cur.amount_minor, patch.amount_minor);
        add('currency', cur.currency, patch.currency);
        add('due_day', cur.due_day, patch.due_day);
        add('active', cur.active, patch.active);
        if (cad(cur) !== cad(next)) diffs.push(['cadence', cad(cur), cad(next)]);
        for (const [f, o, n] of diffs) {
          stmts.push(
            db
              .prepare(
                'INSERT INTO commitment_changes (user_id, commitment_id, field, old_val, new_val) VALUES (?, ?, ?, ?, ?)',
              )
              .bind(
                userId,
                id,
                f,
                o === null ? null : await en('commitment_changes', 'old_val', o),
                n === null ? null : await en('commitment_changes', 'new_val', n),
              ),
          );
        }
      }
      return db.batch(stmts);
    },
    /** Лента изменений платежа (новые первыми); чужой commitment → пусто. */
    listCommitmentChanges(commitmentId: number, limit = 50) {
      return db
        .prepare('SELECT * FROM commitment_changes WHERE user_id = ? AND commitment_id = ? ORDER BY id DESC LIMIT ?')
        .bind(userId, commitmentId, limit)
        .all<CommitmentChangeRow>().then((r) => decRows('commitment_changes', r));
    },
    /** Удаление платежа вместе с журналом оплат (batch = одна транзакция). */
    deleteCommitment(id: number) {
      return db.batch([
        db.prepare('DELETE FROM commitment_changes WHERE user_id = ? AND commitment_id = ?').bind(userId, id),
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
  };
}
