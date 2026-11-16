/** История изменений платежей: diff, шифрование, tenant-изоляция, чистка. */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessRepo, scoped } from '../src/db/repo';

const uid = async (tg: number) => {
  await accessRepo(env.DB).createUser(tg, null, 'member');
  return (await accessRepo(env.DB).findUserByTelegramId(tg))!.id;
};
const add = async (u: number) => {
  await scoped(env.DB, u).addCommitment({ name: 'Английский', amount_minor: 12_000_00, currency: 'RUB', due_day: 5 });
  return (await scoped(env.DB, u).listCommitments()).results[0]!.id;
};

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const t of ['commitment_changes', 'commitment_payments', 'commitments', 'profiles', 'consents', 'reminder_log', 'audit_log', 'invites', 'users'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe('commitment_changes', () => {
  it('пишет только изменённые поля «было → стало»', async () => {
    const u = await uid(1);
    const id = await add(u);
    const r = scoped(env.DB, u);
    await r.patchCommitment(id, { amount_minor: 15_000_00, name: 'Английский', due_day: 5 });
    const ch = (await r.listCommitmentChanges(id)).results;
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ field: 'amount', old_val: '1200000', new_val: '1500000' });
  });

  it('пустой diff и смена active/cadence', async () => {
    const u = await uid(1);
    const id = await add(u);
    const r = scoped(env.DB, u);
    await r.patchCommitment(id, { amount_minor: 12_000_00 });
    expect((await r.listCommitmentChanges(id)).results).toHaveLength(0);
    await r.patchCommitment(id, { active: 0, frequency: 'yearly', due_month: 3 });
    const f = (await r.listCommitmentChanges(id)).results.map((c) => c.field).sort();
    expect(f).toEqual(['active', 'cadence']);
  });

  it('в D1 — enc1:, без plaintext', async () => {
    const u = await uid(1);
    const id = await add(u);
    await scoped(env.DB, u).patchCommitment(id, { name: 'Немецкий' });
    const raw = await env.DB.prepare('SELECT old_val, new_val FROM commitment_changes').first<{ old_val: string; new_val: string }>();
    expect(raw!.old_val).toMatch(/^enc1:/);
    expect(raw!.new_val).toMatch(/^enc1:/);
    expect((await scoped(env.DB, u).listCommitmentChanges(id)).results[0]!.new_val).toBe('Немецкий');
  });

  it('A не видит историю B; чужой patch ничего не пишет', async () => {
    const a = await uid(1);
    const b = await uid(2);
    const idB = await add(b);
    await scoped(env.DB, b).patchCommitment(idB, { amount_minor: 1 });
    expect((await scoped(env.DB, a).listCommitmentChanges(idB)).results).toHaveLength(0);
    await scoped(env.DB, a).patchCommitment(idB, { amount_minor: 2 });
    expect((await scoped(env.DB, b).listCommitmentChanges(idB)).results).toHaveLength(1);
  });

  it('удаление платежа, экспорт и /delete_me', async () => {
    const u = await uid(1);
    const id = await add(u);
    const r = scoped(env.DB, u);
    await r.patchCommitment(id, { amount_minor: 1 });
    expect((await r.exportUserData()).commitment_changes).toHaveLength(1);
    await r.deleteCommitment(id);
    expect((await r.listCommitmentChanges(id)).results).toHaveLength(0);
    const id2 = await add(u);
    await r.patchCommitment(id2, { amount_minor: 1 });
    await r.deleteAllUserData();
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM commitment_changes').first<{ n: number }>())!.n).toBe(0);
  });
});
