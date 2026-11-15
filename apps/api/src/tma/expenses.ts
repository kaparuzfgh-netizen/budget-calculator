/**
 * tma/expenses.ts — траты и категории Mini App (паритет бота /spent, /expenses).
 * Bearer-JWT, только scoped(user.id); идемпотентность client_id.
 */
import { z } from 'zod';
import type { Hono, Next } from 'hono';
import type { Env } from '../env';
import type { UserRow } from '../db/repo';
import { toMinor } from '../domain/money';
import { todayInTz, weekStartInTz } from '../bot/parse';
import { matchCategory } from '../domain/categories';
import {
  bad,
  dayInRange,
  dupResult,
  idOf,
  LIMITS,
  notFound,
  notOnboarded,
  okJson,
  profile,
  repoOf,
  moneySchema,
  zAmount,
  zCcy,
  zClientId,
  zIso,
  zNote,
  type TmaContext as C,
} from './common';

/** Одна строка пакетной записи трат (vision-загрузка ≤30): те же правила, что у одиночного POST. */
const expenseItemSchema = z.object({
  amount: zAmount,
  currency: zCcy.optional(),
  note: zNote,
  /** Идемпотентность строки — свой client_id на позицию ('tma:<client_id>'). */
  client_id: zClientId,
  category_id: z.number().int().positive().nullable().optional(),
  spent_on: zIso.optional(),
});
/**
 * Пакетный POST /expenses: ключ items → схема-пачка (≤30 строк; даты и
 * категории валидируются ДО первой вставки — «всё или ничего» по схеме;
 * повтор по client_id даёт duplicate). Без items — одиночная moneySchema.
 */
const expenseBatchSchema = z.object({ items: z.array(expenseItemSchema).min(1).max(30) });
const expensePatchSchema = z.object({
  amount: zAmount.optional(),
  currency: zCcy.optional(),
  note: z.string().trim().max(LIMITS.maxNote).nullable().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  spent_on: zIso.optional(),
});
const categorySchema = z.object({
  name: z.string().trim().min(1).max(32),
  emoji: z.string().max(8).optional(),
  client_id: zClientId,
});
const categoryPatchSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  emoji: z.string().max(8).optional(),
  archived: z.boolean().optional(),
  sort: z.number().int().optional(),
});

