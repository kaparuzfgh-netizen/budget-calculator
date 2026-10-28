/**
 * loans.ts — личные займы между людьми («Долги людям»).
 * ЧИСТЫЙ редьюсер advanceLoan(state, input, ctx) → {state, effects}; I/O — access.ts.
 * renderLoan(screenId, data, ctx) — единый источник разметки (нав-ряд из navRow, R1–R4).
 * «Я должен» (owe) / «Мне должны» (owed); возвраты — события repay в loan_events.
 */
import type { ReplyMarkup } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import type { InlineButton } from '../telegram/client';
import type { LoanCtx, LoanView } from '../services/loans';
import type { LoanEventRow } from '../db/repo';
import { fmtMoney } from './format';
import { parseAmount } from './parse';
import { round2, toMinor } from '../domain/money';
import { checkRepay } from '../domain/loan';
import { navRow } from './nav/nav';
import { parseAmountDate, parseDayMonth } from './debts';
import { LIMITS } from '../tma/common';

export interface LoanAddDraft {
  direction?: 'owe' | 'owed' | undefined;
  counterparty?: string | undefined;
  amountMinor?: number | undefined;
  currency?: string | undefined;
  dueOn?: string | null | undefined;
  note?: string | null | undefined;
}

export interface LoanState {
  step: string;
  data: {
    loanId?: number | undefined;
    /** Событие возврата — для экранов правки/удаления. */
    eventId?: number | undefined;
    add?: LoanAddDraft | undefined;
  };
}

export type LoanInput = { type: 'text'; text: string } | { type: 'callback'; data: string };

export interface LoanAddPayload {
  counterparty: string;
  direction: 'owe' | 'owed';
  amountMinor: number;
  currency: string;
  dueOn: string | null;
  note: string | null;
}

export type LoanEffect =
  | { kind: 'send'; text: string; markup?: ReplyMarkup }
  | { kind: 'loan_add'; d: LoanAddPayload }
  | { kind: 'loan_repay'; id: number; amountMinor: number; eventOn: string }
  | { kind: 'loan_due'; id: number; dueOn: string | null }
  | { kind: 'loan_close'; id: number }
  | { kind: 'loan_del'; id: number }
  | { kind: 'loan_event_patch'; id: number; patch: { amount_minor?: number; event_on?: string } }
  | { kind: 'loan_event_del'; id: number }
  // render — экран рендерится ПОСЛЕ мутаций из свежего ctx (runLoanEffects перечитывает данные)
  | { kind: 'render'; screen: string; data?: LoanState['data'] | undefined; prefix?: string | undefined };

const send = (text: string, markup?: ReplyMarkup): LoanEffect => ({ kind: 'send', text, ...(markup ? { markup } : {}) });
const ok = (state: LoanState | null, ...effects: LoanEffect[]) => ({ state, effects });

// ── step ↔ screenId (реестр screens.json) ──
export const LOAN_STEP_SCREEN: Record<string, string> = {
  loan: 'LOANS',
  'loan:closed': 'LOANS_CLOSED',
  'loan:one': 'LOAN',
  'loan:repay': 'LOAN_REPAY',
  'loan:due': 'LOAN_DUE_EDIT',
  'loan:close': 'LOAN_CLOSE',
  'loan:del': 'LOAN_DEL',
  'loan:hist': 'LOAN_HIST',
  'loan:ev': 'LOAN_EVENT',
  'loan:ev:edit': 'LOAN_EVENT_EDIT',
  'loan:ev:del': 'LOAN_EVENT_DEL',
  'loan:add:dir': 'LOAN_ADD_DIR',
  'loan:add:name': 'LOAN_ADD_NAME',
  'loan:add:amount': 'LOAN_ADD_AMOUNT',
  'loan:add:due': 'LOAN_ADD_DUE',
  'loan:add:note': 'LOAN_ADD_NOTE',
};

/** Множество loan-экранов реестра — для nv-диспетчера в access.ts. */
export const LOAN_SCREENS = new Set(Object.values(LOAN_STEP_SCREEN));

