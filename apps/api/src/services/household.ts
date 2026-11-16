/**
 * services/household.ts — сводка общего бюджета пары (бот + TMA).
 * Агрегаты по членам household: траты недели каждого — через scoped его
 * user_id (дешифровка на сервере легальна), наружу — ТОЛЬКО суммы по
 * людям и общий итог. Строки трат/категории партнёра наружу не идут.
 * Неделя — по таймзоне запрашивающего (его «неделя» и видна).
 */
import { convert } from '../domain/money';
import type { Env } from '../env';
import { scoped, accessRepo } from '../db/repo';
import type { FxResult } from '../fx/service';
import { weekStartInTz, todayInTz } from '../bot/parse';

export interface HouseholdMemberSpend {
  user_id: number;
  name: string | null;
  role: 'owner' | 'member';
  is_me: boolean;
  spent_week_minor: number;
}

export interface HouseholdSummary {
  currency: string;
  living_cap_minor: number;
  weekly_budget_minor: number;
  spent_week_minor: number;
  week_remaining_minor: number;
  week_over: boolean;
  members: HouseholdMemberSpend[];
  fx_as_of: string;
  fx_note?: string;
}

/**
 * Сводка пары или null — юзер не в household.
 * FxUnavailable пробрасывается наверх (роутер/бот решают сами).
 */
export async function householdSummary(
  db: Env['DB'],
  userId: number,
  getFx: (ccys: string[]) => Promise<FxResult>,
  now: Date = new Date(),
): Promise<HouseholdSummary | null> {
  const access = accessRepo(db);
  const hh = await access.householdFor(userId);
  if (!hh) return null;

  // неделя — в таймзоне запрашивающего
  const me = await scoped(db, userId).getProfile();
  const tz = me?.timezone ?? 'UTC';
  const wStart = weekStartInTz(tz, now);
  const today = todayInTz(tz, now);

  const members = await access.householdMembers(hh.id);
  // все валюты трат членов + валюта котла — одним FX-запросом
  const spend = await Promise.all(
    members.map(async (m) => ({
      m,
      rows: (await scoped(db, m.user_id).listExpensesBetween(wStart, today)).results,
    })),
  );
  const ccys = new Set<string>([hh.living_currency]);
  for (const s of spend) for (const e of s.rows) ccys.add(e.currency);
  const fxr = await getFx([...ccys]);
  const pu = fxr.perUsd;

  const out: HouseholdMemberSpend[] = spend.map(({ m, rows }) => ({
    user_id: m.user_id,
    name: m.display_name,
    role: m.role,
    is_me: m.user_id === userId,
    spent_week_minor: Math.round(
      rows.reduce((s, e) => s + convert(e.amount_minor / 100, e.currency, hh.living_currency, { perUsd: pu }), 0) * 100,
    ),
  }));
  const spent = out.reduce((s, x) => s + x.spent_week_minor, 0);
  const remaining = hh.weekly_budget_minor - spent;
  return {
    currency: hh.living_currency,
    living_cap_minor: hh.living_cap_minor,
    weekly_budget_minor: hh.weekly_budget_minor,
    spent_week_minor: spent,
    week_remaining_minor: remaining,
    week_over: remaining < 0,
    members: out,
    fx_as_of: fxr.asOf,
    ...(fxr.stale ? { fx_note: `Курсы устарели — данные на ${fxr.asOf || '—'}` } : {}),
  };
}

/** Короткая строка для бота: «общий бюджет: X из Y (я a · партнёр b)». */
export function householdLine(s: HouseholdSummary, fmt: (minor: number, ccy: string) => string): string {
  const parts = s.members.map((m) => `${m.is_me ? 'вы' : m.name ?? 'партнёр'} ${fmt(m.spent_week_minor, s.currency)}`);
  return `${fmt(s.spent_week_minor, s.currency)} из ${fmt(s.weekly_budget_minor, s.currency)} (${parts.join(' · ')})`;
}
