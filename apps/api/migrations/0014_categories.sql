-- 0014_categories.sql — категории расходов и дата получения дохода (фаза 1a).
-- categories.name/emoji — шифртекст enc1: (FIELDS в src/db/crypto.ts).
-- weekly_expenses.category_id — мягкая связь: категорию можно удалить
-- (repo сначала обнуляет ссылки). income_entries.received_on — фактическая
-- дата получения дохода; NULL у старых строк → backfill первым числом месяца.
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  preset_key TEXT,                 -- 'food'|'cafe'|… у пресетов; NULL у своих
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_categories_preset
  ON categories(user_id, preset_key) WHERE preset_key IS NOT NULL;

ALTER TABLE weekly_expenses ADD COLUMN category_id INTEGER REFERENCES categories(id);
ALTER TABLE income_entries ADD COLUMN received_on TEXT; -- 'YYYY-MM-DD' локально
UPDATE income_entries SET received_on = month || '-01' WHERE received_on IS NULL;
