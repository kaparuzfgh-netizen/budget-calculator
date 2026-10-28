/**
 * bugfix.test.ts — регрессии прод-багов:
 *  1) Telegram 400 «can't parse entities» → без ответа (HTML-валидатор на всём выводе + ретрай в клиенте);
 *  2) двойные ответы: step-aware callback'и, CAS на conversation_state, /cancel в одном месте;
 *  3) maskChunk — маскировка скрытого ввода.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import { createTelegramClient, TelegramError, type SendMessageOpts, type TelegramClient } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import { TEXT } from '../src/bot/commands';
import { advance, startOnboarding, type ObState } from '../src/bot/onboarding';
import { monthInTz } from '../src/bot/parse';
import { scoped } from '../src/db/repo';
import { maskChunk } from '../../../scripts/hidden-utils.mjs';

// ── валидатор Telegram-HTML-подмножества ──
const ALLOWED = new Set(['b', 'i', 'code', 'pre', 'a']);
function assertTgHtml(t: string) {
  const stack: string[] = [];
  let rest = '';
  const re = /<(\/)?([a-zA-Z]+)((?:\s[^<>]*)?)>/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(t))) {
    rest += t.slice(last, m.index);
    last = m.index + m[0].length;
    const [, close, name, attrs] = m;
    expect(ALLOWED.has(name!.toLowerCase()), `запрещённый тег <${name}> в «${t.slice(0, 60)}…»`).toBe(true);
    if (name === 'a' && !close) expect(attrs).toMatch(/href="[^"]*"/);
    if (close) {
      expect(stack.pop(), `незакрытый <${stack.at(-1)}>`).toBe(name);
    } else stack.push(name!);
  }
  rest += t.slice(last);
  expect(stack, 'небалансированные теги').toEqual([]);
  // в оставшемся тексте — ни <, >, ни & вне entity
  expect(rest).not.toMatch(/[<>]/);
  expect(rest.replace(/&(lt|gt|amp|quot);/g, '')).not.toContain('&');
}

const SECRET = 's3';
const OWNER = 555000111;
const sent: { chatId: number; text: string; markup?: SendMessageOpts['replyMarkup'] }[] = [];
const tg: TelegramClient = {
  sendMessage: async (c, t, o?: SendMessageOpts) => {
    assertTgHtml(t); // ВСЕ исходящие сообщения проверяются на валидность HTML
    sent.push({ chatId: Number(c), text: t, markup: o?.replyMarkup });
  },
  answerCallbackQuery: async () => {},
  sendDocument: async () => {},
};
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, EUR: 1 / 1.09, RUB: 97 }, asOf: '2026-10-20' }) };
const app = createRouter({ telegram: tg, fx });
const tenv = () => ({ ...env, TELEGRAM_WEBHOOK_SECRET: SECRET, OWNER_TELEGRAM_ID: String(OWNER) });
let u = 1000;
const post = (body: unknown) =>
  app.fetch(
    new Request('https://t/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    tenv(),
  );
const msg = (tgId: number, text: string, id?: number) =>
  post({ update_id: id ?? u++, message: { message_id: 1, text, chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'U' } } });
const cb = (tgId: number, data: string, id?: number) =>
  post({ update_id: id ?? u++, callback_query: { id: 'cb', data, from: { id: tgId }, message: { chat: { id: tgId, type: 'private' } } } });

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  for (const t of ['conversation_state', 'income_entries', 'weekly_expenses', 'categories', 'commitment_payments', 'commitments', 'profiles', 'consents', 'fx_rates', 'processed_updates', 'audit_log', 'invites', 'reminder_log', 'users']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

async function makeOnboarded(tgId: number) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number((await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id);
  await scoped(env.DB, uid).grantConsent('terms');
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD', income_currency: 'EUR', living_currency: 'RUB', timezone: 'Asia/Bishkek',
    income_minor: 620000, living_cap_minor: 6000000, weekly_budget_minor: 1384615,
    bonus_prepay_share: 0, bonus_dca_share: 0, onboarded_at: 'x',
  });
  return uid;
}

async function startOb(tgId: number) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  await msg(tgId, '/start'); // → terms
}

describe('симптом 1: HTML-валидность всех текстов', () => {
  it('TEXT.* — валидный Telegram-HTML', () => {
    const strs: string[] = [
      TEXT.welcome('A<b>'), TEXT.welcomeOwner('A'), TEXT.help('member'), TEXT.help('owner'),
      TEXT.inviteCreated('https://t.me/b?start=x', 'code'), TEXT.inviteCreated(null, 'c'),
      TEXT.inviteLimit, TEXT.inviteForbidden, TEXT.inviteInvalid, TEXT.joined('X'),
      TEXT.myId(123), TEXT.unknownCommand, TEXT.helpOnboarded(),
    ];
    for (const s of strs) assertTgHtml(s);
  });
  it('/help у онбоарденного → ответ приходит', async () => {
    await makeOnboarded(OWNER + 10);
    await msg(OWNER + 10, '/help');
    expect(sent.at(-1)!.text).toContain('/plan');
  });
  it('ретрай без parse_mode при 400 «can\'t parse entities»', async () => {
    const calls: { body: string }[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      calls.push({ body: String(init.body) });
      const bad = calls.length === 1;
      return new Response(JSON.stringify({ ok: bad, description: bad ? "Bad Request: can't parse entities" : 'ok' }), { status: bad ? 400 : 200 });
    }) as unknown as typeof fetch;
    const client = createTelegramClient({ token: '1:x', fetchImpl: f });
    await client.sendMessage(1, 'Привет <b>мир</b> <сумма>');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toContain('parse_mode');
    expect(calls[1]!.body).not.toContain('parse_mode');
    expect(calls[1]!.body).not.toContain('<b>'); // теги срезаны, текст дошёл
  });
  it('лог ошибки содержит error_code и санитизированное описание', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom: TelegramClient = {
      sendMessage: async () => { throw new TelegramError(400, 'Bad Request: can\'t parse entities'); },
      answerCallbackQuery: async () => {},
      sendDocument: async () => {},
    };
    const app2 = createRouter({ telegram: boom, fx });
    await makeOnboarded(OWNER + 11);
    const res = await app2.fetch(
      new Request('https://t/telegram/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: u++, message: { message_id: 1, text: '/help', chat: { id: OWNER + 11, type: 'private' }, from: { id: OWNER + 11, first_name: 'U' } } }),
      }),
      tenv(),
    );
    expect(res.status).toBe(200);
    const line = spy.mock.calls.flat().join(' ');
    expect(line).toContain('400');
    expect(line).toContain('TelegramError');
    expect(line).not.toContain(SECRET);
    spy.mockRestore();
  });
});

describe('симптом 2: двойные ответы', () => {
  it('один update → ровно один ответ (consent, /cancel, ➕ Трата)', async () => {
    await startOb(OWNER + 20); // terms
    const before = sent.length;
    await cb(OWNER + 20, 'ob:terms:ok');
    expect(sent.length - before).toBe(1); // один вопрос «валюта дохода»
    await cb(OWNER + 20, 'ob:ic:EUR');
    const b2 = sent.length;
    await msg(OWNER + 20, '/cancel');
    expect(sent.length - b2).toBe(1); // только «отменена»
    const uid21 = await makeOnboarded(OWNER + 21);
    await scoped(env.DB, uid21).claimReminder('kb_removed', 'v1'); // kb-миграция уже пройдена — считаем только ответы
    const b3 = sent.length;
    await msg(OWNER + 21, '➕ Трата');
    expect(sent.length - b3).toBe(1); // только «Сколько потратили?»
  });

  it('callback чужого шага игнорируется (дубликат «Согласен»)', async () => {
    await startOb(OWNER + 22);
    await cb(OWNER + 22, 'ob:terms:ok'); // → income_ccy
    const n = sent.length;
    await cb(OWNER + 22, 'ob:terms:ok'); // «Согласен» повторно — теперь чужой шаг
    expect(sent.length).toBe(n); // молча, вопрос НЕ повторяется
  });

  it('один update_id дважды (seq и concurrent) → обработан один раз', async () => {
    await startOb(OWNER + 23);
    const id = u++;
    const body = { update_id: id, callback_query: { id: 'cb', data: 'ob:terms:ok', from: { id: OWNER + 23 }, message: { chat: { id: OWNER + 23, type: 'private' } } } };
    await post(body);
    const n1 = sent.length;
    await post(body); // повторная доставка — дедуп update_id
    expect(sent.length).toBe(n1);
    const id2 = u++;
    sent.length = 0;
    await Promise.all([
      post({ update_id: id2, callback_query: { id: 'cb', data: 'ob:ic:EUR', from: { id: OWNER + 23 }, message: { chat: { id: OWNER + 23, type: 'private' } } } }),
      post({ update_id: id2, callback_query: { id: 'cb', data: 'ob:ic:EUR', from: { id: OWNER + 23 }, message: { chat: { id: OWNER + 23, type: 'private' } } } }),
    ]);
    expect(sent).toHaveLength(1);
  });

  it('два разных update_id с одним /cancel → нет «Не знаю такую команду»', async () => {
    await startOb(OWNER + 24);
    await cb(OWNER + 24, 'ob:terms:ok');
    await msg(OWNER + 24, '/cancel');
    expect(sent.at(-1)!.text).toContain('отменена');
    await msg(OWNER + 24, '/cancel'); // второй update_id — теперь без состояния
    expect(sent.at(-1)!.text).toContain('Нечего отменять');
    expect(sent.at(-1)!.text).not.toContain('Не знаю');
  });

  it('меню/команда во время spent_ask → отмена вопроса, без «Не понял сумму»', async () => {
    await makeOnboarded(OWNER + 25);
    await msg(OWNER + 25, '➕ Трата');
    expect(sent.at(-1)!.text).toContain('Сколько потратили');
    await msg(OWNER + 25, '📅 Неделя'); // кнопка меню во время spent_ask
    expect(sent.at(-1)!.text).toContain('Неделя');
    expect(sent.at(-1)!.text).not.toContain('Не понял сумму');
    await msg(OWNER + 25, '➕ Трата');
    await msg(OWNER + 25, 'текст-не-сумма');
    expect(sent.at(-1)!.text).toContain('Не понял сумму'); // мусор — ошибка, шаг жив
    await msg(OWNER + 25, '100');
    expect(sent.at(-1)!.text).toContain('Записал'); // повторный ввод суммы работает
  });

  it('два done-колбэка → один persist (CAS)', async () => {
    await startOb(OWNER + 26);
    await cb(OWNER + 26, 'ob:terms:ok');
    await cb(OWNER + 26, 'ob:ic:EUR');
    await msg(OWNER + 26, '6200');
    await msg(OWNER + 26, '60000');
    await cb(OWNER + 26, 'ob:tz:Asia/Bishkek');
    await cb(OWNER + 26, 'ob:com:done'); // persist + сводка
    const n = sent.length;
    await cb(OWNER + 26, 'ob:com:done'); // второй done — состояния уже нет
    expect(sent.length).toBe(n);
    const uid = Number((await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(OWNER + 26).first<{ id: number }>())!.id);
    const commits = (await scoped(env.DB, uid).listCommitments()).results;
    expect(commits).toHaveLength(0);
  });
});

describe('симптом 3: maskChunk', () => {
  it('символ → звёздочка, backspace стирает, вопрос не маскируется', () => {
    expect(maskChunk('a')).toBe('*');
    expect(maskChunk('абв')).toBe('***'); // паста целым куском
    expect(maskChunk('\b')).toBe('\b \b');
    expect(maskChunk('\r\n')).toBe('\n');
    expect(maskChunk('')).toBe('*');
  });
});

describe('редьюсер: step-aware callback', () => {
  it('advance молча игнорирует callback чужого шага', () => {
    const st: ObState = { step: 'income_ccy', data: { commitments: [] } };
    const r = advance(st, { type: 'callback', data: 'ob:terms:ok' });
    expect(r.state).toBe(st);
    expect(r.effects).toEqual([]);
    const r2 = advance(startOnboarding().state, { type: 'callback', data: 'ob:com:done' });
    expect(r2.effects).toEqual([]);
  });
});

describe('голая сумма — быстрый ввод траты', () => {
  it('«344» и «500 kgs» вне промпта → трата пишется; «привет» — «Не знаю»', async () => {
    const uid = await makeOnboarded(OWNER + 30);
    await msg(OWNER + 30, '344');
    expect(sent.at(-1)!.text).toContain('Записал');
    expect((await scoped(env.DB, uid).listExpenses()).results).toHaveLength(1);
    await msg(OWNER + 30, '500 rub');
    expect(sent.at(-1)!.text).toContain('Записал');
    expect((await scoped(env.DB, uid).listExpenses()).results).toHaveLength(2);
    await msg(OWNER + 30, 'привет');
    expect(sent.at(-1)!.text).toBe(TEXT.unknownCommand);
  });

  it('«344» в spent_ask → трата; «344» в income_ask → доход (промпты не тронуты)', async () => {
    const uid = await makeOnboarded(OWNER + 31);
    await msg(OWNER + 31, '➕ Трата');
    expect(sent.at(-1)!.text).toContain('Сколько потратили');
    await msg(OWNER + 31, '344');
    expect(sent.at(-1)!.text).toContain('Записал');
    const exp = (await scoped(env.DB, uid).listExpenses()).results;
    expect(exp).toHaveLength(1);
    expect(exp[0]!.amount_minor).toBe(34400);
    // income_ask через INCOME_HUB → «➕ Добавить доход»
    await msg(OWNER + 31, '/income');
    await cb(OWNER + 31, 'inc:add');
    expect(sent.at(-1)!.text).toContain('Сколько получили');
    await msg(OWNER + 31, '344');
    const inc = (await scoped(env.DB, uid).listIncomeEntries(monthInTz('Asia/Bishkek', new Date()))).results;
    expect(inc).toHaveLength(1);
    expect(inc[0]!.amount_minor).toBe(34400);
  });
});

describe('миграция нижней клавиатуры (kb_removed)', () => {
  const removals = () =>
    sent.filter((m) => (m.markup as { remove_keyboard?: boolean } | undefined)?.remove_keyboard === true);

  it('remove_keyboard уходит ровно один раз на пользователя (дедуп через claim)', async () => {
    await makeOnboarded(OWNER + 40);
    await msg(OWNER + 40, '/help');
    await msg(OWNER + 40, '/week');
    const rm = removals();
    expect(rm).toHaveLength(1);
    expect(rm[0]!.text).toBe('·');
    expect(sent.at(-1)!.text).not.toBe('·'); // основное сообщение дошло после «·»
    // колбэк-ветка тоже молчит про клавиатуру — claim уже стоит
    await cb(OWNER + 40, 'nv:home');
    expect(removals()).toHaveLength(1);
    expect(sent.at(-1)!.text).toBe('Главное меню');
  });

  it('сбой remove_keyboard → claim откатывается и ретраится на следующем сообщении', async () => {
    await makeOnboarded(OWNER + 41);
    let attempts = 0;
    let failRemoval = true;
    const flaky: TelegramClient = {
      sendMessage: async (c, t, o) => {
        if (o?.replyMarkup && 'remove_keyboard' in o.replyMarkup) {
          attempts++;
          if (failRemoval) throw new Error('net down');
        }
        sent.push({ chatId: Number(c), text: t });
      },
      answerCallbackQuery: async () => {},
      sendDocument: async () => {},
    };
    const app2 = createRouter({ telegram: flaky, fx });
    const post2 = (body: unknown) =>
      app2.fetch(
        new Request('https://t/telegram/webhook', {
          method: 'POST',
          headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        tenv(),
      );
    const msg2 = (tgId: number, text: string) =>
      post2({
        update_id: u++,
        message: { message_id: 1, text, chat: { id: tgId, type: 'private' }, from: { id: tgId, first_name: 'U' } },
      });
    await msg2(OWNER + 41, '/help'); // «·» упала → claim откачен, help дошёл
    expect(attempts).toBe(1);
    expect(sent.at(-1)!.text).toContain('/plan');
    failRemoval = false;
    await msg2(OWNER + 41, '/help'); // ретрай миграции — теперь успешно
    expect(attempts).toBe(2);
    expect(sent.filter((m) => m.text === '·')).toHaveLength(1);
    await msg2(OWNER + 41, '/help'); // claim стоит — больше не пытается
    expect(attempts).toBe(2);
  });

  it('свежий пользователь проходит онбординг; в разметке только inline', async () => {
    await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(OWNER + 42).run();
    await msg(OWNER + 42, '/start');
    await cb(OWNER + 42, 'ob:terms:ok');
    await cb(OWNER + 42, 'ob:ic:EUR');
    await msg(OWNER + 42, '6200');
    await msg(OWNER + 42, '60000');
    await cb(OWNER + 42, 'ob:tz:UTC');
    await cb(OWNER + 42, 'ob:com:skip');
    expect(sent.at(-1)!.text).toContain('Профиль сохранён');
    // ни одно сообщение не несёт reply keyboard; сводка — с inline-навигацией
    const markups = sent.map((m) => m.markup as Record<string, unknown> | undefined);
    expect(markups.every((m) => !(m && 'keyboard' in m))).toBe(true);
    expect(markups.at(-1)).toHaveProperty('inline_keyboard');
  });
});
