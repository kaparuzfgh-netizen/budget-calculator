/**
 * features.ts — команды онбоарденных пользователей: /plan /spent /week /profile.
 * Все чтения БД — через scoped(userId); курсы — через fx-сервис.
 */
import { computeWaterfall } from '../domain/cashflow';
import { weeklyStatus } from '../domain/budget';
import { convert, round2 } from '../domain/money';
import type { FxResult } from '../fx/service';
import type { CommitmentRow, IncomeEntryRow } from '../db/repo';
import type { TelegramClient } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import { fmtMoney, fmtPct } from './format';
import { monthInTz, parseAmount } from './parse';
import { MAIN_MENU_KB, profileMenuText, type PfCtx } from './profile';

const FX_FAIL = 'Курсы временно недоступны, попробуйте позже';

type Repo = ReturnType<typeof import('../db/repo').scoped>;

interface FxLike {
  get(currencies: string[]): Promise<FxResult>;
}

/** Валюты, задействованные в расчёте (без USD — он и так 1). */
async function fxFor(fx: FxLike, ccys: (string | undefined)[]): Promise<FxResult> {
  const uniq = [...new Set(ccys.filter((c): c is string => !!c && c !== 'USD'))];
  return fx.get(uniq);
}

const usd = (amount: number, ccy: string, perUsd: Record<string, number>) => convert(amount, ccy, 'USD', { perUsd });

/**
 * resolveIncome — ЧИСТАЯ функция: какой доход идёт в /plan.
 * override (аргумент /plan) > сумма записей месяца («факт») > типичный доход > нет.
 * Записи конвертируются в incomeCcy через USD.
 */
export function resolveIncome(opts: {
  entries: Pick<IncomeEntryRow, 'amount_minor' | 'currency'>[];
  typicalMinor: number;
  incomeCcy: string;
  perUsd: Record<string, number>;
  override?: { amount: number; currency: string };
}): { amount: number; currency: string; source: 'override' | 'actual' | 'typical' | 'none'; count: number } {
  const { entries, typicalMinor, incomeCcy, perUsd, override } = opts;
  if (override)
    return { amount: override.amount, currency: override.currency, source: 'override', count: entries.length };
  if (entries.length) {
    const sum = entries.reduce((s, e) => s + convert(e.amount_minor / 100, e.currency, incomeCcy, { perUsd }), 0);
    return { amount: sum, currency: incomeCcy, source: 'actual', count: entries.length };
  }
  if (typicalMinor > 0) return { amount: typicalMinor / 100, currency: incomeCcy, source: 'typical', count: 0 };
  return { amount: 0, currency: incomeCcy, source: 'none', count: 0 };
}

