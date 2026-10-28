-- 0009_debt_event_mode.sql — режим ЧДП в журнале долгов (веха H2).
-- prepay: 'reduce_payment' (платёж↓, срок сохраняется — стандарт банков)
-- или 'reduce_term' (срок↓, платёж фиксирован). NULL — записи до миграции
-- и старый код трактуются как reduce_payment.

ALTER TABLE debt_events
  ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('reduce_payment', 'reduce_term'));
