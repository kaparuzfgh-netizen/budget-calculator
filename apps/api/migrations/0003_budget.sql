-- 0003_budget.sql — онбординг и бюджет (шаг 4, ADR-0001).
-- Деньги — INTEGER в минорных единицах (копейки/центы); домен — float, конверсия на границе.

CREATE TABLE IF NOT EXISTS profiles (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id),
  base_currency      TEXT NOT NULL DEFAULT 'USD',
  income_currency    TEXT NOT NULL,
  living_currency    TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  income_minor       INTEGER NOT NULL,
  living_cap_minor   INTEGER NOT NULL,
  weekly_budget_minor INTEGER NOT NULL, -- производная: living_cap*12/52
  bonus_prepay_share REAL NOT NULL DEFAULT 0,
  bonus_dca_share    REAL NOT NULL DEFAULT 0,
  onboarded_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commitments (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  due_day      INTEGER CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31)),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commitments_user ON commitments(user_id) WHERE active = 1;

CREATE TABLE IF NOT EXISTS weekly_expenses (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  spent_on     TEXT NOT NULL, -- 'YYYY-MM-DD' в таймзоне пользователя
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  note         TEXT,
  source       TEXT NOT NULL CHECK (source IN ('manual','vision')),
  source_key   TEXT,          -- идемпотентность: 'tg:<update_id>' и т.п. (S9)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON weekly_expenses(user_id, spent_on);

-- Состояние диалога (онбординг и пр. шаги) — JSON, TTL на уровне кода.
CREATE TABLE IF NOT EXISTS conversation_state (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id),
  step       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Глобальный кэш курсов (не user-data → вне scoped; доступ — fxRepo).
CREATE TABLE IF NOT EXISTS fx_rates (
  currency   TEXT PRIMARY KEY,
  per_usd    REAL NOT NULL,
  as_of      TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
