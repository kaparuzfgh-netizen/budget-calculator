/**
 * profile.ts — ЧИСТЫЙ редьюсер редактирования профиля (по образцу onboarding):
 *   advancePf(state, input, ctx) → { state, effects }.
 * ctx — снимок данных, который читает I/O-слой (services/access.ts):
 *   profile, commitments (все, с неактивными), incomeEntries (текущий месяц).
 * effects: send — сообщение; patch — patchProfile; commit_* / income_del —
 *   точечные изменения (все repo-вызовы WHERE id=? AND user_id=? — чужие id
 *   даже если попадут сюда, физически не сработают); checkCcy — валидация
 *   валюты через FX (результат — onPfCcyResult).
 *
 * Реестр разделов — SECTIONS: добавить раздел позже (кредиты/инвестиции) =
 *   одна строка + один case.
 */
import type { ReplyMarkup } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import type { CommitmentRow, IncomeEntryRow, ProfileRow } from '../db/repo';
import { fmtMoney } from './format';
import { isValidTimezone, parseAmount, parseCommitmentLine, parseCurrencyCode, type ParsedCommitment } from './parse';
import { toMinor } from '../domain/money';

export interface PfState {
  step: string;
  data: {
    commitId?: number | undefined;
    incomeId?: number | undefined;
    pendingCcy?: string | undefined;
    ccyTarget?: 'income' | 'living' | undefined;
  };
}

export interface PfCtx {
  profile: ProfileRow;
  commitments: CommitmentRow[];
  incomeEntries: IncomeEntryRow[];
}

export type PfInput = { type: 'text'; text: string } | { type: 'callback'; data: string };

export type PfEffect =
  | { kind: 'send'; text: string; markup?: ReplyMarkup }
  | { kind: 'patch'; patch: Parameters<ReturnType<typeof import('../db/repo').scoped>['patchProfile']>[0] }
  | { kind: 'commit_add'; c: ParsedCommitment }
  | {
      kind: 'commit_patch';
      id: number;
      patch: { amount_minor?: number; currency?: string; due_day?: number | null; active?: number };
    }
  | { kind: 'commit_del'; id: number }
  | { kind: 'income_del'; id: number }
  | { kind: 'checkCcy'; code: string; target: 'income' | 'living' };

const send = (text: string, markup?: ReplyMarkup): PfEffect => ({ kind: 'send', text, ...(markup ? { markup } : {}) });
const ok = (state: PfState | null, ...effects: PfEffect[]) => ({ state, effects });

// ── шаги и разрешённые для них callback-префиксы (step-aware) ──
export const PF_STEPS: Record<string, string> = {
  pf: 'pf:',
  'pf:income': 'pf:|in:',
  'pf:commits': 'pf:cm|pf:cadd|pf:menu|pf:sec:',
  'pf:commit': 'pf:c|pf:sec:|pf:menu',
  'pf:ccytz': 'pf:ccy:|pf:tz|pf:menu|pf:sec:',
  'pf:income_list': 'in:|pf:sec:|pf:menu',
  edit_typical: 'pf:typ|pf:sec:|pf:menu',
  edit_living: 'pf:menu|pf:sec:',
  edit_commit_amount: 'pf:menu|pf:sec:',
  edit_commit_day: 'pf:menu|pf:sec:',
  add_commit: 'pf:menu|pf:sec:',
  confirm_del_commit: 'pf:cdel:',
  confirm_del_income: 'in:del:',
  edit_income_ccy: 'pf:menu|pf:sec:',
  edit_living_ccy: 'pf:menu|pf:sec:',
  edit_tz: 'pf:tzv:|pf:sec:|pf:menu',
  edit_tz_custom: 'pf:menu|pf:sec:',
};

/** Реестр разделов профиля — место для будущих «кредиты»/«инвестиции». */
export const SECTIONS = [
  { key: 'income', label: '💵 Доход', cb: 'pf:sec:income' },
  { key: 'living', label: '🍽 Лимит жизни', cb: 'pf:sec:living' },
  { key: 'commits', label: '🧾 Платежи', cb: 'pf:sec:commits' },
  { key: 'ccytz', label: '🌍 Валюта и пояс', cb: 'pf:sec:ccytz' },
] as const;

