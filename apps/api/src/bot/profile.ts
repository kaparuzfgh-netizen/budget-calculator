/**
 * profile.ts — редактирование профиля + факт дохода.
 * ЧИСТЫЙ редьюсер advancePf(state, input, ctx) → {state, effects}; I/O — access.ts.
 * renderPf(screenId, data, ctx) — ЕДИНСТВЕННЫЙ источник разметки экранов:
 *   экшн-кнопки + навигационный ряд из navRow() реестра (R1–R4) — ручных
 *   назад/меню/отмена в экранах нет.
 */
import type { ReplyMarkup } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import type { CommitmentPaymentRow, CommitmentRow, ExpenseRow, IncomeEntryRow, ProfileRow } from '../db/repo';
import { fmtMoney } from './format';
import { isValidTimezone, parseAmount, parseCommitmentLine, parseCurrencyCode, type ParsedCommitment } from './parse';
import { parseAmountDate } from './debts';
import { toMinor } from '../domain/money';
import { cancelBtn, navRow } from './nav/nav';
import type { InlineButton } from '../telegram/client';

export interface PfState {
  step: string;
  data: {
    commitId?: number | undefined;
    cpayId?: number | undefined;
    incomeId?: number | undefined;
    expenseId?: number | undefined;
    pendingCcy?: string | undefined;
    ccyTarget?: 'income' | 'living' | undefined;
    origin?: string | undefined; // экран-источник для «Назад»/«Отмена»
  };
}

export interface PfCtx {
  profile: ProfileRow;
  commitments: CommitmentRow[];
  commitPayments: CommitmentPaymentRow[]; // журнал оплат платежей (окно ~год)
  incomeEntries: IncomeEntryRow[];
  expenses: ExpenseRow[]; // траты текущей локальной недели
  month: string;
  today: string; // 'YYYY-MM-DD' локально
  incomeTotal?: string | undefined; // итог месяца в валюте дохода (из FX, может быть '—')
}

export type PfInput = { type: 'text'; text: string } | { type: 'callback'; data: string };

export type ProfilePatch = {
  reminders_weekly?: number;
  reminders_payments?: number;
  vision_enabled?: number;
  fx_alerts_enabled?: number;
  income_minor?: number;
  living_cap_minor?: number;
  weekly_budget_minor?: number;
  income_currency?: string;
  living_currency?: string;
  timezone?: string;
};

export type PfEffect =
  | { kind: 'send'; text: string; markup?: ReplyMarkup }
  | { kind: 'patch'; patch: ProfilePatch }
  | { kind: 'commit_add'; c: ParsedCommitment }
  | {
      kind: 'commit_patch';
      id: number;
      patch: { amount_minor?: number; currency?: string; due_day?: number | null; active?: number };
    }
  | { kind: 'commit_del'; id: number }
  | { kind: 'cpay_add'; id: number } // ручная «✅ Оплачено» по платежу id (commitment)
  | { kind: 'cpay_patch'; id: number; patch: { amount_minor?: number; paid_on?: string } }
  | { kind: 'cpay_del'; id: number }
  | { kind: 'income_del'; id: number }
  | { kind: 'checkCcy'; code: string; target: 'income' | 'living' }
  // render — экран рендерится ПОСЛЕ мутаций из свежего ctx (runPfEffects перечитывает данные)
  | { kind: 'render'; screen: string; data?: PfState['data'] | undefined; prefix?: string | undefined }
  // export/delete_me — обрабатываются в runPfEffects (нужен tg/repo)
  | { kind: 'export' }
  | { kind: 'delete_me' }
  | { kind: 'expense_del'; id: number }
  | { kind: 'expense_patch'; id: number; patch: { amount_minor?: number; currency?: string; note?: string | null } };

const send = (text: string, markup?: ReplyMarkup): PfEffect => ({ kind: 'send', text, ...(markup ? { markup } : {}) });
const ok = (state: PfState | null, ...effects: PfEffect[]) => ({ state, effects });

// ── step ↔ screenId (реестр screens.json) ──
export const STEP_SCREEN: Record<string, string> = {
  pf: 'PF_HOME',
  'pf:income': 'PF_INCOME',
  'pf:living': 'PF_LIVING',
  'pf:commits': 'PF_COMMITS',
  'pf:commit': 'PF_COMMIT',
  'pf:cpay': 'PF_CPAY',
  edit_cpay: 'PF_CPAY_EDIT',
  confirm_del_cpay: 'PF_CPAY_DEL',
  'pf:ccytz': 'PF_LOCALE',
  edit_typical: 'PF_TYPICAL_ASK',
  edit_living: 'PF_LIVING_ASK',
  add_commit: 'PF_COMMIT_ADD',
  edit_commit_amount: 'PF_COMMIT_AMOUNT',
  edit_commit_day: 'PF_COMMIT_DAY',
  confirm_del_commit: 'PF_COMMIT_DEL',
  edit_income_ccy: 'PF_LOCALE_PICK',
  edit_living_ccy: 'PF_LOCALE_PICK',
  edit_tz: 'PF_LOCALE_PICK',
  edit_tz_custom: 'PF_LOCALE_PICK',
  'pf:reminders': 'PF_REMINDERS',
  'pf:data': 'PF_DATA',
  'pf:delete': 'PF_DELETE_ASK',
  income_hub: 'INCOME_HUB',
  income_ask: 'INCOME_ASK',
  income_list: 'INCOME_LIST',
  confirm_del_income: 'INCOME_DEL',
  spent_ask: 'SPENT_ASK',
  expenses_list: 'EXPENSES_LIST',
  expense: 'EXPENSE',
  expense_del: 'EXPENSE_DEL',
  edit_expense: 'EXPENSE_EDIT_ASK',
};

