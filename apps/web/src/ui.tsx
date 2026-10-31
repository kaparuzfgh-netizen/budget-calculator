/**
 * ui.tsx — общие кирпичики экранов в дизайн-языке Tailwind/Lucide
 * (эталон — demo/tw.tsx): верхняя навигация, состояния загрузки/ошибки,
 * хук useData, подписанные поля форм, «ⓘ»-подсказка-шторка и общие
 * классы (карточки/кнопки/ряды), чтобы экраны держались единого стиля.
 */
import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import {
  ChevronLeft,
  CircleAlert,
  House,
  Info as InfoIcon,
  LoaderCircle,
  X,
} from 'lucide-preact';
import { isAuthError } from './api';

// ── общие классы (единый словарь стиля экранов) ──

/** Поле ввода/селект. */
export const inputCls =
  'w-full rounded-xl border border-white/10 bg-zinc-950 px-3 py-2.5 text-[15px] text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:ring-2 focus:ring-sky-500/60';
/** Карточка с контентом (padding у самой карточки). */
export const cardCls =
  'rounded-2xl border border-white/10 bg-zinc-900/80 p-4 shadow-lg shadow-black/30';
/** Карточка-список: та же обводка, без отступов — у li свой padding. */
export const listCardCls =
  'rounded-2xl border border-white/10 bg-zinc-900/80 shadow-lg shadow-black/30';
/** Элемент списка в карточке-списке. */
export const liCls = 'px-4 py-3';
/** Заголовок секции (uppercase, с lucide-иконкой). */
export const headCls =
  'flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400';
/** Заголовок экрана. */
export const h1Cls = 'mb-5 flex items-center gap-2 text-xl font-semibold tracking-tight';
/** Строка «лейбл — значение». */
export const rowCls = 'flex items-center justify-between gap-2';
/** Приглушённый текст/сноска. */
export const mutedCls = 'text-[13px] text-zinc-400';
/** Primary-кнопка во всю ширину. */
export const primaryBtnCls =
  'flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 py-3 font-medium text-white transition hover:bg-sky-500 disabled:opacity-50 disabled:hover:bg-sky-600';
/** Вторичная кнопка (обводка, белый текст) — экспорт и т.п. */
export const secondaryBtnCls =
  'flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 py-3 font-medium text-zinc-100 transition hover:bg-white/10 disabled:opacity-50';
/** Ghost-кнопка — только текст/иконка sky. */
export const ghostBtnCls =
  'flex w-full items-center justify-center gap-2 rounded-xl py-2.5 font-medium text-sky-400 transition hover:bg-white/5 disabled:opacity-50';
/** Деструктивная кнопка. */
export const dangerBtnCls =
  'flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 py-3 font-medium text-red-400 transition hover:bg-red-500/20 disabled:opacity-50';
/** Компактная кнопка («+ Добавить», действия в строках). */
export const smBtnCls =
  'inline-flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-[13px] text-sky-400 transition hover:bg-white/10 disabled:opacity-50';
/** Компактная деструктивная. */
export const smDangerBtnCls =
  'inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[13px] text-red-400 transition hover:bg-red-500/20 disabled:opacity-50';
/** Компактная primary — кнопки внутри плашек подтверждения (flex-1: делят ряд). */
export const smPrimaryBtnCls =
  'inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-sky-600 px-2.5 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-50 disabled:hover:bg-sky-600';
/** Компактная danger-заливка — «Да, удалить». */
export const smDangerFillBtnCls =
  'inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-sm font-medium text-red-400 transition hover:bg-red-500/20 disabled:opacity-50';
/** Компактный ghost — «Отмена»/«Нет» рядом с danger. */
export const smGhostBtnCls =
  'inline-flex flex-1 items-center justify-center gap-1 rounded-lg px-2.5 py-2 text-sm font-medium text-sky-400 transition hover:bg-white/5 disabled:opacity-50';
/** Плашка подтверждения деструктивного действия. */
export const confirmCls = 'mt-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3';
/** Плашка подтверждения обычного действия (оплата и т.п.). */
export const confirmNeutralCls = 'mt-2 rounded-xl border border-white/10 bg-white/5 p-3';
/** Раскрытая инлайн-правка события журнала. */
export const evEditCls = 'mt-2 rounded-xl border border-white/10 bg-zinc-950/60 p-3';
/** Иконка-действие в строке списка. */
export const rowBtnCls = 'p-1.5 text-zinc-500 transition hover:text-zinc-200 disabled:opacity-50';
/** Одноразовое сообщение после мутации. */
export const flashCls =
  'sticky top-2 z-40 mb-3 flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-black/30';

