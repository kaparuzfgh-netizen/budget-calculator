/**
 * vision/types.ts — контракт результата распознавания банковского скриншота
 * (шаг 7, порт v1 VisionParser.gs → v2).
 */

export type VisionProvider = 'gemini' | 'groq';
export type VisionScreenType = 'expense_analytics' | 'debt_balance' | 'other';

/** Одна строка истории операций со скриншота (видимые траты, ≤30 в ответе). */
export interface VisionTx {
  /** 'YYYY-MM-DD', если дата строки читается; иначе null. */
  date: string | null;
  /** Сумма строки — float в валюте экрана. */
  amount: number;
  /** Мерчант/описание (≤200). */
  note: string;
  /** Категория, если подписана на экране (≤200, может быть ''). */
  category: string;
}

export interface VisionResult {
  /** Кто разобрал скриншот (gemini — основной, groq — резерв). */
  provider: VisionProvider;
  screen_type: VisionScreenType;
  /** Период аналитики с экрана («неделя», «октябрь»…) — строкой, как в v1. */
  period: string;
  /** Общая сумма расходов за период — float в валюте экрана (0 = не распознано). */
  total_spent: number;
  /** Валюта сумм с экрана — проверена по поддерживаемому набору (bot/parse). */
  currency: string;
  /** ≤5 категорий, каждая ≤ total*1.5 — защита от миспарса. */
  top_categories: { category: string; amount: number }[];
  /** true — аналитика за ВЕСЬ месяц: её нельзя записывать как недельную трату. */
  is_full_month_analytics: boolean;
  /** Банк приложения, если модель его определила. */
  bank: string;
  /**
   * Остаток основного долга с экрана — float в major units валюты экрана
   * (v1: debt_balance_rub). В minor units переводится на границе repo (toMinor).
   */
  debt_balance: number;
  /**
   * Строки истории трат со скриншота — только если на экране есть
   * список операций; бот поле игнорирует (ему хватает сводки),
   * Mini App разворачивает его в редактируемые строки трат.
   */
  transactions?: VisionTx[];
}

/**
 * Безопасная ошибка vision-флоу: provider + короткая причина (HTTP-статус,
 * «пустой ответ»). НИКОГДА не содержит тел ответов, ключей, file_path и
 * содержимого изображения — её можно логировать и показывать пользователю.
 */
export class VisionError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = 'VisionError';
    this.provider = provider;
  }
}
