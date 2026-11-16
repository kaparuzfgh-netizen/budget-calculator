/**
 * features.ts — команды онбоарденных пользователей: /plan /spent /week /profile.
 * Все чтения БД — через scoped(userId); курсы — через fx-сервис.
 */
import { computeWaterfall } from '../domain/cashflow';
import { weeklyStatus } from '../domain/budget';
import { matchCategory } from '../domain/categories';
import { convert, round2 } from '../domain/money';
import { cadenceLabel, monthlyAmount } from '../domain/schedule';
import type { Period } from '../domain/report';
import { buildUserReport } from '../services/report';
import { baselineIncome } from '../services/baseline';
import type { FxResult } from '../fx/service';
import type { CategoryRow, CommitmentRow, DebtRow, ExpenseRow, IncomeEntryRow } from '../db/repo';
import type { ReplyMarkup, TelegramClient } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import { fmtMoney, fmtPct } from './format';
import { monthInTz, parseAmount, todayInTz, weekStartInTz, weekStartOfIso } from './parse';
import { renderPf, type PfCtx } from './profile';
import { HOME_ROW } from './nav/nav';
const HOME_MK = { inline_keyboard: [HOME_ROW] };
/** WEEK: кнопка списка трат + навигация домой. */
const WEEK_MK: ReplyMarkup = {
  inline_keyboard: [[{ text: '📋 Траты недели', callback_data: 'ex:list' }], HOME_ROW],
};

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
 * override (аргумент /plan) > сумма записей месяца («факт») > базовый доход
 * (явный income_minor > 0 → 'typical') > вычисленный из обязательств
 * (income_minor = 0 → 'computed', передаётся как baseline) > нет.
 * Записи конвертируются в incomeCcy через USD.
 */
