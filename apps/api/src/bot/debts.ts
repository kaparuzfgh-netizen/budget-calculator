/**
 * debts.ts — кредиты и ипотеки пользователя (шаг 6, веха H1).
 * ЧИСТЫЙ редьюсер advanceDebt(state, input, ctx) → {state, effects}; I/O — access.ts.
 * renderDebt(screenId, data, ctx) — ЕДИНСТВЕННЫЙ источник разметки экранов:
 *   экшн-кнопки + навигационный ряд из navRow() реестра (R1–R4).
 * События (платёж/ЧДП/сверка) — веха H2; здесь список, карточка, мастер, удаление.
 */
import type { ReplyMarkup } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import type { InlineButton } from '../telegram/client';
import type { DebtCtx, DebtView } from '../services/debts';
import type { DebtEventRow } from '../db/repo';
import { previewPrepay, previewPrepayShortenTerm } from '../domain/debt';
import { fmtMoney, fmtPct } from './format';
import { parseAmount } from './parse';
import { round2, toMinor } from '../domain/money';
import { navRow } from './nav/nav';

export interface DebtAddDraft {
  name?: string | undefined;
  amountMinor?: number | undefined;
  currency?: string | undefined;
  rate?: number | undefined; // годовая доля
  paymentMinor?: number | undefined;
  frequency?: 'monthly' | 'biweekly' | undefined;
  dueDay?: number | undefined;
  epoch?: string | undefined;
}

export interface DebtState {
  step: string;
  data: {
    debtId?: number | undefined;
    /** Событие журнала — для экранов правки/удаления. */
    eventId?: number | undefined;
    add?: DebtAddDraft | undefined;
    /** Черновик ЧДП: сумма + дата — живёт между ASK и PREVIEW. */
    pp?: { amountMinor: number; eventOn: string } | undefined;
  };
}

export type DebtInput = { type: 'text'; text: string } | { type: 'callback'; data: string };

export interface DebtAddPayload {
  name: string;
  amountMinor: number;
  currency: string;
  rate: number;
  paymentMinor: number;
  frequency: 'monthly' | 'biweekly';
  dueDay: number | null;
  epoch: string;
}

export type DebtEffect =
  | { kind: 'send'; text: string; markup?: ReplyMarkup }
  | { kind: 'debt_add'; d: DebtAddPayload }
  | { kind: 'debt_del'; id: number }
  // событие в журнал: платёж по графику / ЧДП (mode) / сверка (amount = факт. остаток)
  | {
      kind: 'debt_event';
      id: number;
      ev: { kind: 'payment' | 'prepay' | 'reconcile'; amountMinor: number; eventOn: string; mode?: 'reduce_payment' | 'reduce_term' | undefined };
    }
  | { kind: 'debt_event_patch'; id: number; patch: { amount_minor?: number; event_on?: string; mode?: 'reduce_payment' | 'reduce_term' | null } }
  | { kind: 'debt_event_del'; id: number }
  | { kind: 'debt_patch'; id: number; patch: { rate?: number; initial_payment_minor?: number; due_day?: number | null } }
  // render — экран рендерится ПОСЛЕ мутаций из свежего ctx (runDebtEffects перечитывает данные)
  | { kind: 'render'; screen: string; data?: DebtState['data'] | undefined; prefix?: string | undefined };

const send = (text: string, markup?: ReplyMarkup): DebtEffect => ({ kind: 'send', text, ...(markup ? { markup } : {}) });
const ok = (state: DebtState | null, ...effects: DebtEffect[]) => ({ state, effects });

// ── step ↔ screenId (реестр screens.json) ──
export const DEBT_STEP_SCREEN: Record<string, string> = {
  debt: 'DEBTS',
  'debt:one': 'DEBT',
  'debt:del': 'DEBT_DEL',
  'debt:pay': 'DEBT_PAY',
  'debt:pp:ask': 'DEBT_PREPAY_ASK',
  'debt:pp': 'DEBT_PREPAY',
  'debt:recon': 'DEBT_RECON',
  'debt:edit': 'DEBT_EDIT',
  'debt:edit:rate': 'DEBT_EDIT_RATE',
  'debt:edit:payment': 'DEBT_EDIT_PAYMENT',
  'debt:edit:day': 'DEBT_EDIT_DUE',
  'debt:hist': 'DEBT_HIST',
  'debt:ev': 'DEBT_EVENT',
  'debt:ev:edit': 'DEBT_EVENT_EDIT',
  'debt:ev:del': 'DEBT_EVENT_DEL',
  'debt:add:name': 'DEBT_ADD_NAME',
  'debt:add:balance': 'DEBT_ADD_BALANCE',
  'debt:add:rate': 'DEBT_ADD_RATE',
  'debt:add:payment': 'DEBT_ADD_PAYMENT',
  'debt:add:freq': 'DEBT_ADD_FREQ',
  'debt:add:due': 'DEBT_ADD_DUE',
  'debt:add:epoch': 'DEBT_ADD_EPOCH',
};

