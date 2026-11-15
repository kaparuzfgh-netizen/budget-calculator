/**
 * ui.tsx — общие кирпичики экранов в дизайн-языке Tailwind/Lucide
 * (эталон — demo/tw.tsx): верхняя навигация, состояния загрузки/ошибки,
 * хук useData, подписанные поля форм, «ⓘ»-подсказка-шторка и общие
 * классы (карточки/кнопки/ряды), чтобы экраны держались единого стиля.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  House,
  Info as InfoIcon,
  LoaderCircle,
  X,
} from 'lucide-preact';
import { isAuthError } from './api';
import { CCY_LIST } from './fmt';

// ── общие классы (единый словарь стиля экранов) ──

/** Поле ввода/селект. */
export const inputCls =
  'w-full rounded-xl border border-line bg-zinc-950 px-3 py-2.5 text-[15px] text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:ring-2 focus:ring-sky-500/60';
/** Компактное поле — для плотных списков (строки разбора скриншота и т.п.). */
export const smInputCls =
  'w-full rounded-lg border border-line bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:ring-2 focus:ring-sky-500/60';
/** Карточка с контентом (padding у самой карточки). */
export const cardCls =
  'rounded-2xl border border-line bg-zinc-900/80 p-4 shadow-lg shadow-shade';
/** Карточка-список: та же обводка, без отступов — у li свой padding. */
export const listCardCls =
  'rounded-2xl border border-line bg-zinc-900/80 shadow-lg shadow-shade';
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
  'flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-fill py-3 font-medium text-zinc-100 transition hover:bg-fill-2 disabled:opacity-50';
/** Ghost-кнопка — только текст/иконка sky. */
export const ghostBtnCls =
  'flex w-full items-center justify-center gap-2 rounded-xl py-2.5 font-medium text-sky-400 transition hover:bg-fill disabled:opacity-50';
/** Деструктивная кнопка. */
export const dangerBtnCls =
  'flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 py-3 font-medium text-red-400 transition hover:bg-red-500/20 disabled:opacity-50';
/** Компактная кнопка («+ Добавить», действия в строках). */
export const smBtnCls =
  'inline-flex items-center gap-1 rounded-lg bg-fill px-2.5 py-1.5 text-[13px] text-sky-400 transition hover:bg-fill-2 disabled:opacity-50';
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
  'inline-flex flex-1 items-center justify-center gap-1 rounded-lg px-2.5 py-2 text-sm font-medium text-sky-400 transition hover:bg-fill disabled:opacity-50';
/** Плашка подтверждения деструктивного действия. */
export const confirmCls = 'mt-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3';
/** Плашка подтверждения обычного действия (оплата и т.п.). */
export const confirmNeutralCls = 'mt-2 rounded-xl border border-line bg-fill p-3';
/** Раскрытая инлайн-правка события журнала. */
export const evEditCls = 'mt-2 rounded-xl border border-line bg-zinc-950/60 p-3';
/** Иконка-действие в строке списка. */
export const rowBtnCls = 'p-1.5 text-zinc-500 transition hover:text-zinc-200 disabled:opacity-50';
/** Одноразовое сообщение после мутации. */
export const flashCls =
  'sticky top-2 z-40 mb-3 flex items-center gap-2 rounded-xl bg-sky-600 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-shade';

