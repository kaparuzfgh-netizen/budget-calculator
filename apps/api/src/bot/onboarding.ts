/**
 * onboarding.ts — ЧИСТЫЙ редьюсер онбординга (без I/O):
 *   advance(state, input) → { state, effects }.
 * effects: send — сообщение (+клавиатура), checkCcy — валидировать код через FX
 *   (I/O оборачивает и кормит назад ccy_result), consent — поставить terms,
 *   persist — записать профиль+платежи, done — онбординг завершён.
 * I/O-слой: services/onboarding-io.ts.
 */
import type { ReplyMarkup } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import { fmtMoney } from './format';
import { isValidTimezone, parseAmount, parseCommitmentLine, parseCurrencyCode, type ParsedCommitment } from './parse';
import { toMinor } from '../domain/money';
import { homeMarkup } from './nav/nav';

export type ObStep =
  | 'terms'
  | 'income_ccy'
  | 'income_ccy_custom'
  | 'income_amount'
  | 'living_cap'
  | 'tz'
  | 'tz_custom'
  | 'commitments'
  | 'confirm';

export interface ObData {
  incomeCcy?: string | undefined;
  incomeMinor?: number | undefined;
  livingCcy?: string | undefined;
  livingMinor?: number | undefined;
  tz?: string | undefined;
  pendingCcy?: string | undefined;
  commitments: ParsedCommitment[];
}

export interface ObState {
  step: ObStep;
  data: ObData;
}

export type ObInput =
  | { type: 'text'; text: string }
  | { type: 'callback'; data: string }
  | { type: 'ccy_result'; ok: boolean; code: string };

export type ObEffect =
  | { kind: 'send'; text: string; markup?: ReplyMarkup }
  | { kind: 'checkCcy'; code: string }
  | { kind: 'consent' }
  | { kind: 'persist'; data: ObData } // несёт финальные данные — state уже null
  | { kind: 'done' };

const CANCEL_BTN = { text: '✖ Отмена', callback_data: 'ob:cancel' };
const CCY_KB: ReplyMarkup = {
  inline_keyboard: [
    [
      { text: 'USD', callback_data: 'ob:ic:USD' },
      { text: 'EUR', callback_data: 'ob:ic:EUR' },
      { text: 'RUB', callback_data: 'ob:ic:RUB' },
      { text: 'KGS', callback_data: 'ob:ic:KGS' },
    ],
    [{ text: 'Другая…', callback_data: 'ob:ic:X' }],
    [CANCEL_BTN],
  ],
};
const TZ_KB: ReplyMarkup = {
  inline_keyboard: [
    [
      { text: 'Бишкек', callback_data: 'ob:tz:Asia/Bishkek' },
      { text: 'Москва', callback_data: 'ob:tz:Europe/Moscow' },
    ],
    [
      { text: 'Алматы', callback_data: 'ob:tz:Asia/Almaty' },
      { text: 'Тбилиси', callback_data: 'ob:tz:Asia/Tbilisi' },
      { text: 'UTC', callback_data: 'ob:tz:UTC' },
    ],
    [{ text: 'Другой…', callback_data: 'ob:tz:X' }],
    [CANCEL_BTN],
  ],
};
const COMM_KB: ReplyMarkup = {
  inline_keyboard: [
    [
      { text: '✅ Готово', callback_data: 'ob:com:done' },
      { text: 'Пропустить', callback_data: 'ob:com:skip' },
    ],
    [CANCEL_BTN],
  ],
};
const TERMS =
  '«Бюджет-компаньон» хранит: профиль (доход, норма повседневных, таймзона), список обязательных ' +
  'платежей и траты — в Cloudflare D1. Данные видите только вы и владелец сервиса. ' +
  'Команды /export и /delete_me появятся скоро.\n\nСогласны?';

const send = (text: string, markup?: ReplyMarkup): ObEffect => ({ kind: 'send', text, ...(markup ? { markup } : {}) });
const ok = (state: ObState | null, ...effects: ObEffect[]) => ({ state, effects });

export function startOnboarding(): { state: ObState; effects: ObEffect[] } {
  const state: ObState = { step: 'terms', data: { commitments: [] } };
  return {
    state,
    effects: [send(TERMS, { inline_keyboard: [[{ text: '✅ Согласен', callback_data: 'ob:terms:ok' }]] })],
  };
}