/** Множество debt-экранов реестра — для nv-диспетчера в access.ts. */
export const DEBT_SCREENS = new Set(Object.values(DEBT_STEP_SCREEN));

/** Разрешённые callback-паттерны на каждом шаге (step-aware, R7). nv:* — вне редьюсера. */
export const DEBT_STEPS: Record<string, string> = {
  debt: 'dbt:v:|dbt:add$',
  'debt:one': 'dbt:(del:\\d+|pay|pp|rc|ed|hist)$',
  'debt:del': 'dbt:del:yes$',
  'debt:pay': 'dbt:pay:sched$',
  'debt:pp:ask': '', // только текст
  'debt:pp': 'dbt:pp:go:(p|t)$',
  'debt:recon': '', // только текст
  'debt:edit': 'dbt:ed:(rate|pay|day)$',
  'debt:edit:rate': '', // только текст
  'debt:edit:payment': '', // только текст
  'debt:edit:day': 'dbt:ed:day:none$',
  'debt:hist': 'dbt:ev:\\d+$',
  'debt:ev': 'dbt:ev:(e|d|m):\\d+$',
  'debt:ev:edit': '', // только текст
  'debt:ev:del': 'dbt:ev:dy:\\d+$',
  'debt:add:name': 'dbt:add$',
  'debt:add:balance': 'dbt:add$',
  'debt:add:rate': 'dbt:add$',
  'debt:add:payment': 'dbt:add$',
  'debt:add:freq': 'dbt:af:|dbt:add$',
  'debt:add:due': 'dbt:add$',
  'debt:add:epoch': 'dbt:ae:|dbt:add$',
};

const btn = (text: string, cb: string): InlineButton => ({ text, callback_data: cb });

/** Подпись события журнала: «05.02 — ✅ Платёж 11 000 ₽», сверка с «→», у ЧДП режим. */
const EVENT_ICON = { payment: '✅ Платёж', prepay: '💸 ЧДП', reconcile: '🏦 Сверка' } as const;
function debtEventLabel(e: DebtEventRow, ccy: string): string {
  const dm = `${e.event_on.slice(8)}.${e.event_on.slice(5, 7)}`;
  const sum = fmtMoney(e.amount_minor / 100, ccy);
  const kind =
    e.kind === 'prepay' ? `${EVENT_ICON.prepay}${e.mode === 'reduce_term' ? '·срок↓' : '·платёж↓'}` : EVENT_ICON[e.kind];
  return `${dm} — ${kind} ${e.kind === 'reconcile' ? `→ ${sum}` : sum}`;
}
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
export function debtsText(ctx: DebtCtx): string {
  if (!ctx.debts.length) return '🏦 <b>Кредиты</b>\nПока ни одного — добавьте ипотеку или кредит.';
  const lines = ctx.debts.map(
    (v) =>
      `  • ${escapeHtml(v.debt.name)} — ${fmtMoney(round2(v.balance), v.debt.currency)}` +
      ` · платёж ${fmtMoney(round2(v.monthlyPayment), v.debt.currency)}/мес`,
  );
  const total = typeof ctx.totalUsd === 'number' ? `\nИтого: ≈${fmtMoney(ctx.totalUsd, 'USD')}` : '';
  return `🏦 <b>Кредиты</b>\n${lines.join('\n')}${total}`;
}

export function debtCardText(v: DebtView): string {
  const d = v.debt;
  const freq = d.frequency === 'biweekly' ? 'раз в 2 недели' : `ежемесячно${d.due_day ? `, ${d.due_day}-го` : ''}`;
  const tail =
    v.balance > 0.01
      ? `Осталось ≈ ${v.monthsLeft} мес → погашение ~${v.payoffDate.slice(0, 7)}\n` +
        `Процентов до конца: ≈${fmtMoney(v.totalInterest, d.currency)}`
      : '🎉 Погашен';
  return (
    `🏦 <b>${escapeHtml(d.name)}</b>\n` +
    `Остаток: <b>${fmtMoney(round2(v.balance), d.currency)}</b>\n` +
    `Платёж: ${fmtMoney(round2(v.payment), d.currency)} ${freq}` +
    (d.frequency === 'biweekly' ? ` (≈${fmtMoney(round2(v.monthlyPayment), d.currency)}/мес)` : '') +
    '\n' +
    `Ставка: ${fmtPct(d.rate)} · платежей: ${v.paymentsMade}\n` +
    tail
  );
}

