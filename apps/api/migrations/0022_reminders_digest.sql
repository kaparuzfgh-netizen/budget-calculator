-- 0022_reminders_digest.sql — дайджест месяца «факт vs план» (T2).
-- Флаг в профиле: итог в последний день месяца (локально). DEFAULT 1 — как у weekly.
ALTER TABLE profiles ADD COLUMN reminders_digest INTEGER NOT NULL DEFAULT 1;
