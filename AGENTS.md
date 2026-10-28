# AGENTS.md — заметки для ИИ-агентов и автоматизации

## Проект

Мультипользовательский Telegram-бот + Mini App личных финансов на
Cloudflare (миграция v1→v2 завершена шагом 9 — legacy-стек удалён,
см. [ADR-0001](docs/adr/0001-platform-and-architecture.md)):

- **`apps/api`** — Cloudflare Worker: TypeScript strict, Hono, D1
  (`wrangler d1 migrations`), cron (напоминания, автопроводки, FX-алерты),
  vision-провайдеры (Gemini → Groq), FX-аналитика (Frankfurter).
- **`apps/web`** — Mini App на Vite + Preact; раздаётся тем же воркером
  через Workers Static Assets.
- Разработка — `docs/v2-development.md`.

## Команды

- `npm ci` — все зависимости (workspaces: apps/*).
- `npm run check` — lint + typecheck + тесты API + сборка web.
  **Обязательно перед коммитом.**
- `npm test` / `npm run test:api` — vitest в рантайме workerd с локальной D1.
- `npm run typecheck` — `tsc --noEmit` по `apps/*`.
- `npm run build:web` — сборка `apps/web` → `dist`.
- `npm run release` — релиз: check → web → миграции D1 → deploy → /health.
- `npm run setup` — мастер подключения бота (токен BotFather один раз,
  дальше всё само; `--dry-run` печатает план).
- `npm run dev -w apps/api` — wrangler dev (локальный воркер + D1).
- `npm run wrangler -- <команда>` — wrangler workspace apps/api.
- `npm run wrangler -- login` — только пользователь (браузер).

## Жёсткие правила

1. **Никогда не коммитить секреты**: `secrets.json`, `.env`, `.dev.vars`,
   `.clasp.json`, `.deploy.json` — всё в `.gitignore`. Секреты воркера —
   `wrangler secret put`, локально — `.dev.vars` (в .gitignore).
2. **Workers ≠ Node**: в коде `apps/api` — только Web API (fetch, Web Crypto,
   `crypto`, `URL`, `URLSearchParams` здесь ЕСТЬ), никаких `process`, `fs`,
   `Buffer`, `node:*`. Тесты идут в workerd — но статически такие ошибки линтер
   не ловит, будь внимателен.
3. **Изоляция tenant (S5):** доступ к БД — только через `scoped(env.DB, userId)`
   в `apps/api/src/db/repo.ts`; каждый запрос обязан содержать
   `WHERE user_id = ?` (или join через таблицу с user_id). Сырые
   `db.prepare(...)` вне repo.ts запрещены; тест «A не видит B» обязателен.
4. **Никаких токенов в URL** — только `Authorization: Bearer <JWT>` после
   проверки `initData`. Секреты — `wrangler secret put`, локально — `.dev.vars`.
5. Миграции — только новые файлы `migrations/NNNN_name.sql` (иммутабельны);
   применение — `wrangler d1 migrations apply DB [--local|--remote]`.
6. Zod-схемы на каждом входе; домен в `src/domain/` — чистые функции без I/O
   («сегодня» — параметром; числа-эталоны — `test/domain/golden.legacy.json`,
   фикстура заморожена, генератор удалён вместе с v1).
7. Деплой/вход в Cloudflare — только владелец (interactive). Агенту
   достаточно `--dry-run` и `wrangler deploy --dry-run`.
   Секреты CI (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
   настраивает владелец — docs/v2-development.md.
8. `node_modules/`, `dist/`, `.wrangler/`, `dist-check/` — не трекаются.
9. **Mini App API:** `/api/tma/*` — Bearer-JWT, только scoped(user.id), суммы
   minor units, идемпотентность `client_id`; правила — как у бота
   (та же валидация).
10. **Вебхук:** никогда не логировать текст сообщений, токены, коды инвайтов
    и их хэши, байты изображений и тела ответов провайдеров (в логах — только
    `update_id` и код ошибки). Незнакомым отправителям — тишина и ноль записей
    в БД. Код приглашения хранится только как SHA-256 hex; в audit_log —
    `expires_at`, не код.
11. **Деньги:** в D1 — INTEGER minor units (копейки); домен — float,
    конвертация `toMinor/fromMinor` на границе repo. Курсы — только через
    `getFxRates` (D1-кэш 6ч + provider). Онбординг — чистый редьюсер
    `bot/onboarding.ts` (эффекты исполняет services/access.ts).
12. **Навигация бота:** источник истины — `docs/ux/navigation.md` +
    `src/bot/nav/screens.json` (zod-реестр). Любое изменение экранов
    сначала вносится в оба; нав-ряды только через `navRow()` (R1–R4),
    колбэки `nv:home`/`nv:back:<id>`/`nv:go:<id>` whitelist-ятся реестром.
    Тест `nav.test.ts` сверяет реестр, mermaid-схему и ряды.
13. **Профиль:** `income_minor` — «типичный доход» (0 = не задан); факт —
    `income_entries` по месяцам (`/income`). Правки профиля — редьюсер
    `bot/profile.ts` (`advancePf`); колбэки `pf:*`/`in:*` step-aware
    (`PF_STEPS`), CAS-запись состояния; ВСЕ мутации по id —
    `WHERE id=? AND user_id=?` (чужие id молча игнорируются).
14. Проверка `X-Telegram-Bot-Api-Secret-Token` — fail-closed (нет секрета в
    env → 503) и константная по времени (`src/http/security.ts`).
15. **Mini App:** SPA — Workers Static Assets в том же воркере
    (`wrangler.toml [assets]` → `../web/dist`, SPA-fallback;
    `run_worker_first = ["/api/*", "/telegram/*", "/health"]`, иначе
    SPA перехватит эти пути). Перед `wrangler deploy` — сборка `apps/web`
    (в `scripts/release.mjs` и CI уже есть). Auth: `POST /api/tma/auth
    {initData}` — HMAC «WebAppData» по токену бота (Web Crypto),
    `auth_date` ≤ 24ч, юзер onboarded → JWT HS256 `{tg_id}` на 12ч
    (`src/tma/auth.ts`); дальше `Authorization: Bearer` на `/api/tma/*`
    (любой не-валидный → 401). Запуск Mini App — menu-button у поля ввода
    (`setChatMenuButton`, `web_app` → `MINI_APP_URL` из `[vars]`): ставится
    в `npm run setup` или `node scripts/telegram-webhook.mjs menu <url>`.
    Inline-кнопки «📱 Приложение» в экранах бота нет.
16. **Vision (шаг 7):** `profiles.vision_enabled` — opt-in (DEFAULT 0);
    без флага фото провайдеру не уходит. Провайдеры: Gemini (`GEMINI_API_KEY`,
    модель `GEMINI_MODEL`, дефолт `gemini-3.5-flash-lite`) → резерв Groq
    (`GROQ_API_KEY`, `GROQ_MODEL`). Лимит 20 скринов/день, фото ≤10 МБ.
17. **FX (шаг 8):** алерты по перцентилю (≥85 hi / ≤15 lo, кулдаун —
    ISO-неделя через `claimReminder('fx', …)`); флаг
    `profiles.fx_alerts_enabled` (DEFAULT 1). Журнал обменов — `exchanges`,
    rate/market_rate в единицах to за 1 from.

19. **Шифрование at rest:** чувствительные текстовые/денежные колонки
    пользовательских таблиц — шифртекст `enc1:` (per-user AES-GCM, src/db/crypto.ts,
    спек `FIELDS`). Работа с ними — только через хелперы crypto.ts внутри repo.ts;
    сырые запросы по ним не писать и в WHERE не использовать. Новая пользовательская
    текстовая/amount-колонка ОБЯЗАТЕЛЬНО добавляется в `FIELDS`.