/** Разрешённые callback-префиксы на каждом шаге (step-aware, R7). nv:* обрабатываются вне редьюсера. */
export const PF_STEPS: Record<string, string> = {
  pf: 'pf:|ex:',
  expenses_list: 'ex:',
  expense: 'ex:',
  expense_del: 'ex:',
  edit_expense: 'ex:',
  'pf:income': 'pf:',
  'pf:living': 'pf:liv|pf:sec:',
  'pf:commits': 'pf:cm:|pf:cadd|pf:sec:|pf:menu',
  'pf:commit': 'pf:c|pf:sec:',
  'pf:cpay': 'pf:cpe:|pf:cpd:|pf:sec:',
  edit_cpay: 'pf:sec:',
  confirm_del_cpay: 'pf:cpdy$|pf:sec:',
  'pf:ccytz': 'pf:ccy:|pf:tz$|pf:sec:',
  'pf:reminders': 'pf:rem:|pf:sec:',
  'pf:data': 'pf:exp|pf:del:|pf:sec:',
  'pf:delete': 'pf:del:',
  'pf:income_list': 'in:|pf:sec:',
  edit_typical: 'pf:typ0|pf:sec:',
  edit_living: 'pf:sec:',
  edit_commit_amount: 'pf:sec:',
  edit_commit_day: 'pf:sec:',
  add_commit: 'pf:sec:',
  confirm_del_commit: 'pf:cdel:',
  edit_income_ccy: 'pf:sec:',
  edit_living_ccy: 'pf:sec:',
  edit_tz: 'pf:tzv:|pf:sec:',
  edit_tz_custom: 'pf:sec:',
  income_hub: 'inc:|pf:sec:',
  income_ask: 'inc:',
  income_list: 'in:|inc:|pf:sec:',
  confirm_del_income: 'in:del:',
};

/** Реестр разделов — будущие «кредиты»/«инвестиции» добавляются строкой + case. */
export const SECTIONS = [
  { key: 'income', label: '💵 Доход', cb: 'pf:sec:income' },
  { key: 'living', label: '🍽 Лимит жизни', cb: 'pf:sec:living' },
  { key: 'commits', label: '🧾 Платежи', cb: 'pf:sec:commits' },
  { key: 'ccytz', label: '🌍 Валюта и пояс', cb: 'pf:sec:ccytz' },
  { key: 'reminders', label: '🔔 Напоминания', cb: 'pf:sec:reminders' },
  { key: 'data', label: '🗄 Мои данные', cb: 'pf:sec:data' },
] as const;

const btn = (text: string, cb: string): InlineButton => ({ text, callback_data: cb });
const kb = (rows: InlineButton[][], screenId: string, backTo?: string): ReplyMarkup => {
  const nav = navRow(screenId, backTo);
  return { inline_keyboard: [...rows, ...(nav ? [nav] : [])] };
};
const promptKb = (screenId: string, extra?: InlineButton[], backTo?: string): ReplyMarkup => {
  const row = navRow(screenId, backTo);
  const rows: InlineButton[][] = extra ? [extra] : [];
  if (row) rows.push(row);
  return { inline_keyboard: rows };
};

// ── тексты экранов ──
export function profileMenuText(ctx: PfCtx): string {
  const p = ctx.profile;
  return (
    '⚙️ <b>Профиль</b>\n' +
    `💵 Доход: типичный ${p.income_minor ? fmtMoney(p.income_minor / 100, p.income_currency) : '—'} · за ${ctx.month} ${ctx.incomeEntries.length} записей\n` +
    `🍽 Лимит жизни: ${fmtMoney(p.living_cap_minor / 100, p.living_currency)} (нед. ${fmtMoney(p.weekly_budget_minor / 100, p.living_currency)})\n` +
    `🧾 Платежи: ${ctx.commitments.filter((c) => c.active).length} активных\n` +
    `🌍 ${escapeHtml(p.timezone)}`
  );
}
export function incomeSectionText(ctx: PfCtx): string {
  const p = ctx.profile;
  const list = ctx.incomeEntries.length
    ? ctx.incomeEntries
        .map((e) => `  • ${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` (${escapeHtml(e.note)})` : ''}`)
        .join('\n')
    : '  записей за месяц нет';
  return (
    `💵 <b>Доход</b>\nТипичный: ${p.income_minor ? fmtMoney(p.income_minor / 100, p.income_currency) : 'не задан'}\n` +
    `Факт за ${ctx.month}:\n${list}`
  );
}
export function commitsText(ctx: PfCtx): string {
  if (!ctx.commitments.length) return '🧾 <b>Платежи</b>\nСписок пуст.';
  return (
    '🧾 <b>Платежи</b>\n' +
    ctx.commitments
      .map(
        (c) =>
          `${c.active ? '' : '⏸ '}${escapeHtml(c.name)} — ${fmtMoney(c.amount_minor / 100, c.currency)}${c.due_day ? ` (${c.due_day})` : ''}`,
      )
      .join('\n')
  );
}
export function commitDetailText(c: CommitmentRow, monthLine?: string): string {
  return (
    `🧾 <b>${escapeHtml(c.name)}</b>\n` +
    `Сумма: ${fmtMoney(c.amount_minor / 100, c.currency)}\n` +
    `День: ${c.due_day ?? '—'}\nСтатус: ${c.active ? 'активен' : '⏸ выключен'}` +
    (monthLine ? `\n${monthLine}` : '')
  );
}

/** 'YYYY-MM-DD' → 'ДД.ММ'. */
const dm = (iso: string) => `${iso.slice(8)}.${iso.slice(5, 7)}`;
export function ccyTzText(ctx: PfCtx): string {
  const p = ctx.profile;
  return (
    '🌍 <b>Валюта и пояс</b>\n' +
    `Валюта дохода: ${p.income_currency} · лимита: ${p.living_currency}\nТаймзона: ${escapeHtml(p.timezone)}\n\n` +
    '<i>⚠️ при смене валюты суммы не пересчитываются</i>'
  );
}
export function livingText(ctx: PfCtx): string {
  const p = ctx.profile;
  return `🍽 <b>Лимит жизни</b>\n${fmtMoney(p.living_cap_minor / 100, p.living_currency)} в месяц (нед. ${fmtMoney(p.weekly_budget_minor / 100, p.living_currency)})`;
}
export function incomeHubText(ctx: PfCtx): string {
  const list = ctx.incomeEntries.length
    ? ctx.incomeEntries
        .map((e) => `  • ${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` (${escapeHtml(e.note)})` : ''}`)
        .join('\n')
    : '  записей нет';
  return `💵 <b>Доход за ${ctx.month}</b>\nИтого: ${ctx.incomeTotal ?? '—'} (${ctx.incomeEntries.length} записей)\n${list}`;
}

