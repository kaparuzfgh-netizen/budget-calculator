/** Часть scoped-репозитория (см. db/scoped/index.ts) — каждый запрос с WHERE user_id = ?. */
import { decRow, decRows, encStr } from '../crypto';
import type { CategoryRow } from './types';
import type { Ctx } from './ctx';

export function categoriesRepo({ db, userId, en }: Ctx) {
  return {
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
      const { PRESETS } = await import('../../domain/categories');
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
  };
}
