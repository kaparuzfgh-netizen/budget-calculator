-- 0015_expense_ccy.sql — валюта повседневных трат по умолчанию.
-- NULL → fallback на living_currency (как раньше). Колонка — код валюты,
-- не чувствительные данные → plaintext (как income/living/base_currency).
ALTER TABLE profiles ADD COLUMN expense_currency TEXT;
