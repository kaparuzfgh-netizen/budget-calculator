/** household.test.ts — общий бюджет пары: create/join/leave, hh_-инвайты
 *  (atomic, одноразовые, без сирот), изоляция, агрегация недели с FX. */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accessRepo, scoped } from '../src/db/repo';
import { encryptBackfill } from '../src/db/repo';
import { householdSummary } from '../src/services/household';
import type { FxResult } from '../src/fx/service';

const d1 = () => env.DB;
const access = () => accessRepo(d1());
const NOW = '2026-10-15T12:00:00.000Z'; // четверг
const FAR = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
// perUsd: RUB 90 за USD, EUR 0.9 за USD (9000 RUB = 100 USD, 9 EUR = 10 USD)
const fx: FxResult = { perUsd: { USD: 1, RUB: 90, EUR: 0.9 }, asOf: '2026-10-15', stale: false };
const getFx = async () => fx;

const uid = async (tg: number, name: string | null = null) => {
  await access().createUser(tg, name, 'member');
  return (await access().findUserByTelegramId(tg))!.id;
};
const mkPair = async (capMinor = 60_000_00, ccy = 'USD') => {
  const a = await uid(1, 'Аня');
  const b = await uid(2, 'Борис');
  const hh = await access().createHousehold(a, capMinor, ccy, Math.round((capMinor * 12) / 52));
  const codeHash = `hash-${hh}`;
  await access().createHouseholdInvite(codeHash, a, hh, FAR);
  return { a, b, hh, codeHash };
};

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(async () => {
  for (const t of [
    'conversation_state', 'income_entries', 'weekly_expenses', 'categories',
    'commitment_payments', 'commitments', 'profiles', 'consents',
    'household_members', 'reminder_log', 'audit_log', 'invites', 'households', 'users',
  ])
    await d1().prepare(`DELETE FROM ${t}`).run();
});

describe('households: создание и членство', () => {
  it('create: owner-мембер, лимиты в БД — enc1:, читаются дешифрованными', async () => {
    const a = await uid(10, 'А');
    const hh = await access().createHousehold(a, 50_000_00, 'USD', 11_538_46);
    const raw = await d1()
      .prepare('SELECT living_cap_minor, weekly_budget_minor FROM households WHERE id = ?')
      .bind(hh)
      .first<{ living_cap_minor: string; weekly_budget_minor: string }>();
    expect(raw!.living_cap_minor).toMatch(/^enc1:/);
    expect(raw!.weekly_budget_minor).toMatch(/^enc1:/);
    const row = await access().householdFor(a);
    expect(row!.living_cap_minor).toBe(50_000_00);
    expect(row!.weekly_budget_minor).toBe(11_538_46);
    const members = await access().householdMembers(hh);
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe('owner');
    expect(members[0]!.display_name).toBe('А');
  });

  it('redeemHouseholdInvite: второй вступает; код одноразовый; место занято → отказ', async () => {
    const { a, b, codeHash } = await mkPair();
    const c = await uid(3, 'C');
    expect((await access().redeemHouseholdInvite(codeHash, b, NOW)).redeemed).toBe(true);
    expect((await access().householdFor(b))!.id).toBe((await access().householdFor(a))!.id);
    // код погашен — третий не может ни по этому коду…
    expect((await access().redeemHouseholdInvite(codeHash, c, NOW)).redeemed).toBe(false);
    // …ни по новому коду — мест уже нет
    const hh = (await access().householdFor(a))!.id;
    await access().createHouseholdInvite('hash-2', a, hh, FAR);
    expect((await access().redeemHouseholdInvite('hash-2', c, NOW)).redeemed).toBe(false);
    expect(await access().householdFor(c)).toBeNull();
  });

  it('истёкший инвайт и повторный join члена — отказ', async () => {
    const { a, b, hh } = await mkPair();
    await access().createHouseholdInvite('hash-old', a, hh, PAST);
    expect((await access().redeemHouseholdInvite('hash-old', b, NOW)).redeemed).toBe(false);
    expect((await access().redeemHouseholdInvite('hash-1', b, NOW)).redeemed).toBe(true);
    // b уже член — второй код не даст вступить в другую пару
    const d = await uid(4);
    const hh2 = await access().createHousehold(d, 1_000_00, 'USD', 23_076);
    await access().createHouseholdInvite('hash-3', d, hh2, FAR);
    expect((await access().redeemHouseholdInvite('hash-3', b, NOW)).redeemed).toBe(false);
    expect((await access().householdFor(b))!.id).toBe(hh);
  });

  it('redeemHouseholdInviteNewUser — atomic: юзер+членство+погашение; при отказе сироты нет', async () => {
    const { a, hh, codeHash } = await mkPair();
    const r = await access().redeemHouseholdInviteNewUser(codeHash, 99, 'Пётр', NOW);
    expect(r.redeemed).toBe(true);
    const u = (await access().findUserByTelegramId(99))!;
    expect(u.id).toBe(r.userId);
    expect(u.display_name).toBe('Пётр'); // enc1: дешифрован по users.id
    expect((await access().householdFor(u.id))!.id).toBe(hh);
    expect((await access().householdMembers(hh)).map((m) => m.user_id).sort()).toEqual([a, u.id].sort());
    // инвайт погашен
    const inv = await d1().prepare('SELECT used_by, used_at FROM invites WHERE code_hash = ?').bind(codeHash).first<{ used_by: number; used_at: string }>();
    expect(inv!.used_by).toBe(u.id);
    // битый код → юзер не остаётся
    const bad = await access().redeemHouseholdInviteNewUser('no-such', 98, 'X', NOW);
    expect(bad.redeemed).toBe(false);
    expect(await access().findUserByTelegramId(98)).toBeFalsy();
  });

  it('leave: член уходит — пара живёт; последний уходит — household сносят, чужие пустые не трогаем', async () => {
    const { a, b, hh, codeHash } = await mkPair();
    expect((await access().redeemHouseholdInvite(codeHash, b, NOW)).redeemed).toBe(true);
    expect(await access().leaveHousehold(b)).toBe(hh);
    expect(await access().householdFor(a)).not.toBeNull(); // владелец остался
    // новый join на освободившееся место — по свежему коду
    const c = await uid(5);
    await access().createHouseholdInvite('hash-4', a, hh, FAR);
    expect((await access().redeemHouseholdInvite('hash-4', c, NOW)).redeemed).toBe(true);
    // уходят оба → household удалён; посторонний юзер без пары → null
    await access().leaveHousehold(a);
    await access().leaveHousehold(c);
    expect(await d1().prepare('SELECT COUNT(*) n FROM households').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await access().leaveHousehold(c)).toBeNull();
  });

  it('изоляция: посторонний юзер не в паре → householdFor null', async () => {
    await mkPair();
    const z = await uid(9);
    expect(await access().householdFor(z)).toBeNull();
  });

  it('legacy plaintext в households читается, backfill зашифровывает (ключ от households.id)', async () => {
    const a = await uid(11);
    const r = await d1()
      .prepare("INSERT INTO households (living_cap_minor, living_currency, weekly_budget_minor, created_by) VALUES (70000, 'USD', 16153, ?)")
      .bind(a)
      .run();
    const hh = Number(r.meta.last_row_id);
    await d1().prepare("INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, 'owner')").bind(hh, a).run();
    expect((await access().householdFor(a))!.living_cap_minor).toBe(70000); // tolerant read
    expect(await encryptBackfill(d1())).toBe(1); // одна строка (две колонки одним UPDATE)
    const raw = await d1().prepare('SELECT living_cap_minor FROM households WHERE id = ?').bind(hh).first<{ living_cap_minor: string }>();
    expect(raw!.living_cap_minor).toMatch(/^enc1:/);
  });
});

