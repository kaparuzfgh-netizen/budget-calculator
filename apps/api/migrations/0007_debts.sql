-- 0007_debts.sql — кредиты и ипотеки пользователей (шаг 6, веха H1).
-- Событийная модель (как v1 DebtEngine): долг хранит НАЧАЛЬНЫЕ параметры,
-- текущее состояние вычисляется replay() по журналу debt_events —
-- пересчёт идемпотентен и самовосстанавливается.
-- Деньги — INTEGER minor units; домен — float на границе repo.

CREATE TABLE IF NOT EXISTS debts (
  id                    INTEGER PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id),
  name                  TEXT NOT NULL,
  currency              TEXT NOT NULL,             -- валюта долга (RUB/EUR/…)
  rate                  REAL NOT NULL CHECK (rate >= 0), -- годовая, доля (0.119)
  frequency             TEXT NOT NULL DEFAULT 'monthly'
    CHECK (frequency IN ('monthly','biweekly')),
  initial_balance_minor INTEGER NOT NULL,          -- остаток на момент заведения
  initial_payment_minor INTEGER NOT NULL,          -- плановый платёж за период
  epoch                 TEXT NOT NULL,             -- 'YYYY-MM-DD' отсчёт (biweekly/старт)
  due_day               INTEGER CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id) WHERE active = 1;

-- Журнал событий — append-only. kind: payment (плановый), prepay (ЧДП
-- «платёж↓»), reconcile (сверка с банком; amount = ФАКТИЧЕСКИЙ остаток).
CREATE TABLE IF NOT EXISTS debt_events (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  debt_id      INTEGER NOT NULL REFERENCES debts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('payment','prepay','reconcile')),
  amount_minor INTEGER NOT NULL,
  event_on     TEXT NOT NULL,                      -- 'YYYY-MM-DD' локально
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto')),
  source_key   TEXT,                               -- 'tg:<update_id>', 'tma:<client_id>', 'auto:<debt>:<period>'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_debt_events_debt ON debt_events(user_id, debt_id, event_on, id);