// ── ЕДИНЫЙ рендер экрана (используют редьюсер и nv-диспетчер) ──
export function renderPf(
  screenId: string,
  data: PfState['data'],
  ctx: PfCtx,
): { step: string; text: string; markup?: ReplyMarkup | undefined } {
  const p = ctx.profile;
  const commitsKb = () =>
    kb(
      [
        ...ctx.commitments
          .slice(0, 30)
          .map((c) => [
            btn(`${c.active ? '' : '⏸ '}${c.name} — ${fmtMoney(c.amount_minor / 100, c.currency)}`, `pf:cm:${c.id}`),
          ]),
        [btn('➕ Добавить', 'pf:cadd')],
      ],
      'PF_COMMITS',
    );
  switch (screenId) {
    case 'PF_HOME':
      return {
        step: 'pf',
        text: profileMenuText(ctx),
        markup: kb(
          [
            [btn('💵 Доход', 'pf:sec:income'), btn('🍽 Лимит жизни', 'pf:sec:living')],
            [btn('🧾 Платежи', 'pf:sec:commits'), btn('🌍 Валюта и пояс', 'pf:sec:ccytz')],
            [btn('🔔 Напоминания', 'pf:sec:reminders'), btn('🗄 Мои данные', 'pf:sec:data')],
          ],
          'PF_HOME',
        ),
      };
    case 'PF_INCOME':
      return {
        step: 'pf:income',
        text: incomeSectionText(ctx),
        markup: kb([[btn('Изменить типичный', 'pf:typ')], [btn('💵 Факт по месяцам', 'pf:inc:hub')]], 'PF_INCOME'),
      };
    case 'PF_LIVING':
      return { step: 'pf:living', text: livingText(ctx), markup: kb([[btn('Изменить', 'pf:liv')]], 'PF_LIVING') };
    case 'PF_COMMITS':
      return { step: 'pf:commits', text: commitsText(ctx), markup: commitsKb() };
    case 'PF_COMMIT': {
      const c = ctx.commitments.find((x) => x.id === data.commitId);
      if (!c) return renderPf('PF_COMMITS', {}, ctx);
      const pays = ctx.commitPayments.filter((x) => x.commitment_id === c.id);
      const monthPay = pays.filter((x) => x.paid_on.startsWith(ctx.month)).at(-1);
      const monthLine = monthPay ? `Этот месяц: ✅ оплачен ${dm(monthPay.paid_on)}` : 'Этот месяц: не оплачен';
      const rows: InlineButton[][] = [
        // последние ≤5 оплат → карточка оплаты (🤖 — автопроводка кроном)
        ...pays
          .slice(-5)
          .reverse()
          .map((e) => [
            btn(`${dm(e.paid_on)} — ${fmtMoney(e.amount_minor / 100, e.currency)}${e.source === 'auto' ? ' 🤖' : ''}`, `pf:cp:${e.id}`),
          ]),
        ...(monthPay ? [] : [[btn('✅ Оплачено', `pf:cpay:${c.id}`)]]),
        [btn('✏️ Сумма', `pf:ca:${c.id}`), btn('📅 День', `pf:cday:${c.id}`)],
        [btn(c.active ? '⏸ Выключить' : '▶️ Включить', `pf:ctog:${c.id}`), btn('🗑 Удалить', `pf:cdel:${c.id}`)],
      ];
      return {
        step: 'pf:commit',
        text: commitDetailText(c, monthLine),
        markup: kb(rows, 'PF_COMMIT'),
      };
    }
    case 'PF_CPAY': {
      const c = ctx.commitments.find((x) => x.id === data.commitId);
      const e = ctx.commitPayments.find((x) => x.id === data.cpayId);
      if (!c || !e || e.commitment_id !== c.id) return renderPf('PF_COMMITS', {}, ctx);
      return {
        step: 'pf:cpay',
        text:
          `🧾 Оплата «${escapeHtml(c.name)}»\n` +
          `${dm(e.paid_on)} · ${fmtMoney(e.amount_minor / 100, e.currency)} · ${e.source === 'auto' ? 'авто' : 'вручную'}`,
        markup: kb([[btn('✏️ Изменить', `pf:cpe:${e.id}`), btn('🗑 Удалить', `pf:cpd:${e.id}`)]], 'PF_CPAY'),
      };
    }
    case 'PF_CPAY_EDIT': {
      const c = ctx.commitments.find((x) => x.id === data.commitId);
      const e = ctx.commitPayments.find((x) => x.id === data.cpayId);
      if (!c || !e || e.commitment_id !== c.id) return renderPf('PF_COMMITS', {}, ctx);
      return {
        step: 'edit_cpay',
        text:
          `Оплата «${escapeHtml(c.name)}» ${dm(e.paid_on)} — ${fmtMoney(e.amount_minor / 100, e.currency)}\n` +
          `Новая сумма (${c.currency}), можно с датой «50000 05.10»:`,
        markup: promptKb('PF_CPAY_EDIT'),
      };
    }
    case 'PF_CPAY_DEL': {
      const c = ctx.commitments.find((x) => x.id === data.commitId);
      const e = ctx.commitPayments.find((x) => x.id === data.cpayId);
      if (!c || !e || e.commitment_id !== c.id) return renderPf('PF_COMMITS', {}, ctx);
      return {
        step: 'confirm_del_cpay',
        text: `Удалить оплату «${escapeHtml(c.name)}»?\n${dm(e.paid_on)} — ${fmtMoney(e.amount_minor / 100, e.currency)}`,
        markup: kb([[btn('🗑 Да, удалить', 'pf:cpdy')]], 'PF_CPAY_DEL'),
      };
    }
    case 'PF_COMMIT_DEL': {
      const c = ctx.commitments.find((x) => x.id === data.commitId);
      if (!c) return renderPf('PF_COMMITS', {}, ctx);
      return {
        step: 'confirm_del_commit',
        text: `Удалить «${escapeHtml(c.name)}» (${fmtMoney(c.amount_minor / 100, c.currency)})?`,
        markup: kb([[btn('🗑 Да, удалить', 'pf:cdel:yes')]], 'PF_COMMIT_DEL'),
      };
    }
    case 'PF_LOCALE':
      return {
        step: 'pf:ccytz',
        text: ccyTzText(ctx),
        markup: kb(
          [
            [btn('Валюта дохода', 'pf:ccy:income'), btn('Валюта лимита', 'pf:ccy:living')],
            [btn('Часовой пояс', 'pf:tz')],
          ],
          'PF_LOCALE',
        ),
      };
    case 'PF_TYPICAL_ASK':
      return {
        step: 'edit_typical',
        text: `Новый типичный доход (${p.income_currency}) — число, или «Убрать»:`,
        markup: promptKb('PF_TYPICAL_ASK', [btn('Убрать', 'pf:typ0')]),
      };
    case 'PF_LIVING_ASK':
      return {
        step: 'edit_living',
        text: `Новый лимит «на жизнь» в месяц (${p.living_currency} по умолчанию):`,
        markup: promptKb('PF_LIVING_ASK'),
      };
    case 'PF_COMMIT_ADD':
      return {
        step: 'add_commit',
        text: 'Новый платёж: <code>Аренда 700 usd 1</code>',
        markup: promptKb('PF_COMMIT_ADD'),
      };
    case 'PF_COMMIT_AMOUNT': {
      const c = ctx.commitments.find((x) => x.id === data.commitId);
      return {
        step: 'edit_commit_amount',
        text: `Новая сумма${c ? ` для «${escapeHtml(c.name)}»` : ''} (${c?.currency ?? ''}):`,
        markup: promptKb('PF_COMMIT_AMOUNT'),
      };
    }
    case 'PF_COMMIT_DAY':
      return { step: 'edit_commit_day', text: 'День месяца 1–31 (или 0 — убрать):', markup: promptKb('PF_COMMIT_DAY') };
    case 'PF_LOCALE_PICK':
      return {
        step: 'edit_tz',
        text: 'Часовой пояс:',
        markup: promptKb('PF_LOCALE_PICK', [btn('Другой…', 'pf:tzv:X')]),
      };
    case 'INCOME_HUB':
      return {
        step: 'income_hub',
        text: incomeHubText(ctx),
        markup: kb(
          [[btn('➕ Добавить доход', 'inc:add')], [btn('📋 Записи месяца', 'inc:list')]],
          'INCOME_HUB',
          data.origin,
        ),
      };
    case 'INCOME_ASK':
      return {
        step: 'income_ask',
        text: 'Сколько получили? (например: 5200 eur зарплата)',
        markup: promptKb('INCOME_ASK'),
      };
    case 'INCOME_LIST':
      return {
        step: 'income_list',
        text: incomeHubText(ctx),
        markup: kb(
          ctx.incomeEntries.map((e) => [
            btn(`🗑 ${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` ${e.note}` : ''}`, `in:del:${e.id}`),
          ]),
          'INCOME_LIST',
        ),
      };
    case 'INCOME_DEL': {
      const e = ctx.incomeEntries.find((x) => x.id === data.incomeId);
      if (!e) return renderPf('INCOME_LIST', {}, ctx);
      return {
        step: 'confirm_del_income',
        text: `Удалить запись ${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` (${escapeHtml(e.note)})` : ''}?`,
        markup: kb([[btn('🗑 Да, удалить', 'in:del:yes')]], 'INCOME_DEL'),
      };
    }
    case 'PF_REMINDERS':
      return {
        step: 'pf:reminders',
        text:
          '🔔 <b>Напоминания</b>\n' +
          `Еженедельный итог (вс 20:00): ${p.reminders_weekly ? '✅ вкл' : '⏸ выкл'}\n` +
          `Платежи (за 2 дня, 10:00): ${p.reminders_payments ? '✅ вкл' : '⏸ выкл'}\n` +
          `� Алерты по курсам: ${p.fx_alerts_enabled ? '✅ вкл' : '⏸ выкл'}\n` +
          `�📷 Скриншоты банка: ${p.vision_enabled ? '✅ вкл' : '⏸ выкл'}\n` +
          '<i>Распознавание скриншотов банка — фото уходит в Google AI.</i>',
        markup: kb(
          [
            [btn(p.reminders_weekly ? '⏸ Выкл недельные' : '✅ Вкл недельные', 'pf:rem:weekly')],
            [btn(p.reminders_payments ? '⏸ Выкл платежи' : '✅ Вкл платежи', 'pf:rem:pay')],
            [btn(p.fx_alerts_enabled ? '⏸ Выкл алерты' : '✅ Вкл алерты', 'pf:rem:fx')],
            [btn(p.vision_enabled ? '⏸ Выкл скриншоты' : '✅ Вкл скриншоты', 'pf:rem:vision')],
          ],
          'PF_REMINDERS',
        ),
      };
    case 'PF_DATA':
      return {
        step: 'pf:data',
        text: '🗄 <b>Мои данные</b>\nЭкспорт — JSON со всеми вашими данными (профиль, платежи, траты, доход).',
        markup: kb([[btn('📤 Экспорт', 'pf:exp:go')], [btn('🗑 Удалить всё', 'pf:del:ask')]], 'PF_DATA'),
      };
    case 'PF_DELETE_ASK':
      return {
        step: 'pf:delete',
        text: '🗑 <b>Удалить все данные?</b>\nПрофиль, платежи, траты и доход будут стёрты безвозвратно. Это действие нельзя отменить.',
        markup: kb([[btn('🗑 Да, удалить всё', 'pf:del:yes')]], 'PF_DELETE_ASK'),
      };
    case 'EXPENSES_LIST': {
      const rows = ctx.expenses
        .slice(0, 20)
        .map((e) => [
          btn(
            `${e.spent_on.slice(5)} · ${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` ${escapeHtml(e.note)}` : ''}`,
            `ex:v:${e.id}`,
          ),
        ]);
      return {
        step: 'expenses_list',
        text: ctx.expenses.length ? `📋 <b>Траты недели</b> — ${ctx.expenses.length}` : 'Трат за неделю нет',
        markup: kb(rows.length ? rows : [], 'EXPENSES_LIST'),
      };
    }
    case 'EXPENSE': {
      const e = ctx.expenses.find((x) => x.id === data.expenseId);
      if (!e)
        return {
          step: 'expenses_list',
          text: 'Запись не найдена',
          markup: kb([], 'EXPENSES_LIST'),
        };
      return {
        step: 'expense',
        text:
          `💸 <b>Трата</b>\n📅 ${e.spent_on}\n` +
          `${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` · ${escapeHtml(e.note)}` : ''}`,
        markup: kb([[btn('✏️ Изменить', `ex:e:${e.id}`), btn('🗑 Удалить', `ex:del:${e.id}`)]], 'EXPENSE'),
      };
    }
    case 'EXPENSE_DEL': {
      const e = ctx.expenses.find((x) => x.id === data.expenseId);
      return {
        step: 'expense_del',
        text: e
          ? `Удалить трату «${escapeHtml(e.note ?? fmtMoney(e.amount_minor / 100, e.currency))}»?`
          : 'Удалить запись?',
        markup: kb([[btn('🗑 Да, удалить', 'ex:dyes')]], 'EXPENSE_DEL'),
      };
    }
    case 'EXPENSE_EDIT_ASK':
      return {
        step: 'edit_expense',
        text: 'Новая сумма (формат как при вводе: 320 или 320 kgs кофе):',
        markup: promptKb('EXPENSE_EDIT_ASK'),
      };
    case 'SPENT_ASK':
      return {
        step: 'spent_ask',
        text: 'Сколько потратили? (например: 320 или 320 kgs кофе)',
        markup: promptKb('SPENT_ASK'),
      };
    default:
      return { step: 'pf', text: profileMenuText(ctx), markup: renderPf('PF_HOME', {}, ctx).markup };
  }
}

