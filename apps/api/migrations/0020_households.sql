-- 0020_households.sql — общий бюджет на двоих (P2: «Общий бюджет»).
-- households — пара юзеров с единым лимитом повседневных трат
-- (enc1:, ключ — households.id, как users.id). Членство — household_members;
-- юзер максимум в одном household. invites получают kind ('access'|…)
-- и household_id — пара создаётся через инвайт-ссылку.

CREATE TABLE IF NOT EXISTS households (
  id                  INTEGER PRIMARY KEY,
  living_cap_minor    INTEGER NOT NULL,
  living_currency     TEXT NOT NULL,
  weekly_budget_minor INTEGER NOT NULL, -- производная: living_cap*12/52
  created_by          INTEGER NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS household_members (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, user_id)
);
-- пользователь — максимум в одном household
CREATE UNIQUE INDEX IF NOT EXISTS idx_hm_user ON household_members(user_id);

ALTER TABLE invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'access';
ALTER TABLE invites ADD COLUMN household_id INTEGER REFERENCES households(id);
