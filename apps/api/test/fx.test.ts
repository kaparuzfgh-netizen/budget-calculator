/**
 * fx.test.ts — шаг 8 «Обмен валют» end-to-end:
 *  • services/fx.ts — пары, анализ (история/кросс), алерты с ISO-неделя-кулдауном;
 *  • repo — журнал обменов: CRUD, идемпотентность, изоляция тенантов;
 *  • бот — /fx экран, мастер записи обмена, правки, stale-колбэки, /cancel;
 *  • TMA — /api/tma/fx + /api/tma/exchanges CRUD, валидация, client_id, 404/401.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { TelegramClient } from '../src/telegram/client';
import type { FxHistory, FxProvider } from '../src/fx/provider';
import type { FxPoint } from '../src/domain/fx';
import { scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';
import {
  buildAnalysis,
  checkFxAlerts,
  fxPairDefs,
  histOf,
  isoWeekKey,
  renderFxText,
  runFxAlerts,
  type FxAnalysis,
} from '../src/services/fx';

const SECRET = 's3';
const JWT_SECRET = 'fx-test-secret';
const sent: { text: string; markup?: unknown }[] = [];
const tg: TelegramClient = {
  sendMessage: async (c, t, o) => void sent.push({ text: t, markup: o?.replyMarkup }),
  answerCallbackQuery: async () => {},
  sendDocument: async () => {},
};

/** Детерминированная история: n точек по +dv к v0, даты назад от to. */
const series = (n: number, v0: number, dv: number, to = '2026-04-20'): FxPoint[] => {
  const end = new Date(`${to}T00:00:00Z`).getTime();
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(end - (n - 1 - i) * 86400_000).toISOString().slice(0, 10),
    v: v0 + i * dv,
  }));
};

