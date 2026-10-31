/**
 * tma-vision.test.ts — POST /api/tma/vision/analyze + пакетная запись трат.
 *  • auth/гейты: 401 без JWT, 'disabled' без opt-in, 'too_big', 'limit' 20/день
 *    (общий с ботом бакет reminder_log), 'not_configured' без ключей;
 *  • happy path: мок провайдера → result со сводкой + transactions;
 *  • batch POST /api/tma/expenses {items}: N строк, дедуп client_id, изоляция.
 * Провайдеры подменяются через deps.vision.fetchImpl — как у webhook-тестов
 * (vision.test.ts): ключи только в deps, внешний fetch не ходит.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import type { FxProvider } from '../src/fx/provider';
import { scoped } from '../src/db/repo';
import { signJwt } from '../src/tma/auth';
import { todayInTz } from '../src/bot/parse';

const JWT_SECRET = 'tma-vision-secret';
const fx: FxProvider = { latest: async () => ({ perUsd: { USD: 1, RUB: 97, EUR: 0.9 }, asOf: 'x' }) };

const geminiResp = (payload: object, status = 200) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), {
    status,
  });
const visionCalls: string[] = [];
const visionFetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
  visionCalls.push(String(url));
  return geminiResp(EXP);
});
const EXP = {
  screen_type: 'expense_analytics',
  period: 'неделя',
  total_spent: 3200,
  currency: 'RUB',
  transactions: [
    { date: '2026-10-20', amount: 1200, note: 'Продукты', category: 'Еда' },
    { amount: 2000, note: 'Кафе' },
  ],
};

/** Приложение С vision-ключами (deps) — как в проде с GEMINI_/GROQ_ env. */
const app = createRouter({ fx, vision: { geminiKey: 'gk-test', fetchImpl: visionFetch as unknown as typeof fetch } });
/** Приложение БЕЗ ключей — 'not_configured'. */
const appNoKeys = createRouter({ fx });
const tenv = () => ({ ...env, JWT_SECRET, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's' }) as typeof env;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]); // сигнатура png
const shot = (
  path: string,
  opts: { token?: string; body?: Uint8Array; contentType?: string; target?: typeof app } = {},
) =>
  (opts.target ?? app).fetch(
    new Request(`https://t${path}`, {
      method: 'POST',
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        'Content-Type': opts.contentType ?? 'image/png',
      },
      body: opts.body ?? PNG,
    }),
    tenv(),
  );

