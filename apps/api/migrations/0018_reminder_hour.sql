-- 0018_reminder_hour.sql — настраиваемый час напоминаний (Mini App → Профиль).
-- reminder_hour:
--   NULL — легаси-расписание: платежи и сроки с 10:00 local, итог недели
--          в воскресенье с 20:00 local (поведение как было);
--   0–23 — свой час НАЧАЛА окна для ОБОИХ видов (и для fx-алертов, которые
--          делят окно с платежами). Срабатывание — первый часовой тик крона
--          внутри окна; дальше claim'ы reminder_log дедупят, как раньше.
-- Поле — открытый планировочный параметр, НЕ добавляется в FIELDS
-- шифрования (как reminders_weekly/reminders_payments).
ALTER TABLE profiles ADD COLUMN reminder_hour INTEGER
  CHECK (reminder_hour IS NULL OR (reminder_hour BETWEEN 0 AND 23));
