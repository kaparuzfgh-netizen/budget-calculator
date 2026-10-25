/**
 * webhook.test.ts — POST /telegram/webhook: заголовок, идемпотентность,
 * контур допуска (владелец / инвайты / тишина для чужих). Всё офлайн:
 * фейковый TelegramClient собирает отправленные сообщения, D1 — локальная.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createRouter } from '../src/http/router';
import { timingSafeEqualStr, verifyWebhookSecret } from '../src/http/security';
import type { TelegramClient } from '../src/telegram/client';
import { buildSetWebhookPayload, maskUrl, redact } from '../../../scripts/webhook-utils.mjs';

const SECRET = 'test-webhook-secret';
const OWNER_TG = 555000111;

const sent: { chatId: number; text: string }[] = [];
const fakeTelegram: TelegramClient = {
  async sendMessage(chatId, text) {
    sent.push({ chatId: Number(chatId), text });
  },
  async answerCallbackQuery() {},
};

const app = createRouter({ telegram: fakeTelegram });
const testEnv = (o: Partial<typeof env> = {}) =>
  ({
    ...env,
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    OWNER_TELEGRAM_ID: String(OWNER_TG),
    TELEGRAM_BOT_USERNAME: 'test_bot',
    ...o,
  }) as typeof env;

function post(body: unknown, opts: { secret?: string | null } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = opts.secret ?? SECRET;
  return app.fetch(
    new Request('https://test.local/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(body) }),
    testEnv(),
  );
}

let uid = 700000000;
function msg(updateId: number, tgId: number, text: string, extra: Record<string, unknown> = {}) {
  uid++;
  return {
    update_id: updateId,
    message: {
      message_id: uid,
      text,
      chat: { id: tgId, type: 'private' },
      from: { id: tgId, first_name: `User${tgId % 1000}` },
      ...extra,
    },
  };
}

async function cleanDb() {
  // дочерние таблицы (FK → users) — до users; БД общая на все тест-файлы
  for (const t of [
    'conversation_state',
    'weekly_expenses',
    'commitments',
    'profiles',
    'consents',
    'fx_rates',
    'processed_updates',
    'audit_log',
    'invites',
    'users',
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

async function tableText(table: string): Promise<string> {
  const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
  return JSON.stringify(results);
}

let uSeq = 900000;
async function inviteCode(ownerTg = OWNER_TG): Promise<string> {
  await post(msg(uSeq++, ownerTg, '/invite'));
  const last = sent.at(-1)!.text;
  const m = /start=(\S+)|\/start (\S+)/.exec(last);
  return (m?.[1] ?? m?.[2])!.trim();
}

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  sent.length = 0;
  await cleanDb();
});

describe('проверка заголовка (S4)', () => {
  it('нет/неверный заголовок → 401; секрет не задан → 503', async () => {
    expect((await post(msg(1, 1, '/start'), { secret: 'wrong' })).status).toBe(401);
    expect((await post(msg(2, 1, '/start'), { secret: null })).status).toBe(401);
    const r = await app.fetch(
      new Request('https://test.local/telegram/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify(msg(3, 1, '/start')),
      }),
      testEnv({ TELEGRAM_WEBHOOK_SECRET: '' }),
    );
    expect(r.status).toBe(503);
  });

  it('timing-safe compare: равные → true, разные/разной длины → false', async () => {
    expect(await timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(await timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(await timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(await verifyWebhookSecret(null, SECRET)).toBe('mismatch');
    expect(await verifyWebhookSecret(SECRET, '')).toBe('unset');
    expect(await verifyWebhookSecret(SECRET, SECRET)).toBe('ok');
  });
});

describe('формат апдейтов', () => {
  it('битое тело → 200 и ноль побочек', async () => {
    const r = await app.fetch(
      new Request('https://test.local/telegram/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
        body: 'not json{',
      }),
      testEnv(),
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(await tableText('processed_updates'))).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('групповой чат и не-message апдейт игнорируются молча', async () => {
    const group = msg(10, 42, '/start');
    (group.message.chat as { type: string }).type = 'group';
    expect((await post(group)).status).toBe(200);
    expect((await post({ update_id: 11, edited_message: { text: 'x' } })).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it('дубликат update_id обрабатывается один раз', async () => {
    expect((await post(msg(20, OWNER_TG, 'привет'))).status).toBe(200);
    expect((await post(msg(20, OWNER_TG, 'привет'))).status).toBe(200);
    expect(sent.length).toBe(1); // владелец создан один раз, один ответ
  });
});

describe('доступ', () => {
  it('владелец бутстрапится любым текстом; повторный /start идемпотентен', async () => {
    await post(msg(30, OWNER_TG, 'любой текст'));
    expect(sent.at(-1)!.text).toContain('владелец');
    await post(msg(31, OWNER_TG, '/start'));
    const { results } = await env.DB.prepare('SELECT role FROM users').all<{ role: string }>();
    expect(results).toEqual([{ role: 'owner' }]);
    expect(await tableText('audit_log')).toContain('owner_bootstrap');
  });

  it('незнакомец без кода → ни ответа, ни записей', async () => {
    await post(msg(40, 999000001, 'hello'));
    await post(msg(41, 999000001, '/help'));
    expect(sent).toEqual([]);
    expect(await tableText('users')).toBe('[]');
    expect(await tableText('audit_log')).toBe('[]');
  });

  it('/id при ненастроенном владельце: ответ один раз на telegram_id', async () => {
    const r = await app.fetch(
      new Request('https://test.local/telegram/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify(msg(50, 888001, '/id')),
      }),
      testEnv({ OWNER_TELEGRAM_ID: '' }),
    );
    expect(r.status).toBe(200);
    expect(sent.at(-1)!.text).toContain('888001');
    await app.fetch(
      new Request('https://test.local/telegram/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify(msg(51, 888001, '/id')),
      }),
      testEnv({ OWNER_TELEGRAM_ID: '' }),
    );
    expect(sent.length).toBe(1); // второй раз — тишина
  });

  it('/invite: в БД только хэш — ни кода, ни в других таблицах', async () => {
    await post(msg(60, OWNER_TG, '/start'));
    const code = await inviteCode();
    expect(sent.at(-1)!.text).toContain('https://t.me/test_bot?start=');
    for (const t of ['invites', 'audit_log']) expect(await tableText(t)).not.toContain(code);
    expect(await tableText('invites')).toMatch(/[a-f0-9]{64}/); // sha256-hex
  });

  it('участник входит по коду; повторное/просроченное использование отклонено', async () => {
    await post(msg(70, OWNER_TG, '/start'));
    const code = await inviteCode();
    await post(msg(72, 777001, `/start ${code}`));
    expect(sent.at(-1)!.text).toContain('Приглашение принято');
    expect(await tableText('users')).toContain('"member"');
    // тот же код вторым отправителем → отказ
    await post(msg(73, 777002, `/start ${code}`));
    expect(sent.at(-1)!.text).toContain('недействительно');
    // просроченный код
    const code2 = await inviteCode();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code2)))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await env.DB.prepare("UPDATE invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE code_hash = ?")
      .bind(hash)
      .run();
    await post(msg(75, 777003, `/start ${code2}`));
    expect(sent.at(-1)!.text).toContain('недействительно');
  });

  it('гонка: один код для двух sender → один пользователь, один отказ', async () => {
    await post(msg(80, OWNER_TG, '/start'));
    const code = await inviteCode();
    await Promise.all([post(msg(82, 881001, `/start ${code}`)), post(msg(83, 882002, `/start ${code}`))]);
    const { results } = await env.DB.prepare("SELECT telegram_id FROM users WHERE role='member'").all();
    expect(results.length).toBe(1);
    const texts = sent.slice(-2).map((m) => m.text);
    expect(texts.filter((t) => t.includes('принято'))).toHaveLength(1);
    expect(texts.filter((t) => t.includes('недействительно'))).toHaveLength(1);
  });

  it('member не может /invite; лимит 10 активных приглашений', async () => {
    await post(msg(90, OWNER_TG, '/start'));
    const code = await inviteCode();
    await post(msg(92, 991001, `/start ${code}`));
    await post(msg(93, 991001, '/invite'));
    expect(sent.at(-1)!.text).toContain('только владельцу');
    for (let i = 0; i < 10; i++) await post(msg(100 + i, OWNER_TG, '/invite'));
    await post(msg(111, OWNER_TG, '/invite'));
    expect(sent.at(-1)!.text).toContain('лимит');
  });

  it('мягко удалённый пользователь игнорируется как незнакомец', async () => {
    await post(msg(120, OWNER_TG, '/start'));
    const code = await inviteCode();
    await post(msg(122, 771001, `/start ${code}`));
    await env.DB.prepare("UPDATE users SET deleted_at = '2026-01-01' WHERE telegram_id = 771001").run();
    sent.length = 0;
    await post(msg(123, 771001, '/help'));
    expect(sent).toEqual([]);
  });

  it('имена пользователей экранируются для HTML', async () => {
    const m = msg(130, OWNER_TG, 'привет');
    (m.message.from as { first_name: string }).first_name = '<b>evil</b>&x';
    await post(m);
    const joined = sent.map((s) => s.text).join(' ');
    expect(joined).not.toContain('<b>evil</b>');
    expect(joined).toContain('&lt;b&gt;');
  });

  it('ошибка внутри обработчика → 200, в логах нет секретов/текста', async () => {
    const boom: TelegramClient = {
      async sendMessage() {
        throw new Error(`boom ${SECRET} ${'token-xyz'} приватный-текст`);
      },
      async answerCallbackQuery() {},
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = createRouter({ telegram: boom });
    const r = await bad.fetch(
      new Request('https://test.local/telegram/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify(msg(140, OWNER_TG, 'секретное-сообщение-пользователя')),
      }),
      testEnv(),
    );
    expect(r.status).toBe(200);
    const logs = spy.mock.calls.flat().join(' ');
    for (const leak of [SECRET, 'token-xyz', 'приватный-текст', 'секретное-сообщение', '140']) {
      if (leak === '140') continue; // update_id в логе — разрешён
      expect(logs).not.toContain(leak);
    }
    spy.mockRestore();
  });
});

describe('webhook-utils (скрипт)', () => {
  it('maskUrl отрезает query; redact прячет секреты; payload https-only', () => {
    expect(maskUrl('https://x.workers.dev/tg?token=abc#f')).toBe('https://x.workers.dev/tg');
    expect(redact('err tok=SECRET123 out', ['SECRET123'])).toBe('err tok=*** out');
    const p = buildSetWebhookPayload({ url: 'https://x.dev/wh?a=1', secretToken: 's' });
    expect(p.allowed_updates).toEqual(['message', 'callback_query']);
    expect(p.drop_pending_updates).toBe(true);
    expect(() => buildSetWebhookPayload({ url: 'http://x.dev/wh' })).toThrow('https');
  });
});