async function user(tgId: number, visionEnabled = 1) {
  await env.DB.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'member')").bind(tgId).run();
  const uid = Number(
    (await env.DB.prepare('SELECT id FROM users WHERE telegram_id=?').bind(tgId).first<{ id: number }>())!.id,
  );
  const r = scoped(env.DB, uid);
  await r.upsertProfile({
    base_currency: 'USD',
    income_currency: 'USD',
    living_currency: 'RUB',
    timezone: 'UTC',
    income_minor: 100000,
    living_cap_minor: 6000000,
    weekly_budget_minor: 1384615,
    bonus_prepay_share: 0,
    bonus_dca_share: 0,
    onboarded_at: 'x',
  });
  await r.patchProfile({ vision_enabled: visionEnabled });
  return { uid, token: await signJwt({ tg_id: tgId }, JWT_SECRET, 3600) };
}
const errBody = async (res: Response) => (await res.json()) as { error?: { code?: string; message?: string } };

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  visionCalls.length = 0;
  visionFetch.mockReset().mockImplementation(async (url: string | URL | Request) => {
    visionCalls.push(String(url));
    return geminiResp(EXP);
  });
  for (const t of [
    'conversation_state',
    'weekly_expenses',
    'categories',
    'profiles',
    'reminder_log',
    'processed_updates',
    'users',
    'audit_log',
  ])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe('/api/tma/vision/analyze — гейты', () => {
  it('401 без JWT', async () => {
    expect((await shot('/api/tma/vision/analyze')).status).toBe(401);
    expect(visionCalls).toHaveLength(0);
  });
  it('vision_enabled=0 → 403 code disabled, провайдер НЕ вызывается', async () => {
    const { token } = await user(910001, 0);
    const res = await shot('/api/tma/vision/analyze', { token });
    expect(res.status).toBe(403);
    expect((await errBody(res)).error?.code).toBe('disabled');
    expect(visionCalls).toHaveLength(0);
  });
  it('не-картинка и пустое тело → 400', async () => {
    const { token } = await user(910002);
    expect((await shot('/api/tma/vision/analyze', { token, contentType: 'application/json' })).status).toBe(400);
    expect((await shot('/api/tma/vision/analyze', { token, body: new Uint8Array(0) })).status).toBe(400);
    expect(visionCalls).toHaveLength(0);
  });
  it('>10 МБ → 413 code too_big, провайдер НЕ вызывается', async () => {
    const { token } = await user(910003);
    const res = await shot('/api/tma/vision/analyze', { token, body: new Uint8Array(10 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect((await errBody(res)).error?.code).toBe('too_big');
    expect(visionCalls).toHaveLength(0);
  });
  it('лимит: слоты дня заняты (общий с ботом бакет) → 429 code limit', async () => {
    const { uid, token } = await user(910004);
    const today = todayInTz('UTC', new Date());
    const r = scoped(env.DB, uid);
    for (let n = 1; n <= 20; n++) await r.claimReminder('vision', `${today}:${n}`);
    const res = await shot('/api/tma/vision/analyze', { token });
    expect(res.status).toBe(429);
    expect((await errBody(res)).error?.code).toBe('limit');
    expect(visionCalls).toHaveLength(0);
    // 19 занято — один скриншот ещё проходит, следующий уже в лимит
    const { uid: uid2, token: token2 } = await user(910005);
    const r2 = scoped(env.DB, uid2);
    for (let n = 1; n <= 19; n++) await r2.claimReminder('vision', `${today}:${n}`);
    expect((await shot('/api/tma/vision/analyze', { token: token2 })).status).toBe(200);
    const res2 = await shot('/api/tma/vision/analyze', { token: token2 });
    expect((await errBody(res2)).error?.code).toBe('limit');
  });
  it('нет ключей провайдеров → 503 code not_configured', async () => {
    const { token } = await user(910006);
    const res = await shot('/api/tma/vision/analyze', { token, target: appNoKeys });
    expect(res.status).toBe(503);
    expect((await errBody(res)).error?.code).toBe('not_configured');
  });
});

describe('/api/tma/vision/analyze — разбор', () => {
  it('happy path: 200, result со сводкой и transactions; mime снифается по сигнатуре', async () => {
    const { token } = await user(910010);
    const res = await shot('/api/tma/vision/analyze', { token });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      ok: boolean;
      result: {
        provider: string;
        screen_type: string;
        total_spent: number;
        currency: string;
        transactions?: { amount: number; note: string }[];
      };
    };
    expect(j.ok).toBe(true);
    expect(j.result.provider).toBe('gemini');
    expect(j.result.screen_type).toBe('expense_analytics');
    expect(j.result.total_spent).toBe(3200);
    expect(j.result.currency).toBe('RUB');
    expect(j.result.transactions).toHaveLength(2);
    expect(j.result.transactions![0]).toMatchObject({ amount: 1200, note: 'Продукты' });
    // провайдеру ушла png по сигнатуре (declared тоже png)
    expect(visionCalls).toHaveLength(1);
    const sent = JSON.parse((visionFetch.mock.calls[0]![1]?.body as string) ?? '{}');
    expect(sent.contents[0].parts[1].inline_data.mime_type).toBe('image/png');
  });
  it('оба провайдера мертвы → 502 code provider_fail, ключи не утекают', async () => {
    const { token } = await user(910011);
    visionFetch.mockImplementation(async () => new Response('leak', { status: 400 }));
    const res = await shot('/api/tma/vision/analyze', { token });
    expect(res.status).toBe(502);
    const j = await errBody(res);
    expect(j.error?.code).toBe('provider_fail');
    expect(j.error?.message ?? '').not.toContain('gk-test');
    expect(j.error?.message ?? '').not.toContain('leak');
  });
});

describe('POST /api/tma/expenses {items} — пакетная запись', () => {
  it('создаёт N строк, дедуп по client_id, изоляция tenant', async () => {
    const A = await user(910020);
    const B = await user(910021);
    const items = [
      { amount: 100, currency: 'RUB', note: 'Продукты', client_id: 'vis:1' },
      { amount: 250.5, currency: 'RUB', note: 'Кафе', client_id: 'vis:2' },
      { amount: 300, currency: 'RUB', client_id: 'vis:3', spent_on: '2026-10-01' },
    ];
    const post = () =>
      app.fetch(
        new Request('https://t/api/tma/expenses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        }),
        tenv(),
      );
    const r1 = await post();
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()) as { created: number; duplicates: number; ids: number[] };
    expect(j1.created).toBe(3);
    expect(j1.ids).toHaveLength(3);
    // повтор того же пакета → все дубликаты, новых строк нет
    const r2 = await post();
    const j2 = (await r2.json()) as { created: number; duplicates: number };
    expect(j2.created).toBe(0);
    expect(j2.duplicates).toBe(3);
    const rows = (await scoped(env.DB, A.uid).listExpenses('2000-01-01')).results;
    expect(rows).toHaveLength(3);
    expect(rows.find((x) => x.spent_on === '2026-10-01')?.amount_minor).toBe(30000);
    // изоляция: у B пусто; чужие записи через его токен не видны
    expect((await scoped(env.DB, B.uid).listExpenses('2000-01-01')).results).toHaveLength(0);
  });
  it('валидация пачки до первой вставки: битая дата/категория → 400, записей нет', async () => {
    const { uid, token } = await user(910022);
    const bad = (items: unknown) =>
      app.fetch(
        new Request('https://t/api/tma/expenses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        }),
        tenv(),
      );
    // будущая дата во второй строке — вся пачка отклонена, ничего не записано
    expect(
      (
        await bad([
          { amount: 10, client_id: 'v:1' },
          { amount: 20, client_id: 'v:2', spent_on: '2099-01-01' },
        ])
      ).status,
    ).toBe(400);
    // несуществующая категория — тоже 400 и ноль строк
    expect((await bad([{ amount: 10, client_id: 'v:3', category_id: 424242 }])).status).toBe(400);
    // пустой/битый массив и перебор лимита → 400
    expect((await bad([])).status).toBe(400);
    expect((await bad(Array.from({ length: 31 }, (_, i) => ({ amount: 1, client_id: `x:${i}` })))).status).toBe(400);
    expect((await scoped(env.DB, uid).listExpenses('2000-01-01')).results).toHaveLength(0);
  });
});
