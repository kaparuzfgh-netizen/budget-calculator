/**
 * repo.ts — ЕДИНСТВЕННАЯ точка доступа к данным (ADR-0001, находка S5).
 *
 * Правило изоляции: все чтения/записи пользовательских данных идут через
 * `scoped(env.DB, userId)` — каждый метод обязан добавлять `WHERE user_id = ?`
 * (или эквивалент через связанную таблицу). Сырые `db.prepare(...)` вне этого
 * модуля — запрещены. Тест «A не видит B» — обязателен (test/repo.test.ts).
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
