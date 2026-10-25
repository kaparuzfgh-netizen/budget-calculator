/**
 * features.ts — команды онбоарденных пользователей: /plan /spent /week /profile.
 * Все чтения БД — через scoped(userId); курсы — через fx-сервис.
 */
import { computeWaterfall } from '../domain/cashflow';
import { weeklyStatus } from '../domain/budget';
import { convert, round2 } from '../domain/money';
import type { FxResult } from '../fx/service';
import type { CommitmentRow } from '../db/repo';
import type { TelegramClient } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import { fmtMoney, fmtPct } from './format';
import { parseAmount } from './parse';

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

export async function runPlan(
  chatId: number,
  tg: TelegramClient,
  repo: Repo,
  fx: FxLike,
  argText: string,
): Promise<void> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) {
    await tg.sendMessage(chatId, 'Сначала настройка — /start');
    return;
  }
  const commits = (await repo.listCommitments()).results;
  let income = { amount: p.income_minor / 100, currency: p.income_currency };
  if (argText.trim()) {
    try {
      const a = parseAmount(argText);
      income = { amount: a.amount, currency: a.currency ?? p.income_currency };
    } catch (e) {
      await tg.sendMessage(chatId, (e as Error).message);
      return;
    }
  }
  let fxr: FxResult;
  try {
    fxr = await fxFor(fx, [p.income_currency, p.living_currency, income.currency, ...commits.map((c) => c.currency)]);
  } catch {
    await tg.sendMessage(chatId, FX_FAIL);
    return;
  }
  const pu = fxr.perUsd;
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
  const lines = [
    `📊 <b>План месяца</b>`,
    `💵 Доход: <b>${fmtMoney(round2(w.incomeUsd), 'USD')}</b>` +
      (income.currency !== 'USD' ? ` (${fmtMoney(income.amount, income.currency)})` : ''),
    `🧾 Обязательства: −${fmtMoney(round2(mandatoryUsd), 'USD')}` + (commits.length ? `\n${top}` : ' (нет)'),
    `🍽 Лимит жизни: −${fmtMoney(round2(w.livingUsd), 'USD')} (${fmtMoney(p.living_cap_minor / 100, p.living_currency)})`,
    `💚 <b>Свободный профицит: ${fmtMoney(round2(w.surplusUsd), 'USD')}</b>`,
  ];
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

export async function runProfile(chatId: number, tg: TelegramClient, repo: Repo): Promise<void> {
  const p = await repo.getProfile();
  if (!p) {
    await tg.sendMessage(chatId, 'Профиль не настроен — /start');
    return;
  }
  const commits = (await repo.listCommitments()).results;
  const lines = [
    '⚙️ <b>Профиль</b>',
    `Доход: ${fmtMoney(p.income_minor / 100, p.income_currency)} · лимит жизни: ${fmtMoney(p.living_cap_minor / 100, p.living_currency)}`,
    `Недельный бюджет: ${fmtMoney(p.weekly_budget_minor / 100, p.living_currency)} · таймзона: ${escapeHtml(p.timezone)}`,
    commits.length
      ? 'Платежи:\n' +
        commits
          .map(
            (c) =>
              `  • ${escapeHtml(c.name)} — ${fmtMoney(c.amount_minor / 100, c.currency)}${c.due_day ? ` (${c.due_day})` : ''}`,
          )
          .join('\n')
      : 'Платежей нет.',
  ];
  await tg.sendMessage(chatId, lines.join('\n'), {
    replyMarkup: { inline_keyboard: [[{ text: '🔁 Пройти настройку заново', callback_data: 'ob:reset' }]] },
  });
}
