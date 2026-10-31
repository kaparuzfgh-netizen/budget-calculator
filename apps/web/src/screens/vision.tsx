/**
 * vision.tsx — «📷 Из скриншота»: загрузка банковского скриншота в форме траты.
 *
 * Файл → POST /api/tma/vision/analyze (сырые байты, api.postRaw) → нижняя
 * шторка с редактируемыми строками (сумма/заметка/дата/категория, чекбоксы) →
 * пакетный POST /api/tma/expenses {items: ≤30, у каждой свой client_id} —
 * ретрай сабмита не плодит дубли (server-side дедуп по 'tma:<client_id>').
 * Коды ошибок сервера → дружелюбные тексты; фича opt-in — при выключенном
 * тогле кнопка не шлёт запрос, а показывает подсказку про Профиль.
 */
import { useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Camera, Sparkles, X } from 'lucide-preact';
import { ApiError, isAuthError } from '../api';
import type { Api, CategoriesList, VisionAnalyzeResponse } from '../api';
import type { Nav } from '../app';
import { amountError, fmtMoney, noteError, parseAmount, todayIso } from '../fmt';
import {
  CcySelect,
  FormError,
  smInputCls,
  mutedCls,
  primaryBtnCls,
  Select,
  secondaryBtnCls,
  smGhostBtnCls,
  useData,
} from '../ui';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // как на сервере (tma/vision)

/** Склонение «трата/траты/трат». */
const plural = (n: number): string => {
  const d = n % 10;
  const h = n % 100;
  if (d === 1 && h !== 11) return 'трата';
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'траты';
  return 'трат';
};

/** Код ошибки /vision/analyze → текст для пользователя (без внутренностей). */
const visionErrorText = (e: unknown): string => {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'disabled':
        return 'Распознавание выключено — включите его: Профиль → ⚡️ Возможности';
      case 'too_big':
        return 'Файл больше 10 МБ — выберите скриншот поменьше';
      case 'limit':
        return 'Лимит: 20 скриншотов в день — попробуйте завтра';
      case 'validation':
        return e.message;
      default:
        return 'Не удалось распознать — введите трату вручную';
    }
  }
  return 'Нет соединения — проверьте сеть и попробуйте ещё раз';
};

/** Редактируемая строка шторки (сумма/дата — строками, парсятся на submit). */
interface SheetRow {
  on: boolean;
  amount: string;
  note: string;
  date: string;
  /** '' — «✨ Авто» (сервер сматчит по заметке), иначе id категории строкой. */
  cat: string;
}
type Sheet =
  | { kind: 'review'; ccy: string; provider: string; batchId: string; rows: SheetRow[] }
  | { kind: 'info'; title: string; text: string };

