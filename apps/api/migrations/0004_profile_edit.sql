-- 0004_profile_edit.sql — редактируемый профиль и факт дохода по месяцам (шаг 4в).
-- income_minor в profiles теперь «типичный доход» (0 = не задан); факт — записи ниже.

CREATE TABLE IF NOT EXISTS income_entries (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  month        TEXT NOT NULL,              -- 'YYYY-MM' в таймзоне пользователя
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency     TEXT NOT NULL,
  note         TEXT,
  source_key   TEXT,                       -- идемпотентность: 'tg:<update_id>'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_income_user_month ON income_entries(user_id, month);

ALTER TABLE commitments ADD COLUMN updated_at TEXT;
