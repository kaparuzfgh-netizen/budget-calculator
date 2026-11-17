-- 0024_price_quotes.sql — автоцены портфеля (T3b).
-- Общий кэш котировок: НЕ пользовательские данные, без user_id (как fx_rates).
CREATE TABLE IF NOT EXISTS price_quotes (
  source      TEXT NOT NULL,       -- 'coingecko'
  asset_id    TEXT NOT NULL,       -- id монеты у провайдера: 'bitcoin' (только из белого списка)
  vs_currency TEXT NOT NULL,       -- 'USD', 'EUR'… (верхний регистр)
  price       TEXT NOT NULL,       -- каноническая десятичная строка (domain/decimal), не REAL
  as_of       TEXT NOT NULL,       -- ISO-время котировки у провайдера (last_updated_at)
  fetched_at  TEXT NOT NULL,       -- ISO-время нашего запроса (для TTL)
  PRIMARY KEY (source, asset_id, vs_currency)
);
-- Состояние провайдера: пауза после 429/5xx/401, чтобы не жечь лимит.
CREATE TABLE IF NOT EXISTS price_provider_state (
  source        TEXT PRIMARY KEY,
  blocked_until TEXT,              -- ISO; до этого момента внешних запросов нет
  last_status   INTEGER,           -- HTTP-код последнего сбоя (без тел ответа)
  updated_at    TEXT NOT NULL
);
-- Opt-in (правило 16 как образец): по умолчанию ничего наружу не уходит.
ALTER TABLE profiles ADD COLUMN auto_prices_enabled INTEGER NOT NULL DEFAULT 0;
-- Флаг позиции: 1 — брать автоцену, если есть; 0 — всегда ручная.
ALTER TABLE holdings ADD COLUMN auto_price INTEGER NOT NULL DEFAULT 1;