export function ShotButton({
  api,
  nav,
  onFatal,
  enabled,
}: {
  api: Api;
  nav: Nav;
  onFatal: () => void;
  /** profile.vision_enabled — при false запрос не уходит, только подсказка. */
  enabled: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);

  const openPicker = () => {
    if (!enabled) {
      setErr('Сначала включите «Распознавание скриншотов»: Профиль → ⚡️ Возможности');
      return;
    }
    setErr(null);
    fileRef.current?.click();
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_IMAGE_BYTES) {
      setErr('Файл больше 10 МБ — выберите скриншот поменьше');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const buf = await f.arrayBuffer();
      const res = await api.postRaw<VisionAnalyzeResponse>(
        '/api/tma/vision/analyze',
        buf,
        f.type || 'application/octet-stream',
      );
      setSheet(sheetOf(res));
    } catch (e) {
      if (isAuthError(e)) {
        onFatal();
        return;
      }
      setErr(visionErrorText(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = ''; // тот же файл — снова выбираемый
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        class="hidden"
        onChange={(e) => void onFile((e.target as HTMLInputElement).files?.[0])}
      />
      <button type="button" class={`${secondaryBtnCls} mt-3`} disabled={busy} onClick={openPicker}>
        <Camera size={16} strokeWidth={1.5} /> {busy ? 'Распознаю…' : '📷 Из скриншота'}
      </button>
      <p class={`${mutedCls} mt-2`}>
        Скриншот истории операций или аналитики банка — строки можно проверить перед записью.
      </p>
      <FormError msg={err} />
      {sheet?.kind === 'review' && (
        <ReviewSheet api={api} nav={nav} sheet={sheet} onClose={() => setSheet(null)} />
      )}
      {sheet?.kind === 'info' && (
        <InfoSheet title={sheet.title} text={sheet.text} onClose={() => setSheet(null)} />
      )}
    </>
  );
}

/** Результат разбора → содержимое шторки (review-строки или инфо-экран). */
function sheetOf(res: VisionAnalyzeResponse): Sheet {
  const r = res.result;
  const info = (title: string, text: string): Sheet => ({ kind: 'info', title, text });
  if (r.screen_type === 'debt_balance' || r.screen_type === 'other') {
    return info(
      'Нет списка трат',
      'На этом экране нет списка трат — пришлите скриншот истории операций или аналитики расходов.',
    );
  }
  if (r.is_full_month_analytics) {
    return info(
      'Сводка за весь месяц',
      'Это сводка за весь месяц — разбейте по неделям вручную, иначе траты задвоятся.',
    );
  }
  const today = todayIso();
  const batchId = crypto.randomUUID(); // ретрай сабмита → те же client_id → дедуп на сервере
  const txs = r.transactions ?? [];
  if (txs.length) {
    return {
      kind: 'review',
      ccy: r.currency,
      provider: r.provider,
      batchId,
      rows: txs.map((t) => ({
        on: true,
        amount: String(t.amount),
        note: t.note || t.category,
        date: t.date ?? today,
        cat: '',
      })),
    };
  }
  if (r.total_spent > 0) {
    // только сводка — предлагаем одну строку на весь период
    return {
      kind: 'review',
      ccy: r.currency,
      provider: r.provider,
      batchId,
      rows: [{ on: true, amount: String(r.total_spent), note: r.period || 'по скриншоту', date: today, cat: '' }],
    };
  }
  return info('Траты не найдены', 'На скриншоте не распознали траты — введите сумму вручную.');
}

// ── шторка проверки строк ──

function ReviewSheet({
  api,
  nav,
  sheet,
  onClose,
}: {
  api: Api;
  nav: Nav;
  sheet: Extract<Sheet, { kind: 'review' }>;
  onClose: () => void;
}) {
  const cats = useData(() => api.get<CategoriesList>('/api/tma/categories'), () => {}, []);
  const [rows, setRows] = useState<SheetRow[]>(sheet.rows);
  const [ccy, setCcy] = useState(sheet.ccy);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (i: number, patch: Partial<SheetRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const checked = rows.filter((r) => r.on);
  const sum = checked.reduce((s, r) => s + (parseAmount(r.amount) ?? 0), 0);

  const submit = async () => {
    const badRow = checked.find((r) => amountError(r.amount) || noteError(r.note));
    if (badRow) {
      setErr(amountError(badRow.amount) ?? noteError(badRow.note));
      return;
    }
    if (!checked.length) {
      setErr('Отметьте хотя бы одну строку');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.post<{ created: number; duplicates: number; ids: number[] }>(
        '/api/tma/expenses',
        {
          items: checked.map((r, i) => ({
            amount: parseAmount(r.amount),
            currency: ccy,
            ...(r.note.trim() ? { note: r.note.trim() } : {}),
            ...(r.date ? { spent_on: r.date } : {}),
            ...(r.cat ? { category_id: Number(r.cat) } : {}),
            client_id: `${sheet.batchId}:${i}`,
          })),
        },
      );
      const n = res.created + res.duplicates;
      nav.flash(`Записано ${n} ${plural(n)}`);
      nav.back(); // → экран-источник с перезагруженными данными
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось записать — проверьте соединение');
      setBusy(false);
    }
  };

  const catOptions = [
    { value: '', label: '✨ Авто' },
    ...(cats.data?.categories ?? []).map((x) => ({ value: String(x.id), label: `${x.emoji} ${x.name}` })),
  ];

  return createPortal(
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        class="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl border-t border-white/10 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between p-5 pb-3">
          <b class="text-base font-semibold text-zinc-100">Скриншот разобран</b>
          <button
            type="button"
            aria-label="Закрыть"
            class="rounded-full bg-white/10 p-1.5 text-zinc-400 transition hover:bg-white/20"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div class="px-5 pb-3">
          <div class="flex items-center gap-3">
            <span class={mutedCls}>
              Провайдер: {sheet.provider === 'gemini' ? 'Gemini' : 'Groq'} · Валюта:
            </span>
            <span class="w-28 flex-none">
              <CcySelect value={ccy} onChange={setCcy} extra={[sheet.ccy]} />
            </span>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-5">
          <ul class="space-y-2 pb-2">
            {rows.map((r, i) => (
              <li key={i} class={`rounded-xl border border-white/10 bg-zinc-950/60 p-2.5${r.on ? '' : ' opacity-50'}`}>
                <div class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    class="h-4 w-4 flex-none accent-sky-500"
                    checked={r.on}
                    aria-label={`Строка ${i + 1}`}
                    onChange={(e) => set(i, { on: (e.target as HTMLInputElement).checked })}
                  />
                  <input
                    class={`${smInputCls} min-w-0 flex-1`}
                    maxLength={200}
                    placeholder="Заметка"
                    value={r.note}
                    onInput={(e) => set(i, { note: (e.target as HTMLInputElement).value })}
                  />
                  <span class="w-24 flex-none">
                    <input
                      class={`${smInputCls} text-right`}
                      inputMode="decimal"
                      placeholder="Сумма"
                      value={r.amount}
                      onInput={(e) => set(i, { amount: (e.target as HTMLInputElement).value })}
                    />
                  </span>
                </div>
                <div class="mt-1.5 flex items-center gap-2 pl-6">
                  <span class="w-36 flex-none">
                    <input
                      class={smInputCls}
                      type="date"
                      max={todayIso()}
                      min="2000-01-01"
                      value={r.date}
                      onInput={(e) => set(i, { date: (e.target as HTMLInputElement).value })}
                    />
                  </span>
                  <span class="min-w-0 flex-1">
                    <Select compact value={r.cat} options={catOptions} onChange={(v) => set(i, { cat: v })} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div class="border-t border-white/10 p-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))]">
          <FormError msg={err} />
          <button type="button" class={primaryBtnCls} disabled={busy || !checked.length} onClick={() => void submit()}>
            {busy
              ? 'Записываю…'
              : `Записать ${checked.length} ${plural(checked.length)} (${fmtMoney(sum, ccy)})`}
          </button>
          <button type="button" class={`${smGhostBtnCls} mt-1 w-full`} disabled={busy} onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── инфо-шторка («нет списка трат», «сводка за месяц») — только Отмена ──

function InfoSheet({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return createPortal(
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        class="w-full max-w-md rounded-t-2xl border-t border-white/10 bg-zinc-900 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between">
          <b class="flex items-center gap-2 text-base font-semibold text-zinc-100">
            <Sparkles size={17} strokeWidth={1.5} class="text-sky-400" /> {title}
          </b>
          <button
            type="button"
            aria-label="Закрыть"
            class="rounded-full bg-white/10 p-1.5 text-zinc-400 transition hover:bg-white/20"
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <p class="mt-2 text-sm leading-relaxed text-zinc-300">{text}</p>
        <button type="button" class={`${secondaryBtnCls} mt-4`} onClick={onClose}>
          Понятно
        </button>
      </div>
    </div>,
    document.body,
  );
}