export async function runPlan(
  chatId: number,
  tg: TelegramClient,
  repo: Repo,
  fx: FxLike,
  argText: string,
  monthIso?: string,
): Promise<void> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) {
    await tg.sendMessage(chatId, 'Сначала настройка — /start');
    return;
  }
  const commits = (await repo.listCommitments()).results;
  const month = monthIso ?? monthInTz(p.timezone, new Date());
  const entries = (await repo.listIncomeEntries(month)).results;
  let override: { amount: number; currency: string } | undefined;
  if (argText.trim()) {
    try {
      const a = parseAmount(argText);
      override = { amount: a.amount, currency: a.currency ?? p.income_currency };
    } catch (e) {
      await tg.sendMessage(chatId, (e as Error).message);
      return;
    }
  }
  let fxr: FxResult;
  try {
    fxr = await fxFor(fx, [
      p.income_currency,
      p.living_currency,
      override?.currency,
      ...entries.map((e) => e.currency),
      ...commits.map((c) => c.currency),
    ]);
  } catch {
    await tg.sendMessage(chatId, FX_FAIL);
    return;
  }
  const pu = fxr.perUsd;
  const inc = resolveIncome({
    entries,
    typicalMinor: p.income_minor,
    incomeCcy: p.income_currency,
    perUsd: pu,
    ...(override ? { override } : {}),
  });
  const income = { amount: inc.amount, currency: inc.currency };
  const mandatoryUsd = commits.reduce(
    (s: number, c: CommitmentRow) => s + usd(c.amount_minor / 100, c.currency, pu),
    0,
  );
  const w = computeWaterfall({
    income,
    baseIncomeUsd: usd(p.income_minor / 100, p.income_currency, pu),
    mandatoryUsd,
    livingCap: { amount: p.living_cap_minor / 100, currency: p.living_currency },
    bonusPrepayShare: p.bonus_prepay_share,
    bonusDcaShare: p.bonus_dca_share,
    // целей DCA пока нет (шаг 6) — {USD:1}: при dca_share=0 не используется
    dcaTargets: { USD: 1 },
    fx: { perUsd: pu },
  });
  const top = [...commits]
    .sort((a, b) => b.amount_minor - a.amount_minor)
    .slice(0, 5)
    .map(
      (c) =>
        `  • ${escapeHtml(c.name)} — ${fmtMoney(c.amount_minor / 100, c.currency)}${c.due_day ? ` (${c.due_day})` : ''}`,
    )
    .join('\n');
  const incLabel =
    inc.source === 'override'
      ? ' (задано вручную)'
      : inc.source === 'actual'
        ? ` — факт за ${month}`
        : inc.source === 'typical'
          ? ' — типичный, факт за месяц не введён'
          : ' — доход не указан, /income';
  const lines = [
    `📊 <b>План месяца</b>`,
    `💵 Доход: <b>${fmtMoney(round2(w.incomeUsd), 'USD')}</b>` +
      (income.currency !== 'USD' ? ` (${fmtMoney(income.amount, income.currency)})` : '') +
      `<i>${incLabel}</i>`,
    `🧾 Обязательства: −${fmtMoney(round2(mandatoryUsd), 'USD')}` + (commits.length ? `\n${top}` : ' (нет)'),
    `🍽 Лимит жизни: −${fmtMoney(round2(w.livingUsd), 'USD')} (${fmtMoney(p.living_cap_minor / 100, p.living_currency)})`,
    `💚 <b>Свободный профицит: ${fmtMoney(round2(w.surplusUsd), 'USD')}${inc.source === 'none' ? ' (без дохода)' : ''}</b>`,
    inc.count > 0 ? `<i>Доход за ${month}: ${inc.count} записей</i>` : '',
  ].filter(Boolean);
  if (p.bonus_prepay_share + p.bonus_dca_share > 0 && w.bonusDeltaUsd > 0) {
    lines.push(
      `🎁 Дельта бонуса: +${fmtMoney(round2(w.bonusDeltaUsd), 'USD')}` +
        ` → досрочка ${fmtMoney(round2(w.toPrepayUsd), 'USD')} · DCA ${fmtMoney(round2(w.toDcaUsd), 'USD')}`,
    );
  }
  lines.push(
    `<i>Курсы на ${escapeHtml(fxr.asOf || '—')}${fxr.stale ? ' — курсы устарели, провайдер недоступен' : ''}</i>`,
  );
  await tg.sendMessage(chatId, lines.join('\n'));
}

export async function runSpent(
  chatId: number,
  tg: TelegramClient,
  repo: Repo,
  fx: FxLike,
  text: string,
  sourceKey: string,
  todayIso: string,
): Promise<void> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) {
    await tg.sendMessage(chatId, 'Сначала настройка — /start');
    return;
  }
  let a;
  try {
    a = parseAmount(text);
  } catch (e) {
    await tg.sendMessage(chatId, (e as Error).message);
    return;
  }
  const ccy = a.currency ?? p.living_currency;
  let fxr: FxResult;
  try {
    fxr = await fxFor(fx, [ccy, p.living_currency]);
  } catch {
    await tg.sendMessage(chatId, FX_FAIL);
    return;
  }
  const livingValue = convert(a.amount, ccy, p.living_currency, { perUsd: fxr.perUsd });
  const cap = p.living_cap_minor / 100;
  if (livingValue > cap * 5) {
    await tg.sendMessage(
      chatId,
      `Сумма ${fmtMoney(round2(livingValue), p.living_currency)} выглядит нереально для траты (лимит ×5). Проверьте ввод.`,
    );
    return;
  }
  const r = await repo.addExpense({
    spent_on: todayIso,
    amount_minor: Math.round(a.amount * 100),
    currency: ccy,
    note: a.note ?? null,
    source: 'manual',
    source_key: sourceKey,
  });
  if (r.meta.changes === 0) return; // дубликат update_id — молча
  await runWeek(
    chatId,
    tg,
    repo,
    fx,
    todayIso,
    `Записал: ${fmtMoney(a.amount, ccy)}${a.note ? ` (${escapeHtml(a.note)})` : ''}\n\n`,
  );
}

