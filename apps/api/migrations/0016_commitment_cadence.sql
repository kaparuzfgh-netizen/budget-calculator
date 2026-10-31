-- 0016_commitment_cadence.sql — периодичность регулярных платежей (вариант A).
-- commitments получают каденс:
--   monthly       — как раньше: due_day 1–31 (кламп к концу месяца), NULL — без даты;
--   interval_days — каждые interval_days дней от якорной даты anchor_on;
--   yearly        — раз в год: due_day 1–31 + due_month 1–12 (кламп, 29.02 → 28).
-- Колонки планирования — НЕ чувствительные: plaintext, как due_day
-- (в FIELDS crypto.ts не добавляются). Существующие строки — monthly.

ALTER TABLE commitments ADD COLUMN frequency TEXT NOT NULL DEFAULT 'monthly'
  CHECK (frequency IN ('monthly', 'interval_days', 'yearly'));
ALTER TABLE commitments ADD COLUMN interval_days INTEGER
  CHECK (interval_days IS NULL OR (interval_days BETWEEN 1 AND 366));
ALTER TABLE commitments ADD COLUMN anchor_on TEXT; -- 'YYYY-MM-DD' дата первого платежа
ALTER TABLE commitments ADD COLUMN due_month INTEGER
  CHECK (due_month IS NULL OR (due_month BETWEEN 1 AND 12));