export function resolveIncome(opts: {
  entries: Pick<IncomeEntryRow, 'amount_minor' | 'currency'>[];
  typicalMinor: number;
  incomeCcy: string;
  perUsd: Record<string, number>;
  override?: { amount: number; currency: string };
  /** расчётный базовый доход (services/baseline.ts) — уже в валюте дохода. */
  baseline?: { amount: number; currency: string };
}): { amount: number; currency: string; source: 'override' | 'actual' | 'typical' | 'computed' | 'none'; count: number } {
  const { entries, typicalMinor, incomeCcy, perUsd, override, baseline } = opts;
  if (override)
    return { amount: override.amount, currency: override.currency, source: 'override', count: entries.length };
  if (entries.length) {
    const sum = entries.reduce((s, e) => s + convert(e.amount_minor / 100, e.currency, incomeCcy, { perUsd }), 0);
    return { amount: sum, currency: incomeCcy, source: 'actual', count: entries.length };
  }
  if (typicalMinor > 0) return { amount: typicalMinor / 100, currency: incomeCcy, source: 'typical', count: 0 };
  if (baseline && baseline.amount > 0)
    return { amount: baseline.amount, currency: incomeCcy, source: 'computed', count: 0 };
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
  // базовый доход: явный (income_minor>0) или вычисленный из обязательств
  let base: Awaited<ReturnType<typeof baselineIncome>>;
  let fxr: FxResult;
  try {
    base = await baselineIncome(repo, p, fx, todayInTz(p.timezone, new Date()));
    fxr = await fxFor(fx, [
      p.income_currency,
      p.living_currency,
      base.currency,
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
    ...(base.source === 'computed' ? { baseline: { amount: base.amount, currency: base.currency } } : {}),
  });
  const income = { amount: inc.amount, currency: inc.currency };
  // месячный эквивалент по каденсу: interval → ×30.4375/n, yearly → /12
  const mandatoryUsd = commits.reduce(
    (s: number, c: CommitmentRow) => s + usd(monthlyAmount(c), c.currency, pu),
    0,
  );
  const w = computeWaterfall({
    income,
    baseIncomeUsd: usd(base.amount, base.currency, pu),
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
        `  • ${escapeHtml(c.name)} — ${fmtMoney(c.amount_minor / 100, c.currency)}${c.due_day || c.frequency !== 'monthly' ? ` (${cadenceLabel(c)})` : ''}`,
    )
    .join('\n');
  const incLabel =
    inc.source === 'override'
      ? ' (задано вручную)'
      : inc.source === 'actual'
        ? ` — факт за ${month}`
        : inc.source === 'typical'
          ? ' — базовый, факт за месяц не введён'
          : inc.source === 'computed'
            ? ' — расчёт: платежи + бюджет + кредиты'
            : ' — доход не указан, /income';
  const lines = [
    `📊 <b>План месяца</b>`,
    `💵 Доход: <b>${fmtMoney(round2(w.incomeUsd), 'USD')}</b>` +
      (income.currency !== 'USD' ? ` (${fmtMoney(income.amount, income.currency)})` : '') +
      `<i>${incLabel}</i>`,
    `🧾 Регулярные платежи: −${fmtMoney(round2(mandatoryUsd), 'USD')}` + (commits.length ? `\n${top}` : ' (нет)'),
    `💸 Бюджет: −${fmtMoney(round2(w.livingUsd), 'USD')} (${fmtMoney(p.living_cap_minor / 100, p.living_currency)})`,
    `💚 <b>Свободный профицит: ${fmtMoney(round2(w.surplusUsd), 'USD')}${inc.source === 'none' ? ' (без дохода)' : ''}</b>`,
    inc.count > 0 ? `<i>Доход за ${month}: ${inc.count} записей</i>` : '',
  ].filter(Boolean);
  if (p.bonus_prepay_share + p.bonus_dca_share > 0 && w.bonusDeltaUsd > 0) {
    // целевая досрочка — активный кредит с максимальной ставкой
    const target =
      w.toPrepayUsd > 0
        ? (await repo.listDebts()).results.reduce<DebtRow | null>(
            (m, d) => (d.rate > 0 && (m === null || d.rate > m.rate) ? d : m),
            null,
          )
        : null;
    lines.push(
      `🎁 Дельта бонуса: +${fmtMoney(round2(w.bonusDeltaUsd), 'USD')}` +
        ` → досрочка ${fmtMoney(round2(w.toPrepayUsd), 'USD')}${target ? ` («${escapeHtml(target.name)}»)` : ''} · DCA ${fmtMoney(round2(w.toDcaUsd), 'USD')}`,
    );
  }
  lines.push(
    `<i>Курсы на ${escapeHtml(fxr.asOf || '—')}${fxr.stale ? ' — курсы устарели, провайдер недоступен' : ''}</i>`,
  );
  await tg.sendMessage(chatId, lines.join('\n'), { replyMarkup: HOME_MK });
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
  const ccy = a.currency ?? p.expense_currency ?? p.living_currency;
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
      `Сумма ${fmtMoney(round2(livingValue), p.living_currency)} выглядит нереально для траты (бюджет ×5). Проверьте ввод.`,
    );
    return;
  }
  await repo.ensureCategories();
  const cats = (await repo.listCategories()).results;
  const m = matchCategory(a.note ?? null, cats);
  const r = await repo.addExpense({
    spent_on: todayIso,
    amount_minor: Math.round(a.amount * 100),
    currency: ccy,
    note: m.note,
    source: 'manual',
    source_key: sourceKey,
    category_id: m.categoryId,
  });
  if (r.meta.changes === 0) return; // дубликат update_id — молча
  const ex = (await repo.getExpense(Number(r.meta.last_row_id)))!;
  const view = await spentView(repo, p, fx, ex, cats, todayIso);
  await tg.sendMessage(chatId, view.text, { replyMarkup: view.mk });
}