// ── ЕДИНЫЙ рендер экрана (используют редьюсер и nv-диспетчер) ──
export function renderDebt(
  screenId: string,
  data: DebtState['data'],
  ctx: DebtCtx,
): { step: string; text: string; markup?: ReplyMarkup | undefined } {
  switch (screenId) {
    case 'DEBTS': {
      const rows = ctx.debts
        .slice(0, 20)
        .map((v) => [
          btn(`${v.debt.name} — ${fmtMoney(round2(v.balance), v.debt.currency)}`, `dbt:v:${v.debt.id}`),
        ]);
      rows.push([btn('➕ Добавить кредит', 'dbt:add')]);
      return { step: 'debt', text: debtsText(ctx), markup: kb(rows, 'DEBTS') };
    }
    case 'DEBT': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      const rows =
        v.balance <= 0.01
          ? [[btn('📜 История', 'dbt:hist'), btn('❌ Удалить', `dbt:del:${v.debt.id}`)]]
          : [
              [btn('✅ Платёж', 'dbt:pay'), btn('💸 ЧДП', 'dbt:pp')],
              [btn('🏦 Сверка', 'dbt:rc'), btn('✏️ Правки', 'dbt:ed')],
              [btn('📜 История', 'dbt:hist'), btn('❌ Удалить', `dbt:del:${v.debt.id}`)],
            ];
      return { step: 'debt:one', text: debtCardText(v), markup: kb(rows, 'DEBT') };
    }
    case 'DEBT_DEL': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      return {
        step: 'debt:del',
        text: `Удалить кредит «${escapeHtml(v.debt.name)}» и его историю платежей?`,
        markup: kb([[btn('❌ Да, удалить', 'dbt:del:yes')]], 'DEBT_DEL'),
      };
    }
    case 'DEBT_PAY': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      const sched = fmtMoney(round2(v.payment), v.debt.currency);
      return {
        step: 'debt:pay',
        text: `Платёж по «${escapeHtml(v.debt.name)}» — по графику ${sched}.\nСумма (${v.debt.currency}), можно с датой «21500 25.10»:`,
        markup: promptKb('DEBT_PAY', [btn(`По графику ${sched}`, 'dbt:pay:sched')]),
      };
    }
    case 'DEBT_PREPAY_ASK': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      return {
        step: 'debt:pp:ask',
        text: `ЧДП по «${escapeHtml(v.debt.name)}» — остаток ${fmtMoney(round2(v.balance), v.debt.currency)}.\nСумма (${v.debt.currency}), можно с датой:`,
        markup: promptKb('DEBT_PREPAY_ASK'),
      };
    }
    case 'DEBT_PREPAY': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v || !data.pp) return renderDebt('DEBTS', {}, ctx);
      const amt = data.pp.amountMinor / 100;
      const snap = {
        rate: v.debt.rate,
        frequency: v.debt.frequency,
        balance: v.balance,
        payment: v.payment,
        paymentsMade: v.paymentsMade,
        effectivePeriods: v.effectivePeriods,
      };
      const ccy = v.debt.currency;
      const pmt = previewPrepay(snap, amt);
      const trm = previewPrepayShortenTerm(snap, amt);
      return {
        step: 'debt:pp',
        text:
          `💸 ЧДП ${fmtMoney(amt, ccy)} по «${escapeHtml(v.debt.name)}» (${data.pp.eventOn.split('-').reverse().join('.')}):\n\n` +
          `Остаток: ${fmtMoney(round2(pmt.balanceBefore), ccy)} → ${fmtMoney(round2(pmt.balanceAfter), ccy)}\n` +
          `📉 Платёж↓: ${fmtMoney(round2(pmt.paymentBefore), ccy)} → ${fmtMoney(round2(pmt.paymentAfter), ccy)}\n` +
          `⏳ Срок↓: −${trm.monthsSaved} мес при том же платеже\n\n` +
          'Что уменьшаем?',
        markup: kb(
          [[btn(`📉 Платёж (−${fmtMoney(round2(pmt.paymentSaved), ccy)})`, 'dbt:pp:go:p'), btn(`⏳ Срок (−${trm.monthsSaved} мес)`, 'dbt:pp:go:t')]],
          'DEBT_PREPAY',
        ),
      };
    }
    case 'DEBT_RECON': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      return {
        step: 'debt:recon',
        text: `Остаток по выписке банка (${v.debt.currency}), можно с датой:`,
        markup: promptKb('DEBT_RECON'),
      };
    }
    case 'DEBT_EDIT': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      const rows = [
        [btn('📉 Ставка', 'dbt:ed:rate'), btn('💰 Платёж', 'dbt:ed:pay')],
        ...(v.debt.frequency === 'monthly' ? [[btn('⏳ День платежа', 'dbt:ed:day')]] : []),
      ];
      return { step: 'debt:edit', text: `Что меняем в «${escapeHtml(v.debt.name)}»?`, markup: kb(rows, 'DEBT_EDIT') };
    }
    case 'DEBT_EDIT_RATE': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      return {
        step: 'debt:edit:rate',
        text: `Новая ставка, % годовых (сейчас ${fmtPct(v.debt.rate)}):`,
        markup: promptKb('DEBT_EDIT_RATE'),
      };
    }
    case 'DEBT_EDIT_PAYMENT': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      return {
        step: 'debt:edit:payment',
        text: `Новый платёж за период (${v.debt.currency}; сейчас ${fmtMoney(round2(v.debt.initial_payment_minor / 100), v.debt.currency)}):`,
        markup: promptKb('DEBT_EDIT_PAYMENT'),
      };
    }
    case 'DEBT_EDIT_DUE': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      const cur = v.debt.due_day ? ` (сейчас ${v.debt.due_day}-е)` : '';
      return {
        step: 'debt:edit:day',
        text: `Новый день платежа в месяце (1–31)${cur}:`,
        markup: promptKb('DEBT_EDIT_DUE', [btn('Без дня', 'dbt:ed:day:none')]),
      };
    }
    case 'DEBT_HIST': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      if (!v) return renderDebt('DEBTS', {}, ctx);
      const evs = v.events.slice(-10).reverse();
      const rows = evs.map((e) => [btn(debtEventLabel(e, v.debt.currency), `dbt:ev:${e.id}`)]);
      return {
        step: 'debt:hist',
        text:
          `📜 Журнал «${escapeHtml(v.debt.name)}»:\n` +
          (rows.length ? 'Событие — сумма и дата (нажмите для правки):' : 'Пока без событий.'),
        markup: kb(rows, 'DEBT_HIST'),
      };
    }
    case 'DEBT_EVENT': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      const e = v?.events.find((x) => x.id === data.eventId);
      if (!v || !e) return renderDebt('DEBT_HIST', data, ctx);
      const modeLine =
        e.kind === 'prepay' ? `\nРежим: ${e.mode === 'reduce_term' ? '⏳ срок↓' : '📉 платёж↓'}` : '';
      const rows: InlineButton[][] = [
        [btn('✏️ Изменить', `dbt:ev:e:${e.id}`), btn('🗑 Удалить', `dbt:ev:d:${e.id}`)],
      ];
      if (e.kind === 'prepay')
        rows.push([btn(e.mode === 'reduce_term' ? '🔀 → платёж↓' : '🔀 → срок↓', `dbt:ev:m:${e.id}`)]);
      return {
        step: 'debt:ev',
        text: `Событие «${escapeHtml(v.debt.name)}»\n${debtEventLabel(e, v.debt.currency)}${modeLine}`,
        markup: kb(rows, 'DEBT_EVENT'),
      };
    }
    case 'DEBT_EVENT_EDIT': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      const e = v?.events.find((x) => x.id === data.eventId);
      if (!v || !e) return renderDebt('DEBT_HIST', data, ctx);
      const what = e.kind === 'reconcile' ? 'Новый остаток по выписке' : 'Новая сумма';
      return {
        step: 'debt:ev:edit',
        text: `${debtEventLabel(e, v.debt.currency)}\n${what} (${v.debt.currency}), можно с датой «11000 25.10»:`,
        markup: promptKb('DEBT_EVENT_EDIT'),
      };
    }
    case 'DEBT_EVENT_DEL': {
      const v = ctx.debts.find((x) => x.debt.id === data.debtId);
      const e = v?.events.find((x) => x.id === data.eventId);
      if (!v || !e) return renderDebt('DEBT_HIST', data, ctx);
      return {
        step: 'debt:ev:del',
        text: `Удалить событие «${escapeHtml(v.debt.name)}»?\n${debtEventLabel(e, v.debt.currency)}`,
        markup: kb([[btn('❌ Да, удалить', `dbt:ev:dy:${e.id}`)]], 'DEBT_EVENT_DEL'),
      };
    }
    case 'DEBT_ADD_NAME':
      return {
        step: 'debt:add:name',
        text: 'Новый кредит — название (например: Ипотека Сбер):',
        markup: promptKb('DEBT_ADD_NAME'),
      };
    case 'DEBT_ADD_BALANCE':
      return {
        step: 'debt:add:balance',
        text: 'Остаток кредита — сумма и валюта (например: 2100000 rub):',
        markup: promptKb('DEBT_ADD_BALANCE'),
      };
    case 'DEBT_ADD_RATE':
      return {
        step: 'debt:add:rate',
        text: 'Ставка, % годовых (например: 11.9):',
        markup: promptKb('DEBT_ADD_RATE'),
      };
    case 'DEBT_ADD_PAYMENT':
      return {
        step: 'debt:add:payment',
        text: `Платёж за период (${data.add?.currency ?? 'валюта долга'}):`,
        markup: promptKb('DEBT_ADD_PAYMENT'),
      };
    case 'DEBT_ADD_FREQ':
      return {
        step: 'debt:add:freq',
        text: 'Как часто платёж?',
        markup: promptKb('DEBT_ADD_FREQ', [btn('Ежемесячно', 'dbt:af:m'), btn('Раз в 2 недели', 'dbt:af:b')]),
      };
    case 'DEBT_ADD_DUE':
      return {
        step: 'debt:add:due',
        text: 'День платежа в месяце (1–31):',
        markup: promptKb('DEBT_ADD_DUE'),
      };
    case 'DEBT_ADD_EPOCH':
      return {
        step: 'debt:add:epoch',
        text: 'Дата ближайшего платежа (ДД.ММ или ДД.ММ.ГГГГ):',
        markup: promptKb('DEBT_ADD_EPOCH', [btn('Сегодня', 'dbt:ae:today')]),
      };
    default:
      return renderDebt('DEBTS', {}, ctx);
  }
}