const btn = (text: string, cb: string) => ({ text, callback_data: cb });
const BACK: ReplyMarkup = { inline_keyboard: [[btn('← Назад', 'pf:menu')]] };
const INCOME_KB: ReplyMarkup = {
  inline_keyboard: [
    [btn('Изменить типичный', 'pf:typ'), btn('➕ Добавить доход', 'pf:inc:add')],
    [btn('📋 Записи месяца', 'pf:inc:list'), btn('← Назад', 'pf:menu')],
  ],
};

// ── рендеры (чистые) ──
export function profileMenuText(ctx: PfCtx): string {
  const p = ctx.profile;
  const inc = ctx.incomeEntries;
  return (
    '⚙️ <b>Профиль</b>\n' +
    `💵 Доход: типичный ${p.income_minor ? fmtMoney(p.income_minor / 100, p.income_currency) : '—'} · за месяц ${inc.length} записей\n` +
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
    `Факт за ${ctx.incomeEntries[0]?.month ?? 'месяц'}:\n${list}`
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
export function commitDetailText(c: CommitmentRow): string {
  return (
    `🧾 <b>${escapeHtml(c.name)}</b>\n` +
    `Сумма: ${fmtMoney(c.amount_minor / 100, c.currency)}\n` +
    `День: ${c.due_day ?? '—'}\nСтатус: ${c.active ? 'активен' : '⏸ выключен'}`
  );
}
export function ccyTzText(ctx: PfCtx): string {
  const p = ctx.profile;
  return (
    '🌍 <b>Валюта и пояс</b>\n' +
    `Валюта дохода: ${p.income_currency} · лимита: ${p.living_currency}\nТаймзона: ${escapeHtml(p.timezone)}\n\n` +
    '<i>⚠️ при смене валюты суммы не пересчитываются</i>'
  );
}
export const MAIN_MENU_KB: ReplyMarkup = {
  inline_keyboard: [
    [btn('💵 Доход', 'pf:sec:income'), btn('🍽 Лимит жизни', 'pf:sec:living')],
    [btn('🧾 Платежи', 'pf:sec:commits'), btn('🌍 Валюта и пояс', 'pf:sec:ccytz')],
  ],
};

// ── редьюсер ──
export function advancePf(state: PfState, input: PfInput, ctx: PfCtx): { state: PfState | null; effects: PfEffect[] } {
  const d = state.data;
  const cb = input.type === 'callback' ? input.data : null;
  const text = input.type === 'text' ? input.text.trim() : '';
  const p = ctx.profile;

  if (cb !== null) {
    const allowed = PF_STEPS[state.step];
    const isPf = cb.startsWith('pf:') || cb.startsWith('in:');
    if (!isPf || !allowed || !new RegExp(`^(${allowed})`).test(cb)) return { state, effects: [] };
  }

  const menuMsg = () => send(profileMenuText(ctx), MAIN_MENU_KB);
  const toMenu = () => ok({ step: 'pf', data: {} }, menuMsg());

  switch (state.step) {
    case 'pf': {
      if (cb === 'pf:sec:income') return ok({ step: 'pf:income', data: {} }, send(incomeSectionText(ctx), INCOME_KB));
      if (cb === 'pf:sec:living')
        return ok(
          { step: 'edit_living', data: {} },
          send(`Новый лимит «на жизнь» в месяц (${p.living_currency} по умолчанию):`, BACK),
        );
      if (cb === 'pf:sec:commits') {
        const rows = ctx.commitments.map((c) => [
          btn(`${c.active ? '' : '⏸ '}${c.name} — ${fmtMoney(c.amount_minor / 100, c.currency)}`, `pf:cm:${c.id}`),
        ]);
        return ok(
          { step: 'pf:commits', data: {} },
          send(commitsText(ctx), {
            inline_keyboard: [...rows, [btn('➕ Добавить', 'pf:cadd'), btn('← Назад', 'pf:menu')]],
          }),
        );
      }
      if (cb === 'pf:sec:ccytz')
        return ok(
          { step: 'pf:ccytz', data: {} },
          send(ccyTzText(ctx), {
            inline_keyboard: [
              [btn('Валюта дохода', 'pf:ccy:income'), btn('Валюта лимита', 'pf:ccy:living')],
              [btn('Часовой пояс', 'pf:tz'), btn('← Назад', 'pf:menu')],
            ],
          }),
        );
      return { state, effects: [] };
    }

    case 'pf:income': {
      if (cb === 'pf:typ')
        return ok(
          { step: 'edit_typical', data: {} },
          send(`Новый типичный доход (${p.income_currency}) — число, или «Убрать»:`, {
            inline_keyboard: [[btn('Убрать', 'pf:typ0')], [btn('← Назад', 'pf:sec:income')]],
          }),
        );
      if (cb === 'pf:inc:list')
        return ok(
          { step: 'pf:income_list', data: {} },
          send(incomeSectionText(ctx), {
            inline_keyboard: [
              ...ctx.incomeEntries.map((e) => [
                btn(`🗑 ${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` ${e.note}` : ''}`, `in:del:${e.id}`),
              ]),
              [btn('← Назад', 'pf:sec:income')],
            ],
          }),
        );
      if (cb === 'pf:inc:add')
        return ok({ step: 'income_ask', data: {} }, send('Сколько получили? (например: 5200 eur зарплата)'));
      if (cb === 'pf:menu') return toMenu();
      if (cb === 'pf:sec:income') return ok({ step: 'pf:income', data: {} }, send(incomeSectionText(ctx), INCOME_KB));
      return { state, effects: [] };
    }

    case 'pf:commits': {
      if (cb === 'pf:cadd')
        return ok({ step: 'add_commit', data: {} }, send('Новый платёж: <code>Аренда 700 usd 1</code>', BACK));
      if (cb === 'pf:menu') return toMenu();
      const m = /^pf:cm:(\d+)$/.exec(cb ?? '');
      if (m) {
        const c = ctx.commitments.find((x) => x.id === Number(m[1]));
        if (!c) return { state, effects: [] }; // чужой/удалённый id — молча
        return ok(
          { step: 'pf:commit', data: { commitId: c.id } },
          send(commitDetailText(c), {
            inline_keyboard: [
              [btn('✏️ Сумма', `pf:ca:${c.id}`), btn('📅 День', `pf:cday:${c.id}`)],
              [btn(c.active ? '⏸ Выключить' : '▶️ Включить', `pf:ctog:${c.id}`), btn('🗑 Удалить', `pf:cdel:${c.id}`)],
              [btn('← Назад', 'pf:sec:commits')],
            ],
          }),
        );
      }
      if (cb === 'pf:sec:commits') {
        const rows = ctx.commitments.map((c) => [
          btn(`${c.active ? '' : '⏸ '}${c.name} — ${fmtMoney(c.amount_minor / 100, c.currency)}`, `pf:cm:${c.id}`),
        ]);
        return ok(
          { step: 'pf:commits', data: {} },
          send(commitsText(ctx), {
            inline_keyboard: [...rows, [btn('➕ Добавить', 'pf:cadd'), btn('← Назад', 'pf:menu')]],
          }),
        );
      }
      return { state, effects: [] };
    }

    case 'pf:commit': {
      const c = ctx.commitments.find((x) => x.id === d.commitId);
      if (!c) return toMenu();
      if (cb === `pf:ca:${c.id}`)
        return ok(
          { step: 'edit_commit_amount', data: d },
          send(`Новая сумма для «${escapeHtml(c.name)}» (${c.currency}):`, BACK),
        );
      if (cb === `pf:cday:${c.id}`)
        return ok({ step: 'edit_commit_day', data: d }, send('День месяца 1–31 (или 0 — убрать):', BACK));
      if (cb === `pf:ctog:${c.id}`) {
        return ok(
          { step: 'pf:commit', data: d },
          { kind: 'commit_patch', id: c.id, patch: { active: c.active ? 0 : 1 } },
          send(commitDetailText({ ...c, active: c.active ? 0 : 1 }), {
            inline_keyboard: [
              [btn('✏️ Сумма', `pf:ca:${c.id}`), btn('📅 День', `pf:cday:${c.id}`)],
              [btn(c.active ? '▶️ Включить' : '⏸ Выключить', `pf:ctog:${c.id}`), btn('🗑 Удалить', `pf:cdel:${c.id}`)],
              [btn('← Назад', 'pf:sec:commits')],
            ],
          }),
        );
      }
      if (cb === `pf:cdel:${c.id}`) {
        return ok(
          { step: 'confirm_del_commit', data: d },
          send(`Удалить «${escapeHtml(c.name)}» (${fmtMoney(c.amount_minor / 100, c.currency)})?`, {
            inline_keyboard: [[btn('🗑 Да, удалить', 'pf:cdel:yes'), btn('Отмена', 'pf:cdel:no')]],
          }),
        );
      }
      if (cb === 'pf:sec:commits') {
        const rows = ctx.commitments.map((x) => [
          btn(`${x.active ? '' : '⏸ '}${x.name} — ${fmtMoney(x.amount_minor / 100, x.currency)}`, `pf:cm:${x.id}`),
        ]);
        return ok(
          { step: 'pf:commits', data: {} },
          send(commitsText(ctx), {
            inline_keyboard: [...rows, [btn('➕ Добавить', 'pf:cadd'), btn('← Назад', 'pf:menu')]],
          }),
        );
      }
      return { state, effects: [] };
    }

    case 'confirm_del_commit': {
      const c = ctx.commitments.find((x) => x.id === d.commitId);
      if (!c) return toMenu();
      if (cb === 'pf:cdel:yes') {
        const rest = ctx.commitments.filter((x) => x.id !== c.id);
        const rows = rest.map((x) => [
          btn(`${x.active ? '' : '⏸ '}${x.name} — ${fmtMoney(x.amount_minor / 100, x.currency)}`, `pf:cm:${x.id}`),
        ]);
        return ok(
          { step: 'pf:commits', data: {} },
          { kind: 'commit_del', id: c.id },
          send(`Удалён: ${escapeHtml(c.name)}\n\n` + commitsText({ ...ctx, commitments: rest }), {
            inline_keyboard: [...rows, [btn('➕ Добавить', 'pf:cadd'), btn('← Назад', 'pf:menu')]],
          }),
        );
      }
      if (cb === 'pf:cdel:no') {
        return ok(
          { step: 'pf:commit', data: d },
          send(commitDetailText(c), {
            inline_keyboard: [
              [btn('✏️ Сумма', `pf:ca:${c.id}`), btn('📅 День', `pf:cday:${c.id}`)],
              [btn(c.active ? '⏸ Выключить' : '▶️ Включить', `pf:ctog:${c.id}`), btn('🗑 Удалить', `pf:cdel:${c.id}`)],
              [btn('← Назад', 'pf:sec:commits')],
            ],
          }),
        );
      }
      return { state, effects: [] };
    }

    case 'edit_typical': {
      if (cb === 'pf:typ0') {
        return ok(
          { step: 'pf:income', data: {} },
          { kind: 'patch', patch: { income_minor: 0 } },
          send('Типичный доход убран — вносите факт: /income'),
        );
      }
      if (cb === 'pf:sec:income')
        return ok(
          { step: 'pf:income', data: {} },
          send(incomeSectionText(ctx), {
            inline_keyboard: [
              [btn('Изменить типичный', 'pf:typ'), btn('➕ Добавить доход', 'pf:inc:add')],
              [btn('📋 Записи месяца', 'pf:inc:list'), btn('← Назад', 'pf:menu')],
            ],
          }),
        );
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        const patch: { income_minor: number; income_currency?: string } = { income_minor: toMinor(a.amount) };
        if (a.currency) patch.income_currency = a.currency;
        return ok(
          { step: 'pf:income', data: {} },
          { kind: 'patch', patch },
          send(`Типичный доход: ${fmtMoney(a.amount, a.currency ?? p.income_currency)}`),
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'edit_living': {
      if (cb === 'pf:menu') return toMenu();
      if (input.type !== 'text') return { state, effects: [] };
      try {
        const a = parseAmount(text);
        const minor = toMinor(a.amount);
        const patch: { living_cap_minor: number; weekly_budget_minor: number; living_currency?: string } = {
          living_cap_minor: minor,
          weekly_budget_minor: Math.round((minor * 12) / 52),
        };
        if (a.currency) patch.living_currency = a.currency;
        return ok(
          { step: 'pf', data: {} },
          { kind: 'patch', patch },
          send(
            `Лимит жизни: ${fmtMoney(a.amount, a.currency ?? p.living_currency)}\n\n` +
              profileMenuText({
                ...ctx,
                profile: {
                  ...p,
                  living_cap_minor: minor,
                  weekly_budget_minor: patch.weekly_budget_minor,
                  living_currency: a.currency ?? p.living_currency,
                },
              }),
            MAIN_MENU_KB,
          ),
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'edit_commit_amount': {
      if (cb === 'pf:menu') return toMenu();
      if (input.type !== 'text') return { state, effects: [] };
      const c = ctx.commitments.find((x) => x.id === d.commitId);
      if (!c) return toMenu();
      try {
        const a = parseAmount(text);
        const patch: { amount_minor: number; currency?: string } = { amount_minor: toMinor(a.amount) };
        if (a.currency) patch.currency = a.currency;
        return ok(
          { step: 'pf:commit', data: d },
          { kind: 'commit_patch', id: c.id, patch },
          send(`«${escapeHtml(c.name)}»: ${fmtMoney(a.amount, a.currency ?? c.currency)}`),
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'edit_commit_day': {
      if (cb === 'pf:menu') return toMenu();
      if (input.type !== 'text') return { state, effects: [] };
      const c = ctx.commitments.find((x) => x.id === d.commitId);
      if (!c) return toMenu();
      const day = Number(text);
      if (text === '0')
        return ok(
          { step: 'pf:commit', data: d },
          { kind: 'commit_patch', id: c.id, patch: { due_day: null } },
          send('День убран'),
        );
      if (!Number.isInteger(day) || day < 1 || day > 31)
        return ok(state, send('День — число от 1 до 31 (0 — убрать).'));
      return ok(
        { step: 'pf:commit', data: d },
        { kind: 'commit_patch', id: c.id, patch: { due_day: day } },
        send(`«${escapeHtml(c.name)}»: ${day} число`),
      );
    }

    case 'add_commit': {
      if (cb === 'pf:menu') return toMenu();
      if (input.type !== 'text') return { state, effects: [] };
      if (ctx.commitments.length >= 30) return ok({ step: 'pf:commits', data: {} }, send('Максимум 30 платежей.'));
      try {
        const c = parseCommitmentLine(text);
        if (!c.currency) c.currency = p.income_currency;
        return ok(
          { step: 'pf:commits', data: {} },
          { kind: 'commit_add', c },
          send(`Добавлен: ${escapeHtml(c.name)} — ${fmtMoney(c.amount, c.currency ?? 'USD')}`, BACK),
        );
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'pf:ccytz': {
      if (cb === 'pf:ccy:income')
        return ok({ step: 'edit_income_ccy', data: {} }, send('Код валюты дохода (USD, EUR, RUB, KGS, GEL…):', BACK));
      if (cb === 'pf:ccy:living')
        return ok({ step: 'edit_living_ccy', data: {} }, send('Код валюты лимита жизни:', BACK));
      if (cb === 'pf:tz')
        return ok(
          { step: 'edit_tz', data: {} },
          send('Часовой пояс:', {
            inline_keyboard: [
              [btn('Бишкек', 'pf:tzv:Asia/Bishkek'), btn('Москва', 'pf:tzv:Europe/Moscow')],
              [btn('Алматы', 'pf:tzv:Asia/Almaty'), btn('Тбилиси', 'pf:tzv:Asia/Tbilisi'), btn('UTC', 'pf:tzv:UTC')],
              [btn('Другой…', 'pf:tzv:X'), btn('← Назад', 'pf:sec:ccytz')],
            ],
          }),
        );
      if (cb === 'pf:menu') return toMenu();
      if (cb === 'pf:sec:ccytz')
        return ok(
          { step: 'pf:ccytz', data: {} },
          send(ccyTzText(ctx), {
            inline_keyboard: [
              [btn('Валюта дохода', 'pf:ccy:income'), btn('Валюта лимита', 'pf:ccy:living')],
              [btn('Часовой пояс', 'pf:tz'), btn('← Назад', 'pf:menu')],
            ],
          }),
        );
      return { state, effects: [] };
    }

    case 'edit_tz': {
      if (cb === 'pf:sec:ccytz')
        return ok(
          { step: 'pf:ccytz', data: {} },
          send(ccyTzText(ctx), {
            inline_keyboard: [
              [btn('Валюта дохода', 'pf:ccy:income'), btn('Валюта лимита', 'pf:ccy:living')],
              [btn('Часовой пояс', 'pf:tz'), btn('← Назад', 'pf:menu')],
            ],
          }),
        );
      if (cb?.startsWith('pf:tzv:')) {
        const tz = cb.slice(7);
        if (tz === 'X')
          return ok(
            { step: 'edit_tz_custom' as PfState['step'], data: d },
            send('Напишите таймзону (IANA), например Europe/Berlin:', BACK),
          );
        if (!isValidTimezone(tz)) return ok(state, send('Не знаю такую таймзону.'));
        return ok(
          { step: 'pf:ccytz', data: {} },
          { kind: 'patch', patch: { timezone: tz } },
          send(`Таймзона: ${escapeHtml(tz)}`),
        );
      }
      if (input.type === 'text' && isValidTimezone(text)) {
        return ok(
          { step: 'pf:ccytz', data: {} },
          { kind: 'patch', patch: { timezone: text } },
          send(`Таймзона: ${escapeHtml(text)}`),
        );
      }
      if (input.type === 'text') return ok(state, send('Не знаю такую таймзону. Пример: Europe/Berlin'));
      return { state, effects: [] };
    }

    case 'edit_tz_custom': {
      if (cb === 'pf:menu') return toMenu();
      if (input.type !== 'text') return { state, effects: [] };
      if (!isValidTimezone(text)) return ok(state, send('Не знаю такую таймзону. Пример: Europe/Berlin'));
      return ok(
        { step: 'pf:ccytz', data: {} },
        { kind: 'patch', patch: { timezone: text } },
        send(`Таймзона: ${escapeHtml(text)}`),
      );
    }

    case 'edit_income_ccy':
    case 'edit_living_ccy': {
      if (cb === 'pf:menu') return toMenu();
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

    case 'pf:income_list': {
      const m = /^in:del:(\d+)$/.exec(cb ?? '');
      if (m) {
        const e = ctx.incomeEntries.find((x) => x.id === Number(m[1]));
        if (!e) return { state, effects: [] }; // чужой id — молча
        return ok(
          { step: 'confirm_del_income', data: { incomeId: e.id } },
          send(
            `Удалить запись ${fmtMoney(e.amount_minor / 100, e.currency)}${e.note ? ` (${escapeHtml(e.note)})` : ''}?`,
            {
              inline_keyboard: [[btn('🗑 Да, удалить', 'in:del:yes'), btn('Отмена', 'in:del:no')]],
            },
          ),
        );
      }
      if (cb === 'pf:sec:income')
        return ok(
          { step: 'pf:income', data: {} },
          send(incomeSectionText(ctx), {
            inline_keyboard: [
              [btn('Изменить типичный', 'pf:typ'), btn('➕ Добавить доход', 'pf:inc:add')],
              [btn('📋 Записи месяца', 'pf:inc:list'), btn('← Назад', 'pf:menu')],
            ],
          }),
        );
      return { state, effects: [] };
    }

    case 'confirm_del_income': {
      const e = ctx.incomeEntries.find((x) => x.id === d.incomeId);
      if (!e) return { state: { step: 'pf:income', data: {} }, effects: [] };
      if (cb === 'in:del:yes') {
        const rest = ctx.incomeEntries.filter((x) => x.id !== e.id);
        return ok(
          { step: 'pf:income', data: {} },
          { kind: 'income_del', id: e.id },
          send(`Удалено.\n\n` + incomeSectionText({ ...ctx, incomeEntries: rest })),
        );
      }
      if (cb === 'in:del:no')
        return ok(
          { step: 'pf:income_list', data: {} },
          send(incomeSectionText(ctx), {
            inline_keyboard: [
              ...ctx.incomeEntries.map((x) => [
                btn(`🗑 ${fmtMoney(x.amount_minor / 100, x.currency)}${x.note ? ` ${x.note}` : ''}`, `in:del:${x.id}`),
              ]),
              [btn('← Назад', 'pf:sec:income')],
            ],
          }),
        );
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
      send(`Валюта ${target === 'income' ? 'дохода' : 'лимита'}: ${ccy}.\n<i>Суммы не пересчитываются.</i>`),
    );
  }
  return ok(state, send('Такая валюта не поддерживается — попробуйте ещё.'));
}
