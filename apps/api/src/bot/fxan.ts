/**
 * fxan.ts — /fx: валютный анализ + журнал фактических обменов (шаг 8).
 * ЧИСТЫЙ редьюсер advanceFx(state, input, ctx) → {state, effects}; I/O — access.ts.
 * renderFx(screenId, data, ctx) — ЕДИНСТВЕННЫЙ источник разметки экранов:
 *   экшн-кнопки + навигационный ряд из navRow() реестра (R1–R4).
 *
 * Мастер записи — по шагам как у займов:
 *   FX_ADD_FROM → FX_ADD_TO → FX_ADD_AMOUNTS → FX_ADD_DATE → FX_ADD_NOTE → FX_LIST.
 * rate/market_rate считает access.ts при выполнении эффекта fx_add/fx_patch
 * (там живёт getFxRates — редьюсер чистый).
 */
import type { InlineButton, ReplyMarkup } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import type { ExchangeRow } from '../db/repo';
import type { FxCtx } from '../services/fx';
import { renderFxText } from '../services/fx';
import { DomainError } from '../domain/errors';
import { toMinor } from '../domain/money';
import { fmtMoney } from './format';
import { parseAmount, parseCurrencyCode } from './parse';
import { parseDayMonth } from './debts';
import { LIMITS } from '../tma/common';
import { navRow } from './nav/nav';

// ── состояние ──

export interface FxAddDraft {
  from?: string | undefined;
  to?: string | undefined;
  amountFromMinor?: number | undefined;
  amountToMinor?: number | undefined;
  spentOn?: string | undefined;
}

export interface FxState {
  step: string;
  data: {
    exchangeId?: number | undefined;
    add?: FxAddDraft | undefined;
  };
}

export type FxInput = { type: 'text'; text: string } | { type: 'callback'; data: string };

export type FxEffect =
  | { kind: 'send'; text: string; markup?: ReplyMarkup }
  | {
      kind: 'fx_add';
      d: { from: string; to: string; amountFromMinor: number; amountToMinor: number; spentOn: string; note: string };
    }
  | {
      kind: 'fx_patch';
      id: number;
      patch: { amount_from_minor?: number; amount_to_minor?: number; spent_on?: string; note?: string };
    }
  | { kind: 'fx_del'; id: number }
  | { kind: 'render'; screen: string; data?: FxState['data'] | undefined; prefix?: string | undefined };

const send = (text: string, markup?: ReplyMarkup): FxEffect => ({ kind: 'send', text, ...(markup ? { markup } : {}) });
const ok = (state: FxState | null, ...effects: FxEffect[]) => ({ state, effects });

// ── step ↔ screenId (реестр screens.json) ──
export const FX_STEP_SCREEN: Record<string, string> = {
  fx: 'FX_HUB',
  'fx:list': 'FX_LIST',
  'fx:item': 'FX_ITEM',
  'fx:e:amounts': 'FX_EDIT_AMOUNTS',
  'fx:e:date': 'FX_EDIT_DATE',
  'fx:e:note': 'FX_EDIT_NOTE',
  'fx:del': 'FX_DEL',
  'fx:add:from': 'FX_ADD_FROM',
  'fx:add:to': 'FX_ADD_TO',
  'fx:add:amounts': 'FX_ADD_AMOUNTS',
  'fx:add:date': 'FX_ADD_DATE',
  'fx:add:note': 'FX_ADD_NOTE',
};

/** Множество fx-экранов реестра — для nv-диспетчера в access.ts. */
export const FX_SCREENS = new Set(Object.values(FX_STEP_SCREEN));

/** Разрешённые callback-паттерны на каждом шаге (step-aware, R7). nv:* — вне редьюсера. */
export const FX_STEPS: Record<string, string> = {
  fx: 'fxa:(list|add)$',
  'fx:list': 'fxa:(v:\\d+|add)$',
  'fx:item': 'fxa:(ed:(amounts|date|note)|del:\\d+)$',
  'fx:e:amounts': '', // только текст
  'fx:e:date': 'fxa:et:today$',
  'fx:e:note': 'fxa:en:clear$',
  'fx:del': 'fxa:dyes$',
  'fx:add:from': 'fxa:af:[A-Za-z]{3,5}$',
  'fx:add:to': 'fxa:at:[A-Za-z]{3,5}$',
  'fx:add:amounts': '', // только текст
  'fx:add:date': 'fxa:ad:today$',
  'fx:add:note': 'fxa:an:skip$',
};

