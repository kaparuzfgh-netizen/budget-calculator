/**
 * digest.ts — дайджест месяца «факт vs план» (T2): сбор данных через scoped-repo
 * и чистый рендер. Текст сообщения содержит суммы — только в Telegram, в логи не идёт.
 */
import type { ScopedRepo } from '../db/repo';
import { buildUserReport } from './report';
import { baselineIncome } from './baseline';
import { savingsRate, topCategoryMovers, type CatAmount, type CatMover } from '../domain/digest';
import { addMonths } from '../domain/dates';
import { isOccurrencePaid, occurrencesInRange } from '../domain/schedule';
import { fmtMoney } from '../bot/format';
import { escapeHtml } from '../telegram/client';
import type { FxResult } from '../fx/service';

type Fx = { get(ccys: string[]): Promise<FxResult> };

export interface DigestData {
  monthKey: string; // YYYY-MM
  currency: string;
  /** Базовый (плановый) доход; 0 — не задан. */
  incomePlan: number;
  incomeActual: number;
  paid: number;
  total: number;
  livingSpent: number;
  livingCap: number;
  /** Доля лимита (0..), 0 при нулевом лимите. */
  livingPct: number;
  obligatory: number;
  /** Доход, на котором считался rate, и признак «оценка» (факта нет). */
  rateIncome: number;
  rateEstimated: boolean;
  savings: number | null;
  movers: CatMover[];
}

const catList = (cs: { id: number | null; name: string; emoji: string; amount: number }[]): CatAmount[] =>
  cs.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji, amount: c.amount / 100 }));

/** offset 0 — текущий месяц, −1 — прошлый. null — данных нет вовсе (дайджест не шлём). */
export async function buildDigest(
  repo: ScopedRepo,
  fx: Fx,
  now: Date,
  offset: 0 | -1,
  today: string,
): Promise<DigestData | null> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) return null;
  const fxGet = (c: string[]) => fx.get(c);
  const [cur, prev] = await Promise.all([
    buildUserReport(repo, fxGet, 'month', offset, now),
    buildUserReport(repo, fxGet, 'month', offset - 1, now),
  ]);
  if (!cur) return null;
  const base = await baselineIncome(repo, p, fx, today);
  const incomeActual = cur.received.income / 100;
  const livingSpent = cur.spent.living / 100;
  const obligatory = (cur.spent.commitments + cur.spent.credits) / 100;
  const incomePlan = base.source === 'none' ? 0 : base.amount;

  // «оплачено N из M»: сроки активных платежей внутри месяца
  const { from, to } = cur;
  const commits = (await repo.listCommitments(true)).results;
  const sinceIso = addMonths(from, -13); // ~год назад — период любого каденса покрыт
  const pays = (await repo.listCommitmentPaymentsSince(sinceIso)).results;
  const paidOns = new Map<number, string[]>();
  for (const x of pays) {
    const a = paidOns.get(x.commitment_id) ?? [];
    a.push(x.paid_on);
    paidOns.set(x.commitment_id, a);
  }
  let total = 0;
  let paid = 0;
  for (const c of commits) {
    for (const occ of occurrencesInRange(c, from, to)) {
      total++;
      if (isOccurrencePaid(c, occ, paidOns.get(c.id) ?? [])) paid++;
    }
  }

  const empty = incomeActual <= 0 && livingSpent <= 0 && cur.spent.commitments <= 0 && cur.spent.credits <= 0;
  if (empty) return null; // не спамим пустым месяцем

  const rateEstimated = incomeActual <= 0;
  const rateIncome = rateEstimated ? incomePlan : incomeActual;
  const capMajor = cur.living_limit.cap / 100;
  return {
    monthKey: from.slice(0, 7),
    currency: cur.currency,
    incomePlan,
    incomeActual,
    paid,
    total,
    livingSpent,
    livingCap: capMajor,
    livingPct: cur.living_limit.used_pct,
    obligatory,
    rateIncome,
    rateEstimated,
    savings: savingsRate(rateIncome, obligatory, livingSpent),
    movers: topCategoryMovers(
      catList(cur.categories),
      prev ? catList(prev.categories) : [],
    ),
  };
}

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function renderDigest(d: DigestData): string {
  const m = Number(d.monthKey.slice(5, 7));
  const money = (x: number) => fmtMoney(x, d.currency);
  const lines = [`📊 <b>Итоги месяца: ${MONTHS[m - 1]}</b>`, ''];
  lines.push(
    d.incomePlan > 0
      ? `💰 Доход: ${money(d.incomeActual)} (план ${money(d.incomePlan)})`
      : `💰 Доход: ${d.incomeActual > 0 ? money(d.incomeActual) : '—'}`,
  );
  if (d.total > 0) lines.push(`🧾 Обязательные: оплачено ${d.paid} из ${d.total}`);
  lines.push(
    d.livingCap > 0
      ? `🛒 Повседневные: ${money(d.livingSpent)} — ${pct(d.livingPct)} от бюджета ${money(d.livingCap)}`
      : `🛒 Повседневные: ${money(d.livingSpent)}`,
  );
  lines.push(
    d.savings === null
      ? '💎 Норма сбережений: —'
      : `💎 Норма сбережений: ${pct(d.savings)}${d.rateEstimated ? ' (оценка по плановому доходу)' : ''}`,
  );
  if (d.movers.length) {
    lines.push('', d.movers[0]!.delta === null || d.movers.every((x) => x.delta === null) ? '🔝 Топ категорий:' : '📈 Больше всего выросло:');
    for (const c of d.movers) {
      lines.push(`  ${escapeHtml(c.emoji)} ${escapeHtml(c.name)} — ${money(c.amount)}${c.delta !== null ? ` (+${money(c.delta)})` : ''}`);
    }
  }
  return lines.join('\n');
}