export function registerTmaExpenses(
  app: Hono<{ Bindings: Env; Variables: { tmaUser: UserRow } }>,
  tmaAuth: (c: C, next: Next) => Promise<Response | void>,
): void {
  // ── expenses ──
  app.get('/api/tma/expenses', tmaAuth, async (c) => {
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const start = weekStartInTz(p.timezone, new Date());
    const rows = (await repo.listExpenses(start)).results.slice(-50).reverse();
    return okJson(c, { week_start: start, expenses: rows.map((e) => ({ id: e.id, spent_on: e.spent_on, amount_minor: e.amount_minor, currency: e.currency, note: e.note, category_id: e.category_id })) });
  });
  // одна запись по id — карточка открывается и из отчётов (любой период)
  app.get('/api/tma/expenses/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const e = await repoOf(c).getExpense(id);
    if (!e) return c.json(notFound().body, 404);
    return okJson(c, { expense: { id: e.id, spent_on: e.spent_on, amount_minor: e.amount_minor, currency: e.currency, note: e.note, category_id: e.category_id } });
  });
  app.post('/api/tma/expenses', tmaAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // наличие ключа items — однозначный выбор пакетной схемы (иначе одиночная)
    const hasItems = typeof body === 'object' && body !== null && 'items' in body;
    const parsed = (hasItems ? expenseBatchSchema : moneySchema).safeParse(body);
    if (!parsed.success) return c.json(bad('нужны amount (>0) и допустимые currency/note').body, 400);
    const repo = repoOf(c);
    const p = await profile(repo);
    if (!p) return c.json(notOnboarded().body, 403);
    const b = parsed.data;
    const today = todayInTz(p.timezone, new Date());
    // ── пакетная запись (vision-скриншот): валидация всей пачки до первой
    // вставки, дальше — та же логика, что у одиночной (дедуп + автокатегория)
    if ('items' in b) {
      for (const it of b.items) {
        if (it.spent_on !== undefined && !dayInRange(it.spent_on, today))
          return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
        if (it.category_id != null && !(await repo.getCategory(it.category_id)))
          return c.json(bad('категория не найдена').body, 400);
      }
      await repo.ensureCategories();
      const cats = (await repo.listCategories()).results;
      const ids: number[] = [];
      let created = 0;
      let duplicates = 0;
      for (const it of b.items) {
        const key = it.client_id ? `tma:${it.client_id}` : `tma:u:${crypto.randomUUID()}`;
        if (it.client_id) {
          const dup = await repo.findExpenseByKey(key);
          if (dup) {
            duplicates++;
            ids.push(dup.id);
            continue;
          }
        }
        let categoryId = it.category_id ?? null;
        let note = it.note ?? null;
        if (categoryId === null) {
          const m = matchCategory(note, cats);
          categoryId = m.categoryId;
          note = m.note;
        }
        const r = await repo.addExpense({
          spent_on: it.spent_on ?? today,
          amount_minor: toMinor(it.amount),
          currency: it.currency ?? p.expense_currency ?? p.living_currency,
          note,
          source: 'manual', // строки проверены человеком в шторке — как ручной ввод
          source_key: key,
          category_id: categoryId,
        });
        if (r.meta.changes === 0) {
          const dup = it.client_id ? await repo.findExpenseByKey(key) : null;
          if (dup) ids.push(dup.id);
          duplicates++;
          continue;
        }
        created++;
        ids.push(Number(r.meta.last_row_id));
      }
      return okJson(c, { created, duplicates, ids }, created ? 201 : 200);
    }
    if (b.spent_on !== undefined && !dayInRange(b.spent_on, today))
      return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
    const key = b.client_id ? `tma:${b.client_id}` : `tma:u:${crypto.randomUUID()}`;
    if (b.client_id) {
      const dup = await repo.findExpenseByKey(key);
      if (dup) return okJson(c, { id: dup.id, duplicate: true });
    }
    let categoryId = b.category_id ?? null;
    if (categoryId !== null && !(await repo.getCategory(categoryId)))
      return c.json(bad('категория не найдена').body, 400);
    let note = b.note ?? null;
    if (categoryId === null) {
      // автокатегория по заметке (совпавшее первое слово вырезается)
      await repo.ensureCategories();
      const m = matchCategory(note, (await repo.listCategories()).results);
      categoryId = m.categoryId;
      note = m.note;
    }
    const r = await repo.addExpense({
      spent_on: b.spent_on ?? today,
      amount_minor: toMinor(b.amount),
      currency: b.currency ?? p.expense_currency ?? p.living_currency,
      note,
      source: 'manual',
      source_key: key,
      category_id: categoryId,
    });
    if (r.meta.changes === 0) {
      const dup = b.client_id ? await repo.findExpenseByKey(key) : null;
      return dupResult(c, dup);
    }
    return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
  });
  app.patch('/api/tma/expenses/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = expensePatchSchema.safeParse(body);
    if (!parsed.success) return c.json(bad('недопустимые поля').body, 400);
    const repo = repoOf(c);
    if (!(await repo.getExpense(id))) return c.json(notFound().body, 404);
    const p = await repo.getProfile();
    if (parsed.data.spent_on !== undefined && !dayInRange(parsed.data.spent_on, todayInTz(p?.timezone ?? 'UTC', new Date())))
      return c.json(bad('дата: 2000-01-01 … сегодня').body, 400);
    const patch: { amount_minor?: number; currency?: string; note?: string | null; category_id?: number | null; spent_on?: string } = {};
    if (parsed.data.amount !== undefined) patch.amount_minor = toMinor(parsed.data.amount);
    if (parsed.data.currency !== undefined) patch.currency = parsed.data.currency;
    if (parsed.data.note !== undefined) patch.note = parsed.data.note;
    if (parsed.data.spent_on !== undefined) patch.spent_on = parsed.data.spent_on;
    if (parsed.data.category_id !== undefined) {
      if (parsed.data.category_id !== null && !(await repo.getCategory(parsed.data.category_id)))
        return c.json(bad('категория не найдена').body, 400);
      patch.category_id = parsed.data.category_id;
    }
    await repo.patchExpense(id, patch);
    return okJson(c, { ok: true });
  });
  app.delete('/api/tma/expenses/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const repo = repoOf(c);
    const w = await repo.deleteExpense(id);
    if (w.meta.changes === 0) return c.json(notFound().body, 404);
    return okJson(c, { ok: true });
  });

  // ── categories ──
  app.get('/api/tma/categories', tmaAuth, async (c) => {
    const repo = repoOf(c);
    await repo.ensureCategories();
    const all = c.req.query('all') === '1';
    const rows = (await repo.listCategories(all)).results;
    return okJson(c, {
      categories: rows.map((x) => ({ id: x.id, name: x.name, emoji: x.emoji, preset_key: x.preset_key, archived: !!x.archived, sort: x.sort })),
    });
  });
  app.post('/api/tma/categories', tmaAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = categorySchema.safeParse(body);
    if (!parsed.success) return c.json(bad('нужны name (1..32) и допустимый emoji').body, 400);
    const repo = repoOf(c);
    const cnt = await repo.countCategories();
    if ((cnt?.n ?? 0) >= 50) return c.json(bad('не больше 50 активных категорий').body, 400);
    const r = await repo.addCategory({
      name: parsed.data.name,
      emoji: parsed.data.emoji ?? '',
      sort: (cnt?.n ?? 0) + 100,
    });
    return okJson(c, { id: Number(r.meta.last_row_id) }, 201);
  });
  app.patch('/api/tma/categories/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = categoryPatchSchema.safeParse(body);
    if (!parsed.success) return c.json(bad('недопустимые поля').body, 400);
    const repo = repoOf(c);
    if (!(await repo.getCategory(id))) return c.json(notFound().body, 404);
    const patch: { name?: string; emoji?: string; archived?: number; sort?: number } = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.emoji !== undefined) patch.emoji = parsed.data.emoji;
    if (parsed.data.archived !== undefined) patch.archived = parsed.data.archived ? 1 : 0;
    if (parsed.data.sort !== undefined) patch.sort = parsed.data.sort;
    await repo.patchCategory(id, patch);
    return okJson(c, { ok: true });
  });
  app.delete('/api/tma/categories/:id', tmaAuth, async (c) => {
    const id = idOf(c);
    if (!id) return c.json(notFound().body, 404);
    const repo = repoOf(c);
    if (!(await repo.getCategory(id))) return c.json(notFound().body, 404);
    await repo.deleteCategory(id);
    return okJson(c, { ok: true });
  });

}
