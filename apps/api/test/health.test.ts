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

  it('неизвестный путь → 404', async () => {
    const res = await exports.default.fetch('https://test.local/nope');
    expect(res.status).toBe(404);
  });
});