/** Разрешённые callback-паттерны на каждом шаге (step-aware, R7). nv:* — вне редьюсера. */
export const LOAN_STEPS: Record<string, string> = {
  loan: 'ln:v:|ln:add$|ln:arc$',
  'loan:closed': 'ln:v:',
  'loan:one': 'ln:(rp|cl|dl|dd|hs)$',
  'loan:repay': 'ln:rp:all$',
  'loan:due': 'ln:dd:none$',
  'loan:close': 'ln:cl:yes$',
  'loan:del': 'ln:dl:yes$',
  'loan:hist': 'ln:ev:\\d+$',
  'loan:ev': 'ln:ev:(e|d):\\d+$',
  'loan:ev:edit': '', // только текст
  'loan:ev:del': 'ln:ev:dy:\\d+$',
  'loan:add:dir': 'ln:dir:|ln:add$',
  'loan:add:name': 'ln:add$',
  'loan:add:amount': 'ln:add$',
  'loan:add:due': 'ln:nodue$|ln:add$',
  'loan:add:note': 'ln:nonote$|ln:add$',
};

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

const dirLabel = (d: 'owe' | 'owed') => (d === 'owe' ? 'я должен' : 'мне должны');

/** Подпись события возврата: «05.02 — 💸 Возврат 5 000 сом». */
const loanEventLabel = (e: LoanEventRow, ccy: string) =>
  `${e.event_on.slice(8)}.${e.event_on.slice(5, 7)} — 💸 Возврат ${fmtMoney(e.amount_minor / 100, ccy)}`;
const statusLabel = (v: LoanView) =>
  v.status === 'closed' ? (v.loan.closed_at ? '· закрыт' : '· возвращён ✅') : v.status === 'partial' ? '· частично' : '';

// ── тексты экранов ──
export function loansText(ctx: LoanCtx): string {
  const all = [...ctx.owe, ...ctx.owed];
  if (!all.length) return '🤝 <b>Долги</b>\nЛичные займы — «я должен» и «мне должны». Пока пусто.';
  const open = all.filter((v) => v.status !== 'closed');
  if (!open.length) return `🤝 <b>Долги</b>\nВсе займы закрыты (${all.length}).`;
  const line = (v: LoanView) =>
    `  • ${escapeHtml(v.loan.counterparty)} — ${fmtMoney(round2(v.remaining), v.loan.currency)}${statusLabel(v)}`;
  const oweSec = ctx.owe.filter((v) => v.status !== 'closed');
  const owedSec = ctx.owed.filter((v) => v.status !== 'closed');
  const parts: string[] = ['🤝 <b>Долги</b>'];
  if (oweSec.length) {
    parts.push('<b>Я должен:</b>', ...oweSec.map(line));
    if (typeof ctx.oweUsd === 'number' && oweSec.length) parts.push(`  Итого: ≈${fmtMoney(ctx.oweUsd, 'USD')}`);
  }
  if (owedSec.length) {
    parts.push('<b>Мне должны:</b>', ...owedSec.map(line));
    if (typeof ctx.owedUsd === 'number' && owedSec.length) parts.push(`  Итого: ≈${fmtMoney(ctx.owedUsd, 'USD')}`);
  }
  return parts.join('\n');
}

export function loanCardText(v: LoanView): string {
  const l = v.loan;
  const head =
    l.direction === 'owe'
      ? `🤝 <b>${escapeHtml(l.counterparty)}</b> — я должен`
      : `🤝 <b>${escapeHtml(l.counterparty)}</b> — мне должны`;
  const status =
    v.status === 'closed'
      ? l.closed_at
        ? '✅ Закрыт (остаток прощён)'
        : '✅ Возвращён полностью'
      : v.status === 'partial'
        ? '⏳ Возвращается частями'
        : 'Открыт';
  const lines = [
    head,
    `Остаток: <b>${fmtMoney(round2(v.remaining), l.currency)}</b> из ${fmtMoney(round2(l.amount_minor / 100), l.currency)}`,
    `Внесено: ${fmtMoney(round2(v.repaid), l.currency)} · ${status}`,
  ];
  if (v.status === 'closed') {
    const closed = (l.closed_at ?? v.lastEventOn ?? '').slice(0, 10);
    if (closed) lines.push(`Закрыт: ${closed.split('-').reverse().join('.')}`);
  }
  if (l.due_on) lines.push(`Срок: до ${l.due_on.split('-').reverse().join('.')}`);
  if (l.note) lines.push(`Заметка: ${escapeHtml(l.note)}`);
  return lines.join('\n');
}

