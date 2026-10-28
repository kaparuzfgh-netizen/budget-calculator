-- 0012_vision.sql — распознавание скриншотов банка по согласию (шаг 7, ADR-0001).
-- Флаг согласия пользователя: фото уходит во внешний vision-провайдер
-- (Gemini 2.5 Flash, резерв Groq) только при vision_enabled = 1.
-- По умолчанию выключено — включается в Профиль → 🔔 Напоминания.

ALTER TABLE profiles ADD COLUMN vision_enabled INTEGER NOT NULL DEFAULT 0;
