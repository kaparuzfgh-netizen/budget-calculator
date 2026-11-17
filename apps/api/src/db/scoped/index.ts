/**
 * scoped(db, userId) — репозиторий пользователя: композиция доменных частей.
 * Правило изоляции (AGENTS.md №3): каждый запрос — WHERE user_id = ? (или join
 * через таблицу с user_id). `this` между частями не используется.
 */
import type { Env } from '../../env';
import { FIELDS, encNum, encStr } from '../crypto';
import type { Ctx } from './ctx';
import { profileRepo } from './profile';
import { remindersRepo } from './reminders';
import { commitmentsRepo } from './commitments';
import { incomeRepo } from './income';
import { categoriesRepo } from './categories';
import { rangesRepo } from './ranges';
import { expensesRepo } from './expenses';
import { exchangesRepo } from './exchanges';
import { debtsRepo } from './debts';
import { loansRepo } from './loans';
import { holdingsRepo } from './holdings';
import { conversationRepo } from './conversation';
import { userDataRepo } from './userdata';

export function scoped(db: Env['DB'], userId: number) {
  const en: Ctx['en'] = (table, col, v) => {
    const spec = FIELDS[table]?.[col];
    if (!spec || v === undefined) return Promise.resolve((v ?? null) as string | number | null);
    return spec === 'num' ? encNum(userId, table, col, v as number) : encStr(userId, table, col, v as string);
  };
  const c: Ctx = { db, userId, en };
  const parts = {
    ...profileRepo(c),
    ...remindersRepo(c),
    ...commitmentsRepo(c),
    ...incomeRepo(c),
    ...categoriesRepo(c),
    ...rangesRepo(c),
    ...expensesRepo(c),
    ...exchangesRepo(c),
    ...debtsRepo(c),
    ...loansRepo(c),
    ...holdingsRepo(c),
    ...conversationRepo(c),
  };
  return { ...parts, ...userDataRepo(c, parts) };
}