/** Провайдер: latest — фиксированные курсы; history — история по карте. */
const HIST: Record<string, FxPoint[]> = {
  'EUR>RUB': series(40, 80, 0.4), // рост → последний курс у максимума → высокий перцентиль
  'EUR>USD': series(40, 1.05, 0.0005),
  'USD>RUB': series(40, 85, 0.3),
};
const fx: FxProvider = {
  latest: async () => ({ perUsd: { USD: 1, EUR: 1 / 1.09, RUB: 97 }, asOf: '2026-04-20' }),
  history: async (base, quotes) => {
    const out: FxHistory = {};
    for (const q of quotes) {
      const s = HIST[`${base}>${q}`];
      if (s) out[q] = s;
    }
    return out;
  },
};
const app = createRouter({ telegram: tg, fx });
const tenv = () => ({ ...env, TELEGRAM_WEBHOOK_SECRET: SECRET, JWT_SECRET, TELEGRAM_BOT_TOKEN: 't' });
let u = 6000;
const post = (b: unknown) =>
  app.fetch(
    new Request('https://t/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    }),
    tenv(),
  );
const msg = (id: number, text: string) =>
  post({
    update_id: u++,
    message: { message_id: 1, text, chat: { id, type: 'private' }, from: { id, first_name: 'U' } },
  });
const cb = (id: number, data: string) =>
  post({
    update_id: u++,
    callback_query: { id: 'c' + u, data, from: { id }, message: { chat: { id, type: 'private' } } },
  });
const api = (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) =>
  app.fetch(
    new Request(`https://t${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.method && opts.method !== 'GET' && opts.body !== undefined ? JSON.stringify(opts.body) : null,
    }),
    tenv(),
  );
const lastMsg = () => sent.at(-1)!;
const lastCbs = (): string[] =>
  ((lastMsg().markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [])
    .flat()
    .map((b) => b.callback_data ?? '');

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  for (const t of [
    'conversation_state', 'debt_events', 'debts', 'loan_events', 'loans', 'exchanges',
    'income_entries', 'weekly_expenses', 'categories', 'commitment_payments', 'commitments', 'profiles',
    'consents', 'fx_rates', 'reminder_log', 'processed_updates', 'audit_log', 'invites', 'users',
  ]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

async function onboarded(tgId: number) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number(
    (await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id,
  );
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD', income_currency: 'EUR', living_currency: 'RUB', timezone: 'UTC',
    income_minor: 620000, living_cap_minor: 6000000, weekly_budget_minor: 1384615,
    bonus_prepay_share: 0, bonus_dca_share: 0, onboarded_at: 'x',
  });
  return { uid, token: await signJwt({ tg_id: tgId }, JWT_SECRET, 3600) };
}

// ── services/fx: пары и анализ ──

describe('fxPairDefs', () => {
  const P = {
    income_currency: 'EUR', living_currency: 'RUB', base_currency: 'USD', fx_alerts_enabled: 1,
  } as never;
  it('пары из профиля: жизнь → база → валюты кредитов; дубли/self — нет', () => {
    const pairs = fxPairDefs(P, ['USD', 'KGS', 'EUR', 'RUB']);
    expect(pairs.map((p) => p.key)).toEqual(['eur_rub', 'eur_usd', 'eur_kgs']);
    expect(pairs[0]!.purpose).toBe('жизнь');
    expect(pairs[0]!.alerts).toBe(true); // жизнь — алерты
    expect(pairs[1]!.alerts).toBe(false); // база — без пушей (как v1 eur_usd)
    expect(pairs[2]!.alerts).toBe(true); // кредиты — алерты
  });
  it('без кредитов — только жизнь и база', () => {
    expect(fxPairDefs(P, []).map((p) => p.key)).toEqual(['eur_rub', 'eur_usd']);
  });
});

describe('buildAnalysis + histOf', () => {
  const P = {
    income_currency: 'EUR', living_currency: 'RUB', base_currency: 'USD',
  } as never;
  it('история по прямому запросу; пара без ≥30 точек → skipped', async () => {
    const pairs = fxPairDefs(P, []);
    const a = await buildAnalysis(histOf(fx), pairs, new Date('2026-04-20T00:00:00Z'), '2026-04-20 12:00');
    expect(a.ok).toBe(true);
    expect(a.actions.map((x) => x.key)).toEqual(['eur_rub', 'eur_usd']);
    expect(a.actions[0]!.current).toBe(80 + 39 * 0.4);
    expect(a.actions[0]!.percentile).toBe(100); // монотонный рост — последний максимум
    const a2 = await buildAnalysis(
      async () => ({ RUB: series(10, 1, 0.1) }), // <30 точек
      pairs,
      new Date('2026-04-20T00:00:00Z'),
    );
    expect(a2.ok).toBe(false);
    expect(a2.skipped).toContain('EUR → RUB');
    expect(a2.note).toBe('Нет данных по валютным парам — история курсов недоступна.');
  });
  it('кросс через USD: прямой пустой/короткий → from→USD × USD→to', async () => {
    // провайдер без EUR>KGS, но с EUR>USD и USD>KGS
    const crossFx: FxProvider = {
      latest: fx.latest!,
      history: async (base, quotes) => {
        const out: FxHistory = {};
        if (base === 'EUR' && quotes.includes('USD')) out['USD'] = series(40, 1.1, 0.001);
        if (base === 'USD' && quotes.includes('KGS')) out['KGS'] = series(40, 80, 0.2);
        return out;
      },
    };
    const pairs = [
      { key: 'eur_kgs', from: 'EUR', to: 'KGS', label: 'EUR → KGS', purpose: 'жизнь', emoji: '🛒', alerts: true },
    ];
    const a = await buildAnalysis(histOf(crossFx), pairs, new Date('2026-04-20T00:00:00Z'));
    expect(a.ok).toBe(true);
    // последний кросс = 1.139 × 87.8 = 100.0058…
    expect(a.actions[0]!.current).toBeCloseTo((1.1 + 39 * 0.001) * (80 + 39 * 0.2), 6);
  });
  it('провайдер без history → FxUnavailable на каждой паре → skipped', async () => {
    const noHist: FxProvider = { latest: async () => ({ perUsd: { USD: 1 }, asOf: 'x' }) };
    await expect(histOf(noHist)('EUR', ['RUB'], 'a', 'b')).rejects.toThrow(/истори/);
    const a = await buildAnalysis(histOf(noHist), fxPairDefs(P, []), new Date());
    expect(a.ok).toBe(false);
  });
});

describe('renderFxText', () => {
  it('текст как в v1: заголовок, стрелка/перцентиль/RSI, сигнал, прогноз, дисклеймер', async () => {
    const pairs = fxPairDefs(
      { income_currency: 'EUR', living_currency: 'RUB', base_currency: 'USD' } as never,
      [],
    );
    const a = await buildAnalysis(histOf(fx), pairs, new Date('2026-04-20T00:00:00Z'), '2026-04-20 12:00');
    const t = renderFxText(a);
    expect(t).toContain('💱 <b>Валютный анализ</b> · 2026-04-20 12:00');
    expect(t).toContain('EUR → RUB');
    expect(t).toContain('▲ +');
    expect(t).toContain('100-й перцентиль');
    expect(t).toContain('RSI 100');
    expect(t).toContain('конвертируйте сейчас');
    expect(t).toContain('Прогноз 30д:');
    expect(t).toContain('⚠️ Статистическая модель');
    expect(t).toContain('тайминг вторичен');
  });
  it('!ok → однострочная заметка', () => {
    expect(renderFxText({ ok: false, note: 'Нет данных', generated_at: '', actions: [], skipped: [], disclaimer: '' })).toBe(
      '💱 Нет данных',
    );
  });
});

// ── алерты ──

describe('checkFxAlerts / runFxAlerts', () => {
  const profile = { income_currency: 'EUR', living_currency: 'RUB', base_currency: 'USD', fx_alerts_enabled: 1, timezone: 'UTC' } as never;
  const pairs = fxPairDefs(profile, []);
  const hi = async (pct: number): Promise<FxAnalysis> => ({
    ok: true,
    generated_at: 'x',
    disclaimer: '',
    skipped: [],
    actions: [
      {
        key: 'eur_rub', label: 'EUR → RUB', purpose: 'жизнь', emoji: '🛒',
        current: 96.4, digits: 2, min: 80, max: 96.4, percentile: pct, rsi14: 62,
        change30d_pct: 5, vol30d_pct: 3, trend_up: true,
        signal: 'convert', signal_text: 'Курс высокий — конвертируйте сейчас',
        forecast7d: { low: 1, mid: 1, high: 1 }, forecast30d: { low: 1, mid: 1, high: 1 }, series: [],
      },
    ],
  });

  it('percentile ≥85 → hi-пуш с кнопкой; кулдаун — ISO-неделя (повтор тишина)', async () => {
    const { uid } = await onboarded(620001);
    const repo = scoped(env.DB, uid);
    const got: string[] = [];
    const send = async (t: string) => void got.push(t);
    const now = new Date('2026-04-20T12:00:00Z');
    const s1 = await checkFxAlerts(repo, await hi(90), pairs, send, now);
    expect(s1).toEqual(['eur_rub:hi']);
    expect(got[0]).toContain('Выгодное окно конвертации');
    expect(got[0]).toContain('90-й перцентиль');
    expect(got[0]).toContain('/fx');
    // повтор в ту же неделю — claim съеден, тишина
    const s2 = await checkFxAlerts(repo, await hi(90), pairs, send, now);
    expect(s2).toEqual([]);
    expect(got).toHaveLength(1);
  });

  it('percentile ≤15 → lo-пуш; 16..84 — тишина; «базовая» пара (alerts:false) не пушит', async () => {
    const { uid } = await onboarded(620002);
    const repo = scoped(env.DB, uid);
    const got: string[] = [];
    const send = async (t: string) => void got.push(t);
    const now = new Date('2026-04-20T12:00:00Z');
    expect(await checkFxAlerts(repo, await hi(50), pairs, send, now)).toEqual([]);
    const s = await checkFxAlerts(repo, await hi(10), pairs, send, now);
    expect(s).toEqual(['eur_rub:lo']);
    expect(got[0]).toContain('нижней зоне');
    // eur_usd — alerts:false
    const usdAction = await hi(95);
    usdAction.actions[0]!.key = 'eur_usd';
    expect(await checkFxAlerts(repo, usdAction, pairs, send, now)).toEqual([]);
  });

  it('сбой отправки → claim снят, следующий прогон шлёт снова', async () => {
    const { uid } = await onboarded(620003);
    const repo = scoped(env.DB, uid);
    const now = new Date('2026-04-20T12:00:00Z');
    let calls = 0;
    const flaky = async () => {
      calls++;
      throw new Error('net down');
    };
    await expect(checkFxAlerts(repo, await hi(90), pairs, flaky, now)).rejects.toThrow('net down');
    const got: string[] = [];
    const s = await checkFxAlerts(repo, await hi(90), pairs, async (t) => void got.push(t), now);
    expect(s).toEqual(['eur_rub:hi']); // claim отпущен — повтор прошёл
    expect(calls).toBe(1);
  });

  it('runFxAlerts: флаг выключен → ничего не считает и не шлёт', async () => {
    const { uid } = await onboarded(620004);
    const repo = scoped(env.DB, uid);
    const p = (await repo.getProfile())!;
    await repo.patchProfile({ fx_alerts_enabled: 0 });
    const p0 = (await repo.getProfile())!;
    expect(p0.fx_alerts_enabled).toBe(0);
    let calls = 0;
    const s = await runFxAlerts(
      repo,
      { ...p, fx_alerts_enabled: 0 },
      { latest: async () => ({ perUsd: {}, asOf: '' }), history: async () => { calls++; return {}; } },
      async () => {},
      new Date(),
    );
    expect(s).toEqual([]);
    expect(calls).toBe(0); // провайдер не дёргали
  });

  it('runFxAlerts: живая история → пуш по живой паре', async () => {
    const { uid } = await onboarded(620005);
    const repo = scoped(env.DB, uid);
    const p = (await repo.getProfile())!; // EUR→RUB из профиля
    const got: string[] = [];
    const s = await runFxAlerts(repo, p, fx, async (t) => void got.push(t), new Date('2026-04-20T12:00:00Z'));
    // EUR→RUB монотонно растёт → перцентиль 100 ≥ 85 → hi
    expect(s).toEqual(['eur_rub:hi']);
    expect(got[0]).toContain('EUR → RUB');
  });

  it('isoWeekKey — стабильный ключ недели для кулдауна', () => {
    expect(isoWeekKey(new Date('2026-04-20T00:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
    expect(isoWeekKey(new Date('2026-04-20T00:00:00Z'))).toBe(isoWeekKey(new Date('2026-04-26T23:00:00Z')));
  });
});

// ── repo: журнал обменов ──

describe('repo exchanges — CRUD, идемпотентность, изоляция', () => {
  it('add/list/get/patch/delete; rate считается repo; source_key идемпотентен', async () => {
    const { uid } = await onboarded(620010);
    const repo = scoped(env.DB, uid);
    const w = await repo.addExchange({
      from_ccy: 'EUR', to_ccy: 'RUB', amount_from_minor: 50000, amount_to_minor: 4820000,
      market_rate: 97.1, spent_on: '2026-04-19', note: 'касса', source: 'manual', source_key: 'tg:1',
    });
    expect(w.meta.changes).toBe(1);
    const id = Number(w.meta.last_row_id);
    const x = (await repo.getExchange(id))!;
    expect(x.rate).toBeCloseTo(96.4, 6);
    expect(x.market_rate).toBe(97.1);
    // повторный insert с тем же source_key — INSERT OR IGNORE → 0 изменений
    const w2 = await repo.addExchange({
      from_ccy: 'EUR', to_ccy: 'RUB', amount_from_minor: 1, amount_to_minor: 1,
      market_rate: null, spent_on: '2026-04-19', note: '', source: 'manual', source_key: 'tg:1',
    });
    expect(w2.meta.changes).toBe(0);
    expect((await repo.findExchangeByKey('tg:1'))!.id).toBe(id);
    // patch сумм — rate обязан пересчитать вызывающий (инвариант на границе)
    await repo.patchExchange(id, { amount_to_minor: 4900000, rate: 4900000 / 50000 });
    expect((await repo.getExchange(id))!.rate).toBe(98);
    await repo.patchExchange(id, { note: 'новая', spent_on: '2026-04-20' });
    expect((await repo.getExchange(id))!.note).toBe('новая');
    expect((await repo.listExchanges()).results[0]!.id).toBe(id);
    await repo.deleteExchange(id);
    expect(await repo.getExchange(id)).toBeNull();
  });

  it('изоляция: user B не видит/не правит/не удаляет записи A', async () => {
    const { uid: a } = await onboarded(620011);
    const { uid: b } = await onboarded(620012);
    const w = await scoped(env.DB, a).addExchange({
      from_ccy: 'EUR', to_ccy: 'RUB', amount_from_minor: 100, amount_to_minor: 9700,
      market_rate: null, spent_on: '2026-04-19', note: 'A-обмен', source: 'manual', source_key: null,
    });
    const id = Number(w.meta.last_row_id);
    const rb = scoped(env.DB, b);
    expect(await rb.getExchange(id)).toBeNull();
    expect((await rb.listExchanges()).results).toHaveLength(0);
    expect((await rb.patchExchange(id, { note: 'угон' })).meta.changes).toBe(0);
    expect((await rb.deleteExchange(id)).meta.changes).toBe(0);
    expect((await scoped(env.DB, a).getExchange(id))!.note).toBe('A-обмен');
    // findByKey тоже scoped
    await scoped(env.DB, a).addExchange({
      from_ccy: 'X', to_ccy: 'Y', amount_from_minor: 1, amount_to_minor: 1,
      market_rate: null, spent_on: '2026-04-19', note: '', source: 'm', source_key: 'same-key',
    });
    expect(await rb.findExchangeByKey('same-key')).toBeNull();
  });
});

// ── бот: /fx и мастер обмена ──

describe('бот /fx', () => {
  it('/fx → FX_HUB с анализом и кнопками; мастер записи обмена end-to-end', async () => {
    const { uid } = await onboarded(620020);
    await msg(620020, '/fx');
    expect(lastMsg().text).toContain('Валютный анализ');
    expect(lastMsg().text).toContain('EUR → RUB');
    expect(lastCbs()).toContain('fxa:list');
    // журнал пуст
    await cb(620020, 'fxa:list');
    expect(lastMsg().text).toContain('Журнал обменов');
    expect(lastMsg().text).toContain('пусто');
    // мастер: валюта кнопкой, валюта текстом, суммы, дата, заметка
    await cb(620020, 'fxa:add');
    expect(lastMsg().text).toContain('Из чего меняем');
    await cb(620020, 'fxa:af:EUR');
    expect(lastMsg().text).toContain('Во что меняем');
    await msg(620020, 'RUB'); // код текстом тоже принимается
    expect(lastMsg().text).toContain('Суммы обмена');
    await msg(620020, 'мусор'); // ошибка парсинга — шаг жив
    expect(lastMsg().text).toContain('Формат');
    await msg(620020, '500 → 48500');
    expect(lastMsg().text).toContain('Дата обмена');
    await cb(620020, 'fxa:ad:today');
    expect(lastMsg().text).toContain('Заметка к обмену');
    await msg(620020, 'обменник на ахунбаева');
    expect(lastMsg().text).toContain('Записано');
    expect(lastMsg().text).toContain('Журнал обменов');
    const rows = (await scoped(env.DB, uid).listExchanges()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_from_minor).toBe(50000);
    expect(rows[0]!.amount_to_minor).toBe(4850000);
    expect(rows[0]!.rate).toBeCloseTo(97, 6);
    // market_rate из getFxRates: RUB 97 / EUR(1/1.09) → 97*1.09? perUsd[RUB]/perUsd[EUR] = 97/(1/1.09)=105.73
    expect(rows[0]!.market_rate).toBeCloseTo(105.73, 2);
    expect(rows[0]!.source_key).toMatch(/^tg:\d+$/);
    // карточка
    await cb(620020, `fxa:v:${rows[0]!.id}`);
    expect(lastMsg().text).toContain('💱 <b>Обмен</b>');
    expect(lastMsg().text).toContain('ахунбаева');
    expect(lastMsg().text).toContain('рынок');
    // правка сумм → rate пересчитан
    await cb(620020, 'fxa:ed:amounts');
    await msg(620020, '400 → 39000');
    expect(lastMsg().text).toContain('Суммы обновлены');
    expect((await scoped(env.DB, uid).getExchange(rows[0]!.id))!.rate).toBeCloseTo(97.5, 6);
    // удаление через confirm
    await cb(620020, `fxa:del:${rows[0]!.id}`);
    expect(lastMsg().text).toContain('Удалить обмен?');
    await cb(620020, 'fxa:dyes');
    expect(lastMsg().text).toContain('Обмен удалён');
    expect((await scoped(env.DB, uid).listExchanges()).results).toHaveLength(0);
  });

  it('/cancel из мастера → FX_LIST с «Отменено»; повторная запись работает', async () => {
    await onboarded(620021);
    await msg(620021, '/fx');
    await cb(620021, 'fxa:list');
    await cb(620021, 'fxa:add');
    expect(lastMsg().text).toContain('Из чего меняем');
    await msg(620021, '/cancel');
    expect(lastMsg().text).toContain('Отменено');
    expect(lastMsg().text).toContain('Журнал обменов');
  });

  it('stale/чужие fxa-колбэки молча игнорируются; чужой id → список', async () => {
    await onboarded(620022);
    const n0 = sent.length;
    await cb(620022, 'fxa:list'); // без диалога — молча
    expect(sent.length).toBe(n0);
    await msg(620022, '/fx');
    // на хабе 'fx' паттерн v: не разрешён (step-aware) — колбэк молча умирает
    const nDead = sent.length;
    await cb(620022, 'fxa:v:999999');
    expect(sent.length).toBe(nDead);
    // на шаге fx:list id допустим, но такого обмена нет → возврат к списку
    await cb(620022, 'fxa:list');
    const n1 = sent.length;
    await cb(620022, 'fxa:v:999999');
    expect(sent.length).toBeGreaterThan(n1);
    expect(lastMsg().text).toContain('Журнал обменов');
    // чужой id тоже возвращает список (не карточку)
    const { uid: b } = await onboarded(620023);
    const w = await scoped(env.DB, b).addExchange({
      from_ccy: 'EUR', to_ccy: 'RUB', amount_from_minor: 100, amount_to_minor: 9000,
      market_rate: null, spent_on: '2026-04-19', note: 'чужой', source: 'm', source_key: null,
    });
    await cb(620022, 'fxa:list');
    await cb(620022, `fxa:v:${Number(w.meta.last_row_id)}`);
    expect(lastMsg().text).toContain('Журнал обменов'); // не карточка чужого обмена
  });

  it('ввод валюты кнопкой недоступной в ccys — текстом принимается; валюты одинаковые → ошибка', async () => {
    await onboarded(620024);
    await msg(620024, '/fx');
    await cb(620024, 'fxa:add');
    await msg(620024, 'KGS'); // не из профиля — принимается текстом
    expect(lastMsg().text).toContain('Во что меняем');
    await msg(620024, 'kgs');
    expect(lastMsg().text).toContain('должны отличаться');
  });
});

// ── TMA: /api/tma/fx + /api/tma/exchanges ──

describe('TMA /api/tma/fx*', () => {
  it('401 без токена на всех роутах', async () => {
    for (const [m, p] of [
      ['GET', '/api/tma/fx'], ['GET', '/api/tma/exchanges'],
      ['POST', '/api/tma/exchanges'], ['PATCH', '/api/tma/exchanges/1'], ['DELETE', '/api/tma/exchanges/1'],
    ] as const) expect((await api(p, { method: m, body: {} })).status, `${m} ${p}`).toBe(401);
  });

  it('GET /fx → анализ (поля карточки) + журнал; POST → запись с rate/market', async () => {
    const { token } = await onboarded(620030);
    const r = await api('/api/tma/exchanges', {
      method: 'POST', token,
      body: { from: 'EUR', to: 'RUB', amount_from: 500, amount_to: 48500, note: 'тест', client_id: 'e1' },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: number };
    const j = (await (await api('/api/tma/fx', { token })).json()) as {
      analysis: { ok: boolean; actions: { key: string; signal: string; percentile: number; series: number[] }[] };
      exchanges: { id: number; amount_from_minor: number; rate: number; market_rate: number | null; note: string }[];
    };
    expect(j.analysis.ok).toBe(true);
    expect(j.analysis.actions[0]!.key).toBe('eur_rub');
    expect(j.exchanges).toHaveLength(1);
    expect(j.exchanges[0]!.id).toBe(id);
    expect(j.exchanges[0]!.amount_from_minor).toBe(50000);
    expect(j.exchanges[0]!.rate).toBeCloseTo(97, 6);
    expect(j.exchanges[0]!.market_rate).toBeCloseTo(105.73, 2);
  });

  it('client_id идемпотентность: повтор → duplicate, одна строка', async () => {
    const { token } = await onboarded(620031);
    const body = { from: 'EUR', to: 'RUB', amount_from: 100, amount_to: 9700, client_id: 'dup1' };
    const r1 = await api('/api/tma/exchanges', { method: 'POST', token, body });
    expect(r1.status).toBe(201);
    const r2 = await api('/api/tma/exchanges', { method: 'POST', token, body });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { duplicate: boolean }).duplicate).toBe(true);
    const j = (await (await api('/api/tma/exchanges', { token })).json()) as { exchanges: unknown[] };
    expect(j.exchanges).toHaveLength(1);
  });

  it('PATCH пересчитывает rate; DELETE убирает; чужой id → 404', async () => {
    const { token } = await onboarded(620032);
    const { token: tokenB } = await onboarded(620033);
    const { id } = (await (
      await api('/api/tma/exchanges', {
        method: 'POST', token, body: { from: 'EUR', to: 'RUB', amount_from: 500, amount_to: 48500 },
      })
    ).json()) as { id: number };
    // чужой — 404 во всех точках
    expect((await api(`/api/tma/exchanges/${id}`, { method: 'PATCH', token: tokenB, body: { note: 'x' } })).status).toBe(404);
    expect((await api(`/api/tma/exchanges/${id}`, { method: 'DELETE', token: tokenB })).status).toBe(404);
    // правка сумм → rate новый
    const p = await api(`/api/tma/exchanges/${id}`, { method: 'PATCH', token, body: { amount_to: 49000 } });
    expect(p.status).toBe(200);
    const j = (await (await api('/api/tma/exchanges', { token })).json()) as { exchanges: { rate: number }[] };
    expect(j.exchanges[0]!.rate).toBe(98);
    // валидация: пустой patch, плохие поля
    expect((await api(`/api/tma/exchanges/${id}`, { method: 'PATCH', token, body: {} })).status).toBe(400);
    expect((await api('/api/tma/exchanges', { method: 'POST', token, body: { from: 'EUR', to: 'EUR', amount_from: 1, amount_to: 1 } })).status).toBe(400);
    expect((await api('/api/tma/exchanges', { method: 'POST', token, body: { from: 'EU', to: 'RUB', amount_from: 1, amount_to: 1 } })).status).toBe(400);
    expect((await api('/api/tma/exchanges', { method: 'POST', token, body: { from: 'EUR', to: 'RUB', amount_from: -1, amount_to: 1 } })).status).toBe(400);
    // delete → 200, повтор → 404
    expect((await api(`/api/tma/exchanges/${id}`, { method: 'DELETE', token })).status).toBe(200);
    expect((await api(`/api/tma/exchanges/${id}`, { method: 'DELETE', token })).status).toBe(404);
  });
});

// ── напоминания: fx-алерты в cron ──

describe('runReminders — fx-скан', () => {
  it('окно 10:00–21:59 + флаг → пуш; флаг выкл/вне окна → тишина', async () => {
    const { runReminders } = await import('../src/services/reminders');
    const { uid } = await onboarded(620040);
    const e = () => ({ ...tenv(), TELEGRAM_BOT_TOKEN: 't' });
    // 12:00 UTC — в окне
    await runReminders(e(), new Date('2026-04-20T12:00:00Z'), { telegram: tg, fx });
    expect(sent.some((m) => m.text.includes('Выгодное окно конвертации'))).toBe(true);
    const n = sent.length;
    // второй прогон в ту же неделю — кулдаун
    await runReminders(e(), new Date('2026-04-20T13:00:00Z'), { telegram: tg, fx });
    expect(sent.length).toBe(n);
    // флаг выкл → тишина
    await scoped(env.DB, uid).patchProfile({ fx_alerts_enabled: 0 });
    await runReminders(e(), new Date('2026-04-27T12:00:00Z'), { telegram: tg, fx });
    expect(sent.length).toBe(n);
    // вне окна (05:00) — тишина даже с включённым флагом
    await scoped(env.DB, uid).patchProfile({ fx_alerts_enabled: 1 });
    await runReminders(e(), new Date('2026-05-04T05:00:00Z'), { telegram: tg, fx });
    expect(sent.filter((m) => m.text.includes('конвертации'))).toHaveLength(1);
  });
});