const goTo = (step: string, data: FxState['data'] = {}): ReturnType<typeof ok> => {
  const scr = FX_STEP_SCREEN[step]!;
  return ok({ step, data }, { kind: 'render', screen: scr, data });
};

const btn = (text: string, cb: string): InlineButton => ({ text, callback_data: cb });
const kb = (rows: InlineButton[][], screenId: string, backTo?: string): ReplyMarkup => {
  const nav = navRow(screenId, backTo);
  return { inline_keyboard: [...rows, ...(nav ? [nav] : [])] };
};

// ── форматирование ──

/** Курс для журнала/карточки: '96.4' / '0.9674' — digits как в stats_ (cur>20 → 2, иначе 4). */
export function fmtRate(v: number): string {
  return (v > 20 ? v.toFixed(2) : v.toFixed(4)).replace(/\.?0+$/, '');
}

const fmtDate = (iso: string) => `${iso.slice(8)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const fmtDay = (iso: string) => `${iso.slice(8)}.${iso.slice(5, 7)}`;

/** Подпись строки журнала: '25.10 — 500 € → 48 200 с · 96.4'. */
export function exchangeLabel(x: ExchangeRow): string {
  return `${fmtDay(x.spent_on)} — ${fmtMoney(x.amount_from_minor / 100, x.from_ccy)} → ${fmtMoney(x.amount_to_minor / 100, x.to_ccy)} · ${fmtRate(x.rate)}`;
}

/** Разница сделки с рынком, знак и % — '−0.7%'. */
const marketDiff = (x: ExchangeRow): string => {
  if (x.market_rate === null || x.market_rate <= 0) return '';
  const d = (x.rate / x.market_rate - 1) * 100;
  const sign = d >= 0 ? '+' : '−';
  return ` (${sign}${Math.abs(d).toFixed(1)}%)`;
};

export function exchangeCardText(x: ExchangeRow): string {
  const market =
    x.market_rate !== null ? ` · рынок ${fmtRate(x.market_rate)}${marketDiff(x)}` : ' · рынок —';
  return (
    '💱 <b>Обмен</b>\n' +
    `${fmtMoney(x.amount_from_minor / 100, x.from_ccy)} → ${fmtMoney(x.amount_to_minor / 100, x.to_ccy)}\n` +
    `Курс: ${fmtRate(x.rate)}${market}\n` +
    `📅 ${fmtDate(x.spent_on)}` +
    (x.note ? `\n📝 ${escapeHtml(x.note)}` : '')
  );
}

// ── парсеры ──

const amountsHint = (from: string, to: string) => `Формат: <code>500 ${from} → 48 200 ${to}</code>`;

/**
 * «500 EUR → 48 200 KGS» или «500 → 48200»: две суммы через «→».
 * Валюты в тексте необязательны — если указаны, обязаны совпасть с выбранными.
 */
export function parseExchangeAmounts(
  text: string,
  from: string,
  to: string,
): { amountFromMinor: number; amountToMinor: number } {
  const t = text.trim().replace(/[-–]>/g, '→').replace(/ /g, ' ');
  const parts = t.split('→');
  if (parts.length !== 2) throw new DomainError('PARSE', `Не понял суммы. ${amountsHint(from, to)}`);
  const a = parseAmount(parts[0]!);
  const b = parseAmount(parts[1]!);
  if (a.currency && a.currency !== from) throw new DomainError('PARSE', `Слева сумма в ${from}, не в ${a.currency}`);
  if (b.currency && b.currency !== to) throw new DomainError('PARSE', `Справа сумма в ${to}, не в ${b.currency}`);
  const amountFromMinor = toMinor(a.amount);
  const amountToMinor = toMinor(b.amount);
  if (amountFromMinor <= 0 || amountToMinor <= 0) {
    throw new DomainError('PARSE', 'Суммы должны быть больше нуля');
  }
  return { amountFromMinor, amountToMinor };
}

const ccyOf = (text: string): string => {
  try {
    return parseCurrencyCode(text);
  } catch (e) {
    if (e instanceof DomainError) throw new DomainError('PARSE', 'Валюта — 3–5 латинских букв (USD, EUR, RUB, KGS…)');
    throw e;
  }
};

/** Быстрые кнопки валют — профиль + валюты кредитов, выбранная исключается. */
function ccyRows(ctx: FxCtx, exclude?: string): InlineButton[][] {
  const ccys = ctx.ccys.filter((c) => c !== exclude).slice(0, 8);
  const rows: InlineButton[][] = [];
  for (let i = 0; i < ccys.length; i += 4) {
    rows.push(ccys.slice(i, i + 4).map((c) => btn(c, `fxa:${exclude === undefined ? 'af' : 'at'}:${c}`)));
  }
  return rows;
}

const exchangeById = (ctx: FxCtx, id: number | undefined): ExchangeRow | undefined =>
  id === undefined ? undefined : ctx.exchanges.find((x) => x.id === id);

// ── рендер экранов ──

export function renderFx(screenId: string, data: FxState['data'], ctx: FxCtx): { text: string; markup?: ReplyMarkup; step: string } {
  const step = Object.entries(FX_STEP_SCREEN).find(([, s]) => s === screenId)![0]!;
  switch (screenId) {
    case 'FX_HUB': {
      const rows = [
        [btn('📒 Журнал обменов', 'fxa:list'), btn('➕ Записать обмен', 'fxa:add')],
      ];
      return { step, text: renderFxText(ctx.analysis), markup: kb(rows, 'FX_HUB') };
    }
    case 'FX_LIST': {
      const rows = ctx.exchanges.slice(0, 10).map((x) => [btn(exchangeLabel(x), `fxa:v:${x.id}`)]);
      rows.push([btn('➕ Записать обмен', 'fxa:add')]);
      const text =
        '📒 <b>Журнал обменов</b>' +
        (ctx.exchanges.length ? '' : '\nПока пусто — запишите первый обмен.');
      return { step, text, markup: kb(rows, 'FX_LIST') };
    }
    case 'FX_ITEM': {
      const x = exchangeById(ctx, data.exchangeId);
      if (!x) return renderFx('FX_LIST', {}, ctx);
      const rows = [
        [btn('✏️ Суммы', 'fxa:ed:amounts'), btn('📅 Дата', 'fxa:ed:date')],
        [btn('📝 Заметка', 'fxa:ed:note'), btn('🗑 Удалить', `fxa:del:${x.id}`)],
      ];
      return { step, text: exchangeCardText(x), markup: kb(rows, 'FX_ITEM') };
    }
    case 'FX_EDIT_AMOUNTS': {
      const x = exchangeById(ctx, data.exchangeId);
      if (!x) return renderFx('FX_LIST', {}, ctx);
      return {
        step,
        text: `Новые суммы — ${amountsHint(x.from_ccy, x.to_ccy)}`,
        markup: kb([], 'FX_EDIT_AMOUNTS'),
      };
    }
    case 'FX_EDIT_DATE': {
      const x = exchangeById(ctx, data.exchangeId);
      if (!x) return renderFx('FX_LIST', {}, ctx);
      return {
        step,
        text: `Новая дата — <code>25.10</code> (день.месяц) или «Сегодня»`,
        markup: kb([[btn('📅 Сегодня', 'fxa:et:today')]], 'FX_EDIT_DATE'),
      };
    }
    case 'FX_EDIT_NOTE': {
      const x = exchangeById(ctx, data.exchangeId);
      if (!x) return renderFx('FX_LIST', {}, ctx);
      return {
        step,
        text: 'Новая заметка (или «Очистить» — убрать)',
        markup: kb([[btn('🧹 Очистить', 'fxa:en:clear')]], 'FX_EDIT_NOTE'),
      };
    }
    case 'FX_DEL': {
      const x = exchangeById(ctx, data.exchangeId);
      if (!x) return renderFx('FX_LIST', {}, ctx);
      return {
        step,
        text: `Удалить обмен?\n${exchangeCardText(x)}`,
        markup: kb([[btn('🗑 Да, удалить', 'fxa:dyes')]], 'FX_DEL'),
      };
    }
    case 'FX_ADD_FROM':
      return {
        step,
        text: '💱 <b>Записать обмен</b>\nИз чего меняем? Кнопка или код валюты (USD, EUR, RUB, KGS…):',
        markup: kb(ccyRows(ctx), 'FX_ADD_FROM'),
      };
    case 'FX_ADD_TO': {
      const from = data.add?.from ?? '?';
      return {
        step,
        text: `Во что меняем ${from}? Кнопка или код валюты:`,
        markup: kb(ccyRows(ctx, data.add?.from), 'FX_ADD_TO'),
      };
    }
    case 'FX_ADD_AMOUNTS': {
      const d = data.add ?? {};
      return {
        step,
        text: `Суммы обмена — ${amountsHint(d.from ?? 'EUR', d.to ?? 'KGS')}`,
        markup: kb([], 'FX_ADD_AMOUNTS'),
      };
    }
    case 'FX_ADD_DATE':
      return {
        step,
        text: 'Дата обмена — <code>25.10</code> (день.месяц) или «Сегодня»:',
        markup: kb([[btn('📅 Сегодня', 'fxa:ad:today')]], 'FX_ADD_DATE'),
      };
    case 'FX_ADD_NOTE':
      return {
        step,
        text: 'Заметка к обмену (или «Пропустить»):',
        markup: kb([[btn('⏭ Пропустить', 'fxa:an:skip')]], 'FX_ADD_NOTE'),
      };
    default:
      return renderFx('FX_HUB', {}, ctx);
  }
}

// ── редьюсер ──

export function advanceFx(state: FxState, input: FxInput, ctx: FxCtx): { state: FxState | null; effects: FxEffect[] } {
  const step = state.step;
  const d = state.data ?? {};
  const cb = input.type === 'callback' ? input.data : null;
  const text = input.type === 'text' ? input.text.trim() : '';

  switch (step) {
    case 'fx':
      if (cb === 'fxa:list') return goTo('fx:list');
      if (cb === 'fxa:add') return goTo('fx:add:from', { add: {} });
      break;
    case 'fx:list':
      if (cb === 'fxa:add') return goTo('fx:add:from', { add: {} });
      if (cb?.startsWith('fxa:v:')) {
        const id = Number(cb.slice(6));
        if (exchangeById(ctx, id)) return goTo('fx:item', { exchangeId: id });
        return goTo('fx:list'); // чужой/устаревший id — назад к списку
      }
      break;
    case 'fx:item': {
      const id = d.exchangeId;
      if (cb === 'fxa:ed:amounts') return goTo('fx:e:amounts', d);
      if (cb === 'fxa:ed:date') return goTo('fx:e:date', d);
      if (cb === 'fxa:ed:note') return goTo('fx:e:note', d);
      if (cb === `fxa:del:${id}`) return goTo('fx:del', d);
      break;
    }
    case 'fx:e:amounts': {
      if (input.type !== 'text') break;
      const x = exchangeById(ctx, d.exchangeId);
      if (!x) return goTo('fx:list');
      try {
        const a = parseExchangeAmounts(text, x.from_ccy, x.to_ccy);
        return ok(
          { step: 'fx:item', data: d },
          { kind: 'fx_patch', id: x.id, patch: { amount_from_minor: a.amountFromMinor, amount_to_minor: a.amountToMinor } },
          { kind: 'render', screen: 'FX_ITEM', data: d, prefix: 'Суммы обновлены.\n\n' },
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }
    case 'fx:e:date': {
      const x = exchangeById(ctx, d.exchangeId);
      if (!x) return goTo('fx:list');
      let iso: string | null = null;
      if (cb === 'fxa:et:today') iso = ctx.today;
      else if (input.type === 'text') {
        iso = /^сегодня$/i.test(text) ? ctx.today : parseDayMonth(text.replace(/\//g, '.'), ctx.today);
        if (!iso) return ok(state, send('Дата — день.месяц, например 25.10 (или «Сегодня»).'));
      }
      if (!iso) break;
      return ok(
        { step: 'fx:item', data: d },
        { kind: 'fx_patch', id: x.id, patch: { spent_on: iso } },
        { kind: 'render', screen: 'FX_ITEM', data: d, prefix: 'Дата обновлена.\n\n' },
      );
    }
    case 'fx:e:note': {
      const x = exchangeById(ctx, d.exchangeId);
      if (!x) return goTo('fx:list');
      let note: string | null = null;
      if (cb === 'fxa:en:clear') note = '';
      else if (input.type === 'text') {
        if (text.length > LIMITS.maxNote) return ok(state, send(`Заметка — не длиннее ${LIMITS.maxNote} символов.`));
        note = text;
      }
      if (note === null) break;
      return ok(
        { step: 'fx:item', data: d },
        { kind: 'fx_patch', id: x.id, patch: { note } },
        { kind: 'render', screen: 'FX_ITEM', data: d, prefix: 'Заметка обновлена.\n\n' },
      );
    }
    case 'fx:del': {
      if (cb === 'fxa:dyes' && d.exchangeId !== undefined) {
        return ok(
          { step: 'fx:list', data: {} },
          { kind: 'fx_del', id: d.exchangeId },
          { kind: 'render', screen: 'FX_LIST', prefix: 'Обмен удалён.\n\n' },
        );
      }
      break;
    }
    case 'fx:add:from': {
      let ccy: string | undefined;
      if (cb?.startsWith('fxa:af:')) ccy = cb.slice(7).toUpperCase();
      else if (input.type === 'text') {
        try {
          ccy = ccyOf(text);
        } catch (e) {
          return ok(state, send((e as Error).message));
        }
      }
      if (!ccy) break;
      return goTo('fx:add:to', { add: { ...d.add, from: ccy } });
    }
    case 'fx:add:to': {
      let ccy: string | undefined;
      if (cb?.startsWith('fxa:at:')) ccy = cb.slice(7).toUpperCase();
      else if (input.type === 'text') {
        try {
          ccy = ccyOf(text);
        } catch (e) {
          return ok(state, send((e as Error).message));
        }
      }
      if (!ccy) break;
      if (ccy === d.add?.from) return ok(state, send('Валюты должны отличаться — выберите другую.'));
      return goTo('fx:add:amounts', { add: { ...d.add, to: ccy } });
    }
    case 'fx:add:amounts': {
      if (input.type !== 'text') break;
      const from = d.add?.from ?? 'EUR';
      const to = d.add?.to ?? 'KGS';
      try {
        const a = parseExchangeAmounts(text, from, to);
        return goTo('fx:add:date', { add: { ...d.add, amountFromMinor: a.amountFromMinor, amountToMinor: a.amountToMinor } });
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }
    case 'fx:add:date': {
      let iso: string | null = null;
      if (cb === 'fxa:ad:today') iso = ctx.today;
      else if (input.type === 'text') {
        iso = /^сегодня$/i.test(text) ? ctx.today : parseDayMonth(text.replace(/\//g, '.'), ctx.today);
        if (!iso) return ok(state, send('Дата — день.месяц, например 25.10 (или «Сегодня»).'));
      }
      if (!iso) break;
      return goTo('fx:add:note', { add: { ...d.add, spentOn: iso } });
    }
    case 'fx:add:note': {
      let note = '';
      if (cb === 'fxa:an:skip') note = '';
      else if (input.type === 'text') {
        if (text.length > LIMITS.maxNote) return ok(state, send(`Заметка — не длиннее ${LIMITS.maxNote} символов.`));
        note = text;
      } else break;
      const a = d.add;
      if (!a?.from || !a.to || !a.amountFromMinor || !a.amountToMinor) return goTo('fx:add:from', { add: {} });
      const spentOn = a.spentOn ?? ctx.today;
      return ok(
        { step: 'fx:list', data: {} },
        {
          kind: 'fx_add',
          d: { from: a.from, to: a.to, amountFromMinor: a.amountFromMinor, amountToMinor: a.amountToMinor, spentOn, note },
        },
        {
          kind: 'render',
          screen: 'FX_LIST',
          prefix: `Записано: ${fmtMoney(a.amountFromMinor / 100, a.from)} → ${fmtMoney(a.amountToMinor / 100, a.to)}.\n\n`,
        },
      );
    }
    default:
      break;
  }
  return ok(state); // нераспознанный ввод — состояние живёт, молчим (R7)
}

/** /cancel — куда возвращаемся из шага (R3): навигационные экраны → свой parent. */
export function fxCancelTarget(state: FxState): string {
  const screen = FX_STEP_SCREEN[state.step];
  switch (screen) {
    case 'FX_ADD_FROM':
    case 'FX_ADD_TO':
    case 'FX_ADD_AMOUNTS':
    case 'FX_ADD_DATE':
    case 'FX_ADD_NOTE':
      return 'FX_LIST';
    case 'FX_EDIT_AMOUNTS':
    case 'FX_EDIT_DATE':
    case 'FX_EDIT_NOTE':
    case 'FX_DEL':
      return 'FX_ITEM';
    case 'FX_ITEM':
    case 'FX_LIST':
      return 'FX_HUB';
    default:
      return 'HOME';
  }
}