/** Куда возвращает /cancel и ✖ Отмена: мастер → DEBTS, подтверждение → DEBT. */
export function debtCancelTarget(state: DebtState): string {
  const scr = DEBT_STEP_SCREEN[state.step] ?? 'HOME';
  return (
    (
      {
        DEBTS: 'HOME',
        DEBT: 'DEBTS',
        DEBT_DEL: 'DEBT',
        DEBT_PAY: 'DEBT',
        DEBT_PREPAY_ASK: 'DEBT',
        DEBT_PREPAY: 'DEBT',
        DEBT_RECON: 'DEBT',
        DEBT_EDIT: 'DEBT',
        DEBT_EDIT_RATE: 'DEBT_EDIT',
        DEBT_EDIT_PAYMENT: 'DEBT_EDIT',
        DEBT_EDIT_DUE: 'DEBT_EDIT',
        DEBT_HIST: 'DEBT',
        DEBT_EVENT: 'DEBT_HIST',
        DEBT_EVENT_EDIT: 'DEBT_HIST',
        DEBT_EVENT_DEL: 'DEBT_HIST',
        DEBT_ADD_NAME: 'DEBTS',
        DEBT_ADD_BALANCE: 'DEBTS',
        DEBT_ADD_RATE: 'DEBTS',
        DEBT_ADD_PAYMENT: 'DEBTS',
        DEBT_ADD_FREQ: 'DEBTS',
        DEBT_ADD_DUE: 'DEBTS',
        DEBT_ADD_EPOCH: 'DEBTS',
      } as Record<string, string>
    )[scr] ?? 'HOME'
  );
}

