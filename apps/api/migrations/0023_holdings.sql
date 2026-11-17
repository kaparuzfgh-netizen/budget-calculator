-- 0023_holdings.sql — ручной инвест-портфель (T3a, шаг 10 этап 1).
-- Чувствительные колонки — enc1: (см. FIELDS в src/db/crypto.ts).
CREATE TABLE IF NOT EXISTS holdings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  kind         TEXT    NOT NULL CHECK (kind IN ('deposit','bond','crypto','stock','other')),
  name         TEXT    NOT NULL,   -- enc1: str
  ticker       TEXT,               -- enc1: str (задел под T3b/T3c)
  currency     TEXT    NOT NULL,   -- валюта цены/суммы, plaintext (как loans.currency)
  quantity     TEXT,               -- enc1: str, каноническая десятичная строка '0.12345678'
  avg_price    TEXT,               -- enc1: str, цена покупки за единицу (десятичная строка)
  price        TEXT,               -- enc1: str, текущая ручная цена за единицу
  price_on     TEXT,               -- 'YYYY-MM-DD' дата ручной цены, plaintext
  amount_minor INTEGER,            -- enc1: num, сумма для deposit/other (minor units)
  rate         REAL,               -- enc1: num, % годовых (deposit/bond)
  opened_on    TEXT,               -- 'YYYY-MM-DD', plaintext
  matures_on   TEXT,               -- 'YYYY-MM-DD', plaintext
  note         TEXT,               -- enc1: str
  source_key   TEXT,               -- 'tma:<client_id>' (идемпотентность создания)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_holdings_user_key
  ON holdings(user_id, source_key) WHERE source_key IS NOT NULL;

-- Цели распределения по видам: enc1: str, JSON {"deposit":40,"crypto":25,...}
-- (целые %, сумма 100); NULL — не заданы.
ALTER TABLE profiles ADD COLUMN invest_targets TEXT;
