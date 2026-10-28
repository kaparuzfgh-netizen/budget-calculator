-- 0013_fx.sql — шаг 8: журнал фактических обменов валют + флаг FX-алертов.
-- Деньги — INTEGER в минорных единицах; rate/market_rate — REAL (to за 1 from).

CREATE TABLE IF NOT EXISTS exchanges (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  from_ccy          TEXT NOT NULL,
  to_ccy            TEXT NOT NULL,
  amount_from_minor INTEGER NOT NULL CHECK (amount_from_minor > 0),
  amount_to_minor   INTEGER NOT NULL CHECK (amount_to_minor > 0),
  -- курс сделки: amount_to / amount_from (пересчитывается при записи/правке)
  rate              REAL NOT NULL,
  -- рыночный курс Frankfurter на дату записи (to за 1 from); NULL — не удалось получить
  market_rate       REAL,
  spent_on          TEXT NOT NULL, -- 'YYYY-MM-DD' в таймзоне пользователя
  note              TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT 'manual',
  source_key        TEXT,          -- идемпотентность: 'tma:<client_id>', 'tg:<update_id>'
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exchanges_user_date ON exchanges(user_id, spent_on);
-- Partial UNIQUE пропускает NULL: ручные записи без ключа не конфликтуют (как 0011).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_exchanges_user_key
  ON exchanges(user_id, source_key) WHERE source_key IS NOT NULL;

-- Выключатель валютных алертов в профиле (по умолчанию включён).
ALTER TABLE profiles ADD COLUMN fx_alerts_enabled INTEGER NOT NULL DEFAULT 1;
