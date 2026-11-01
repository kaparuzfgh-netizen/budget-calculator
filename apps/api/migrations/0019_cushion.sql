-- 0019_cushion.sql — «подушка безопасности»: ручной остаток в валюте бюджета.
-- NULL → не задана. Чувствительная сумма → шифртекст enc1 (FIELDS.profiles).
ALTER TABLE profiles ADD COLUMN cushion_minor TEXT;
