-- 0001_init.sql — каркас доступа (шаг 1 миграции, ADR-0001).
-- Пользовательские таблицы с данными (commitments, debts, …) добавятся
-- следующими миграциями; здесь — только контур допуска и аудита.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  telegram_id INTEGER NOT NULL UNIQUE,
  display_name TEXT,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);

-- Одноразовые приглашения: хранится только хэш кода.
CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_by    INTEGER REFERENCES users(id),
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Согласия пользователя (vision-провайдеры, экспорт и т.п.).
CREATE TABLE IF NOT EXISTS consents (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,
  granted    INTEGER NOT NULL DEFAULT 0 CHECK (granted IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind)
);

-- Журнал действий (meta — JSON-текст).
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