describe('householdSummary: агрегаты пары', () => {
  it('неделя: сумма трат двух членов с конвертацией в валюту котла; прошлая неделя не считается', async () => {
    const { a, b, codeHash } = await mkPair(600_00, 'USD'); // weekly = 13846 (600*12/52)
    expect((await access().redeemHouseholdInvite(codeHash, b, NOW)).redeemed).toBe(true);
    // неделя 2026-10-12..15 (UTC): A тратит 50 USD, B — 9000 RUB (=100 USD) и 9 EUR (=10 USD)
    await scoped(d1(), a).addExpense({ spent_on: '2026-10-14', amount_minor: 50_00, currency: 'USD', note: 'x', source: 'manual', source_key: 'k1' });
    await scoped(d1(), b).addExpense({ spent_on: '2026-10-15', amount_minor: 9000_00, currency: 'RUB', note: 'y', source: 'manual', source_key: 'k2' });
    await scoped(d1(), b).addExpense({ spent_on: '2026-10-15', amount_minor: 9_00, currency: 'EUR', note: 'z', source: 'manual', source_key: 'k3' });
    await scoped(d1(), b).addExpense({ spent_on: '2026-10-05', amount_minor: 1_00, currency: 'USD', note: 'old', source: 'manual', source_key: 'k4' });

    const s = (await householdSummary(d1(), a, getFx, new Date(NOW)))!;
    expect(s.currency).toBe('USD');
    expect(s.spent_week_minor).toBe(160_00); // 50 + 100 + 10
    expect(s.week_remaining_minor).toBe(s.weekly_budget_minor - 160_00);
    const me = s.members.find((m) => m.is_me)!;
    const other = s.members.find((m) => !m.is_me)!;
    expect(me.spent_week_minor).toBe(50_00);
    expect(other.spent_week_minor).toBe(110_00);
    expect(other.name).toBe('Борис');
    // наружу — только агрегаты: notes/категорий/списков в ответе нет
    expect(Object.keys(s).sort()).toEqual(
      ['currency', 'fx_as_of', 'living_cap_minor', 'members', 'spent_week_minor', 'week_over', 'week_remaining_minor', 'weekly_budget_minor'].sort(),
    );
    expect(Object.keys(s.members[0]!).sort()).toEqual(['is_me', 'name', 'role', 'spent_week_minor', 'user_id'].sort());
  });

  it('юзер вне пары → null; котёл в EUR — суммы в EUR', async () => {
    const z = await uid(8);
    expect(await householdSummary(d1(), z, getFx)).toBeNull();
    const { a, b, codeHash } = await mkPair(90_000, 'EUR'); // weekly = 20769
    expect((await access().redeemHouseholdInvite(codeHash, b, NOW)).redeemed).toBe(true);
    await scoped(d1(), a).addExpense({ spent_on: '2026-10-15', amount_minor: 90_00, currency: 'USD', note: 'x', source: 'manual', source_key: 'k5' });
    const s = (await householdSummary(d1(), b, getFx, new Date(NOW)))!;
    expect(s.currency).toBe('EUR');
    expect(s.spent_week_minor).toBe(81_00); // 90 USD * 0.9
    expect(s.members.find((m) => m.is_me)!.spent_week_minor).toBe(0);
  });
});