/** Куда возвращает /cancel и ✖ Отмена: parent шага из реестра. */
export function cancelTarget(state: PfState): string {
  const scr = STEP_SCREEN[state.step] ?? 'HOME';
  return (
    (
      {
        PF_TYPICAL_ASK: 'PF_INCOME',
        PF_LIVING_ASK: 'PF_LIVING',
        PF_COMMIT_ADD: 'PF_COMMITS',
        PF_COMMIT_AMOUNT: 'PF_COMMIT',
        PF_COMMIT_DAY: 'PF_COMMIT',
        PF_COMMIT_DEL: 'PF_COMMIT',
        PF_CPAY: 'PF_COMMIT',
        PF_CPAY_EDIT: 'PF_COMMIT',
        PF_CPAY_DEL: 'PF_COMMIT',
        PF_LOCALE_PICK: 'PF_LOCALE',
        INCOME_ASK: 'INCOME_HUB',
        INCOME_DEL: 'INCOME_LIST',
        SPENT_ASK: 'HOME',
        PF_INCOME: 'PF_HOME',
        PF_LIVING: 'PF_HOME',
        PF_COMMITS: 'PF_HOME',
        PF_COMMIT: 'PF_COMMITS',
        PF_LOCALE: 'PF_HOME',
        INCOME_LIST: 'INCOME_HUB',
        INCOME_HUB: state.data.origin ?? 'HOME',
        PF_HOME: 'HOME',
        PF_REMINDERS: 'PF_HOME',
        PF_DATA: 'PF_HOME',
        PF_DELETE_ASK: 'PF_DATA',
        EXPENSES_LIST: 'WEEK',
        EXPENSE: 'EXPENSES_LIST',
        EXPENSE_DEL: 'EXPENSE',
        EXPENSE_EDIT_ASK: 'EXPENSE',
      } as Record<string, string>
    )[scr] ?? 'HOME'
  );
}

