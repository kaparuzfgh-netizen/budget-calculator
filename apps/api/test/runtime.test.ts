import { describe, expect, it } from 'vitest';

// Тесты выполняются в workerd (реальный рантайм Workers), а не в Node —
// это ловит класс ошибок вида S1 (URLSearchParams в Apps Script):
// API, которого нет в боевом рантайме, здесь просто упадёт.
describe('runtime', () => {
  it('тесты идут в workerd, а не в Node', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });
});