/** Текст и клавиатура записанной траты: компактная строка + статус недели. */
async function spentView(
  repo: Repo,
  p: { living_currency: string; living_cap_minor: number; weekly_budget_minor: number },
  fx: FxLike,
  ex: ExpenseRow,
  cats: CategoryRow[],
  todayIso: string,
  forcePicker = false,
): Promise<{ text: string; mk: ReplyMarkup }> {
  const weekStart = weekStartOfIso(todayIso);
  const expenses = (await repo.listExpenses(weekStart)).results;
  const fxr = await fxFor(fx, [p.living_currency, ...expenses.map((e) => e.currency)]);
  const weekSpent = expenses.reduce(
    (s, e) => s + convert(e.amount_minor / 100, e.currency, p.living_currency, { perUsd: fxr.perUsd }),
    0,
  );
  const budget = p.weekly_budget_minor / 100;
  const c = p.living_currency;
  const cat = cats.find((x) => x.id === ex.category_id) ?? null;
  const head =
    `✅ Записал ${fmtMoney(round2(ex.amount_minor / 100), ex.currency)}` +
    (cat ? ` · ${cat.emoji} ${escapeHtml(cat.name)}` : '') +
    (ex.note ? ` — ${escapeHtml(ex.note)}` : '');
  const week =
    `Неделя: ${fmtMoney(round2(weekSpent), c)} из ${fmtMoney(round2(budget), c)} · ` +
    (weekSpent > budget
      ? `🔴 перерасход бюджета ${fmtMoney(round2(weekSpent - budget), c)}`
      : `остаток ${fmtMoney(round2(budget - weekSpent), c)}`);
  const undoEdit = [
    { text: '↩ Отменить', callback_data: `ex:undo:${ex.id}` },
    { text: '✏️ Изменить', callback_data: `ex:e:${ex.id}` },
  ];
  if (cat && !forcePicker) {
    return {
      text: `${head}\n${week}`,
      mk: { inline_keyboard: [[{ text: '🏷 Категория', callback_data: `ex:cg:${ex.id}` }], undoEdit, HOME_ROW] },
    };
  }
  // пикер: до 9 активных категорий, по 3 в ряд
  const pick = cats.filter((x) => !x.archived).slice(0, 9);
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < pick.length; i += 3)
    rows.push(
      pick.slice(i, i + 3).map((x) => ({
        text: `${x.emoji} ${x.name.length > 10 ? `${x.name.slice(0, 9)}…` : x.name}`,
        callback_data: `ex:sc:${ex.id}:${x.id}`,
      })),
    );
  return {
    text: `${head}\n${week}\n\nВыберите категорию:`,
    mk: { inline_keyboard: [...rows, undoEdit, HOME_ROW] },
  };
}

/** Колбэки категории траты: ex:cg:<id> — показать пикер; ex:sc:<id>:<cat> — назначить. */
export async function handleExCategory(
  data: string,
  chatId: number,
  messageId: number | undefined,
  repo: Repo,
  fx: FxLike,
  tg: TelegramClient,
  todayIso: string,
): Promise<void> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) return;
  const send = async (text: string, mk: ReplyMarkup) => {
    if (messageId && tg.editMessageText) {
      try {
        await tg.editMessageText(chatId, messageId, text, { replyMarkup: mk });
        return;
      } catch {
        /* упало редактирование — шлём новым сообщением */
      }
    }
    await tg.sendMessage(chatId, text, { replyMarkup: mk });
  };
  const cg = /^ex:cg:(\d+)$/.exec(data);
  if (cg) {
    const ex = await repo.getExpense(Number(cg[1]));
    if (!ex) return; // чужая/удалённая — молча
    const cats = (await repo.listCategories()).results;
    const view = await spentView(repo, p, fx, ex, cats, todayIso, true);
    await send(view.text, view.mk);
    return;
  }
  const sc = /^ex:sc:(\d+):(\d+)$/.exec(data);
  if (sc) {
    const ex = await repo.getExpense(Number(sc[1]));
    const cat = await repo.getCategory(Number(sc[2]));
    if (!ex || !cat) return; // чужие id — молча (R7)
    await repo.patchExpense(ex.id, { category_id: cat.id });
    const ex2 = (await repo.getExpense(ex.id))!;
    const cats = (await repo.listCategories()).results;
    const view = await spentView(repo, p, fx, ex2, cats, todayIso);
    await send(view.text, view.mk);
    return;
  }
}