// ── ЕДИНЫЙ рендер экрана (используют редьюсер и nv-диспетчер) ──
export function renderLoan(
  screenId: string,
  data: LoanState['data'],
  ctx: LoanCtx,
): { step: string; text: string; markup?: ReplyMarkup | undefined } {
  const all = [...ctx.owe, ...ctx.owed];
  const view = () => all.find((x) => x.loan.id === data.loanId);
  switch (screenId) {
    case 'LOANS': {
      const open = all.filter((v) => v.status !== 'closed').slice(0, 20);
      const closedN = all.length - all.filter((v) => v.status !== 'closed').length;
      const rows = open.map((v) => [
        btn(
          `${v.loan.direction === 'owe' ? '→' : '←'} ${v.loan.counterparty} — ${fmtMoney(round2(v.remaining), v.loan.currency)}`,
          `ln:v:${v.loan.id}`,
        ),
      ]);
      if (closedN) rows.push([btn(`✅ Закрытые (${closedN})`, 'ln:arc')]);
      rows.push([btn('➕ Добавить долг', 'ln:add')]);
      return { step: 'loan', text: loansText(ctx), markup: kb(rows, 'LOANS') };
    }
    case 'LOANS_CLOSED': {
      const closed = all.filter((v) => v.status === 'closed').slice(0, 20);
      const rows = closed.map((v) => [
        btn(
          `✅ ${v.loan.direction === 'owe' ? '→' : '←'} ${v.loan.counterparty} — ${fmtMoney(v.loan.amount_minor / 100, v.loan.currency)}`,
          `ln:v:${v.loan.id}`,
        ),
      ]);
      return {
        step: 'loan:closed',
        text: closed.length
          ? '✅ <b>Закрытые займы</b>\nКому, сколько и когда вернули — в карточке и журнале:'
          : '✅ <b>Закрытые займы</b>\nПока пусто.',
        markup: kb(rows, 'LOANS_CLOSED'),
      };
    }
    case 'LOAN': {
      const v = view();
      if (!v) return renderLoan('LOANS', {}, ctx);
      const rows =
        v.status === 'closed'
          ? [[btn('📜 Журнал', 'ln:hs'), btn('❌ Удалить', 'ln:dl')]]
          : [
              [btn('💸 Возврат', 'ln:rp'), btn('✅ Закрыть', 'ln:cl')],
              [btn('⏳ Срок', 'ln:dd'), btn('📜 Журнал', 'ln:hs')],
              [btn('❌ Удалить', 'ln:dl')],
            ];
      return { step: 'loan:one', text: loanCardText(v), markup: kb(rows, 'LOAN') };
    }
    case 'LOAN_REPAY': {
      const v = view();
      if (!v) return renderLoan('LOANS', {}, ctx);
      return {
        step: 'loan:repay',
        text: `Возврат «${escapeHtml(v.loan.counterparty)}» — осталось ${fmtMoney(round2(v.remaining), v.loan.currency)}.\nСумма (${v.loan.currency}), можно с датой «5000 25.10»:`,
        markup: promptKb('LOAN_REPAY', [btn('💯 Вся сумма', 'ln:rp:all')]),
      };
    }
    case 'LOAN_DUE_EDIT': {
      const v = view();
      if (!v) return renderLoan('LOANS', {}, ctx);
      const cur = v.loan.due_on ? ` (сейчас ${v.loan.due_on.split('-').reverse().join('.')})` : ' (сейчас без срока)';
      return {
        step: 'loan:due',
        text: `Новый срок возврата${cur} (ДД.ММ или ДД.ММ.ГГГГ):`,
        markup: promptKb('LOAN_DUE_EDIT', [btn('Без срока', 'ln:dd:none')]),
      };
    }
    case 'LOAN_CLOSE': {
      const v = view();
      if (!v) return renderLoan('LOANS', {}, ctx);
      const rest =
        v.remaining > 0.005 ? ` Остаток ${fmtMoney(round2(v.remaining), v.loan.currency)} будет прощён.` : '';
      return {
        step: 'loan:close',
        text: `Закрыть долг «${escapeHtml(v.loan.counterparty)}»?${rest}`,
        markup: kb([[btn('✅ Да, закрыть', 'ln:cl:yes')]], 'LOAN_CLOSE'),
      };
    }
    case 'LOAN_DEL': {
      const v = view();
      if (!v) return renderLoan('LOANS', {}, ctx);
      return {
        step: 'loan:del',
        text: `Удалить «${escapeHtml(v.loan.counterparty)}» и историю возвратов?`,
        markup: kb([[btn('❌ Да, удалить', 'ln:dl:yes')]], 'LOAN_DEL'),
      };
    }
    case 'LOAN_HIST': {
      const v = view();
      if (!v) return renderLoan('LOANS', {}, ctx);
      const evs = v.events.slice(-10).reverse();
      const rows = evs.map((e) => [btn(loanEventLabel(e, v.loan.currency), `ln:ev:${e.id}`)]);
      return {
        step: 'loan:hist',
        text:
          `📜 Журнал «${escapeHtml(v.loan.counterparty)}»:\n` +
          (rows.length ? 'Возврат — сумма и дата (нажмите для правки):' : 'Пока без возвратов.'),
        markup: kb(rows, 'LOAN_HIST'),
      };
    }
    case 'LOAN_EVENT': {
      const v = view();
      const e = v?.events.find((x) => x.id === data.eventId);
      if (!v || !e) return renderLoan('LOAN_HIST', data, ctx);
      return {
        step: 'loan:ev',
        text: `Возврат «${escapeHtml(v.loan.counterparty)}»\n${loanEventLabel(e, v.loan.currency)}`,
        markup: kb([[btn('✏️ Изменить', `ln:ev:e:${e.id}`), btn('🗑 Удалить', `ln:ev:d:${e.id}`)]], 'LOAN_EVENT'),
      };
    }
    case 'LOAN_EVENT_EDIT': {
      const v = view();
      const e = v?.events.find((x) => x.id === data.eventId);
      if (!v || !e) return renderLoan('LOAN_HIST', data, ctx);
      return {
        step: 'loan:ev:edit',
        text: `${loanEventLabel(e, v.loan.currency)}\nНовая сумма (${v.loan.currency}), можно с датой «5000 25.10»:`,
        markup: promptKb('LOAN_EVENT_EDIT'),
      };
    }
    case 'LOAN_EVENT_DEL': {
      const v = view();
      const e = v?.events.find((x) => x.id === data.eventId);
      if (!v || !e) return renderLoan('LOAN_HIST', data, ctx);
      return {
        step: 'loan:ev:del',
        text: `Удалить возврат «${escapeHtml(v.loan.counterparty)}»?\n${loanEventLabel(e, v.loan.currency)}`,
        markup: kb([[btn('❌ Да, удалить', `ln:ev:dy:${e.id}`)]], 'LOAN_EVENT_DEL'),
      };
    }
    case 'LOAN_ADD_DIR':
      return {
        step: 'loan:add:dir',
        text: 'Новый долг — кто кому должен?',
        markup: promptKb('LOAN_ADD_DIR', [btn('Я должен', 'ln:dir:owe'), btn('Мне должны', 'ln:dir:owed')]),
      };
    case 'LOAN_ADD_NAME':
      return {
        step: 'loan:add:name',
        text: `${data.add?.direction === 'owed' ? 'Кто должен' : 'Кому должен'} — имя (например: Вася):`,
        markup: promptKb('LOAN_ADD_NAME'),
      };
    case 'LOAN_ADD_AMOUNT':
      return {
        step: 'loan:add:amount',
        text: 'Сумма и валюта (300 usd, 500 руб, 2000 сом):',
        markup: promptKb('LOAN_ADD_AMOUNT'),
      };
    case 'LOAN_ADD_DUE':
      return {
        step: 'loan:add:due',
        text: 'Срок возврата (ДД.ММ или ДД.ММ.ГГГГ):',
        markup: promptKb('LOAN_ADD_DUE', [btn('Без срока', 'ln:nodue')]),
      };
    case 'LOAN_ADD_NOTE':
      return {
        step: 'loan:add:note',
        text: 'Заметка (или «Пропустить»):',
        markup: promptKb('LOAN_ADD_NOTE', [btn('Пропустить', 'ln:nonote')]),
      };
    default:
      return renderLoan('LOANS', {}, ctx);
  }
}