// ── редьюсер ──
export function advancePf(state: PfState, input: PfInput, ctx: PfCtx): { state: PfState | null; effects: PfEffect[] } {
  const d = state.data;
  const cb = input.type === 'callback' ? input.data : null;
  const text = input.type === 'text' ? input.text.trim() : '';
  const p = ctx.profile;

  if (cb !== null) {
    const allowed = PF_STEPS[state.step];
    const isNav = cb.startsWith('pf:') || cb.startsWith('in:') || cb.startsWith('inc:') || cb.startsWith('ex:');
    if (!isNav || !allowed || !new RegExp(`^(${allowed})`).test(cb)) return { state, effects: [] };
  }

  /** Переход на экран из реестра (рендер через renderPf — нав-ряд автоматически). */
  const go = (screenId: string, data: PfState['data'] = {}, ...extra: PfEffect[]) => {
    const r = renderPf(screenId, data, ctx);
    return ok({ step: r.step, data }, send(r.text, r.markup), ...extra);
  };
  const commit = () => ctx.commitments.find((x) => x.id === d.commitId);

  switch (state.step) {
    case 'pf': {
      if (cb === 'pf:sec:income') return go('PF_INCOME');
      if (cb === 'pf:sec:living') return go('PF_LIVING');
      if (cb === 'pf:sec:commits') return go('PF_COMMITS');
      if (cb === 'pf:sec:ccytz') return go('PF_LOCALE');
      if (cb === 'pf:sec:reminders') return go('PF_REMINDERS');
      if (cb === 'pf:sec:data') return go('PF_DATA');
      // траты: ex:* принимаем и на свободном шаге (после SPENT_DONE conv очищен)
      if (cb === 'ex:list') return go('EXPENSES_LIST');
      {
        const m = /^ex:(v|e|del|undo):(\d+)$/.exec(cb ?? '');
        if (m) {
          const id = Number(m[2]);
          if (!ctx.expenses.some((x) => x.id === id)) return { state, effects: [] }; // чужой/несуществующий — молча
          if (m[1] === 'v') return go('EXPENSE', { expenseId: id });
          if (m[1] === 'e') return go('EXPENSE_EDIT_ASK', { expenseId: id });
          if (m[1] === 'del') return go('EXPENSE_DEL', { expenseId: id });
          return ok(
            { step: 'pf', data: {} },
            { kind: 'expense_del', id },
            send('Трата удалена.', { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'nv:home' }]] }),
          );
        }
      }
      return { state, effects: [] };
    }

    case 'expenses_list': {
      if (cb === 'ex:list') return go('EXPENSES_LIST');
      const m = /^ex:v:(\d+)$/.exec(cb ?? '');
      if (m) return go('EXPENSE', { expenseId: Number(m[1]) });
      return { state, effects: [] };
    }

    case 'expense': {
      const m = /^ex:(e|del):(\d+)$/.exec(cb ?? '');
      if (!m || Number(m[2]) !== d.expenseId) return { state, effects: [] };
      if (m[1] === 'e') return go('EXPENSE_EDIT_ASK', { expenseId: d.expenseId });
      return go('EXPENSE_DEL', { expenseId: d.expenseId });
    }

    case 'expense_del': {
      if (cb === 'ex:dyes')
        return ok(
          { step: 'expenses_list', data: {} },
          { kind: 'expense_del', id: d.expenseId! },
          { kind: 'render', screen: 'EXPENSES_LIST', prefix: 'Удалено.\n\n' },
        );
      return { state, effects: [] };
    }

    case 'edit_expense': {
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        return ok(
          { step: 'expense', data: { expenseId: d.expenseId! } },
          {
            kind: 'expense_patch',
            id: d.expenseId!,
            patch: {
              amount_minor: toMinor(a.amount),
              ...(a.currency ? { currency: a.currency } : {}),
              note: a.note ?? null,
            },
          },
          { kind: 'render', screen: 'EXPENSE', data: { expenseId: d.expenseId }, prefix: 'Обновлено.\n\n' },
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'pf:reminders': {
      if (cb === 'pf:rem:weekly')
        return ok(
          { step: 'pf:reminders', data: {} },
          { kind: 'patch', patch: { reminders_weekly: p.reminders_weekly ? 0 : 1 } },
          { kind: 'render', screen: 'PF_REMINDERS' },
        );
      if (cb === 'pf:rem:pay')
        return ok(
          { step: 'pf:reminders', data: {} },
          { kind: 'patch', patch: { reminders_payments: p.reminders_payments ? 0 : 1 } },
          { kind: 'render', screen: 'PF_REMINDERS' },
        );
      if (cb === 'pf:rem:fx')
        return ok(
          { step: 'pf:reminders', data: {} },
          { kind: 'patch', patch: { fx_alerts_enabled: p.fx_alerts_enabled ? 0 : 1 } },
          { kind: 'render', screen: 'PF_REMINDERS' },
        );
      if (cb === 'pf:rem:vision')
        return ok(
          { step: 'pf:reminders', data: {} },
          { kind: 'patch', patch: { vision_enabled: p.vision_enabled ? 0 : 1 } },
          { kind: 'render', screen: 'PF_REMINDERS' },
        );
      if (cb === 'pf:sec:reminders') return go('PF_REMINDERS');
      return { state, effects: [] };
    }

    case 'pf:data': {
      if (cb === 'pf:exp:go') return ok(state, { kind: 'export' });
      if (cb === 'pf:del:ask') return go('PF_DELETE_ASK');
      if (cb === 'pf:sec:data') return go('PF_DATA');
      return { state, effects: [] };
    }

    case 'pf:delete': {
      if (cb === 'pf:del:yes') return ok(null, { kind: 'delete_me' });
      return { state, effects: [] };
    }

    case 'pf:income': {
      if (cb === 'pf:typ') return go('PF_TYPICAL_ASK');
      if (cb === 'pf:inc:hub') return go('INCOME_HUB', { origin: 'PF_INCOME' });
      if (cb === 'pf:sec:income') return go('PF_INCOME');
      return { state, effects: [] };
    }

    case 'pf:living': {
      if (cb === 'pf:liv') return go('PF_LIVING_ASK');
      if (cb === 'pf:sec:living') return go('PF_LIVING');
      return { state, effects: [] };
    }

    case 'pf:commits': {
      if (cb === 'pf:cadd') return go('PF_COMMIT_ADD');
      if (cb === 'pf:sec:commits') return go('PF_COMMITS');
      const m = /^pf:cm:(\d+)$/.exec(cb ?? '');
      if (m) {
        const c = ctx.commitments.find((x) => x.id === Number(m[1]));
        if (!c) return { state, effects: [] }; // чужой/удалённый id — молча
        return go('PF_COMMIT', { commitId: c.id });
      }
      return { state, effects: [] };
    }

    case 'pf:commit': {
      const c = commit();
      if (!c) return go('PF_COMMITS');
      if (cb === `pf:ca:${c.id}`) return go('PF_COMMIT_AMOUNT', d);
      if (cb === `pf:cday:${c.id}`) return go('PF_COMMIT_DAY', d);
      if (cb === `pf:ctog:${c.id}`)
        return ok(
          { step: 'pf:commit', data: d },
          { kind: 'commit_patch', id: c.id, patch: { active: c.active ? 0 : 1 } },
          { kind: 'render', screen: 'PF_COMMIT', data: d },
        );
      if (cb === `pf:cdel:${c.id}`) return go('PF_COMMIT_DEL', d);
      // «✅ Оплачено» — ручная запись оплаты (сумма платежа, сегодня, tg:<update_id>)
      if (cb === `pf:cpay:${c.id}`) {
        const paid = ctx.commitPayments.some((x) => x.commitment_id === c.id && x.paid_on.startsWith(ctx.month));
        if (paid) return ok({ step: 'pf:commit', data: d }, { kind: 'render', screen: 'PF_COMMIT', data: d });
        return ok(
          { step: 'pf:commit', data: d },
          { kind: 'cpay_add', id: c.id },
          { kind: 'render', screen: 'PF_COMMIT', data: d },
        );
      }
      {
        const mp = /^pf:cp:(\d+)$/.exec(cb ?? '');
        if (mp) {
          const e = ctx.commitPayments.find((x) => x.id === Number(mp[1]) && x.commitment_id === c.id);
          if (!e) return go('PF_COMMITS'); // чужой/удалённый — молча в список
          return go('PF_CPAY', { commitId: c.id, cpayId: e.id });
        }
      }
      if (cb === 'pf:sec:commits') return go('PF_COMMITS');
      return { state, effects: [] };
    }

    case 'pf:cpay': {
      const c = commit();
      const e = ctx.commitPayments.find((x) => x.id === d.cpayId);
      if (!c || !e || e.commitment_id !== c.id) return go('PF_COMMITS');
      if (cb === `pf:cpe:${e.id}`) return go('PF_CPAY_EDIT', d);
      if (cb === `pf:cpd:${e.id}`) return go('PF_CPAY_DEL', d);
      return { state, effects: [] };
    }

    case 'edit_cpay': {
      const c = commit();
      const e = ctx.commitPayments.find((x) => x.id === d.cpayId);
      if (!c || !e || e.commitment_id !== c.id) return go('PF_COMMITS');
      if (input.type !== 'text') return { state, effects: [] };
      const ad = parseAmountDate(text, ctx.today);
      if (ad.badDate) return ok(state, send('Не понял дату — формат ДД.ММ (или ДД.ММ.ГГГГ).'));
      try {
        const a = parseAmount(ad.amountText);
        return ok(
          { step: 'pf:commit', data: { commitId: c.id } },
          { kind: 'cpay_patch', id: e.id, patch: { amount_minor: toMinor(a.amount), paid_on: ad.eventOn } },
          { kind: 'render', screen: 'PF_COMMIT', data: { commitId: c.id }, prefix: 'Исправлено.\n\n' },
        );
      } catch (err2) {
        return ok(state, send((err2 as Error).message));
      }
    }

    case 'confirm_del_cpay': {
      const c = commit();
      const e = ctx.commitPayments.find((x) => x.id === d.cpayId);
      if (!c || !e || e.commitment_id !== c.id) return go('PF_COMMITS');
      if (cb === 'pf:cpdy')
        return ok(
          { step: 'pf:commit', data: { commitId: c.id } },
          { kind: 'cpay_del', id: e.id },
          { kind: 'render', screen: 'PF_COMMIT', data: { commitId: c.id }, prefix: 'Удалено.\n\n' },
        );
      return { state, effects: [] };
    }

    case 'confirm_del_commit': {
      const c = commit();
      if (!c) return go('PF_COMMITS');
      if (cb === 'pf:cdel:yes')
        return ok(
          { step: 'pf:commits', data: {} },
          { kind: 'commit_del', id: c.id },
          { kind: 'render', screen: 'PF_COMMITS', prefix: `Удалён: ${escapeHtml(c.name)}\n\n` },
        );
      if (cb === 'pf:cdel:no') return go('PF_COMMIT', d);
      return { state, effects: [] };
    }

    case 'edit_typical': {
      if (cb === 'pf:typ0')
        return ok(
          { step: 'pf:income', data: {} },
          { kind: 'patch', patch: { income_minor: 0 } },
          { kind: 'render', screen: 'PF_INCOME', prefix: 'Типичный доход убран — вносите факт через 💵 Доход\n\n' },
        );
      if (cb === 'pf:sec:income') return go('PF_INCOME');
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        const minor = toMinor(a.amount);
        const patch: ProfilePatch = { income_minor: minor, ...(a.currency ? { income_currency: a.currency } : {}) };
        return ok(
          { step: 'pf:income', data: {} },
          { kind: 'patch', patch },
          {
            kind: 'render',
            screen: 'PF_INCOME',
            prefix: `Типичный доход: ${fmtMoney(a.amount, a.currency ?? p.income_currency)}\n\n`,
          },
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'edit_living': {
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        const minor = toMinor(a.amount);
        const weekly = Math.round((minor * 12) / 52);
        const patch: ProfilePatch = {
          living_cap_minor: minor,
          weekly_budget_minor: weekly,
          ...(a.currency ? { living_currency: a.currency } : {}),
        };
        return ok(
          { step: 'pf:living', data: {} },
          { kind: 'patch', patch },
          {
            kind: 'render',
            screen: 'PF_LIVING',
            prefix: `Лимит жизни: ${fmtMoney(a.amount, a.currency ?? p.living_currency)}\n\n`,
          },
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'edit_commit_amount': {
      const c = commit();
      if (!c) return go('PF_COMMITS');
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        const patch = { amount_minor: toMinor(a.amount), ...(a.currency ? { currency: a.currency } : {}) };
        return ok(
          { step: 'pf:commit', data: d },
          { kind: 'commit_patch', id: c.id, patch },
          { kind: 'render', screen: 'PF_COMMIT', data: d },
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'edit_commit_day': {
      const c = commit();
      if (!c) return go('PF_COMMITS');
      if (input.type !== 'text') return { state, effects: [] };
      if (text === '0')
        return ok(
          { step: 'pf:commit', data: d },
          { kind: 'commit_patch', id: c.id, patch: { due_day: null } },
          { kind: 'render', screen: 'PF_COMMIT', data: d },
        );
      const day = Number(text);
      if (!Number.isInteger(day) || day < 1 || day > 31)
        return ok(state, send('День — число от 1 до 31 (0 — убрать).'));
      return ok(
        { step: 'pf:commit', data: d },
        { kind: 'commit_patch', id: c.id, patch: { due_day: day } },
        { kind: 'render', screen: 'PF_COMMIT', data: d },
      );
    }

    case 'add_commit': {
      if (input.type !== 'text') return { state, effects: [] };
      if (ctx.commitments.length >= 30) return go('PF_COMMITS', {}, send('Максимум 30 платежей.'));
      try {
        const c = parseCommitmentLine(text);
        if (!c.currency) c.currency = p.income_currency;
        return ok(
          { step: 'pf:commits', data: {} },
          { kind: 'commit_add', c },
          { kind: 'render', screen: 'PF_COMMITS' },
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'pf:ccytz': {
      if (cb === 'pf:ccy:income')
        return ok(
          { step: 'edit_income_ccy', data: {} },
          send('Код валюты дохода (USD, EUR, RUB, KGS, GEL…):', promptKb('PF_LOCALE_PICK')),
        );
      if (cb === 'pf:ccy:living')
        return ok({ step: 'edit_living_ccy', data: {} }, send('Код валюты лимита жизни:', promptKb('PF_LOCALE_PICK')));
      if (cb === 'pf:tz')
        return ok(
          { step: 'edit_tz', data: {} },
          send(
            'Часовой пояс:',
            kb(
              [
                [btn('Бишкек', 'pf:tzv:Asia/Bishkek'), btn('Москва', 'pf:tzv:Europe/Moscow')],
                [btn('Алматы', 'pf:tzv:Asia/Almaty'), btn('Тбилиси', 'pf:tzv:Asia/Tbilisi'), btn('UTC', 'pf:tzv:UTC')],
                [btn('Другой…', 'pf:tzv:X')],
              ],
              'PF_LOCALE_PICK',
            ),
          ),
        );
      if (cb === 'pf:sec:ccytz') return go('PF_LOCALE');
      return { state, effects: [] };
    }

    case 'edit_tz': {
      if (cb === 'pf:sec:ccytz') return go('PF_LOCALE');
      if (cb?.startsWith('pf:tzv:')) {
        const tz = cb.slice(7);
        if (tz === 'X')
          return ok(
            { step: 'edit_tz_custom', data: d },
            send('Напишите таймзону (IANA), например Europe/Berlin:', promptKb('PF_LOCALE_PICK')),
          );
        if (!isValidTimezone(tz)) return ok(state, send('Не знаю такую таймзону.'));
        return ok(
          { step: 'pf:ccytz', data: {} },
          { kind: 'patch', patch: { timezone: tz } },
          { kind: 'render', screen: 'PF_LOCALE', prefix: `Таймзона: ${escapeHtml(tz)}\n\n` },
        );
      }
      if (input.type === 'text' && isValidTimezone(text)) {
        return ok(
          { step: 'pf:ccytz', data: {} },
          { kind: 'patch', patch: { timezone: text } },
          { kind: 'render', screen: 'PF_LOCALE', prefix: `Таймзона: ${escapeHtml(text)}\n\n` },
        );
      }
      if (input.type === 'text') return ok(state, send('Не знаю такую таймзону. Пример: Europe/Berlin'));
      return { state, effects: [] };
    }

    case 'edit_tz_custom': {
      if (cb === 'pf:sec:ccytz') return go('PF_LOCALE');
      if (input.type !== 'text') return { state, effects: [] };
      if (!isValidTimezone(text)) return ok(state, send('Не знаю такую таймзону. Пример: Europe/Berlin'));
      return ok(
        { step: 'pf:ccytz', data: {} },
        { kind: 'patch', patch: { timezone: text } },
        { kind: 'render', screen: 'PF_LOCALE', prefix: `Таймзона: ${escapeHtml(text)}\n\n` },
      );
    }

    case 'edit_income_ccy':
    case 'edit_living_ccy': {
      if (cb === 'pf:sec:ccytz') return go('PF_LOCALE');
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const code = parseCurrencyCode(text);
        const target = state.step === 'edit_income_ccy' ? 'income' : 'living';
        return ok(
          { ...state, data: { ...d, pendingCcy: code, ccyTarget: target } },
          { kind: 'checkCcy', code, target },
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'income_hub': {
      if (cb === 'inc:add') return go('INCOME_ASK', { origin: d.origin });
      if (cb === 'inc:list') return go('INCOME_LIST', { origin: d.origin });
      if (cb === 'pf:sec:income') return go('PF_INCOME');
      return { state, effects: [] };
    }

    case 'income_ask': {
      if (cb === 'inc:add') return go('INCOME_ASK', { origin: d.origin });
      return { state, effects: [] }; // текст обрабатывается в access.ts (нужен sourceKey/FX)
    }

    case 'pf:income_list':
    case 'income_list': {
      const m = /^in:del:(\d+)$/.exec(cb ?? '');
      if (m) {
        const e = ctx.incomeEntries.find((x) => x.id === Number(m[1]));
        if (!e) return { state, effects: [] }; // чужой id — молча
        return go('INCOME_DEL', { incomeId: e.id, origin: d.origin });
      }
      if (cb === 'inc:list') return go('INCOME_LIST', { origin: d.origin });
      if (cb === 'pf:sec:income') return go('PF_INCOME');
      return { state, effects: [] };
    }

    case 'confirm_del_income': {
      const e = ctx.incomeEntries.find((x) => x.id === d.incomeId);
      if (!e) return go('INCOME_LIST', { origin: d.origin });
      if (cb === 'in:del:yes')
        return ok(
          { step: 'income_list', data: { origin: d.origin } },
          { kind: 'income_del', id: e.id },
          { kind: 'render', screen: 'INCOME_LIST', data: { origin: d.origin }, prefix: 'Удалено.\n\n' },
        );
      if (cb === 'in:del:no') return go('INCOME_LIST', { origin: d.origin });
      return { state, effects: [] };
    }

    default:
      return { state: null, effects: [] };
  }
}

/** Результат FX-валидации кода валюты при редактировании. */
export function onPfCcyResult(state: PfState, okFlag: boolean): { state: PfState | null; effects: PfEffect[] } {
  const d = state.data;
  const ccy = d.pendingCcy;
  const target = d.ccyTarget;
  delete d.pendingCcy;
  delete d.ccyTarget;
  if (okFlag && ccy && target) {
    return ok(
      { step: 'pf:ccytz', data: {} },
      target === 'income'
        ? { kind: 'patch', patch: { income_currency: ccy } }
        : { kind: 'patch', patch: { living_currency: ccy } },
      {
        kind: 'render',
        screen: 'PF_LOCALE',
        prefix: `Валюта ${target === 'income' ? 'дохода' : 'лимита'}: ${ccy}. Суммы не пересчитываются.\n\n`,
      },
    );
  }
  return ok(state, send('Такая валюта не поддерживается — попробуйте ещё.'));
}

export { cancelBtn };