function askIncomeCcy(): ObEffect {
  return send('В какой валюте основной доход?', CCY_KB);
}
function askIncomeAmount(d: ObData): ObEffect {
  return send(
    `Типичный месячный доход в ${d.incomeCcy} (примерно, просто число — например 6200). ` +
      'Если доход каждый месяц разный — нажмите «Пропустить» и вносите факт командой /income.',
    { inline_keyboard: [[{ text: 'Пропустить', callback_data: 'ob:inc:skip' }], [CANCEL_BTN]] },
  );
}
function askLiving(d: ObData): ObEffect {
  return send(`Норма повседневных (еда/быт) в месяц? Число${d.incomeCcy ? ` — по умолчанию ${d.incomeCcy}` : ''}.`, {
    inline_keyboard: [[CANCEL_BTN]],
  });
}
function askTz(): ObEffect {
  return send('Ваш часовой пояс?', TZ_KB);
}
function commitmentsList(d: ObData): string {
  if (!d.commitments.length) return 'Пока пусто.';
  return d.commitments
    .map(
      (c, i) =>
        `${i + 1}. ${escapeHtml(c.name)} — ${fmtMoney(c.amount, c.currency ?? d.incomeCcy ?? 'USD')}${c.dueDay ? ` (${c.dueDay} числа)` : ''}`,
    )
    .join('\n');
}

/** Какие callback-префиксы разрешены на каждом шаге ('' — кнопок нет). */
const CB_STEP: Record<ObStep, string> = {
  terms: 'ob:terms:',
  income_ccy: 'ob:ic:',
  income_ccy_custom: '',
  income_amount: 'ob:inc:',
  living_cap: '',
  tz: 'ob:tz:',
  tz_custom: '',
  commitments: 'ob:com:',
  confirm: '',
};