/** Куда возвращает /cancel и ✖ Отмена: мастер → LOANS, промпт/подтверждение → LOAN. */
export function loanCancelTarget(state: LoanState): string {
  const scr = LOAN_STEP_SCREEN[state.step] ?? 'HOME';
  return (
    (
      {
        LOANS: 'HOME',
        LOANS_CLOSED: 'LOANS',
        LOAN: 'LOANS',
        LOAN_REPAY: 'LOAN',
        LOAN_DUE_EDIT: 'LOAN',
        LOAN_CLOSE: 'LOAN',
        LOAN_DEL: 'LOAN',
        LOAN_HIST: 'LOAN',
        LOAN_EVENT: 'LOAN_HIST',
        LOAN_EVENT_EDIT: 'LOAN_HIST',
        LOAN_EVENT_DEL: 'LOAN_HIST',
        LOAN_ADD_DIR: 'LOANS',
        LOAN_ADD_NAME: 'LOANS',
        LOAN_ADD_AMOUNT: 'LOANS',
        LOAN_ADD_DUE: 'LOANS',
        LOAN_ADD_NOTE: 'LOANS',
      } as Record<string, string>
    )[scr] ?? 'HOME'
  );
}

// ── редьюсер ──
export function advanceLoan(
  state: LoanState,
  input: LoanInput,
  ctx: LoanCtx,
): { state: LoanState | null; effects: LoanEffect[] } {
  const d = state.data;
  const cb = input.type === 'callback' ? input.data : null;
  const text = input.type === 'text' ? input.text.trim() : '';
  const all = [...ctx.owe, ...ctx.owed];

  if (cb !== null) {
    const allowed = LOAN_STEPS[state.step];
    if (!cb.startsWith('ln:') || !allowed || !new RegExp(`^(${allowed})`).test(cb))
      return { state, effects: [] };
  }

  const go = (screenId: string, data: LoanState['data'] = {}, ...extra: LoanEffect[]) => {
    const r = renderLoan(screenId, data, ctx);
    return ok({ step: r.step, data }, send(r.text, r.markup), ...extra);
  };
  const view = () => all.find((x) => x.loan.id === d.loanId);
  const add = d.add ?? {};
  const restartAdd = () => {
    // P2-2: открытые займы (closed_at IS NULL) — та же граница, что у REST countLoans
    const active = all.filter((v) => v.loan.closed_at === null).length;
    if (active >= LIMITS.maxLoans)
      return ok(state, send(`Максимум ${LIMITS.maxLoans} займов — сначала удалите ненужный.`));
    return go('LOAN_ADD_DIR', { add: {} });
  };

  /** Финал мастера: запись займа + возврат в список (R3). */
  const finishAdd = (draft: LoanAddDraft) =>
    ok(
      { step: 'loan', data: {} },
      {
        kind: 'loan_add',
        d: {
          counterparty: draft.counterparty!,
          direction: draft.direction!,
          amountMinor: draft.amountMinor!,
          currency: draft.currency!,
          dueOn: draft.dueOn ?? null,
          note: draft.note ?? null,
        },
      },
      {
        kind: 'render',
        screen: 'LOANS',
        prefix: `Добавлен: ${dirLabel(draft.direction!)} ${escapeHtml(draft.counterparty!)} — ${fmtMoney(round2(draft.amountMinor! / 100), draft.currency!)}\n\n`,
      },
    );

  switch (state.step) {
    case 'loan':
    case 'loan:closed': {
      if (state.step === 'loan' && cb === 'ln:add') return restartAdd();
      if (state.step === 'loan' && cb === 'ln:arc') return go('LOANS_CLOSED');
      const m = /^ln:v:(\d+)$/.exec(cb ?? '');
      if (m) {
        const v = all.find((x) => x.loan.id === Number(m[1]));
        if (!v) return { state, effects: [] }; // чужой/удалённый id — молча
        return go('LOAN', { loanId: v.loan.id });
      }
      return { state, effects: [] };
    }

    case 'loan:one': {
      const v = view();
      if (!v) return go('LOANS');
      if (cb === 'ln:rp') {
        if (v.status === 'closed') return { state, effects: [] };
        return go('LOAN_REPAY', { loanId: v.loan.id });
      }
      if (cb === 'ln:cl') {
        if (v.status === 'closed') return { state, effects: [] };
        return go('LOAN_CLOSE', { loanId: v.loan.id });
      }
      if (cb === 'ln:dd') {
        if (v.status === 'closed') return { state, effects: [] };
        return go('LOAN_DUE_EDIT', { loanId: v.loan.id });
      }
      if (cb === 'ln:hs') return go('LOAN_HIST', { loanId: v.loan.id });
      if (cb === 'ln:dl') return go('LOAN_DEL', { loanId: v.loan.id });
      return { state, effects: [] };
    }

    case 'loan:repay': {
      const v = view();
      if (!v) return go('LOANS');
      if (cb === 'ln:rp:all')
        // «вернул всё» — полная сумма без ввода
        return ok(
          { step: 'loan:one', data: { loanId: v.loan.id } },
          { kind: 'loan_repay', id: v.loan.id, amountMinor: toMinor(v.remaining), eventOn: ctx.today },
          {
            kind: 'render',
            screen: 'LOAN',
            data: { loanId: v.loan.id },
            prefix: `✅ ${dirLabel(v.loan.direction)} ${escapeHtml(v.loan.counterparty)} — возвращён полностью!\n\n`,
          },
        );
      if (input.type !== 'text') return { state, effects: [] };
      // опциональная дата возврата в конце: «5000» → сегодня, «5000 25.10» → 25.10
      const dm = parseAmountDate(text, ctx.today);
      if (dm.badDate) return ok(state, send('Дата — ДД.ММ или ДД.ММ.ГГГГ (например: 25.10).'));
      const eventOn = dm.eventOn;
      try {
        const a = parseAmount(dm.amountText);
        if (a.currency && a.currency !== v.loan.currency)
          return ok(state, send(`Сумма — в валюте долга (${v.loan.currency}).`));
        checkRepay(v.remaining, a.amount);
        const full = a.amount >= v.remaining - 0.005;
        return ok(
          { step: 'loan:one', data: { loanId: v.loan.id } },
          { kind: 'loan_repay', id: v.loan.id, amountMinor: toMinor(a.amount), eventOn },
          {
            kind: 'render',
            screen: 'LOAN',
            data: { loanId: v.loan.id },
            prefix: full
              ? `✅ ${dirLabel(v.loan.direction)} ${escapeHtml(v.loan.counterparty)} — возвращён полностью!\n\n`
              : `Внесено: ${fmtMoney(round2(a.amount), v.loan.currency)}\n\n`,
          },
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'loan:due': {
      const v = view();
      if (!v) return go('LOANS');
      const finishDue = (dueOn: string | null, prefix: string) =>
        ok(
          { step: 'loan:one', data: { loanId: v.loan.id } },
          { kind: 'loan_due', id: v.loan.id, dueOn },
          { kind: 'render', screen: 'LOAN', data: { loanId: v.loan.id }, prefix },
        );
      if (cb === 'ln:dd:none') return finishDue(null, 'Срок убран.\n\n');
      if (input.type !== 'text') return { state, effects: [] };
      const iso = parseDayMonth(text, ctx.today);
      if (!iso) return ok(state, send('Дата — ДД.ММ или ДД.ММ.ГГГГ (например: 15.11).'));
      return finishDue(iso, `Новый срок: ${iso.split('-').reverse().join('.')}\n\n`);
    }

    case 'loan:close': {
      const v = view();
      if (!v) return go('LOANS');
      if (cb === 'ln:cl:yes')
        return ok(
          { step: 'loan:one', data: { loanId: v.loan.id } },
          { kind: 'loan_close', id: v.loan.id },
          { kind: 'render', screen: 'LOAN', data: { loanId: v.loan.id }, prefix: 'Закрыт.\n\n' },
        );
      return { state, effects: [] };
    }

    case 'loan:del': {
      const v = view();
      if (!v) return go('LOANS');
      if (cb === 'ln:dl:yes')
        return ok(
          { step: 'loan', data: {} },
          { kind: 'loan_del', id: v.loan.id },
          { kind: 'render', screen: 'LOANS', prefix: `Удалён: ${escapeHtml(v.loan.counterparty)}\n\n` },
        );
      return { state, effects: [] };
    }

    case 'loan:hist': {
      const v = view();
      if (!v) return go('LOANS');
      const m = /^ln:ev:(\d+)$/.exec(cb ?? '');
      if (m && v.events.some((e) => e.id === Number(m[1])))
        return go('LOAN_EVENT', { loanId: v.loan.id, eventId: Number(m[1]) });
      return { state, effects: [] };
    }

    case 'loan:ev': {
      const v = view();
      const e = v?.events.find((x) => x.id === d.eventId);
      if (!v || !e) return go('LOAN_HIST', { loanId: d.loanId });
      if (cb === `ln:ev:e:${e.id}`) return go('LOAN_EVENT_EDIT', { loanId: v.loan.id, eventId: e.id });
      if (cb === `ln:ev:d:${e.id}`) return go('LOAN_EVENT_DEL', { loanId: v.loan.id, eventId: e.id });
      return { state, effects: [] };
    }

    case 'loan:ev:edit': {
      const v = view();
      const e = v?.events.find((x) => x.id === d.eventId);
      if (!v || !e) return go('LOAN_HIST', { loanId: d.loanId });
      if (input.type !== 'text') return { state, effects: [] };
      const dm = parseAmountDate(text, ctx.today);
      if (dm.badDate) return ok(state, send('Дата — ДД.ММ или ДД.ММ.ГГГГ (например: 25.10).'));
      try {
        const a = parseAmount(dm.amountText);
        if (a.currency && a.currency !== v.loan.currency)
          return ok(state, send(`Сумма — в валюте долга (${v.loan.currency}).`));
        // сумма не может превысить то, что было на тот момент:
        // текущий остаток + внесённые ПОСЛЕ этого события + само событие
        const after = v.events.filter((x) => x.event_on > e.event_on || (x.event_on === e.event_on && x.id > e.id));
        const headroom = v.remaining + after.reduce((s, x) => s + x.amount_minor / 100, 0) + e.amount_minor / 100;
        if (a.amount > headroom + 0.005) return ok(state, send('Сумма больше, чем оставалось долга.'));
        return ok(
          { step: 'loan:ev', data: { loanId: v.loan.id, eventId: e.id } },
          { kind: 'loan_event_patch', id: e.id, patch: { amount_minor: toMinor(a.amount), event_on: dm.eventOn } },
          {
            kind: 'render',
            screen: 'LOAN_EVENT',
            data: { loanId: v.loan.id, eventId: e.id },
            prefix: `Записано: ${fmtMoney(round2(a.amount), v.loan.currency)} (${dm.eventOn.split('-').reverse().join('.')})\n\n`,
          },
        );
      } catch (err) {
        return ok(state, send((err as Error).message));
      }
    }

    case 'loan:ev:del': {
      const v = view();
      const e = v?.events.find((x) => x.id === d.eventId);
      if (!v || !e) return go('LOAN_HIST', { loanId: d.loanId });
      if (cb === `ln:ev:dy:${e.id}`)
        return ok(
          { step: 'loan:hist', data: { loanId: v.loan.id } },
          { kind: 'loan_event_del', id: e.id },
          { kind: 'render', screen: 'LOAN_HIST', data: { loanId: v.loan.id }, prefix: 'Возврат удалён.\n\n' },
        );
      return { state, effects: [] };
    }

    case 'loan:add:dir': {
      if (cb === 'ln:dir:owe') return go('LOAN_ADD_NAME', { add: { direction: 'owe' } });
      if (cb === 'ln:dir:owed') return go('LOAN_ADD_NAME', { add: { direction: 'owed' } });
      if (cb === 'ln:add') return restartAdd();
      return { state, effects: [] };
    }

    case 'loan:add:name': {
      if (cb === 'ln:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      const name = text.slice(0, 40);
      if (!name) return ok(state, send('Имя не может быть пустым.'));
      return go('LOAN_ADD_AMOUNT', { add: { ...add, counterparty: name } });
    }

    case 'loan:add:amount': {
      if (cb === 'ln:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        if (!a.currency) return ok(state, send('Укажите валюту после суммы: 300 usd, 500 руб, 2000 сом'));
        return go('LOAN_ADD_DUE', { add: { ...add, amountMinor: toMinor(a.amount), currency: a.currency } });
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'loan:add:due': {
      if (cb === 'ln:nodue') return go('LOAN_ADD_NOTE', { add: { ...add, dueOn: null } });
      if (cb === 'ln:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      const iso = parseDayMonth(text, ctx.today);
      if (!iso) return ok(state, send('Дата — ДД.ММ или ДД.ММ.ГГГГ (например: 15.11).'));
      return go('LOAN_ADD_NOTE', { add: { ...add, dueOn: iso } });
    }

    case 'loan:add:note': {
      if (cb === 'ln:nonote') return finishAdd({ ...add, note: null });
      if (cb === 'ln:add') return restartAdd();
      if (input.type !== 'text') return { state, effects: [] };
      return finishAdd({ ...add, note: text.slice(0, 120) || null });
    }

    default:
      return { state: null, effects: [] };
  }
}