/** Верхняя панель вложенных экранов (показывается при глубине ≥ 1). */
export function TopBar({ onBack, onHome }: { onBack: () => void; onHome: () => void }) {
  const btn =
    'flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-sky-400 transition hover:bg-fill';
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
 * flex-col + растущая подпись: в ряду все label тянутся до самого высокого
 * и инпуты выравниваются по нижнему краю — длинные подписи в соседних
 * полях ряда больше не сдвигают инпут.
 */
export function Field({ label, children }: { label: ComponentChildren; children: ComponentChildren }) {
  return (
    <label class="mb-3 flex min-w-0 flex-1 flex-col">
      <span class="mb-1.5 flex flex-1 items-start text-[13px] text-zinc-400">{label}</span>
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
            class="fixed inset-0 z-50 flex items-end justify-center bg-scrim"
            onClick={() => setOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              class="w-full max-w-md rounded-t-2xl border-t border-line bg-zinc-900 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div class="flex items-center justify-between">
                <b class="text-base font-semibold text-zinc-100">{title}</b>
                <button
                  type="button"
                  aria-label="Закрыть"
                  class="rounded-full bg-fill-2 p-1.5 text-zinc-400 transition hover:bg-fill-4"
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

/** Тонкая полоска «потрачено/бюджет» — нагляднее, чем «X из Y». */
export function BudgetBar({ share, over }: { share: number; over?: boolean }) {
  return (
    <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fill-2">
      <div
        class={`h-full rounded-full ${over ? 'bg-red-400' : 'bg-sky-500'}`}
        style={{ width: `${Math.min(100, Math.round(share * 100))}%` }}
      />
    </div>
  );
}

/** Мини-полоска для темпа месяца: «дни прошло» vs «бюджета потрачено». */
export function PaceBar({
  label,
  share,
  fillCls,
  right,
}: {
  label: string;
  share: number;
  fillCls: string;
  right: string;
}) {
  return (
    <div class="flex items-center gap-2">
      <span class="w-12 flex-none text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-fill-2">
        <div class={`h-full rounded-full ${fillCls}`} style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
      </div>
      <span class="w-12 flex-none text-right text-[10px] tabular-nums text-zinc-500">{right}</span>
    </div>
  );
}

// ── селекты ──

/** Опция Select: строка — и значение, и подпись; hint — доп. текст поиска. */
export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}
const optOf = (o: string | SelectOption): SelectOption => (typeof o === 'string' ? { value: o, label: o } : o);

/**
 * Тёмный селект в стиле inputCls — нативный <select> в UI не используем
 * (WebView рисует его не в теме). Панель — absolute под кнопкой;
 * закрывается по клику вне, Escape и выбору; Enter/Space на кнопке — toggle.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = '—',
  disabled = false,
  searchable = false,
  compact = false,
}: {
  value: string;
  options: readonly (string | SelectOption)[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  /** Компактная кнопка (smInputCls) — для плотных списков. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);
  const opts = options.map(optOf);
  const cur = opts.find((o) => o.value === value);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? opts.filter(
        (o) =>
          o.label.toLowerCase().includes(needle) ||
          o.value.toLowerCase().includes(needle) ||
          (o.hint?.toLowerCase().includes(needle) ?? false),
      )
    : opts;
  return (
    <div class="relative" ref={root}>
      <button
        type="button"
        class={`${compact ? smInputCls : inputCls} flex items-center justify-between gap-2 text-left disabled:opacity-50`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        <span class={`truncate ${cur ? '' : 'text-zinc-600'}`}>{cur?.label ?? placeholder}</span>
        <ChevronDown size={compact ? 14 : 16} strokeWidth={1.5} class="flex-none text-zinc-400" />
      </button>
      {open && (
        <div class="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-auto rounded-xl border border-line bg-zinc-900 shadow-xl shadow-shade">
          {searchable && (
            <div class="sticky top-0 border-b border-line bg-zinc-900 p-1.5">
              <input
                autoFocus
                class="w-full rounded-lg border border-line bg-zinc-950 px-3 py-2 text-[14px] text-zinc-100 placeholder-zinc-500 outline-none focus:ring-2 focus:ring-sky-500/60"
                placeholder="Поиск…"
                value={q}
                onInput={(e) => setQ((e.target as HTMLInputElement).value)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
          {shown.length === 0 && (
            <div class="px-3 py-2.5 text-sm text-zinc-500">Ничего не найдено</div>
          )}
          {shown.map((o) => (
            <button
              key={o.value}
              type="button"
              class="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[15px] text-zinc-100 transition hover:bg-fill"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span class="truncate">{o.label}</span>
              {o.value === value && <Check size={15} strokeWidth={1.5} class="flex-none text-sky-400" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Маркер опции «Другое…» в селекте валют. */
const CCY_CUSTOM = '__ccy_custom__';

/** Русские имена ходовых валют — для поиска («доллар» → USD). */
const CCY_RU: Record<string, string> = {
  USD: 'доллар',
  EUR: 'евро',
  RUB: 'рубль',
  KGS: 'сом',
  KZT: 'тенге',
  UAH: 'гривна',
  UZS: 'сум',
  GEL: 'лари',
  AMD: 'драм',
  AZN: 'манат',
  BYN: 'белорусский рубль',
  TRY: 'лира',
  GBP: 'фунт',
  CNY: 'юань',
  JPY: 'иена',
  AED: 'дирхам',
};

/**
 * Поле валюты: Select из CCY_LIST ∪ extra ∪ текущее значение и финальная
 * опция «Другое…» → свободный ввод (его валидирует currencyError в форме).
 * allowEmpty — первой опцией идёт «пустое» значение (emptyLabel), пустая
 * строка = «как у бюджета»/дефолт профиля.
 */
export function CcySelect({
  value,
  onChange,
  extra = [],
  allowEmpty = false,
  emptyLabel = '—',
  placeholder = '—',
}: {
  value: string;
  onChange: (v: string) => void;
  extra?: readonly (string | null | undefined)[];
  allowEmpty?: boolean;
  emptyLabel?: string;
  placeholder?: string;
}) {
  const up = (x: string) => x.toUpperCase();
  const known = [
    ...new Set(
      [...extra.filter((x): x is string => !!x), ...CCY_LIST, ...(value ? [value] : [])].map(up),
    ),
  ];
  const custom = !!value && !known.includes(up(value));
  const [customMode, setCustomMode] = useState(custom);
  // значение пришло извне и оно в списке → выходим из режима «Другое»
  useEffect(() => {
    if (value && known.includes(up(value))) setCustomMode(false);
  }, [value]);
  const options: SelectOption[] = [
    ...(allowEmpty ? [{ value: '', label: emptyLabel }] : []),
    ...known.map((x) => ({ value: x, label: x, ...(CCY_RU[x] ? { hint: CCY_RU[x] } : {}) })),
    { value: CCY_CUSTOM, label: 'Другое…' },
  ];
  const pick = (v: string) => {
    if (v === CCY_CUSTOM) {
      setCustomMode(true);
      onChange(''); // сбрасываем — код введёт вручную
    } else {
      setCustomMode(false);
      onChange(v);
    }
  };
  return (
    <div>
      <Select
        value={customMode ? CCY_CUSTOM : up(value)}
        options={options}
        onChange={pick}
        searchable
        placeholder={placeholder}
      />
      {customMode && (
        <input
          class={`${inputCls} mt-2`}
          maxLength={5}
          placeholder="USD"
          value={value}
          onInput={(e) => onChange((e.target as HTMLInputElement).value.toUpperCase())}
        />
      )}
    </div>
  );
}