const RP_PERIODS: { p: Period; label: string }[] = [
  { p: 'week', label: 'Неделя' },
  { p: 'month', label: 'Месяц' },
  { p: 'quarter', label: 'Квартал' },
  { p: 'half', label: 'Полгода' },
  { p: 'year', label: 'Год' },
];

function reportMarkup(period: Period, offset: number): ReplyMarkup {
  const btn = (p: Period, label: string) => ({
    text: `${p === period ? '• ' : ''}${label}`,
    callback_data: `rp:${p}:${offset}`,
  });
  const nav = [{ text: '‹ Раньше', callback_data: `rp:${period}:${offset - 1}` }];
  if (offset < 0) nav.push({ text: 'Позже ›', callback_data: `rp:${period}:${offset + 1}` });
  return {
    inline_keyboard: [
      RP_PERIODS.slice(0, 3).map((x) => btn(x.p, x.label)),
      RP_PERIODS.slice(3).map((x) => btn(x.p, x.label)),
      nav,
      HOME_ROW,
    ],
  };
}

function renderReport(rep: NonNullable<Awaited<ReturnType<typeof buildUserReport>>>): string {
  const c = rep.currency;
  const m = (minor: number) => fmtMoney(round2(minor / 100), c);
  const pctDelta =
    rep.prev.spent_total > 0 ? Math.round((rep.spent.total / rep.prev.spent_total - 1) * 100) : null;
  const lines = [
    `📈 <b>${escapeHtml(rep.label)}</b>`,
    `Получено: ${m(rep.received.total)}`,
    `Потрачено: ${m(rep.spent.total)}`,
    `  • Повседневные: ${m(rep.spent.living)}${rep.living_limit.cap > 0 ? ` (${Math.round(rep.living_limit.used_pct * 100)}% бюджета)` : ''}`,
    `  • Регулярные платежи: ${m(rep.spent.commitments)}`,
    `  • Кредиты: ${m(rep.spent.credits)}`,
    `  • Долги людям: ${m(rep.spent.loans_repaid)}`,
    `Итог: ${rep.net >= 0 ? '+' : '−'}${m(Math.abs(rep.net))}` +
      (pctDelta !== null ? ` (${pctDelta >= 0 ? '▲' : '▼'} ${Math.abs(pctDelta)}% расходов к ${escapeHtml(rep.prev.label)})` : ''),
  ];
  if (rep.categories.length) {
    lines.push('', 'По категориям:');
    for (const cat of rep.categories.slice(0, 10))
      lines.push(`${cat.emoji} ${escapeHtml(cat.name)} — ${m(cat.amount)} · ${Math.round(cat.share * 100)}%`);
  }
  lines.push('', `<i>Курсы на ${escapeHtml(rep.fx_as_of || '—')}</i>`);
  return lines.join('\n');
}

/** /report и rp:<period>:<offset> (правка сообщения вместо нового). */
export async function runReport(
  chatId: number,
  tg: TelegramClient,
  repo: Repo,
  fx: FxLike,
  period: Period,
  offset: number,
  messageId?: number,
): Promise<void> {
  const rep = await buildUserReport(repo, (ccys) => fx.get(ccys), period, offset, new Date());
  if (!rep) {
    await tg.sendMessage(chatId, 'Сначала настройка — /start');
    return;
  }
  const text = renderReport(rep);
  const mk = reportMarkup(period, offset);
  if (messageId && tg.editMessageText) {
    try {
      await tg.editMessageText(chatId, messageId, text, { replyMarkup: mk });
      return;
    } catch {
      /* fallback — новое сообщение */
    }
  }
  await tg.sendMessage(chatId, text, { replyMarkup: mk });
}

