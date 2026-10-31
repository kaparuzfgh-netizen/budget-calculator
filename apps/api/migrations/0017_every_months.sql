-- 0017_every_months.sql — «каждые N месяцев» (подвариант каденса monthly,
-- см. 0016_commitment_cadence.sql).
--
-- every_months:
--   1 — обычный monthly (поведение как было);
--  >1 — сроки каждые N месяцев в due_day (кламп к концу месяца),
--       фаза отсчёта — месяц anchor_on (при >1 anchor_on и due_day
--       обязательны — гарантирует zod/merge-валидация API, не БД).
-- Пример: anchor_on=2025-10-31, every_months=3, due_day=31 →
--   сроки 31.01, 30.04, 31.07, 31.10 (дата «31-е» клампится к 30.04).
-- Поле — открытый планировочный, НЕ добавляется в FIELDS шифрования
-- (как frequency/due_day/anchor_on).
ALTER TABLE commitments ADD COLUMN every_months INTEGER NOT NULL DEFAULT 1
  CHECK (every_months BETWEEN 1 AND 24);
