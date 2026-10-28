import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';

describe('GET /health', () => {
  it('отдаёт 200 и ожидаемую форму JSON', async () => {
    const res = await exports.default.fetch('https://test.local/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      app: 'budget-companion-api',
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      time: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(body.time as string))).toBe(false);
  });

  // Шаг 5: SPA-fallback — не-API GET идёт в assets → index.html (200).
  it('неизвестный не-API путь → SPA index.html; неизвестный /api/* → 404 JSON', async () => {
    const res = await exports.default.fetch('https://test.local/nope');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const api = await exports.default.fetch('https://test.local/api/nope');
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type') ?? '').toContain('json');
  });
});
