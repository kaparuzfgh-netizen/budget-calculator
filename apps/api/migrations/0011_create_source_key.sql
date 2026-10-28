-- 0011_create_source_key.sql — идемпотентное создание кредита/займа (P2-3).
-- Mini App POST /api/tma/debts|loans принимает client_id → source_key
-- 'tma:<client_id>'; повторный POST с тем же ключом возвращает старый id.
-- Partial UNIQUE пропускает NULL: записи бота/ручные (без ключа) не конфликтуют.

ALTER TABLE debts ADD COLUMN source_key TEXT;
ALTER TABLE loans ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_debts_user_key
  ON debts(user_id, source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_loans_user_key
  ON loans(user_id, source_key) WHERE source_key IS NOT NULL;
