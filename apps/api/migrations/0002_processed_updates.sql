-- 0002_processed_updates.sql — идемпотентность webhook (S9): Telegram
-- присылает update повторно, пока не получит 2xx, и после редеплоев.
-- update_id монотонно растёт — дубликаты отсекаем по PRIMARY KEY.
--
-- TODO (шаг 4, cron): периодическая чистка старых строк:
--   DELETE FROM processed_updates WHERE created_at < datetime('now', '-7 days');
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id  INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
