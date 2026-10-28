-- 0005_reminders.sql — напоминания и приватность (шаг 4б).
-- reminder_log: идемпотентность отправки (claim INSERT OR IGNORE, changes=1 → шлём)
-- и рейт-лимит /export (kind='export', key = unix-бакет минуты).

CREATE TABLE IF NOT EXISTS reminder_log (
  user_id  INTEGER NOT NULL,
  kind     TEXT NOT NULL,             -- 'weekly' | 'payment' | 'export'
  key      TEXT NOT NULL,             -- локальная ISO-дата (или бакет для export)
  sent_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, key)
);

-- Флаги напоминаний в профиле (1 = включено по умолчанию).
ALTER TABLE profiles ADD COLUMN reminders_weekly   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE profiles ADD COLUMN reminders_payments INTEGER NOT NULL DEFAULT 1;
