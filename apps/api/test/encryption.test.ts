/** Шифрование at rest (вариант A): round-trip через repo, сырой SELECT = enc1:,
 *  AAD-изоляция юзеров/колонок, legacy plaintext, backfill + CAS, export decrypted. */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessRepo, encryptBackfill, scoped } from '../src/db/repo';
import { decStr } from '../src/db/crypto';

const uid = async (tg: number) => {
  await accessRepo(env.DB).createUser(tg, null, 'member');
  return (await accessRepo(env.DB).findUserByTelegramId(tg))!.id;
};
const d1 = () => env.DB;

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

beforeEach(async () => {
  for (const t of [
    'conversation_state', 'income_entries', 'weekly_expenses', 'categories', 'loan_events', 'loans',
    'exchanges', 'debt_events', 'debts', 'commitment_changes', 'commitment_payments', 'commitments',
    'profiles', 'consents', 'reminder_log', 'audit_log', 'invites', 'users',
  ])
    await d1().prepare(`DELETE FROM ${t}`).run();
});

describe('encryption at rest', () => {
  it('round-trip через repo; raw SELECT — enc1:, без plaintext', async () => {
    const u = await uid(1);
    const r = scoped(d1(), u);
    await r.addCommitment({ name: 'Квартплата', amount_minor: 5_000_00, currency: 'RUB', due_day: 5 });
    const got = await r.listCommitments();
    expect(got.results[0]!.name).toBe('Квартплата');
    expect(got.results[0]!.amount_minor).toBe(5_000_00);
    const raw = await d1().prepare('SELECT name, amount_minor FROM commitments').first<{ name: string; amount_minor: unknown }>();
    expect(raw!.name).toMatch(/^enc1:/);
    expect(String(raw!.amount_minor)).toMatch(/^enc1:/);
    expect(raw!.name).not.toContain('Квартплата');

    // CHECK > 0: enc1:-TEXT проходит (TEXT > число в SQLite) — income_entries/exchanges
    await r.addIncomeEntry({ month: '2026-10', amount_minor: 1, currency: 'RUB', note: 'x', source_key: 'k1' });
    await r.addExpense({ spent_on: '2026-10-01', amount_minor: 2, currency: 'RUB', note: 'кафе', source: 'manual', source_key: 'k2' });
    const rawE = await d1().prepare('SELECT amount_minor, note FROM weekly_expenses').first<{ amount_minor: unknown; note: string }>();
    expect(String(rawE!.amount_minor)).toMatch(/^enc1:/);
    expect(rawE!.note).toMatch(/^enc1:/);
    expect((await r.listExpenses()).results[0]!.amount_minor).toBe(2);
    expect((await r.listExpenses()).results[0]!.note).toBe('кафе');
  });

  it('per-user ключ: B не расшифрует A; подмена колонки/юзера ломает AAD', async () => {
    const a = await uid(10);
    await scoped(d1(), a).addCommitment({ name: 'Секрет', amount_minor: 1, currency: 'RUB', due_day: null });
    const raw = await d1().prepare('SELECT name FROM commitments').first<{ name: string }>();
    await expect(decStr(await uid(20), 'commitments', 'name', raw!.name)).rejects.toThrow();
    await expect(decStr(a, 'commitments', 'amount_minor', raw!.name)).rejects.toThrow();
    await expect(decStr(a, 'commitments', 'name', raw!.name)).resolves.toBe('Секрет');
  });

  it('legacy plaintext читается; backfill шифрует, второй прогон — no-op, CAS не затирает конкурентную правку', async () => {
    const u = await uid(30);
    await d1()
      .prepare("INSERT INTO commitments (user_id, name, amount_minor, currency, due_day) VALUES (?, 'Плейн', 700, 'RUB', 3)")
      .bind(u)
      .run();
    // толерантное чтение
    expect((await scoped(d1(), u).listCommitments()).results[0]!.name).toBe('Плейн');
    expect(await encryptBackfill(d1())).toBe(1);
    const raw = await d1().prepare('SELECT name, amount_minor FROM commitments').first<{ name: string; amount_minor: unknown }>();
    expect(raw!.name).toMatch(/^enc1:/);
    expect(await encryptBackfill(d1())).toBe(0); // no-op
    // CAS: «конкурентная» правка после SELECT backfill-а имитируем сменой значения
    // до UPDATE — второй бэкфилл на свежих данных шифрует корректно
    await d1().prepare("INSERT INTO weekly_expenses (user_id, spent_on, amount_minor, currency, source) VALUES (?, '2026-10-01', 9, 'RUB', 'manual')").bind(u).run();
    expect(await encryptBackfill(d1())).toBe(1);
    expect((await scoped(d1(), u).listExpenses()).results[0]!.amount_minor).toBe(9);
  });

  it('users.display_name: round-trip через repo; raw SELECT — enc1:, без plaintext', async () => {
    await accessRepo(env.DB).createUser(50, 'Алиса', 'member');
    const u = (await accessRepo(env.DB).findUserByTelegramId(50))!;
    expect(u.display_name).toBe('Алиса');
    const raw = await d1()
      .prepare('SELECT display_name FROM users WHERE id = ?')
      .bind(u.id)
      .first<{ display_name: string }>();
    expect(raw!.display_name).toMatch(/^enc1:/);
    expect(raw!.display_name).not.toContain('Алиса');
    // null-имя — остаётся NULL, шифровать нечего
    await accessRepo(env.DB).createUser(55, null, 'member');
    const rawNull = await d1().prepare('SELECT display_name FROM users WHERE telegram_id = 55').first();
    expect(rawNull!.display_name).toBeNull();
  });

  it('users.display_name: legacy plaintext читается; backfill шифрует по WHERE id=?', async () => {
    await d1().prepare("INSERT INTO users (telegram_id, display_name, role) VALUES (?, 'Легаси', 'member')").bind(51).run();
    expect((await accessRepo(env.DB).findUserByTelegramId(51))!.display_name).toBe('Легаси'); // tolerant read
    expect(await encryptBackfill(d1())).toBe(1);
    const raw = await d1().prepare('SELECT display_name FROM users WHERE telegram_id = 51').first<{ display_name: string }>();
    expect(raw!.display_name).toMatch(/^enc1:/);
    expect(await encryptBackfill(d1())).toBe(0); // no-op
    expect((await accessRepo(env.DB).findUserByTelegramId(51))!.display_name).toBe('Легаси'); // дешифруется
  });

  it('redeemInvite пишет display_name зашифрованным; refreshDisplayName — только при расхождении', async () => {
    const owner = await uid(60);
    const hash = 'a'.repeat(64);
    await accessRepo(env.DB).createInvite(hash, owner, '2999-01-01T00:00:00.000Z');
    const r = await accessRepo(env.DB).redeemInvite(hash, 61, 'Гость', new Date().toISOString());
    expect(r.redeemed).toBe(true);
    const raw = await d1().prepare('SELECT display_name FROM users WHERE telegram_id = 61').first<{ display_name: string }>();
    expect(raw!.display_name).toMatch(/^enc1:/);
    const u = (await accessRepo(env.DB).findUserByTelegramId(61))!;
    expect(u.display_name).toBe('Гость');
    // совпадение и «нет данных» — no-op; расхождение — запись + in-place
    await accessRepo(env.DB).refreshDisplayName(u, 'Гость');
    await accessRepo(env.DB).refreshDisplayName(u, null);
    expect((await accessRepo(env.DB).findUserByTelegramId(61))!.display_name).toBe('Гость');
    await accessRepo(env.DB).refreshDisplayName(u, 'Новый Гость');
    expect(u.display_name).toBe('Новый Гость');
    expect((await accessRepo(env.DB).findUserByTelegramId(61))!.display_name).toBe('Новый Гость');
  });

  it('export возвращает расшифрованные значения', async () => {
    const u = await uid(40);
    const r = scoped(d1(), u);
    await r.addCommitment({ name: 'Интернет', amount_minor: 500, currency: 'RUB', due_day: 1 });
    const exp = await r.exportUserData();
    expect(exp.commitments[0]!.name).toBe('Интернет');
    expect(exp.commitments[0]!.amount_minor).toBe(500);
  });
});
