-- 0006_rate_limit.sql — лимит частоты POST /api/tma/auth (шаг 5, веха E).
-- Ключ — SHA-256(hex) от CF-Connecting-IP (сам IP не храним и не логируем).
-- Окно — 10 минут (window_start в ISO); старые окна удаляются при вставке.

CREATE TABLE IF NOT EXISTS rate_limit (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
