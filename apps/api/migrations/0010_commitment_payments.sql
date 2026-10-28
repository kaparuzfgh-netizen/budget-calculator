-- 0010_commitment_payments.sql — журнал оплат регулярных платежей (commitments).
-- Как loan_events/debt_events: append-only журнал; source 'manual'|'auto'
-- (auto — автопроводка кроном в день due_day). Оплаты НЕ идут в
-- weekly_expenses — иначе двойной счёт против лимита жизни.
-- Деньги — INTEGER minor units.
CREATE TABLE IF NOT EXISTS commitment_payments (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  commitment_id INTEGER NOT NULL REFERENCES commitments(id),
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  paid_on       TEXT NOT NULL,              -- 'YYYY-MM-DD' локально
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto')),
  source_key    TEXT,                       -- 'auto:c:<id>:<YYYY-MM>' / 'tma:<client_id>' / 'tg:<update_id>'
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_commitment_payments ON commitment_payments(user_id, commitment_id, paid_on, id);
