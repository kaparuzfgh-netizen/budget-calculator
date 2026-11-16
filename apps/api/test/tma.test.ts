/**
 * tma.test.ts — Mini App API (шаг 5):
 *  (a) verifyInitData: валидная подпись (фикстура подписывается тем же
 *      алгоритмом, что и прод), подделанный hash, просроченный auth_date,
 *      отсутствует user, чужой токен — всё 401/403;
 *  (b) JWT: roundtrip /api/tma/auth → /api/tma/overview; просроченный,
 *      неверная подпись, другой секрет, нет Bearer — 401;
 *  (c) изоляция: пользователь B не видит данные A (цифры — свои);
 *  (d) SPA smoke: GET / отдаёт index.html через биндинг ASSETS.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations, SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { FxProvider } from '../src/fx/provider';
import { accessRepo, scoped } from '../src/db/repo';
import { monthInTz, todayInTz, weekStartInTz } from '../src/bot/parse';
import { buildOverview } from '../src/tma/overview';
import { signJwt, verifyJwt } from '../src/tma/auth';

const BOT_TOKEN = '123456:test-bot-token';
const JWT_SECRET = 'test-jwt-secret';
const APP_URL = 'https://app.test';

const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, EUR: 0.9, RUB: 90 }, asOf: '2026-10-20' }) };
const app = createRouter({ fx });
const tenv = () =>
  ({
    ...env,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    JWT_SECRET,
    MINI_APP_URL: APP_URL,
    TELEGRAM_WEBHOOK_SECRET: 's3',
  }) as typeof env;

// ── фикстура initData: подписываем ровно алгоритмом Telegram ──
async function hmac(keyData: ArrayBuffer | string, msg: string): Promise<ArrayBuffer> {
  const raw = typeof keyData === 'string' ? new TextEncoder().encode(keyData) : keyData;
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function makeInitData(
  tgId: number,
  opts: {
    token?: string;
    authDateSec?: number;
    user?: object | null;
    tamperHash?: boolean;
    extra?: Record<string, string>;
  } = {},
): Promise<string> {
  const token = opts.token ?? BOT_TOKEN;
  const fields: Record<string, string> = {
    auth_date: String(opts.authDateSec ?? Math.floor(Date.now() / 1000)),
    query_id: 'AAtest',
    ...(opts.extra ?? {}),
  };
  if (opts.user !== null) fields.user = JSON.stringify(opts.user ?? { id: tgId, first_name: 'U' });
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  let hash = hex(await hmac(await hmac('WebAppData', token), dcs));
  if (opts.tamperHash) hash = (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1);
  return new URLSearchParams({ ...fields, hash }).toString();
}

const authPost = (initData: unknown, ip?: string) =>
  app.fetch(
    new Request('https://t/api/tma/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ip ? { 'CF-Connecting-IP': ip } : {}),
      },
      body: JSON.stringify({ initData }),
    }),
    tenv(),
  );

const overviewGet = (token?: string) =>
  app.fetch(
    new Request('https://t/api/tma/overview', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    tenv(),
  );

async function cleanDb() {
  for (const t of [
    'conversation_state',
    'income_entries',
    'weekly_expenses', 'categories',
    'commitment_payments',
    'commitments',
    'profiles',
    'consents',
    'fx_rates',
    'processed_updates',
    'audit_log',
    'invites',
    'household_members',
    'households',
    'users',
    'reminder_log',
    'rate_limit',
  ])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
}

const TZ = 'UTC';
async function addUser(tgId: number, name: string, onboarded = true) {
  await env.DB.prepare('INSERT INTO users (telegram_id, display_name, role) VALUES (?, ?, ?)')
    .bind(tgId, name, 'member')
    .run();
  const uid = Number(
    (await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?').bind(tgId).first<{ id: number }>())!.id,
  );
  await scoped(env.DB, uid).upsertProfile({
    base_currency: 'USD',
    income_currency: 'USD',
    living_currency: 'USD',
    timezone: TZ,
    income_minor: 0,
    living_cap_minor: 1000000,
    weekly_budget_minor: 200000,
    bonus_prepay_share: 0,
    bonus_dca_share: 0,
    onboarded_at: onboarded ? '2026-01-01T00:00:00Z' : null,
  });
  return uid;
}

async function tokenFor(tgId: number): Promise<string> {
  const r = await authPost(await makeInitData(tgId));
  expect(r.status).toBe(200);
  return (await r.json() as { token: string }).token;
}

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(cleanDb);

describe('POST /api/tma/auth — верификация initData', () => {
  it('валидная подпись → 200 {token, user.name}', async () => {
    await addUser(601, 'Alice');
    const r = await authPost(await makeInitData(601, { user: { id: 601, first_name: 'Alice' } }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; token: string; user: { name: string } };
    expect(j.ok).toBe(true);
    expect(j.token.split('.')).toHaveLength(3);
    expect(j.user.name).toBe('Alice');
    expect((await verifyJwt(j.token, JWT_SECRET))?.tg_id).toBe(601);
  });

  it('refresh-on-change: свежий first_name из initData переписывает display_name и отдаётся в ответе', async () => {
    await addUser(640, 'Старое Имя');
    const r = await authPost(await makeInitData(640, { user: { id: 640, first_name: 'Свежее Имя' } }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { user: { name: string } };
    expect(j.user.name).toBe('Свежее Имя'); // initData приоритетнее БД
    const raw = await env.DB
      .prepare('SELECT display_name FROM users WHERE telegram_id = 640')
      .first<{ display_name: string }>();
    expect(raw!.display_name).toMatch(/^enc1:/);
    expect((await accessRepo(env.DB).findUserByTelegramId(640))!.display_name).toBe('Свежее Имя');
  });

  it('подделанный hash / чужой токен → 401', async () => {
    await addUser(602, 'B');
    expect((await authPost(await makeInitData(602, { tamperHash: true }))).status).toBe(401);
    expect((await authPost(await makeInitData(602, { token: '999:other-token' }))).status).toBe(401);
  });

  it('просроченный auth_date (>24ч) и будущее → 401', async () => {
    await addUser(603, 'C');
    const old = Math.floor(Date.now() / 1000) - 25 * 3600;
    expect((await authPost(await makeInitData(603, { authDateSec: old }))).status).toBe(401);
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect((await authPost(await makeInitData(603, { authDateSec: future }))).status).toBe(401);
  });

  it('нет поля user → 401; битое тело → 400', async () => {
    await addUser(604, 'D');
    expect((await authPost(await makeInitData(604, { user: null }))).status).toBe(401);
    expect((await authPost('')).status).toBe(400);
  });

  it('подпись верна, но пользователя нет / не онбоарден → 403', async () => {
    expect((await authPost(await makeInitData(999001))).status).toBe(403);
    await addUser(605, 'E', false);
    expect((await authPost(await makeInitData(605))).status).toBe(403);
  });
});

describe('JWT-гейт /api/tma/overview', () => {
  it('нет/битый Bearer, чужой секрет, просроченный → 401', async () => {
    await addUser(610, 'F');
    expect((await overviewGet()).status).toBe(401);
    expect((await overviewGet('not-a-jwt')).status).toBe(401);
    expect((await overviewGet(await signJwt({ tg_id: 610 }, 'other-secret', 3600))).status).toBe(401);
    expect((await overviewGet(await signJwt({ tg_id: 610 }, JWT_SECRET, -10))).status).toBe(401);
    // валидная подпись, но пользователя нет → 403 (не утёкли чужие данные)
    expect((await overviewGet(await signJwt({ tg_id: 424242 }, JWT_SECRET, 3600))).status).toBe(403);
  });

  it('roundtrip: auth → overview со своими цифрами', async () => {
    const uid = await addUser(611, 'G');
    const repo = scoped(env.DB, uid);
    await repo.addCommitment({ name: 'Аренда', amount_minor: 70000, currency: 'USD', due_day: 1 });
    await repo.addCommitment({ name: 'Связь', amount_minor: 3000, currency: 'USD', due_day: null });
    const month = monthInTz(TZ, new Date());
    await repo.addIncomeEntry({ month, amount_minor: 100000, currency: 'USD', note: 'зарплата', source_key: 'i1' });
    await repo.addIncomeEntry({ month, amount_minor: 90000, currency: 'EUR', note: null, source_key: 'i2' });
    await repo.addExpense({
      spent_on: todayInTz(TZ, new Date()),
      amount_minor: 32000,
      currency: 'USD',
      note: 'кофе',
      source: 'manual',
      source_key: 'e1',
    });
    await repo.addExpense({
      spent_on: '2000-01-15',
      amount_minor: 99900,
      currency: 'USD',
      note: null,
      source: 'manual',
      source_key: 'e2',
    });

    const r = await overviewGet(await tokenFor(611));
    expect(r.status).toBe(200);
    const o = (await r.json()) as {
      income_month_minor: number;
      income_month_currency: string;
      income_month_source: string;
      income_entries_count: number;
      commitments: { name: string; amount_minor: number; due_day: number | null }[];
      weekly_budget_minor: number;
      living_currency: string;
      spent_week_minor: number;
      week_remaining_minor: number;
      spent_month_minor: number;
      month_cap_minor: number;
      base_currency: string;
      fx_as_of: string;
      fx_note?: string;
    };
    // доход: 1000 USD + 900 EUR→USD (perUsd.EUR=0.9 → 1000 USD) = 2000 USD
    expect(o.income_month_minor).toBe(200000);
    expect(o.income_month_currency).toBe('USD');
    expect(o.income_month_source).toBe('actual');
    expect(o.income_entries_count).toBe(2);
    expect(o.commitments).toEqual([
      { name: 'Аренда', amount_minor: 70000, currency: 'USD', due_day: 1 },
      { name: 'Связь', amount_minor: 3000, currency: 'USD', due_day: null },
    ]);
    expect(o.weekly_budget_minor).toBe(200000);
    expect(o.living_currency).toBe('USD');
    expect(o.spent_week_minor).toBe(32000);
    expect(o.week_remaining_minor).toBe(168000);
    expect(o.spent_month_minor).toBe(32000);
    expect(o.month_cap_minor).toBe(1000000);
    expect(o.base_currency).toBe('USD');
    expect(o.fx_note).toBeUndefined();
  });

  it('изоляция: B получает только свои данные (пустые), цифр A нет', async () => {
    const uidA = await addUser(613, 'A');
    await scoped(env.DB, uidA).addCommitment({ name: 'Аренда', amount_minor: 70000, currency: 'USD', due_day: 1 });
    await addUser(612, 'H');
    const rB = await overviewGet(await tokenFor(612));
    expect(rB.status).toBe(200);
    const o = (await rB.json()) as Record<string, unknown>;
    // income_minor=0 → базовый доход вычисляется из обязательств B:
    // только бюджет 10 000 (платёж A «Аренда» 700 в расчёт не попал = изоляция)
    expect(o.income_month_minor).toBe(1000000);
    expect(o.income_month_source).toBe('computed');
    expect(o.spent_week_minor).toBe(0);
    expect(o.spent_month_minor).toBe(0);
    expect(o.commitments).toEqual([]);
    expect(JSON.stringify(o)).not.toContain('Аренда');
    // и валидный JWT A не даёт параметров на чужие данные — эндпоинт их просто не принимает
    const rA = await overviewGet(await tokenFor(613));
    expect(rA.status).toBe(200);
    expect(JSON.stringify(await rA.json())).toContain('Аренда');
  });
});

describe('P2-1: выборка трат ограничена текущими неделей/месяцем', () => {
  it('overview: listExpenses зовётся с since = min(понедельник недели, 1-е месяца)', async () => {
    const uid = await addUser(630, 'BND');
    const repo = scoped(env.DB, uid);
    const spy = vi.spyOn(repo, 'listExpenses');
    const now = new Date();
    const o = await buildOverview(repo, async () => ({ perUsd: { USD: 1 }, asOf: 'x', stale: false }), now);
    expect(o).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
    const since = spy.mock.calls[0]![0]!;
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const mStart = `${monthInTz(TZ, now)}-01`;
    const wStart = weekStartInTz(TZ, now);
    expect(since).toBe(wStart < mStart ? wStart : mStart);
  });

  it('GET /api/tma/week: старая трата не читается (не доезжает до FX) и не раздувает месяц', async () => {
    const uid = await addUser(631, 'W');
    const repo = scoped(env.DB, uid);
    // маркер-валюта ZZZ: будь строка прочитана — ушла бы в провайдер курсов
    await repo.addExpense({
      spent_on: '2000-01-15', amount_minor: 99900, currency: 'ZZZ',
      note: null, source: 'manual', source_key: 'e-old',
    });
    await repo.addExpense({
      spent_on: todayInTz(TZ, new Date()), amount_minor: 500, currency: 'EUR',
      note: null, source: 'manual', source_key: 'e-new',
    });
    const ccys: string[][] = [];
    const spyFx: FxProvider = {
      latest: async (c) => {
        ccys.push(c);
        return { perUsd: { USD: 1, EUR: 0.9, RUB: 90 }, asOf: 'x' };
      },
    };
    const app2 = createRouter({ fx: spyFx });
    const r = await app2.fetch(
      new Request('https://t/api/tma/week', { headers: { Authorization: `Bearer ${await tokenFor(631)}` } }),
      tenv(),
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { month_spent_minor: number; week_spent_minor: number };
    // 5 EUR → USD при perUsd.EUR=0.9: 5/0.9 ≈ 5.56 → 556 minor
    expect(j.month_spent_minor).toBe(556);
    expect(j.week_spent_minor).toBe(556);
    expect(ccys.length).toBeGreaterThan(0); // FX-запрос был (новая трата в EUR)
    expect(ccys.flat()).not.toContain('ZZZ'); // а двухлетнюю трату вообще не прочитали
  });
});

describe('SPA-раздача (Workers Static Assets)', () => {
  it('GET / и неизвестный путь → index.html; /api/* не перехватывается', async () => {
    const r = await SELF.fetch('https://t/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toContain('text/html');
    const html = await r.text();
    expect(html).toContain('<main id="app">');
    // SPA-fallback для не-API путей
    const r2 = await SELF.fetch('https://t/some/spa/route');
    expect(r2.status).toBe(200);
    expect(await r2.text()).toContain('<main id="app">');
    // а API без токена — честный 401, не index.html
    const r3 = await SELF.fetch('https://t/api/tma/overview');
    expect(r3.status).toBe(401);
    expect(r3.headers.get('content-type') ?? '').toContain('json');
  });
});

describe('харденинг (веха E)', () => {
  it('rate-limit /api/tma/auth: 21-я попытка → 429 + Retry-After; разные IP независимы', async () => {
    await addUser(620, 'RL');
    const ip = '203.0.113.7';
    for (let i = 0; i < 20; i++) {
      const r = await authPost(await makeInitData(620), ip);
      expect(r.status, `attempt ${i + 1}`).toBe(200);
    }
    const r21 = await authPost(await makeInitData(620), ip);
    expect(r21.status).toBe(429);
    expect(r21.headers.get('Retry-After')).toBeTruthy();
    // другой IP — независимый счётчик
    const other = await authPost(await makeInitData(620), '198.51.100.9');
    expect(other.status).toBe(200);
  });

  it('окно лимита сбрасывается: старое окно не мешает', async () => {
    await addUser(621, 'RL2');
    const ip = '203.0.113.8';
    // детерминированно: сидим bucket на count=20 в ТЕКУЩЕМ окне (хэш как в роутере)
    const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip)))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const winStart = new Date(Math.floor(Date.now() / 600_000) * 600_000).toISOString();
    await env.DB.prepare('INSERT INTO rate_limit (bucket, count, window_start) VALUES (?, 20, ?)')
      .bind(key, winStart)
      .run();
    expect((await authPost(await makeInitData(621), ip)).status).toBe(429);
    // следующее окно: сдвигаем window_start на 10+ минут назад → ON CONFLICT сбросит count
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    await env.DB.prepare('UPDATE rate_limit SET window_start = ?').bind(old).run();
    const r = await authPost(await makeInitData(621), ip);
    expect(r.status).toBe(200);
  });

  it('успешные и неуспешные попытки считаются одинаково', async () => {
    await addUser(622, 'RL3');
    const ip = '203.0.113.9';
    for (let i = 0; i < 10; i++) await authPost(await makeInitData(622), ip); // 200
    for (let i = 0; i < 10; i++) await authPost(await makeInitData(622, { tamperHash: true }), ip); // 401
    expect((await authPost(await makeInitData(622), ip)).status).toBe(429);
  });

  it('одинаковый 403 для «нет пользователя» и «не онбоарден»', async () => {
    const j1 = (await (await authPost(await makeInitData(999777))).json()) as { error: string };
    await addUser(623, 'NB', false);
    const j2 = (await (await authPost(await makeInitData(623))).json()) as { error: string };
    expect(j1.error).toBe('forbidden');
    expect(j2.error).toBe('forbidden');
    expect(j1).toEqual(j2);
  });

  it('replay initData в пределах 24ч — допустим (принятый риск, задокументирован)', async () => {
    await addUser(624, 'RP');
    const initData = await makeInitData(624);
    expect((await authPost(initData)).status).toBe(200);
    expect((await authPost(initData)).status).toBe(200);
  });

  it('JWT удалённого пользователя → 403 (не 500, не данные)', async () => {
    const uid = await addUser(625, 'DEL');
    const token = await tokenFor(625);
    await scoped(env.DB, uid).deleteAllUserData();
    const r = await overviewGet(token);
    expect(r.status).toBe(403);
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(false);
  });

  it('security-заголовки: nosniff/no-referrer/no-store на /api/*; CSP на HTML', async () => {
    const r401 = await overviewGet();
    expect(r401.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r401.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(r401.headers.get('Cache-Control')).toBe('no-store');
    const spa = await SELF.fetch('https://t/');
    expect(spa.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const csp = spa.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("frame-ancestors https://web.telegram.org");
    expect(csp).toContain("script-src 'self' https://telegram.org");
    expect(spa.headers.get('X-Frame-Options')).toBeNull(); // Mini App во фрейме — нельзя DENY
  });
});

// ── общий бюджет пары (P2) ──

const hhReq = (token: string, method: string, path = '/api/tma/household', body?: unknown) =>
  app.fetch(
    new Request(`https://t${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    tenv(),
  );

describe('/api/tma/household — общий бюджет пары', () => {
  it('без пары → household: null; invite → join вторым; оба видят агрегаты, членство проверяется', async () => {
    const a = await addUser(700, 'Аня');
    await addUser(701, 'Борис');
    await addUser(702, 'Посторонний');
    const ta = await tokenFor(700);
    const tb = await tokenFor(701);
    const tz = await tokenFor(702);

    const empty = (await (await hhReq(ta, 'GET')).json()) as { household: unknown };
    expect(empty.household).toBeNull();

    const inv = (await (
      await hhReq(ta, 'POST', '/api/tma/household/invite')
    ).json()) as { code: string; link: string | null };
    expect(inv.code).toMatch(/^hh_[0-9a-f]{32}$/);
    expect(inv.link).toContain(encodeURIComponent(inv.code));

    // A уже в паре → повторный invite 409; посторонний join чужим кодом — ок
    expect((await hhReq(ta, 'POST', '/api/tma/household/invite')).status).toBe(409);
    const join = await hhReq(tb, 'POST', '/api/tma/household/join', { code: inv.link });
    expect(join.status).toBe(200);

    // оба члена видят сводку; посторонний — null (не 403: признак «нет пары»)
    const sa = (await (await hhReq(ta, 'GET')).json()) as { household: { members: { is_me: boolean; user_id: number }[] } };
    const sb = (await (await hhReq(tb, 'GET')).json()) as { household: { members: unknown[] } };
    expect(sa.household.members).toHaveLength(2);
    expect(sa.household.members.find((m) => m.is_me)!.user_id).toBe(a);
    expect(sb.household.members).toHaveLength(2);
    expect(((await (await hhReq(tz, 'GET')).json()) as { household: unknown }).household).toBeNull();
    expect((await hhReq(tz, 'PATCH', '/api/tma/household', { living_cap: 100, living_currency: 'USD' })).status).toBe(404);
  });

  it('join: битый/просроченный код → 400; уже в паре → 409', async () => {
    await addUser(710, 'A');
    await addUser(711, 'B');
    await addUser(712, 'C');
    const ta = await tokenFor(710);
    const tb = await tokenFor(711);
    const tc = await tokenFor(712);

    expect((await hhReq(tb, 'POST', '/api/tma/household/join', { code: 'бред' })).status).toBe(400);
    const inv = (await (await hhReq(ta, 'POST', '/api/tma/household/invite')).json()) as { code: string };
    expect((await hhReq(tb, 'POST', '/api/tma/household/join', { code: inv.code })).status).toBe(200);
    // C опаздывает: код уже погашен
    expect((await hhReq(tc, 'POST', '/api/tma/household/join', { code: inv.code })).status).toBe(400);
    // B уже в паре — второй join запрещён
    expect((await hhReq(tb, 'POST', '/api/tma/household/join', { code: inv.code })).status).toBe(409);
  });

  it('PATCH лимита — weekly = cap×12/52 (enc1:), leave → household исчезает', async () => {
    await addUser(720, 'A');
    await addUser(721, 'B');
    const ta = await tokenFor(720);
    const tb = await tokenFor(721);
    const inv = (await (await hhReq(ta, 'POST', '/api/tma/household/invite')).json()) as { code: string };
    await hhReq(tb, 'POST', '/api/tma/household/join', { code: inv.code });

    expect((await hhReq(ta, 'PATCH', '/api/tma/household', { living_cap: 1200, living_currency: 'EUR' })).status).toBe(200);
    const s = (await (await hhReq(tb, 'GET')).json()) as {
      household: { living_cap_minor: number; weekly_budget_minor: number; currency: string };
    };
    expect(s.household.currency).toBe('EUR');
    expect(s.household.living_cap_minor).toBe(1200_00);
    expect(s.household.weekly_budget_minor).toBe(Math.round((1200 * 12 * 100) / 52));
    // в БД — шифртекст
    const raw = await env.DB.prepare('SELECT living_cap_minor FROM households').first<{ living_cap_minor: string }>();
    expect(raw!.living_cap_minor).toMatch(/^enc1:/);
    // валидация
    expect((await hhReq(ta, 'PATCH', '/api/tma/household', { living_cap: -5, living_currency: 'USD' })).status).toBe(400);
    expect((await hhReq(ta, 'PATCH', '/api/tma/household', { living_cap: 10 })).status).toBe(400);

    expect((await hhReq(tb, 'POST', '/api/tma/household/leave')).status).toBe(200);
    expect(((await (await hhReq(tb, 'GET')).json()) as { household: unknown }).household).toBeNull();
    // владелец остался — пара жива; его выход — пара удалена
    expect(((await (await hhReq(ta, 'GET')).json()) as { household: unknown }).household).not.toBeNull();
    await hhReq(ta, 'POST', '/api/tma/household/leave');
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM households').first<{ n: number }>()).toEqual({ n: 0 });
  });
});