export async function runWeek(
  chatId: number,
  tg: TelegramClient,
  repo: Repo,
  fx: FxLike,
  todayIso: string,
  prefix = '',
): Promise<void> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) {
    await tg.sendMessage(chatId, 'Сначала настройка — /start');
    return;
  }
  const expenses = (await repo.listExpenses()).results;
  let fxr: FxResult;
  try {
    fxr = await fxFor(fx, [p.living_currency, ...expenses.map((e) => e.currency)]);
  } catch {
    await tg.sendMessage(chatId, FX_FAIL);
    return;
  }
  const inLiving = expenses.map((e) => ({
    date: e.spent_on,
    amount: convert(e.amount_minor / 100, e.currency, p.living_currency, { perUsd: fxr.perUsd }),
  }));
  const s = weeklyStatus({
    expenses: inLiving,
    today: todayIso,
    monthlyCap: p.living_cap_minor / 100,
    weeklyBudget: p.weekly_budget_minor / 100,
  });
  const c = p.living_currency;
  const lines = [
    `📅 <b>Неделя</b>: ${fmtMoney(round2(s.weekSpent), c)} из ${fmtMoney(round2(s.weekBudget), c)}` +
      ` — ${s.weekOver ? '🔴 перерасход' : `остаток ${fmtMoney(round2(s.weekRemaining), c)}`}`,
    `🗓 Месяц: ${fmtMoney(round2(s.monthSpent), c)} из ${fmtMoney(round2(s.monthCap), c)}` +
      ` · burn rate ${fmtPct(s.burnRate)}${s.burnRate > 1 ? ' ⚠️' : ''}`,
    `💵 В день до конца месяца: ${fmtMoney(round2(s.dailyAllowance), c)} (${s.daysLeft} дн.)`,
  ];
  if (!expenses.length) lines.push('Пока нет трат — запишите через «➕ Трата».');
  await tg.sendMessage(chatId, prefix + lines.join('\n'));
}

/** /income — факт дохода за ТЕКУЩИЙ месяц в таймзоне пользователя. */
export async function runIncome(
  chatId: number,
  tg: TelegramClient,
  repo: Repo,
  fx: FxLike,
  text: string,
  sourceKey: string,
  monthIso: string,
): Promise<void> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) {
    await tg.sendMessage(chatId, 'Сначала настройка — /start');
    return;
  }
  let a;
  try {
    a = parseAmount(text);
  } catch (e) {
    await tg.sendMessage(chatId, (e as Error).message);
    return;
  }
  const ccy = a.currency ?? p.income_currency;
  const r = await repo.addIncomeEntry({
    month: monthIso,
    amount_minor: Math.round(a.amount * 100),
    currency: ccy,
    note: a.note ?? null,
    source_key: sourceKey,
  });
  if (r.meta.changes === 0) return; // дубликат update_id — молча
  const entries = (await repo.listIncomeEntries(monthIso)).results;
  let total = '';
  try {
    const fxr = await fxFor(fx, [p.income_currency, ...entries.map((e) => e.currency)]);
    const sum = entries.reduce(
      (s, e) => s + convert(e.amount_minor / 100, e.currency, p.income_currency, { perUsd: fxr.perUsd }),
      0,
    );
    total = ` — итого за ${monthIso}: ${fmtMoney(round2(sum), p.income_currency)}`;
  } catch {
    total = ' — курсы недоступны, итог позже';
  }
  await tg.sendMessage(
    chatId,
    `Записал доход: ${fmtMoney(a.amount, ccy)}${a.note ? ` (${escapeHtml(a.note)})` : ''}${total}\n/plan покажет расклад.`,
  );
}

/** /income без аргументов — список записей месяца с кнопками удаления. */
export async function runIncomeList(chatId: number, tg: TelegramClient, repo: Repo, monthIso: string): Promise<void> {
  const entries = (await repo.listIncomeEntries(monthIso)).results;
  const incomeSectionText = entries.length
    ? entries
        .map((e) => `  • ${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` (${escapeHtml(e.note)})` : ''}`)
        .join('\n')
    : '  записей за месяц нет';
  await repo.setConversation('pf:income_list', '{}');
  await tg.sendMessage(chatId, `💵 Доход за ${monthIso}:\n${incomeSectionText}`, {
    replyMarkup: {
      inline_keyboard: entries.map((e) => [
        {
          text: `🗑 ${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` ${e.note}` : ''}`,
          callback_data: `in:del:${e.id}`,
        },
      ]),
    },
  });
}

export async function runProfile(chatId: number, tg: TelegramClient, repo: Repo): Promise<void> {
  const p = await repo.getProfile();
  if (!p) {
    await tg.sendMessage(chatId, 'Профиль не настроен — /start');
    return;
  }
  const ctx: PfCtx = {
    profile: p,
    commitments: (await repo.listCommitments(false)).results,
    incomeEntries: (await repo.listIncomeEntries(monthInTz(p.timezone, new Date()))).results,
  };
  await repo.setConversation('pf', '{}'); // меню активно — кнопки живут 24ч
  await tg.sendMessage(chatId, profileMenuText(ctx), { replyMarkup: MAIN_MENU_KB });
}
