/**
 * api.test.ts — unit-тесты fetch-клиента Mini App (A2-4).
 * fetch заменяется моком; проверяем Bearer-заголовок, один reauth на пачку
 * 401, семантику 403 в postRaw и повтор «ровно один раз».
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';

const jsonRes = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** getToken читает переменную — reauth обновляет её (зеркало main.tsx). */
function setup(initial = 't0') {
  let token = initial;
  const reauth = vi.fn(async () => {
    token = 't1';
    return token;
  });
  const api = createApi({ getToken: () => token, reauth });
  return { api, reauth };
}

const authOf = (call: unknown[]) =>
  ((call[1] as RequestInit | undefined)?.headers as Record<string, string>).Authorization;

afterEach(() => vi.unstubAllGlobals());

describe('createApi', () => {
  it('GET шлёт Bearer-токен и отдаёт JSON', async () => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) => jsonRes(200, { ok: true, n: 1 }));
    vi.stubGlobal('fetch', f);
    const { api } = setup('abc');
    const r = await api.get<{ ok: boolean; n: number }>('/api/tma/overview');
    expect(r).toEqual({ ok: true, n: 1 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe('/api/tma/overview');
    expect(authOf(f.mock.calls[0]!)).toBe('Bearer abc');
  });

  it('401 → один reauth → повтор с новым токеном → данные', async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) =>
      (init?.headers as Record<string, string>).Authorization === 'Bearer t0'
        ? jsonRes(401)
        : jsonRes(200, { ok: true }),
    );
    vi.stubGlobal('fetch', f);
    const { api, reauth } = setup();
    const r = await api.get<{ ok: boolean }>('/x');
    expect(r.ok).toBe(true);
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(authOf(f.mock.calls[1]!)).toBe('Bearer t1');
  });

  it('пачка параллельных 401 → ровно один reauth', async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) =>
      (init?.headers as Record<string, string>).Authorization === 'Bearer t0'
        ? jsonRes(401)
        : jsonRes(200, { ok: true }),
    );
    vi.stubGlobal('fetch', f);
    const { api, reauth } = setup();
    const [a, b] = await Promise.all([api.get<{ ok: boolean }>('/x'), api.get<{ ok: boolean }>('/y')]);
    expect(a.ok && b.ok).toBe(true);
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(4); // 2 исходных + 2 повтора
  });

  it('повторный 401 после reauth → forbidden, без третьей попытки', async () => {
    const f = vi.fn(async () => jsonRes(401));
    vi.stubGlobal('fetch', f);
    const { api, reauth } = setup();
    const e: unknown = await api.get('/x').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('forbidden');
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('403 без reauth → forbidden', async () => {
    const f = vi.fn(async () => jsonRes(403, { error: { code: 'forbidden' } }));
    vi.stubGlobal('fetch', f);
    const { api, reauth } = setup();
    const e: unknown = await api.get('/x').catch((x) => x);
    expect((e as ApiError).code).toBe('forbidden');
    expect(reauth).not.toHaveBeenCalled();
  });

  it('ошибка сервера отдаёт code/message тела', async () => {
    const f = vi.fn(async () => jsonRes(400, { error: { code: 'validation', message: 'сумма' } }));
    vi.stubGlobal('fetch', f);
    const { api } = setup();
    const e: unknown = await api.post('/x', { a: 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    expect((e as ApiError).code).toBe('validation');
    expect((e as ApiError).message).toBe('сумма');
  });
});

describe('postRaw (vision/analyze)', () => {
  it('403 с кодом ошибки → ApiError с этим кодом (не «forbidden»)', async () => {
    const f = vi.fn(async () => jsonRes(403, { error: { code: 'disabled', message: 'off' } }));
    vi.stubGlobal('fetch', f);
    const { api, reauth } = setup();
    const e: unknown = await api.postRaw('/api/tma/vision/analyze', new ArrayBuffer(2), 'image/png').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(403);
    expect((e as ApiError).code).toBe('disabled');
    expect(reauth).not.toHaveBeenCalled();
  });

  it('403 без кода → «forbidden» (нет доступа)', async () => {
    const f = vi.fn(async () => jsonRes(403, {}));
    vi.stubGlobal('fetch', f);
    const { api } = setup();
    const e: unknown = await api.postRaw('/v', new ArrayBuffer(2), 'image/png').catch((x) => x);
    expect((e as ApiError).code).toBe('forbidden');
  });

  it('429 лимит → code=limit из тела', async () => {
    const f = vi.fn(async () => jsonRes(429, { error: { code: 'limit', message: 'завтра' } }));
    vi.stubGlobal('fetch', f);
    const { api } = setup();
    const e: unknown = await api.postRaw('/v', new ArrayBuffer(2), 'image/png').catch((x) => x);
    expect((e as ApiError).code).toBe('limit');
  });
});

describe('getBlob (экспорт)', () => {
  it('200 → blob; 401 → reauth → повтор', async () => {
    let n = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      n++;
      const ok = (init?.headers as Record<string, string>).Authorization === 'Bearer t1';
      return ok && n === 2 ? new Response(new Blob(['{}'])) : jsonRes(401);
    });
    vi.stubGlobal('fetch', f);
    const { api, reauth } = setup();
    const blob = await api.getBlob('/api/tma/export');
    expect(blob).toBeInstanceOf(Blob);
    expect(reauth).toHaveBeenCalledTimes(1);
  });

  it('403 → forbidden', async () => {
    const f = vi.fn(async () => jsonRes(403));
    vi.stubGlobal('fetch', f);
    const { api } = setup();
    const e: unknown = await api.getBlob('/api/tma/export').catch((x) => x);
    expect((e as ApiError).code).toBe('forbidden');
  });
});
