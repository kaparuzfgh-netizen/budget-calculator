-- 0008_loans.sql — личные займы между людьми («Долги людям», BACKLOG P1).
-- Не кредиты: direction 'owe' = я должен человеку, 'owed' = человек должен мне.
-- Событийная модель как у debts: сумма займа неизменна, остаток = replay
-- по журналу loan_events (kind 'repay'). closed_at — ручное закрытие
-- (остаток прощён). Деньги — INTEGER minor units.

CREATE TABLE IF NOT EXISTS loans (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  counterparty  TEXT NOT NULL,               -- имя человека свободным текстом
  direction     TEXT NOT NULL CHECK (direction IN ('owe','owed')),
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  due_on        TEXT,                        -- 'YYYY-MM-DD' или NULL — без срока
  note          TEXT,
  closed_at     TEXT,                        -- закрыт вручную (остаток прощён)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);

-- Журнал возвратов — append-only. manual-записи с source_key NULL
-- (UNIQUE в SQLite пропускает NULL), auto — с ключом идемпотентности.
CREATE TABLE IF NOT EXISTS loan_events (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  loan_id      INTEGER NOT NULL REFERENCES loans(id),
  kind         TEXT NOT NULL CHECK (kind IN ('repay')),
  amount_minor INTEGER NOT NULL,
  event_on     TEXT NOT NULL,                -- 'YYYY-MM-DD' локально
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto')),
  source_key   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_loan_events_loan ON loan_events(user_id, loan_id, event_on, id);