/** Верхняя панель вложенных экранов (показывается при глубине ≥ 1). */
export function TopBar({ onBack, onHome }: { onBack: () => void; onHome: () => void }) {
  const btn =
    'flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-sky-400 transition hover:bg-white/5';
  return (
    <div class="mb-4 flex items-center justify-between">
      <button type="button" class={btn} onClick={onBack}>
        <ChevronLeft size={18} strokeWidth={1.5} /> Назад
      </button>
      <button type="button" class={btn} onClick={onHome}>
        <House size={16} strokeWidth={1.5} /> На главную
      </button>
    </div>
  );
}

export function Loading() {
  return (
    <div class="flex min-h-[60vh] flex-col items-center justify-center">
      <LoaderCircle size={28} strokeWidth={1.5} class="animate-spin text-zinc-500" />
      <p class="mt-3 text-sm text-zinc-500">Загружаю…</p>
    </div>
  );
}

export function ErrorView({
  title,
  text,
  onRetry,
}: {
  title: string;
  text: string;
  onRetry?: () => void;
}) {
  return (
    <div class="flex min-h-[70vh] items-center justify-center px-4">
      <div class="w-full max-w-xs text-center">
        <CircleAlert size={36} strokeWidth={1.5} class="mx-auto text-zinc-500" />
        <h1 class="mt-3 text-xl font-semibold tracking-tight">{title}</h1>
        <p class="mt-2 text-sm leading-relaxed text-zinc-400">{text}</p>
        {onRetry && (
          <button type="button" class={`${primaryBtnCls} mt-5`} onClick={onRetry}>
            Повторить
          </button>
        )}
      </div>
    </div>
  );
}

/** Заголовок и текст экрана ошибки загрузки: сеть — TypeError от fetch. */
export function errorView(e: unknown): { title: string; text: string } {
  if (e instanceof TypeError)
    return { title: 'Сеть недоступна', text: 'Не удалось связаться с сервером. Проверьте соединение.' };
  if (e instanceof Error) return { title: 'Ошибка сервера', text: e.message };
  return { title: 'Ошибка', text: 'Что-то пошло не так.' };
}

export interface LoadState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Загрузка данных экрана. Рефетч — reload() или смена deps.
 * 401/403 (в т.ч. после неудачного reauth) → onAuthFail → экран «Нет доступа».
 */
export function useData<T>(
  fn: () => Promise<T>,
  onAuthFail: () => void,
  deps: readonly unknown[] = [],
): LoadState<T> {
  const [tick, setTick] = useState(0);
  const [st, setSt] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => {
        if (live) setSt({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (live) setSt({ data: undefined, error, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [tick, ...deps]);
  useEffect(() => {
    if (isAuthError(st.error)) onAuthFail();
  }, [st.error]);
  return { data: st.data, error: st.error, loading: st.loading, reload: () => setTick((t) => t + 1) };
}

/** Условный переход на фатальный экран (например, профиль без онбординга). */
export function useFatalOn(cond: boolean, onFatal: () => void): void {
  useEffect(() => {
    if (cond) onFatal();
  }, [cond, onFatal]);
}

/**
 * Поле с подписью. flex-1 — чтобы в рядах `flex gap-3` поля делили
 * ширину поровну (как старый .inline > *); вне flex-ряда flex-1 инертен.
 */
export function Field({ label, children }: { label: ComponentChildren; children: ComponentChildren }) {
  return (
    <label class="mb-3 block min-w-0 flex-1">
      <span class="mb-1.5 flex items-center text-[13px] text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

/** Кнопка-подсказка «ⓘ»: открывает нижнюю шторку с объяснением (портал в body). */
export function Info({ title, children }: { title: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        class="ml-1.5 inline-flex align-middle text-zinc-500 transition hover:text-zinc-300"
        aria-label={`Подсказка: ${title}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <InfoIcon size={16} strokeWidth={1.5} />
      </button>
      {open &&
        createPortal(
          <div
            class="fixed inset-0 z-50 flex items-end justify-center bg-black/60"
            onClick={() => setOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              class="w-full max-w-md rounded-t-2xl border-t border-white/10 bg-zinc-900 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div class="flex items-center justify-between">
                <b class="text-base font-semibold text-zinc-100">{title}</b>
                <button
                  type="button"
                  aria-label="Закрыть"
                  class="rounded-full bg-white/10 p-1.5 text-zinc-400 transition hover:bg-white/20"
                  onClick={() => setOpen(false)}
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </div>
              <div class="mt-2 space-y-2 text-sm leading-relaxed text-zinc-300">{children}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function FormError({ msg }: { msg: string | null }) {
  return msg ? <p class="mb-3 text-sm text-red-400">{msg}</p> : null;
}
