-- 0021_commitment_changes.sql — история изменений регулярных платежей.
-- Append-only журнал «было → стало»; пишется в patchCommitment (единая точка
-- для бота и Mini App). old_val/new_val — строки, шифруются (enc1:) целиком:
-- имена и суммы приватны. amount — minor units строкой, currency — отдельное поле.
CREATE TABLE IF NOT EXISTS commitment_changes (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  commitment_id INTEGER NOT NULL REFERENCES commitments(id),
  field         TEXT NOT NULL CHECK (field IN ('name','amount','currency','due_day','active','cadence')),
  old_val       TEXT,
  new_val       TEXT,
  changed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commitment_changes ON commitment_changes(user_id, commitment_id, id);
