/**
 * vision.test.ts — шаг 7: скриншоты банка.
 *  • sanitizeVision — порт v1 санитайзинга (whitelist, лимиты, валюта);
 *  • parseScreenshot — цепочка Gemini → Groq на мокнутом fetch;
 *  • toBase64 — чанкинг >64 КБ;
 *  • e2e через webhook: фото → трата/сверка/лимиты/согласие.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { TelegramClient } from '../src/telegram/client';
import type { FxProvider } from '../src/fx/provider';
import { scoped } from '../src/db/repo';
import { parseScreenshot, sanitizeVision, toBase64, VisionError } from '../src/vision';
import { visionPrompt } from '../src/vision/parse';

// ── unit: sanitizeVision ──
describe('sanitizeVision', () => {
  it('whitelist screen_type: мусор → other', () => {
    const r = sanitizeVision({ screen_type: 'hack", "x' }, 'gemini', 'RUB');
    expect(r.screen_type).toBe('other');
    expect(sanitizeVision({ screen_type: 'debt_balance' }, 'groq', 'RUB').screen_type).toBe('debt_balance');
  });
  it('total_spent: нефинит/≤0/>5e6 → 0', () => {
    for (const t of ['abc', -5, 0, 6_000_000, NaN])
      expect(sanitizeVision({ screen_type: 'expense_analytics', total_spent: t }, 'gemini', 'RUB').total_spent).toBe(0);
    expect(sanitizeVision({ screen_type: 'expense_analytics', total_spent: 3200 }, 'gemini', 'RUB').total_spent).toBe(3200);
  });
  it('категории: ≤5, amount>0 и ≤total*1.5, мусор отфильтрован', () => {
    const r = sanitizeVision(
      {
        screen_type: 'expense_analytics',
        total_spent: 1000,
        top_categories: [
          { category: 'A', amount: 500 },
          { category: 'B', amount: 2000 }, // >1000*1.5 — вылетает
          { category: 'C', amount: -10 },
          { category: 'D', amount: 'x' },
          { category: 'E', amount: 100 },
          { category: 'F', amount: 90 },
          { category: 'G', amount: 80 },
          { category: 'H', amount: 70 }, // 6-я валидная — отрезана slice(0,5)
        ],
      },
      'gemini',
      'RUB',
    );
    expect(r.top_categories.map((c) => c.category)).toEqual(['A', 'E', 'F', 'G', 'H']);
  });
  it('валюта: поддерживаемый набор, иначе — fallback (living_ccy), не хардкод KGS', () => {
    expect(sanitizeVision({ currency: 'GEL' }, 'gemini', 'RUB').currency).toBe('GEL'); // в наборе
    expect(sanitizeVision({ currency: 'BTC' }, 'gemini', 'RUB').currency).toBe('RUB'); // не в наборе → fallback
    expect(sanitizeVision({ currency: 'sek' }, 'gemini', 'KGS').currency).toBe('KGS');
    expect(sanitizeVision({}, 'gemini', 'UZS').currency).toBe('UZS');
  });
  it('debt_balance: только 1e3<bal<1e8; в major units (float)', () => {
    expect(sanitizeVision({ debt_balance: 500 }, 'gemini', 'RUB').debt_balance).toBe(0);
    expect(sanitizeVision({ debt_balance: 1_500_000.5 }, 'gemini', 'RUB').debt_balance).toBe(1_500_000.5);
    expect(sanitizeVision({ debt_balance: 2e8 }, 'gemini', 'RUB').debt_balance).toBe(0);
    expect(sanitizeVision({ debt_balance: 'nope' }, 'gemini', 'RUB').debt_balance).toBe(0);
  });
  it('битый вход → VisionError (не молчаливый мусор)', () => {
    expect(() => sanitizeVision([1, 2], 'gemini', 'RUB')).toThrow(VisionError);
    expect(() => sanitizeVision('json', 'groq', 'RUB')).toThrow(VisionError);
  });
  it('transactions: строки парсятся; сводка не ломается', () => {
    const r = sanitizeVision(
      {
        screen_type: 'expense_analytics',
        period: 'неделя',
        total_spent: 1000,
        currency: 'RUB',
        transactions: [
          { date: '2026-10-20', amount: 320, note: 'Кофейня', category: 'Кафе' },
          { date: null, amount: 680.5, note: 'Магазин' },
        ],
      },
      'gemini',
      'RUB',
    );
    expect(r.screen_type).toBe('expense_analytics');
    expect(r.total_spent).toBe(1000);
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions![0]).toEqual({ date: '2026-10-20', amount: 320, note: 'Кофейня', category: 'Кафе' });
    expect(r.transactions![1]).toMatchObject({ date: null, amount: 680.5, category: '' });
  });
  it('transactions: битые строки выпадают, строки обрезаются', () => {
    const r = sanitizeVision(
      {
        screen_type: 'expense_analytics',
        total_spent: 0, // итога нет — база капа = сумма самих строк
        transactions: [
          ...Array.from({ length: 28 }, (_, i) => ({ date: '2026-10-01', amount: 100, note: `t${i}` })),
          { amount: 'мусор' },
          { amount: -50 },
          { amount: 0 },
          null,
          { amount: 9_000_000 }, // >5e6 — абсолютный предел
          { amount: 100, date: 'не дата', note: 'x'.repeat(500), category: 'y'.repeat(300) },
          { amount: 100, date: '2026-02-30' }, // несуществующая дата → null
        ],
      },
      'groq',
      'RUB',
    );
    expect(r.transactions).toHaveLength(30); // 30 валидных; битые строки выпали
    expect(r.transactions![28]).toMatchObject({ date: null, amount: 100 });
    expect(r.transactions![28]!.note).toHaveLength(200); // обрезано до 200
    expect(r.transactions![28]!.category).toHaveLength(200);
    expect(r.transactions![29]!.date).toBeNull(); // '2026-02-30' → null
    expect(r.transactions!.every((t) => t.amount > 0 && t.amount <= 5_000_000)).toBe(true);
  });
  it('transactions: кап — 30 строк', () => {
    const r = sanitizeVision(
      { transactions: Array.from({ length: 40 }, (_, i) => ({ amount: 10, note: `t${i}` })) },
      'gemini',
      'RUB',
    );
    expect(r.transactions).toHaveLength(30);
  });
  it('transactions: сверх total*1.5 отсекается, как у категорий', () => {
    const r = sanitizeVision(
      {
        screen_type: 'expense_analytics',
        total_spent: 1000,
        transactions: [
          { amount: 1400 }, // ≤1500 — ок
          { amount: 1600 }, // >total*1.5 — вылетает
        ],
      },
      'gemini',
      'RUB',
    );
    expect(r.transactions!.map((t) => t.amount)).toEqual([1400]);
  });
  it('transactions: нет/пустой массив — поле не добавляется', () => {
    expect(sanitizeVision({ screen_type: 'expense_analytics' }, 'gemini', 'RUB').transactions).toBeUndefined();
    expect(
      sanitizeVision({ transactions: [{ amount: 'x' }] }, 'gemini', 'RUB').transactions,
    ).toBeUndefined();
  });
});

// ── unit: провайдеры на мокнутом fetch ──
const geminiResp = (payload: object, status = 200) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), {
    status,
  });
const groqResp = (payload: object, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status });
const EXP = { screen_type: 'expense_analytics', period: 'неделя', total_spent: 3200, currency: 'RUB' };

describe('parseScreenshot: цепочка провайдеров', () => {
  it('Gemini успешен → Groq не вызывается; тело — response_schema snake_case', async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as string | undefined });
      return geminiResp(EXP);
    }) as unknown as typeof fetch;
    const r = await parseScreenshot('AAAA', 'image/jpeg', {
      geminiKey: 'g',
      groqKey: 'q',
      fallbackCcy: 'RUB',
      currencies: ['EUR', 'RUB'],
      fetchImpl: f,
    });
    expect(r.provider).toBe('gemini');
    expect(r.total_spent).toBe(3200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('generativelanguage.googleapis.com');
    const body = JSON.parse(calls[0]!.body!);
    // v1-совместимость: generationConfig.response_schema + inline_data/mime_type
    expect(body.generationConfig.response_mime_type).toBe('application/json');
    expect(body.generationConfig.response_schema.properties.screen_type.enum).toContain('debt_balance');
    expect(body.contents[0].parts[1].inline_data).toEqual({ mime_type: 'image/jpeg', data: 'AAAA' });
    // валюты пользователя — в промпте
    expect(body.contents[0].parts[0].text).toContain('EUR, RUB');
  });
  it('Gemini 400 → fallback на Groq (без ретрая)', async () => {
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('groq') ? groqResp(EXP) : new Response('bad', { status: 400 }),
    ) as unknown as typeof fetch;
    const r = await parseScreenshot('AA', 'image/jpeg', {
      geminiKey: 'g',
      groqKey: 'q',
      fallbackCcy: 'RUB',
      currencies: ['RUB'],
      fetchImpl: f,
    });
    expect(r.provider).toBe('groq');
    expect(f).toHaveBeenCalledTimes(2);
    expect(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![0])).toContain('groq');
  });
  it('оба провайдера падают → VisionError, ключи не в сообщении', async () => {
    const f = vi.fn(async () => new Response('leak!', { status: 400 })) as unknown as typeof fetch;
    await expect(
      parseScreenshot('AA', 'image/jpeg', {
        geminiKey: 'SECRET_G',
        groqKey: 'SECRET_Q',
        fallbackCcy: 'RUB',
        currencies: ['RUB'],
        fetchImpl: f,
      }),
    ).rejects.toThrow(VisionError);
    const e = (await parseScreenshot('AA', 'image/jpeg', {
      geminiKey: 'SECRET_G',
      groqKey: 'SECRET_Q',
      fallbackCcy: 'RUB',
      currencies: ['RUB'],
      fetchImpl: f,
    }).catch((x) => x)) as VisionError;
    expect(e.message).not.toContain('SECRET');
    expect(e.message).not.toContain('leak!');
    expect(e.message).toContain('HTTP 400');
  });
  it('нет ключей → VisionError «ключ не задан»', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    const e = (await parseScreenshot('AA', 'image/jpeg', {
      fallbackCcy: 'RUB',
      currencies: ['RUB'],
      fetchImpl: f,
    }).catch((x) => x)) as VisionError;
    expect(e.message).toContain('gemini: ключ не задан');
    expect(e.message).toContain('groq: ключ не задан');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('toBase64', () => {
  it('чанкинг: вход >64 КБ кодируется целиком и валидно', () => {
    const bytes = new Uint8Array(150_000).map((_, i) => i % 256);
    const b64 = toBase64(bytes);
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(back.length).toBe(bytes.length);
    expect([...back.subarray(0x7ff0, 0x8010)]).toEqual([...bytes.subarray(0x7ff0, 0x8010)]); // граница чанков
    expect(back[0]).toBe(0);
    expect(back.at(-1)).toBe(bytes.at(-1));
  });
});

describe('visionPrompt', () => {
  it('валюты пользователя вставляются в промпт', () => {
    const p = visionPrompt(['EUR', 'RUB', 'KGS']);
    expect(p).toContain('EUR, RUB, KGS');
    expect(p).toContain('debt_balance');
  });
});

// ── e2e: webhook → vision-флоу ──
const SECRET = 'vs3';
const OWNER = 555000111;
const sent: { chatId: number; text: string; markup?: { inline_keyboard?: { text: string; callback_data?: string }[][] } }[] = [];
const actions: string[] = [];
let fileSize = 4321; // getFile().file_size — подменяется в тесте лимита
const tg: TelegramClient = {
  sendMessage: async (c, t, o) => {
    sent.push({ chatId: Number(c), text: t, markup: o?.replyMarkup as never });
  },
  answerCallbackQuery: async () => {},
  sendDocument: async () => {},
  getFile: async (fileId) => ({ file_path: `photos/${fileId}.jpg`, file_size: fileSize }),
  downloadFileBytes: async () => new Uint8Array([137, 80, 78, 71]),
  sendChatAction: async (_c, a) => {
    actions.push(a);
  },
};
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, EUR: 1 / 1.09, RUB: 97 }, asOf: 'x' }) };
const visionCalls: string[] = [];
const visionFetch = vi.fn(async (url: string | URL | Request) => {
  visionCalls.push(String(url));
  return geminiResp(EXP);
});
const app = createRouter({
  telegram: tg,
  fx,
  vision: { geminiKey: 'gk', groqKey: 'qk', fetchImpl: visionFetch as unknown as typeof fetch },
});
const tenv = () => ({ ...env, TELEGRAM_WEBHOOK_SECRET: SECRET, OWNER_TELEGRAM_ID: String(OWNER) });
let u = 500000;
const post = (body: unknown) =>
  app.fetch(
    new Request('https://t/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    tenv(),
  );
const photo = (tgId: number, updateId?: number) =>
  post({
    update_id: updateId ?? u++,
    message: {
      message_id: u,
      photo: [{ file_id: 'small' }, { file_id: 'big' }],
      chat: { id: tgId, type: 'private' },
      from: { id: tgId, first_name: 'U' },
    },
  });
const photoDoc = (tgId: number, mime = 'image/png') =>
  post({
    update_id: u++,
    message: {
      message_id: u,
      document: { file_id: 'doc1', mime_type: mime },
      chat: { id: tgId, type: 'private' },
      from: { id: tgId, first_name: 'U' },
    },
  });
const cb = (tgId: number, data: string) =>
  post({
    update_id: u++,
    callback_query: { id: 'c' + u, data, from: { id: tgId }, message: { chat: { id: tgId, type: 'private' } } },
  });
const last = () => sent.at(-1)!;
const cbs = () => (last().markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data).filter(Boolean);

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  actions.length = 0;
  visionCalls.length = 0;
  fileSize = 4321;
  visionFetch.mockReset().mockImplementation(async (url: string | URL | Request) => {
    visionCalls.push(String(url));
    return geminiResp(EXP);
  });
  for (const t of [
    'conversation_state',
    'weekly_expenses', 'categories',
    'debt_events',
    'debts',
    'profiles',
    'reminder_log',
    'processed_updates',
    'users',
    'audit_log',
  ])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});
async function user(tgId: number, visionEnabled = 1) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number(
    (await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id,
  );
  const r = scoped(env.DB, uid);
  await r.upsertProfile({
    base_currency: 'USD',
    income_currency: 'EUR',
    living_currency: 'RUB',
    timezone: 'UTC',
    income_minor: 0,
    living_cap_minor: 6000000,
    weekly_budget_minor: 1384615,
    bonus_prepay_share: 0,
    bonus_dca_share: 0,
    onboarded_at: 'x',
  });
  await r.patchProfile({ vision_enabled: visionEnabled });
  await r.claimReminder('kb_removed', 'v1'); // миграционное «·» не путаем с ответами
  return uid;
}
const expenses = (uid: number) => scoped(env.DB, uid).listExpenses('2000-01-01');

describe('vision: фото → расход', () => {
  it('фото → одна недельная трата source=vision; ответ — голова + статус недели', async () => {
    const tgId = OWNER + 10;
    const uid = await user(tgId);
    await photo(tgId);
    const r = (await expenses(uid)).results;
    expect(r).toHaveLength(1);
    expect(r[0]!.source).toBe('vision');
    expect(r[0]!.amount_minor).toBe(320000);
    expect(r[0]!.note).toContain('vision/gemini');
    expect(last().text).toContain('Gemini разобрал скриншот');
    expect(last().text).toContain('Неделя');
    expect(actions).toContain('typing');
  });
  it('редоставка того же update_id → дубля траты нет', async () => {
    const tgId = OWNER + 11;
    const uid = await user(tgId);
    const upd = u++;
    await photo(tgId, upd);
    await photo(tgId, upd);
    expect((await expenses(uid)).results).toHaveLength(1);
  });
  it('полномесячная аналитика → инфо, записи нет', async () => {
    const tgId = OWNER + 12;
    const uid = await user(tgId);
    visionFetch.mockImplementationOnce(async () => geminiResp({ ...EXP, is_full_month_analytics: true }));
    await photo(tgId);
    expect(last().text).toContain('весь месяц');
    expect((await expenses(uid)).results).toHaveLength(0);
  });
  it('screen_type=other → хинт «Не нашёл», записи нет', async () => {
    const tgId = OWNER + 13;
    const uid = await user(tgId);
    visionFetch.mockImplementationOnce(async () => geminiResp({ screen_type: 'other', total_spent: 0 }));
    await photo(tgId);
    expect(last().text).toContain('Не нашёл на скриншоте');
    expect((await expenses(uid)).results).toHaveLength(0);
  });
  it('выключенный флаг → хинт, провайдер НЕ вызывается', async () => {
    const tgId = OWNER + 14;
    await user(tgId, 0);
    await photo(tgId);
    expect(last().text).toContain('выключено');
    expect(visionCalls).toHaveLength(0);
  });
  it('документ image/png → разбор; не-картинка → маршрутизация текста', async () => {
    const tgId = OWNER + 15;
    const uid = await user(tgId);
    await photoDoc(tgId);
    expect((await expenses(uid)).results).toHaveLength(1);
    // pdf-документ — не изображение → уходит в обычный текстовый путь
    await photoDoc(tgId, 'application/pdf');
    expect(last().text).toContain('Не знаю такую команду');
  });
  it('файл >10 МБ → отказ по размеру, провайдер НЕ вызывается', async () => {
    const tgId = OWNER + 18;
    await user(tgId);
    fileSize = 11 * 1024 * 1024;
    await photo(tgId);
    expect(last().text).toContain('слишком большое');
    expect(visionCalls).toHaveLength(0);
  });
  it('лимит: 20 скриншотов приняты, 21-й отклонён', async () => {
    const tgId = OWNER + 16;
    await user(tgId);
    for (let i = 0; i < 20; i++) await photo(tgId);
    expect(visionCalls).toHaveLength(20);
    await photo(tgId);
    expect(last().text).toContain('Лимит: 20 скриншотов');
    expect(visionCalls).toHaveLength(20);
  });
  it('оба провайдера мертвы → безопасная ошибка без ключей', async () => {
    const tgId = OWNER + 17;
    await user(tgId);
    visionFetch.mockImplementationOnce(async () => new Response('x', { status: 400 }));
    visionFetch.mockImplementationOnce(async () => new Response('x', { status: 400 }));
    await photo(tgId);
    expect(last().text).toContain('😕');
    expect(last().text).toContain('/spent 3200');
    expect(last().text).not.toContain('gk');
    expect(last().text).not.toContain('qk');
  });
  it('незнакомец шлёт фото → тишина и ноль записей в БД', async () => {
    const stranger = OWNER + 90;
    const n = sent.length;
    await photo(stranger);
    expect(sent.length).toBe(n); // ни одного ответа
    expect(visionCalls).toHaveLength(0); // провайдер не дергается
    expect(
      await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(stranger).first(),
    ).toBeNull();
  });
});

describe('vision: сверка долга', () => {
  it('остаток → кнопки ТОЛЬКО своих кредитов; vs:rec → VIS_RECON; vs:reconok → reconcile', async () => {
    const tgA = OWNER + 20;
    const tgB = OWNER + 21;
    const uidA = await user(tgA);
    const uidB = await user(tgB);
    const r = scoped(env.DB, uidA);
    await r.addDebt({ name: 'Ипотека', currency: 'RUB', rate: 11, frequency: 'monthly', initial_balance_minor: 200000000, initial_payment_minor: 2100000, epoch: '2026-01-01', due_day: 15 });
    await r.addDebt({ name: 'Авто', currency: 'RUB', rate: 9, frequency: 'monthly', initial_balance_minor: 50000000, initial_payment_minor: 1200000, epoch: '2026-01-01', due_day: 15 });
    const bId = (
      await scoped(env.DB, uidB).addDebt({ name: 'Чужой', currency: 'RUB', rate: 9, frequency: 'monthly', initial_balance_minor: 1, initial_payment_minor: 1, epoch: '2026-01-01', due_day: null })
    ).meta.last_row_id;
    const ownIds = (await r.listDebts()).results.map((d) => d.id);
    visionFetch.mockImplementationOnce(async () =>
      geminiResp({ screen_type: 'debt_balance', debt_balance: 1_500_000, currency: 'RUB', bank: 'Сбербанк' }),
    );
    await photo(tgA);
    expect(last().text).toContain('Какой это кредит?');
    for (const id of ownIds) expect(cbs()).toContain(`vs:rec:${id}`);
    expect(cbs()).not.toContain(`vs:rec:${bId}`); // чужой долг — нет кнопки
    // сумма — в состоянии, не в callback
    for (const c of cbs()) expect(c).not.toMatch(/1500000/);
    const conv = await r.getConversation();
    expect(conv!.step).toBe('vs:recon');
    // vs:rec → подтверждение VIS_RECON
    const did = ownIds[0]!;
    await cb(tgA, `vs:rec:${did}`);
    expect(last().text).toContain('Сверить «Ипотека» до');
    expect(last().text).toMatch(/1[\s ]500[\s ]000/); // fmtMoney — группировка NBSP
    expect(cbs()).toContain(`vs:reconok:${did}`);
    expect(cbs()).toContain('nv:back:DEBTS');
    // vs:reconok → reconcile-событие с source_key vis:rec:<updateId>:<id>
    await cb(tgA, `vs:reconok:${did}`);
    const evs = (await r.listDebtEvents(did)).results;
    const rec = evs.find((e) => e.kind === 'reconcile')!;
    expect(rec.amount_minor).toBe(150000000);
    expect(rec.source).toBe('manual');
    expect(rec.source_key).toMatch(/^vis:rec:\d+:\d+$/);
    expect(last().text).toContain('Сверено');
  });
  it('чужой id в vs:rec — молча', async () => {
    const tgA = OWNER + 22;
    const tgB = OWNER + 23;
    const uidA = await user(tgA);
    const uidB = await user(tgB);
    const bId = (
      await scoped(env.DB, uidB).addDebt({ name: 'Чужой', currency: 'RUB', rate: 9, frequency: 'monthly', initial_balance_minor: 1, initial_payment_minor: 1, epoch: '2026-01-01', due_day: null })
    ).meta.last_row_id;
    const r = scoped(env.DB, uidA);
    await r.setConversation('vs:recon', JSON.stringify({ amount_minor: 500000 }));
    const n = sent.length;
    await cb(tgA, `vs:rec:${bId}`);
    await cb(tgA, 'vs:reconok:999999');
    expect(sent.length).toBe(n); // молча
  });
  it('debt_balance без суммы → хинт ручного ввода', async () => {
    const tgId = OWNER + 24;
    await user(tgId);
    visionFetch.mockImplementationOnce(async () =>
      geminiResp({ screen_type: 'debt_balance', debt_balance: 0 }),
    );
    await photo(tgId);
    expect(last().text).toContain('остаток долга не распознан');
  });
});
