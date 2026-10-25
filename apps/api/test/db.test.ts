import { beforeAll, describe, expect, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { scoped } from '../src/db/repo';

// Локальная D1 (miniflare) + настоящие файлы миграций.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => env.DB;

describe('миграции D1', () => {
  it('0001_init применяется: таблицы users, invites, consents, audit_log существуют', async () => {
    const { results } = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ['users', 'invites', 'consents', 'audit_log']) {
      expect(names).toContain(t);
    }
  });
});

describe('репозиторный слой — изоляция tenant (ADR-0001, S5)', () => {
  it('scoped(db, A) никогда не возвращает согласия пользователя B', async () => {
    await db().batch([
      db().prepare("INSERT INTO users (telegram_id, display_name, role) VALUES (?, ?, 'owner')").bind(1001, 'A'),
      db().prepare("INSERT INTO users (telegram_id, display_name, role) VALUES (?, ?, 'member')").bind(2002, 'B'),
    ]);
    const a = await db().prepare('SELECT id FROM users WHERE telegram_id = 1001').first<{ id: number }>();
    const b = await db().prepare('SELECT id FROM users WHERE telegram_id = 2002').first<{ id: number }>();
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBeTruthy();

    await db().batch([
      db().prepare('INSERT INTO consents (user_id, kind, granted) VALUES (?, ?, ?)').bind(a!.id, 'vision', 1),
      db().prepare('INSERT INTO consents (user_id, kind, granted) VALUES (?, ?, ?)').bind(b!.id, 'vision', 0),
      db().prepare('INSERT INTO consents (user_id, kind, granted) VALUES (?, ?, ?)').bind(b!.id, 'export', 1),
    ]);

    const consentsA = await scoped(db(), a!.id).listConsents();
    expect(consentsA.results).toHaveLength(1);
    expect(consentsA.results[0]).toMatchObject({ kind: 'vision', granted: 1 });

    const consentsB = await scoped(db(), b!.id).listConsents();
    expect(consentsB.results).toHaveLength(2);
    // перекрёстная проверка: ни одна строка B не попала к A
    const kindsA = consentsA.results.map((r) => r.kind);
    expect(kindsA).not.toContain('export');
  });
});