/** 'ДД.ММ' | 'ДД.ММ.ГГ(ГГ)' → 'YYYY-MM-DD'; год по умолчанию — из today. */
export function parseDayMonth(text: string, today: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/.exec(text.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const mon = Number(m[2]);
  let year = m[3] !== undefined ? Number(m[3]) : Number(today.slice(0, 4));
  if (year < 100) year += 2000;
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, mon - 1, day));
  if (d.getUTCMonth() !== mon - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * «<amount> [дата]»: хвост ДД.ММ(.ГГ[ГГ]) → eventOn; без даты — today;
 * кривая дата → badDate (сообщение об ошибке на стороне вызывающего).
 */
export function parseAmountDate(
  text: string,
  today: string,
): { amountText: string; eventOn: string; badDate: boolean } {
  const dm = /^(.*?)\s+(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)$/.exec(text.trim());
  if (!dm) return { amountText: text.trim(), eventOn: today, badDate: false };
  const iso = parseDayMonth(dm[2]!.replace(/\//g, '.'), today);
  if (!iso) return { amountText: text, eventOn: today, badDate: true };
  return { amountText: dm[1]!, eventOn: iso, badDate: false };
}

// ── редьюсер ──
export function advanceDebt(
  state: DebtState,
  input: DebtInput,
  ctx: DebtCtx,
): { state: DebtState | null; effects: DebtEffect[] } {
  const d = state.data;
  const cb = input.type === 'callback' ? input.data : null;
  const text = input.type === 'text' ? input.text.trim() : '';

  if (cb !== null) {
    const allowed = DEBT_STEPS[state.step];
    if (!cb.startsWith('dbt:') || !allowed || !new RegExp(`^(${allowed})`).test(cb))
      return { state, effects: [] };
  }

  /** Переход на экран из реестра (рендер через renderDebt — нав-ряд автоматически). */
  const go = (screenId: string, data: DebtState['data'] = {}, ...extra: DebtEffect[]) => {
    const r = renderDebt(screenId, data, ctx);
    return ok({ step: r.step, data }, send(r.text, r.markup), ...extra);
  };
  const view = () => ctx.debts.find((x) => x.debt.id === d.debtId);
  const add = d.add ?? {};
  const restartAdd = () => go('DEBT_ADD_NAME', { add: {} });

  /** Финал мастера: запись долга + возврат в список (R3). */
  const finishAdd = (draft: DebtAddDraft) =>
    ok(
      { step: 'debt', data: {} },
      {
        kind: 'debt_add',
        d: {
          name: draft.name!,
          amountMinor: draft.amountMinor!,
          currency: draft.currency!,
          rate: draft.rate!,
          paymentMinor: draft.paymentMinor!,
          frequency: draft.frequency!,
          dueDay: draft.dueDay ?? null,
          epoch: draft.epoch ?? ctx.today,
        },
      },
      { kind: 'render', screen: 'DEBTS', prefix: `Добавлен: ${escapeHtml(draft.name!)}\n\n` },
    );

  switch (state.step) {
    case 'debt': {
      if (cb === 'dbt:add') return restartAdd();
      const m = /^dbt:v:(\d+)$/.exec(cb ?? '');
      if (m) {
        const v = ctx.debts.find((x) => x.debt.id === Number(m[1]));
        if (!v) return { state, effects: [] }; // чужой/удалённый id — молча
        return go('DEBT', { debtId: v.debt.id });
      }
      return { state, effects: [] };
    }

    case 'debt:one': {
      const v = view();
      if (!v) return go('DEBTS');
      if (cb === `dbt:del:${v.debt.id}`) return go('DEBT_DEL', { debtId: v.debt.id });
      if (cb === 'dbt:hist') return go('DEBT_HIST', { debtId: v.debt.id });
      if (v.balance <= 0.01) return { state, effects: [] }; // погашен — только история/удаление
      if (cb === 'dbt:pay') return go('DEBT_PAY', { debtId: v.debt.id });
      if (cb === 'dbt:pp') return go('DEBT_PREPAY_ASK', { debtId: v.debt.id });
      if (cb === 'dbt:rc') return go('DEBT_RECON', { debtId: v.debt.id });
      if (cb === 'dbt:ed') return go('DEBT_EDIT', { debtId: v.debt.id });
      return { state, effects: [] };
    }

    case 'debt:del': {
      const v = view();
      if (!v) return go('DEBTS');
      if (cb === 'dbt:del:yes')
        return ok(
          { step: 'debt', data: {} },
          { kind: 'debt_del', id: v.debt.id },
          { kind: 'render', screen: 'DEBTS', prefix: `Удалён: ${escapeHtml(v.debt.name)}\n\n` },
        );
      return { state, effects: [] };
    }

    /** Разбор «сумма [дата]» для событийных промптов: платёж/ЧДП/сверка. */
    case 'debt:pay':
    case 'debt:recon': {
      const v = view();
      if (!v) return go('DEBTS');
      const sched = state.step === 'debt:pay' && cb === 'dbt:pay:sched';
      if (input.type === 'callback' && !sched) return { state, effects: [] };
      let amountMinor = toMinor(v.payment);
      let eventOn = ctx.today;
      if (!sched) {
        if (input.type !== 'text') return { state, effects: [] };
        const dm = parseAmountDate(text, ctx.today);
        if (dm.badDate) return ok(state, send('Дата — ДД.ММ или ДД.ММ.ГГГГ (например: 25.10).'));
        try {
          const a = parseAmount(dm.amountText);
          if (a.currency && a.currency !== v.debt.currency)
            return ok(state, send(`Сумма — в валюте кредита (${v.debt.currency}).`));
          amountMinor = toMinor(a.amount);
          eventOn = dm.eventOn;
        } catch (e) {
          return ok(state, send((e as Error).message));
        }
      }
      const kind = state.step === 'debt:pay' ? 'payment' : 'reconcile';
      const prefix =
        kind === 'payment'
          ? `✅ Платёж записан: ${fmtMoney(round2(amountMinor / 100), v.debt.currency)}\n\n`
          : `🏦 Сверено: фактический остаток ${fmtMoney(round2(amountMinor / 100), v.debt.currency)}\n\n`;
      return ok(
        { step: 'debt:one', data: { debtId: v.debt.id } },
        { kind: 'debt_event', id: v.debt.id, ev: { kind, amountMinor, eventOn } },
        { kind: 'render', screen: 'DEBT', data: { debtId: v.debt.id }, prefix },
      );
    }

    case 'debt:pp:ask': {
      const v = view();
      if (!v) return go('DEBTS');
      if (input.type !== 'text') return { state, effects: [] };
      const dm = parseAmountDate(text, ctx.today);
      if (dm.badDate) return ok(state, send('Дата — ДД.ММ или ДД.ММ.ГГГГ (например: 25.10).'));
      try {
        const a = parseAmount(dm.amountText);
        if (a.currency && a.currency !== v.debt.currency)
          return ok(state, send(`Сумма — в валюте кредита (${v.debt.currency}).`));
        if (a.amount > v.balance + 0.005) return ok(state, send('Сумма ЧДП больше остатка долга.'));
        return go('DEBT_PREPAY', { debtId: v.debt.id, pp: { amountMinor: toMinor(a.amount), eventOn: dm.eventOn } });
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'debt:pp': {
      const v = view();
      const pp = d.pp;
      if (!v || !pp) return go('DEBTS');
      const gm = /^dbt:pp:go:(p|t)$/.exec(cb ?? '');
      if (gm) {
        const mode = gm[1] === 't' ? 'reduce_term' : 'reduce_payment';
        const snap = {
          rate: v.debt.rate,
          frequency: v.debt.frequency,
          balance: v.balance,
          payment: v.payment,
          paymentsMade: v.paymentsMade,
          effectivePeriods: v.effectivePeriods,
        };
        const prefix =
          mode === 'reduce_term'
            ? `💸 ЧДП записано (срок↓): −${previewPrepayShortenTerm(snap, pp.amountMinor / 100).monthsSaved} мес\n\n`
            : `💸 ЧДП записано (платёж↓): ${(() => {
                const pv = previewPrepay(snap, pp.amountMinor / 100);
                return `${fmtMoney(round2(pv.paymentBefore), v.debt.currency)} → ${fmtMoney(round2(pv.paymentAfter), v.debt.currency)}`;
              })()}\n\n`;
        return ok(
          { step: 'debt:one', data: { debtId: v.debt.id } },
          { kind: 'debt_event', id: v.debt.id, ev: { kind: 'prepay', amountMinor: pp.amountMinor, eventOn: pp.eventOn, mode } },
          { kind: 'render', screen: 'DEBT', data: { debtId: v.debt.id }, prefix },
        );
      }
      return { state, effects: [] };
    }

    case 'debt:edit': {
      const v = view();
      if (!v) return go('DEBTS');
      if (cb === 'dbt:ed:rate') return go('DEBT_EDIT_RATE', { debtId: v.debt.id });
      if (cb === 'dbt:ed:pay') return go('DEBT_EDIT_PAYMENT', { debtId: v.debt.id });
      if (cb === 'dbt:ed:day' && v.debt.frequency === 'monthly') return go('DEBT_EDIT_DUE', { debtId: v.debt.id });
      return { state, effects: [] };
    }

    case 'debt:edit:rate': {
      const v = view();
      if (!v) return go('DEBTS');
      if (input.type !== 'text') return { state, effects: [] };
      const r = Number(text.replace('%', '').replace(',', '.').trim());
      if (!Number.isFinite(r) || r < 0 || r > 100)
        return ok(state, send('Ставка — число от 0 до 100 (например: 11.9).'));
      return ok(
        { step: 'debt:one', data: { debtId: v.debt.id } },
        { kind: 'debt_patch', id: v.debt.id, patch: { rate: r / 100 } },
        { kind: 'render', screen: 'DEBT', data: { debtId: v.debt.id }, prefix: `Новая ставка: ${fmtPct(r / 100)}\n\n` },
      );
    }

    case 'debt:edit:payment': {
      const v = view();
      if (!v) return go('DEBTS');
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        if (a.currency && a.currency !== v.debt.currency)
          return ok(state, send(`Платёж — в валюте кредита (${v.debt.currency}).`));
        return ok(
          { step: 'debt:one', data: { debtId: v.debt.id } },
          { kind: 'debt_patch', id: v.debt.id, patch: { initial_payment_minor: toMinor(a.amount) } },
          {
            kind: 'render',
            screen: 'DEBT',
            data: { debtId: v.debt.id },
            prefix: `Новый платёж: ${fmtMoney(round2(a.amount), v.debt.currency)}\n\n`,
          },
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'debt:edit:day': {
      const v = view();
      if (!v) return go('DEBTS');
      const finishDay = (dueDay: number | null, prefix: string) =>
        ok(
          { step: 'debt:one', data: { debtId: v.debt.id } },
          { kind: 'debt_patch', id: v.debt.id, patch: { due_day: dueDay } },
          { kind: 'render', screen: 'DEBT', data: { debtId: v.debt.id }, prefix },
        );
      if (cb === 'dbt:ed:day:none') return finishDay(null, 'День платежа убран.\n\n');
      if (input.type !== 'text') return { state, effects: [] };
      const day = Number(text);
      if (!Number.isInteger(day) || day < 1 || day > 31) return ok(state, send('День — число от 1 до 31.'));
      return finishDay(day, `День платежа: ${day}-е\n\n`);
    }

    case 'debt:hist': {
      const v = view();
      if (!v) return go('DEBTS');
      const m = /^dbt:ev:(\d+)$/.exec(cb ?? '');
      if (m && v.events.some((e) => e.id === Number(m[1])))
        return go('DEBT_EVENT', { debtId: v.debt.id, eventId: Number(m[1]) });
      return { state, effects: [] };
    }

    case 'debt:ev': {
      const v = view();
      const e = v?.events.find((x) => x.id === d.eventId);
      if (!v || !e) return go('DEBT_HIST', { debtId: d.debtId });
      if (cb === `dbt:ev:e:${e.id}`) return go('DEBT_EVENT_EDIT', { debtId: v.debt.id, eventId: e.id });
      if (cb === `dbt:ev:d:${e.id}`) return go('DEBT_EVENT_DEL', { debtId: v.debt.id, eventId: e.id });
      if (cb === `dbt:ev:m:${e.id}` && e.kind === 'prepay') {
        // переключение режима ЧДП — тут же, без промпта
        const next = e.mode === 'reduce_term' ? 'reduce_payment' : 'reduce_term';
        return ok(
          { step: 'debt:ev', data: { debtId: v.debt.id, eventId: e.id } },
          { kind: 'debt_event_patch', id: e.id, patch: { mode: next } },
          {
            kind: 'render',
            screen: 'DEBT_EVENT',
            data: { debtId: v.debt.id, eventId: e.id },
            prefix: `Режим: ${next === 'reduce_term' ? '⏳ срок↓' : '📉 платёж↓'}\n\n`,
          },
        );
      }
      return { state, effects: [] };
    }

    case 'debt:ev:edit': {
      const v = view();
      const e = v?.events.find((x) => x.id === d.eventId);
      if (!v || !e) return go('DEBT_HIST', { debtId: d.debtId });
      if (input.type !== 'text') return { state, effects: [] };
      const dm = parseAmountDate(text, ctx.today);
      if (dm.badDate) return ok(state, send('Дата — ДД.ММ или ДД.ММ.ГГГГ (например: 25.10).'));
      try {
        const a = parseAmount(dm.amountText);
        if (a.currency && a.currency !== v.debt.currency)
          return ok(state, send(`Сумма — в валюте кредита (${v.debt.currency}).`));
        if (e.kind === 'prepay') {
          // не позволяем ЧДП превысить остаток до этого события — грубая проверка по текущему остатку + сумме самого события
          const headroom = v.balance + e.amount_minor / 100;
          if (a.amount > headroom + 0.005) return ok(state, send('Сумма ЧДП больше остатка долга.'));
        }
        return ok(
          { step: 'debt:ev', data: { debtId: v.debt.id, eventId: e.id } },
          { kind: 'debt_event_patch', id: e.id, patch: { amount_minor: toMinor(a.amount), event_on: dm.eventOn } },
          {
            kind: 'render',
            screen: 'DEBT_EVENT',
            data: { debtId: v.debt.id, eventId: e.id },
            prefix: `Записано: ${fmtMoney(round2(a.amount), v.debt.currency)} (${dm.eventOn.split('-').reverse().join('.')})\n\n`,
          },
        );
      } catch (err) {
        return ok(state, send((err as Error).message));
      }
    }

    case 'debt:ev:del': {
      const v = view();
      const e = v?.events.find((x) => x.id === d.eventId);
      if (!v || !e) return go('DEBT_HIST', { debtId: d.debtId });
      if (cb === `dbt:ev:dy:${e.id}`)
        return ok(
          { step: 'debt:hist', data: { debtId: v.debt.id } },
          { kind: 'debt_event_del', id: e.id },
          { kind: 'render', screen: 'DEBT_HIST', data: { debtId: v.debt.id }, prefix: 'Событие удалено.\n\n' },
        );
      return { state, effects: [] };
    }

    case 'debt:add:name': {
      if (cb === 'dbt:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      const name = text.slice(0, 60);
      if (!name) return ok(state, send('Название не может быть пустым.'));
      return go('DEBT_ADD_BALANCE', { add: { name } });
    }

    case 'debt:add:balance': {
      if (cb === 'dbt:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        if (!a.currency) return ok(state, send('Укажите валюту после суммы, например: 2100000 rub'));
        return go('DEBT_ADD_RATE', { add: { ...add, amountMinor: toMinor(a.amount), currency: a.currency } });
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'debt:add:rate': {
      if (cb === 'dbt:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      const r = Number(text.replace('%', '').replace(',', '.').trim());
      if (!Number.isFinite(r) || r < 0 || r > 100)
        return ok(state, send('Ставка — число от 0 до 100 (например: 11.9).'));
      return go('DEBT_ADD_PAYMENT', { add: { ...add, rate: r / 100 } });
    }

    case 'debt:add:payment': {
      if (cb === 'dbt:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        if (a.currency && a.currency !== add.currency)
          return ok(state, send(`Платёж — в валюте долга (${add.currency}).`));
        return go('DEBT_ADD_FREQ', { add: { ...add, paymentMinor: toMinor(a.amount) } });
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'debt:add:freq': {
      if (cb === 'dbt:af:m') return go('DEBT_ADD_DUE', { add: { ...add, frequency: 'monthly' } });
      if (cb === 'dbt:af:b') return go('DEBT_ADD_EPOCH', { add: { ...add, frequency: 'biweekly' } });
      if (cb === 'dbt:add') return restartAdd();
      return { state, effects: [] };
    }

    case 'debt:add:due': {
      if (cb === 'dbt:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      const day = Number(text);
      if (!Number.isInteger(day) || day < 1 || day > 31)
        return ok(state, send('День — число от 1 до 31.'));
      return finishAdd({ ...add, dueDay: day });
    }

    case 'debt:add:epoch': {
      if (cb === 'dbt:ae:today') return finishAdd({ ...add, epoch: ctx.today });
      if (cb === 'dbt:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      const iso = parseDayMonth(text, ctx.today);
      if (!iso) return ok(state, send('Дата — ДД.ММ или ДД.ММ.ГГГГ (например: 05.11).'));
      return finishAdd({ ...add, epoch: iso });
    }

    default:
      return { state: null, effects: [] };
  }
}
