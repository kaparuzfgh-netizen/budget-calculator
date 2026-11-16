import { CircleCheck, HandCoins, Landmark } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { ApiError } from '../api';
import type { DebtEvent } from '../api';

export const EVENT_KIND: Record<DebtEvent['kind'], { icon: LucideIcon; label: string }> = {
  payment: { icon: CircleCheck, label: 'Платёж' },
  prepay: { icon: HandCoins, label: 'ЧДП' },
  reconcile: { icon: Landmark, label: 'Сверка' },
};
export const MODE_LABEL: Record<string, string> = {
  reduce_payment: 'платёж↓',
  reduce_term: 'срок↓',
};

export const clientId = () => crypto.randomUUID();
export const todayIso = () => new Date().toISOString().slice(0, 10);
export const apiErr = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : fallback;

/** Кнопка-режим операции в карточке кредита/займа (grid .menu). */
export const actionTileCls =
  'flex items-center justify-center gap-1.5 rounded-xl border border-line bg-zinc-900/80 py-3 text-[14px] font-medium text-zinc-100 transition hover:bg-zinc-800/80';
export const actionTileOnCls =
  'flex items-center justify-center gap-1.5 rounded-xl border border-sky-500/60 bg-sky-500/15 py-3 text-[14px] font-medium text-sky-300';

// ── список ──