export function advance(state: ObState, input: ObInput): { state: ObState | null; effects: ObEffect[] } {
  const d = state.data;
  const cb = input.type === 'callback' ? input.data : null;
  const text = input.type === 'text' ? input.text.trim() : '';

  if (cb === 'ob:cancel' || (input.type === 'text' && text === '/cancel')) {
    return ok(null, send('Настройка отменена. /start — начать заново.'));
  }

  // Step-aware: callback чужого шага (старая кнопка / повторная доставка) —
  // молча игнорируем: иначе повторное «Согласен» переспрашивало валюту.
  if (cb !== null) {
    const allowed = CB_STEP[state.step];
    if (!allowed || !cb.startsWith(allowed)) return { state, effects: [] };
  }

  switch (state.step) {
    case 'terms': {
      if (cb === 'ob:terms:ok') {
        return ok({ step: 'income_ccy', data: d }, { kind: 'consent' }, askIncomeCcy());
      }
      return ok(
        state,
        send('Нужно согласие — нажмите «Согласен».', {
          inline_keyboard: [[{ text: '✅ Согласен', callback_data: 'ob:terms:ok' }]],
        }),
      );
    }

    case 'income_ccy': {
      if (cb?.startsWith('ob:ic:')) {
        const c = cb.slice(6);
        if (c === 'X') return ok({ step: 'income_ccy_custom', data: d }, send('Напишите код валюты (USD, GEL, BTC…).'));
        d.incomeCcy = c;
        return ok({ step: 'income_amount', data: d }, askIncomeAmount(d));
      }
      return ok(state, askIncomeCcy());
    }

    case 'income_ccy_custom': {
      if (input.type === 'text') {
        let code: string;
        try {
          code = parseCurrencyCode(text);
        } catch (e) {
          return ok(state, send((e as Error).message));
        }
        d.pendingCcy = code;
        return ok({ step: 'income_ccy_custom', data: d }, { kind: 'checkCcy', code });
      }
      return ok(state, send('Напишите код валюты текстом, например GEL.'));
    }

    case 'income_amount': {
      if (cb === 'ob:inc:skip') {
        d.incomeMinor = 0; // типичный доход не задан — факт через /income
        d.livingCcy = d.incomeCcy;
        return ok({ step: 'living_cap', data: d }, askLiving(d));
      }
      if (input.type !== 'text') return ok(state, askIncomeAmount(d));
      try {
        const a = parseAmount(text);
        d.incomeMinor = toMinor(a.amount);
        if (a.currency) d.incomeCcy = a.currency; // «6200 eur» перекрывает кнопку
        d.livingCcy = d.incomeCcy;
        return ok({ step: 'living_cap', data: d }, askLiving(d));
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'living_cap': {
      if (input.type !== 'text') return ok(state, askLiving(d));
      try {
        const a = parseAmount(text);
        d.livingMinor = toMinor(a.amount);
        d.livingCcy = a.currency ?? d.incomeCcy;
        return ok({ step: 'tz', data: d }, askTz());
      } catch (e) {
        return ok(state, send((e as Error).message));
      }
    }

    case 'tz': {
      if (cb?.startsWith('ob:tz:')) {
        const tz = cb.slice(6);
        if (tz === 'X')
          return ok({ step: 'tz_custom', data: d }, send('Напишите таймзону (IANA), например Europe/Berlin.'));
        if (!isValidTimezone(tz)) return ok(state, send('Не знаю такую таймзону — выберите из кнопок.', TZ_KB));
        d.tz = tz;
        return ok(
          { step: 'commitments', data: d },
          send(
            'Обязательные платежи — по одному в строке:\n' +
              '<code>Аренда 700 usd 1</code> (название сумма [валюта] [день месяца])\n\n' +
              commitmentsList(d),
            COMM_KB,
          ),
        );
      }
      return ok(state, askTz());
    }

    case 'tz_custom': {
      if (input.type !== 'text') return ok(state, send('Напишите таймзону текстом.'));
      const tz = text;
      if (!isValidTimezone(tz)) return ok(state, send('Не знаю такую таймзону. Пример: Europe/Berlin'));
      d.tz = tz;
      return ok(
        { step: 'commitments', data: d },
        send(
          'Обязательные платежи — по одному в строке:\n<code>Аренда 700 usd 1</code>\n\n' + commitmentsList(d),
          COMM_KB,
        ),
      );
    }

    case 'commitments': {
      if (cb === 'ob:com:done' || cb === 'ob:com:skip') {
        const weekly = Math.round(((d.livingMinor ?? 0) * 12) / 52);
        const summary =
          '✅ Профиль сохранён:\n' +
          `Доход: ${fmtMoney((d.incomeMinor ?? 0) / 100, d.incomeCcy ?? 'USD')}\n` +
          `Повседневные: ${fmtMoney((d.livingMinor ?? 0) / 100, d.livingCcy ?? 'USD')} (недельный ≈ ${fmtMoney(weekly / 100, d.livingCcy ?? 'USD')})\n` +
          `Таймзона: ${escapeHtml(d.tz ?? 'UTC')}\nПлатежи:\n${commitmentsList(d)}\n\n` +
          'Главное меню — /menu.';
        return ok(null, { kind: 'persist', data: d }, { kind: 'done' }, send(summary, homeMarkup()));
      }
      if (input.type === 'text') {
        try {
          const c = parseCommitmentLine(text);
          if (!c.currency) c.currency = d.incomeCcy;
          if (d.commitments.length >= 30) return ok(state, send('Максимум 30 платежей — нажмите «Готово».', COMM_KB));
          d.commitments.push(c);
          return ok(state, send(`Добавлено. Итого:\n${commitmentsList(d)}`, COMM_KB));
        } catch (e) {
          return ok(state, send(`${(e as Error).message}`, COMM_KB));
        }
      }
      return ok(state, send('Введите платёж текстом или нажмите «Готово».', COMM_KB));
    }

    default:
      return ok(null, send('Сбросил настройку. /start — начать заново.'));
  }
}

/** Ответ на checkCcy: ok → переход к сумме дохода, не ok → спросить снова. */
export function onCcyResult(state: ObState, okFlag: boolean): { state: ObState | null; effects: ObEffect[] } {
  const d = state.data;
  if (okFlag && d.pendingCcy) {
    d.incomeCcy = d.pendingCcy;
    delete d.pendingCcy;
    return ok({ step: 'income_amount', data: d }, askIncomeAmount(d));
  }
  delete d.pendingCcy;
  return ok(state, send('Такая валюта не поддерживается. Коды вроде USD, GEL — попробуйте ещё.'));
}
