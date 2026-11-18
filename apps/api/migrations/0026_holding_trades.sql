-- 0026_holding_trades.sql — журнал покупок/продаж позиций (T3d1).
-- Чувствительные колонки — enc1: (FIELDS в src/db/crypto.ts). Количества и суммы —
-- канонические десятичные строки (domain/decimal.ts, правило 21), в валюте позиции.
CREATE TABLE IF NOT EXISTS holding_trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  holding_id  INTEGER NOT NULL REFERENCES holdings(id),
  side        TEXT    NOT NULL CHECK (side IN ('buy','sell')),
  is_initial  INTEGER NOT NULL DEFAULT 0 CHECK (is_initial IN (0,1)), -- начальная запись старой позиции
  quantity    TEXT    NOT NULL,   -- enc1: str, сколько единиц куплено/продано
  amount      TEXT    NOT NULL,   -- enc1: str, сколько всего ушло/пришло, с комиссией
  traded_on   TEXT    NOT NULL,   -- 'YYYY-MM-DD', plaintext
  note        TEXT,               -- enc1: str
  source_key  TEXT,               -- 'tma:<client_id>' | 'init:<holding_id>' (идемпотентность)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_holding_trades ON holding_trades(user_id, holding_id, traded_on, id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_holding_trades_user_key
  ON holding_trades(user_id, source_key) WHERE source_key IS NOT NULL;

-- Кэш свёртки журнала в позиции (источник истины — holding_trades).
ALTER TABLE holdings ADD COLUMN realized_minor INTEGER;                -- enc1: num, зафиксированный результат (minor units валюты позиции)
ALTER TABLE holdings ADD COLUMN closed_on TEXT;                        -- 'YYYY-MM-DD' дата полной продажи, plaintext; NULL — открыта
ALTER TABLE holdings ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;     -- 1 — закрытая позиция скрыта из списка
ALTER TABLE holdings ADD COLUMN trade_rev INTEGER NOT NULL DEFAULT 0;  -- версия для CAS-записи сделок