export async function runWeek(
  chatId: number,
  tg: TelegramClient,
  repo: Repo,
  fx: FxLike,
  todayIso: string,
  prefix = '',
  markup?: ReplyMarkup,
): Promise<void> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) {
    await tg.sendMessage(chatId, 'Сначала настройка — /start');
    return;
  }
  // P2-1: weeklyStatus считает только неделю и месяц todayIso — читаем не всё,
  // а от min(понедельник недели, начало месяца). todayIso уже локальная дата.
  const weekStart = weekStartOfIso(todayIso);
  const monthStart = `${todayIso.slice(0, 7)}-01`;
  const expenses = (await repo.listExpenses(weekStart < monthStart ? weekStart : monthStart)).results;
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
      ` — ${s.weekOver ? '🔴 перерасход бюджета' : `остаток ${fmtMoney(round2(s.weekRemaining), c)}`}`,
    `🗓 Месяц: ${fmtMoney(round2(s.monthSpent), c)} из ${fmtMoney(round2(s.monthCap), c)}` +
      ` · burn rate ${fmtPct(s.burnRate)}${s.burnRate > 1 ? ' ⚠️' : ''}`,
    `💵 В день до конца месяца: ${fmtMoney(round2(s.dailyAllowance), c)} (${s.daysLeft} дн.)`,
  ];
  if (!expenses.length) lines.push('Пока нет трат — запишите через «➕ Трата».');
  await tg.sendMessage(chatId, prefix + lines.join('\n'), { replyMarkup: markup ?? WEEK_MK });
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
): Promise<boolean> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) {
    await tg.sendMessage(chatId, 'Сначала настройка — /start');
    return false;
  }
  let a;
  try {
    a = parseAmount(text);
  } catch (e) {
    await tg.sendMessage(chatId, (e as Error).message);
    return false;
  }
  const ccy = a.currency ?? p.income_currency;
  const r = await repo.addIncomeEntry({
    month: monthIso,
    amount_minor: Math.round(a.amount * 100),
    currency: ccy,
    note: a.note ?? null,
    source_key: sourceKey,
    received_on: todayInTz(p.timezone, new Date()),
  });
  if (r.meta.changes === 0) return false; // дубликат update_id — молча
  return true;
}

export async function runProfile(chatId: number, tg: TelegramClient, repo: Repo, fx?: FxLike): Promise<void> {
  const p = await repo.getProfile();
  if (!p) {
    await tg.sendMessage(chatId, 'Профиль не настроен — /start');
    return;
  }
  const now = new Date();
  const month = monthInTz(p.timezone, now);
  const today = todayInTz(p.timezone, now);
  // расчётный базовый доход для подписи (best-effort — без FX только состав)
  let baseline: PfCtx['baseline'];
  if (!p.income_minor && fx) {
    try {
      const b = await baselineIncome(repo, p, fx, today);
      if (b.source === 'computed') baseline = { amount: b.amount, currency: b.currency };
    } catch {
      baseline = undefined;
    }
  }
  const ctx: PfCtx = {
    profile: p,
    commitments: (await repo.listCommitments(false)).results,
    commitPayments: (
      await repo.listCommitmentPaymentsSince(`${Number(month.slice(0, 4)) - 1}${month.slice(4)}-01`)
    ).results,
    incomeEntries: (await repo.listIncomeEntries(month)).results,
    expenses: (await repo.listExpenses(weekStartInTz(p.timezone, now))).results,
    categories: (await repo.listCategories(true)).results,
    month,
    today,
    baseline,
  };
  const r = renderPf('PF_HOME', {}, ctx);
  await repo.setConversation(r.step, '{}'); // меню активно — кнопки живут 24ч
  await tg.sendMessage(chatId, r.text, r.markup ? { replyMarkup: r.markup } : {});
}
