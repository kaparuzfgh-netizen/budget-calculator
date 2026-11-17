-- 0025_holdings_invested.sql — «потрачено всего» по позиции (T10).
-- invested: enc1: str — каноническая десятичная строка (сумма в валюте позиции).
-- Старые строки не бэкфиллятся (значения зашифрованы): пустой invested в JS
-- заменяется на quantity × avg_price (domain/portfolio.investedMinor).
ALTER TABLE holdings ADD COLUMN invested TEXT;
