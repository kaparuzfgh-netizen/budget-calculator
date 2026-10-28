/**
 * vision.ts — тексты и разметка vision-флоу (шаг 7, порт v1 Code.gs
 * handlePhoto_/handleDebtBalancePhoto_). Чистые функции, без I/O.
 */
import { escapeHtml, type InlineButton } from '../telegram/client';
import { fmtMoney } from './format';
import { round2 } from '../domain/money';
import type { VisionResult, VisionProvider } from '../vision/types';

const PROVIDER_NAME: Record<VisionProvider, string> = { gemini: 'Gemini', groq: 'Groq (резерв)' };

const btn = (text: string, cb: string): InlineButton => ({ text, callback_data: cb });

/** Заголовок «🤖 … разобрал скриншот» — как в v1 handlePhoto_. */
export function visionHeadText(r: VisionResult): string {
  return (
    `🤖 <b>${PROVIDER_NAME[r.provider]} разобрал скриншот</b>\n` +
    `Период: ${escapeHtml(r.period || '—')} · Валюта: ${r.currency}\n` +
    `Сумма: <b>${fmtMoney(round2(r.total_spent), r.currency)}</b>` +
    (r.top_categories.length
      ? `\nКатегории: ${r.top_categories
          .map((c) => `${escapeHtml(c.category)} ${fmtMoney(round2(c.amount), r.currency)}`)
          .join(' · ')}`
      : '')
  );
}

/** Полномесячная аналитика — не пишем как недельную трату (как в v1). */
export const VISION_MONTH_NOTE =
  '\n\nℹ️ Это аналитика за <b>весь месяц</b> — не записываю её как недельную. Свежий месячный расход покажет /week.';

/** Подсказка «не распознано» — как в v1 (other или total=0). */
export function visionHintText(provider: VisionProvider): string {
  return (
    `🤖 Не нашёл на скриншоте ни аналитики расходов, ни остатка долга (провайдер: ${PROVIDER_NAME[provider]}).\n` +
    'Пришлите экран «Аналитика/Расходы за период» из банковского приложения или экран кредита с остатком долга.\n' +
    'Или введите сумму: /spent 3200'
  );
}

/** Экран кредита есть, а остатка нет — v1-хинт ручного ввода. */
export const VISION_DEBT_NO_AMOUNT =
  '🏦 Вижу экран кредита, но остаток долга не распознан.\nСверьте вручную: /credits → карточка → 🏦 Сверка.';

/** Сообщение «какой это кредит?» + кнопки активных долгов. */
export function visionDebtPickText(r: VisionResult): string {
  return `🏦 Остаток долга на скриншоте: <b>${fmtMoney(round2(r.debt_balance), r.currency)}</b>\nКакой это кредит?`;
}

/** Кнопки выбора кредита: одна на активный долг + ✖ Отмена → DEBTS. */
export function visionDebtPickRows(debts: { id: number; name: string }[], cancelRow: InlineButton[]): InlineButton[][] {
  return [
    ...debts.slice(0, 20).map((d) => [btn(`🏦 ${d.name}`, `vs:rec:${d.id}`)]),
    cancelRow,
  ];
}

/** Экран подтверждения VIS_RECON: «Сверить «<name>» до <fmt(amount, ccy)>?». */
export function visionReconText(name: string, amountMinor: number, ccy: string): string {
  return `Сверить «${escapeHtml(name)}» до <b>${fmtMoney(amountMinor / 100, ccy)}</b>?`;
}

/** Заметка записи: провайдер + период + топ-3 категории (без file_id — v1 его
 *  клал в note, но для приватности идентификатор файла не храним). */
export function visionNote(r: VisionResult): string {
  const cats = r.top_categories
    .slice(0, 3)
    .map((c) => `${c.category} ${round2(c.amount)}`)
    .join(' · ');
  return `vision/${r.provider} · ${r.period || '—'}${cats ? ` · ${cats}` : ''}`.slice(0, 200);
}

export const VISION_DISABLED =
  '📷 Распознавание скриншотов выключено — включите в ⚙️ Профиль → 🔔 Напоминания.';
export const VISION_NOT_CONFIGURED = 'Распознавание скриншотов не настроено на сервере.';
export const VISION_TOO_BIG = 'Фото слишком большое (>10 МБ) — пришлите скриншот поменьше.';
export const VISION_DAILY_LIMIT_TEXT = 'Лимит: 20 скриншотов в день. Попробуйте завтра или введите сумму: /spent 3200';
export function visionFailText(reason: string | null): string {
  return `😕 ${reason ?? 'Сервис временно недоступен'}\nПопробуйте переснять скриншот (полный экран аналитики) или введите сумму: /spent 3200`;
}
