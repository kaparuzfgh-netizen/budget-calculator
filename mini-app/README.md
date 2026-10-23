# 📱 Mini App — хостинг за $0

Один файл `index.html` (Vue 3 + Tailwind + Chart.js через CDN). Перед публикацией:

1. Вставьте URL Web App Apps Script в константу в начале `<script>`:
   ```js
   const API_URL = 'REPLACE_WITH_WEBAPP_URL';
   ```
   (для локальной проверки можно открыть файл с `?api=<URL>` — параметр переопределяет константу)

## Вариант A — GitHub Pages

1. Создайте репозиторий, например `finance-dashboard`.
2. Загрузите `index.html` в корень.
3. Settings → Pages → Source: `main` / root → Save.
4. Через минуту сайт доступен: `https://<username>.github.io/finance-dashboard/`.

## Вариант B — Cloudflare Pages

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Upload assets.
2. Загрузите `index.html` → Deploy → получите `https://<name>.pages.dev`.

## Подключение к боту

@BotFather → `/setmenubutton` → выбрать бота → вставить URL → название кнопки `Дашборд`.
Кнопка появится слева от поля ввода (☰ / иконка меню).

## Что внутри

| Экран | Виджеты |
|-------|---------|
| Обзор | Валютный тикер (EUR/USD, USD/RUB, USD/KGS), Net Worth gauge (чистая доля в активах), плитки Cash/Portfolio/Debt, недельный прогресс и дневной лимит, график Net Worth |
| План | Слайдер дохода (€) + слайдеры доп. досрочки (₽/мес) и DCA ($/мес) → живой водопад и каскад дельты бонуса с арбитражным вердиктом |
| Долги | Карточки Сбербанк/Т-Банк (баланс, ставка, платёж, срок, прогресс), ЧДП-симулятор с переключателем «платёж ↓ / срок ↓» и записью в Debt_Engine |
| Портфель | Пончик по классам активов, бары «текущая vs целевая доля» (58/23/19), таблица позиций с PnL |

Записи (кнопка «Записать ЧДП») работают только внутри Telegram — они подписаны
`initData` (HMAC-SHA256 проверяется на сервере). В браузере — режим чтения.

## CORS-примечание

Mini App шлёт POST с `Content-Type: text/plain` — так Apps Script не требует
preflight; GET-запросы CORS-free. Ничего дополнительно настраивать не нужно.
