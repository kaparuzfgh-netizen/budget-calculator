/**
 * fx.tsx — «Курсы» в Mini App (шаг 8).
 *
 * FxScreen: GET /api/tma/fx — карточки пар (сигнал/перцентиль/RSI/прогноз)
 *   + журнал обменов (раскрытие строки → правка сумм/даты/заметки, удаление).
 * Форма записи — POST /api/tma/exchanges (client_id против дублей, P2-3).
 */
import { useState } from 'preact/hooks';
import {
  ArrowLeftRight,
  NotebookText,
  Pencil,
  Plus,
  Trash2,
  TrendingDown,
  TrendingUp,
} from 'lucide-preact';
import { ApiError } from '../api';
import type { Api, ExchangeItem, FxActionItem, FxScreenData } from '../api';
import type { ScreenProps } from '../app';
import { amountError, currencyError, fmtDay, fmtMinor, parseAmount } from '../fmt';
import {
  cardCls,
  CcySelect,
  ErrorView,
  errorView,
  evEditCls,
  Field,
  FormError,
  headCls,
  inputCls,
  listCardCls,
  Loading,
  mutedCls,
  primaryBtnCls,
  rowCls,
  smBtnCls,
  smDangerBtnCls,
  useData,
} from '../ui';

const apiErr = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const todayIso = () => new Date().toISOString().slice(0, 10);
/** Курс для списка/карточки — digits как в боте (>20 → 2 знака, иначе 4). */
const fmtRate = (v: number): string => (v > 20 ? v.toFixed(2) : v.toFixed(4)).replace(/\.?0+$/, '');
const SIGNAL_CLASS: Record<FxActionItem['signal'], string> = {
  convert: 'text-emerald-400',
  split: '',
  wait: 'text-amber-400',
  hold: 'text-red-400',
};

export function FxScreen({ api, nav, onFatal }: ScreenProps) {
  const q = useData(() => api.get<FxScreenData>('/api/tma/fx'), onFatal, []);
  const [showAdd, setShowAdd] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  if (q.loading) return <Loading />;
  if (q.error || !q.data) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  const d = q.data;
  const done = (msg: string) => {
    setShowAdd(false);
    setOpen(null);
    nav.flash(msg);
    q.reload();
  };

  return (
    <>
      <div class="mb-5 flex items-center justify-between">
        <h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <ArrowLeftRight size={20} strokeWidth={1.5} class="text-sky-400" /> Курсы
        </h1>
        <button type="button" class={smBtnCls} onClick={() => setShowAdd(!showAdd)}>
          <Plus size={14} strokeWidth={1.5} /> Записать
        </button>
      </div>

      {showAdd && <ExchangeAddForm api={api} done={done} />}

      <h2 class={`${headCls} mt-6`}>Анализ · {d.analysis.generated_at}</h2>
      {d.analysis.ok ? (
        d.analysis.actions.map((a) => <PairCard key={a.key} a={a} />)
      ) : (
        <div class={`${cardCls} mt-2`}>
          <p class={mutedCls}>{d.analysis.note ?? 'Нет данных по валютным парам.'}</p>
        </div>
      )}
      {d.analysis.skipped.length > 0 && <p class={`${mutedCls} mt-2`}>Нет данных: {d.analysis.skipped.join(', ')}</p>}
      <p class={`${mutedCls} mt-2`}>{d.analysis.disclaimer}</p>

      <h2 class={`${headCls} mt-6`}>
        <NotebookText size={16} strokeWidth={1.5} /> Журнал обменов
      </h2>
      <div class={`${listCardCls} mt-2`}>
        {d.exchanges.length ? (
          <ul class="divide-y divide-line-soft">
            {d.exchanges.map((x) => (
              <ExchangeRow
                key={x.id}
                api={api}
                x={x}
                open={open === x.id}
                onToggle={() => setOpen(open === x.id ? null : x.id)}
                onDone={done}
              />
            ))}
          </ul>
        ) : (
          <p class={`${mutedCls} px-4 py-3`}>Пока пусто — запишите первый обмен.</p>
        )}
      </div>
    </>
  );
}

function PairCard({ a }: { a: FxActionItem }) {
  return (
    <div class={`${cardCls} mt-2`}>
      <div class={rowCls}>
        <span class="text-[15px] text-zinc-100">
          {a.emoji} {a.label}
        </span>
        <span class="text-2xl font-semibold">{fmtRate(a.current)}</span>
      </div>
      <div class={`${rowCls} mt-1`}>
        <span class={`${mutedCls} flex items-center gap-1`}>
          {a.change30d_pct >= 0 ? (
            <TrendingUp size={13} strokeWidth={1.5} class="text-emerald-400" />
          ) : (
            <TrendingDown size={13} strokeWidth={1.5} class="text-red-400" />
          )}
          {a.change30d_pct >= 0 ? '+' : ''}
          {a.change30d_pct.toFixed(1)}% за 30д · {a.percentile}-й перцентиль
        </span>
        <span class={mutedCls}>RSI {a.rsi14}</span>
      </div>
      <div class={`${rowCls} mt-2`}>
        <span class={`font-medium ${SIGNAL_CLASS[a.signal]}`}>{a.signal_text}</span>
      </div>
      <div class={`${rowCls} mt-2`}>
        <span class={mutedCls}>Прогноз 30д</span>
        <span class={mutedCls}>
          {fmtRate(a.forecast30d.low)} – {fmtRate(a.forecast30d.high)}
        </span>
      </div>
      <div class={`${rowCls} mt-1`}>
        <span class={mutedCls}>{a.purpose}</span>
        <span class={mutedCls}>
          {fmtRate(a.min)} – {fmtRate(a.max)}
        </span>
      </div>
    </div>
  );
}

// ── журнал: строка + правка ──

function ExchangeRow({
  api,
  x,
  open,
  onToggle,
  onDone,
}: {
  api: Api;
  x: ExchangeItem;
  open: boolean;
  onToggle: () => void;
  onDone: (m: string) => void;
}) {
  const [af, setAf] = useState(String(x.amount_from_minor / 100));
  const [at, setAt] = useState(String(x.amount_to_minor / 100));
  const [on, setOn] = useState(x.spent_on);
  const [note, setNote] = useState(x.note);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const diff =
    x.market_rate !== null && x.market_rate > 0
      ? `${(x.rate / x.market_rate - 1) * 100 >= 0 ? '+' : '−'}${Math.abs((x.rate / x.market_rate - 1) * 100).toFixed(1)}%`
      : null;

  const save = async (e: Event) => {
    e.preventDefault();
    const aErr = amountError(af) ?? amountError(at);
    if (aErr) return setErr(aErr);
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/exchanges/${x.id}`, {
        amount_from: parseAmount(af),
        amount_to: parseAmount(at),
        spent_on: on,
        note: note.trim(),
      });
      onDone('Обмен обновлён');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось сохранить'));
      setBusy(false);
    }
    return undefined;
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.del(`/api/tma/exchanges/${x.id}`);
      onDone('Обмен удалён');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось удалить'));
      setBusy(false);
    }
  };

  return (
    <li class="px-4 py-3">
      <div class={`${rowCls} cursor-pointer`} onClick={onToggle}>
        <span>
          {fmtDay(x.spent_on)} · {fmtMinor(x.amount_from_minor, x.from_ccy)} → {fmtMinor(x.amount_to_minor, x.to_ccy)}
        </span>
        <span class={mutedCls}>
          {fmtRate(x.rate)}
          {diff ? ` (${diff})` : ''}
        </span>
      </div>
      {open && (
        <div class={evEditCls}>
          {x.note && <p class={`${mutedCls} mb-2`}>Заметка: {x.note}</p>}
          {x.market_rate !== null && <p class={`${mutedCls} mb-2`}>Рынок на дату записи: {fmtRate(x.market_rate)}</p>}
          <form onSubmit={(e) => void save(e)}>
            <div class="flex gap-3">
              <Field label={`Сумма (${x.from_ccy})`}>
                <input class={inputCls} inputMode="decimal" value={af} onInput={(e) => setAf((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label={`Сумма (${x.to_ccy})`}>
                <input class={inputCls} inputMode="decimal" value={at} onInput={(e) => setAt((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="Дата">
                <input class={inputCls} type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
              </Field>
            </div>
            <Field label="Заметка">
              <input class={inputCls} maxLength={200} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
            </Field>
            <FormError msg={err} />
            <div class="flex gap-2">
              <button type="submit" class={`${smBtnCls} flex-1 justify-center`} disabled={busy}>
                <Pencil size={13} strokeWidth={1.5} /> Сохранить
              </button>
              {confirmDel ? (
                <>
                  <button type="button" class={`${smDangerBtnCls} flex-1 justify-center`} disabled={busy} onClick={() => void del()}>
                    Точно удалить?
                  </button>
                  <button type="button" class={smBtnCls} onClick={() => setConfirmDel(false)}>
                    Нет
                  </button>
                </>
              ) : (
                <button type="button" class={smDangerBtnCls} disabled={busy} onClick={() => setConfirmDel(true)}>
                  <Trash2 size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </li>
  );
}

// ── форма записи обмена ──

function ExchangeAddForm({ api, done }: { api: Api; done: (m: string) => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [af, setAf] = useState('');
  const [at, setAt] = useState('');
  const [on, setOn] = useState(todayIso());
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cid] = useState(() => crypto.randomUUID()); // client_id на форму — retry не задвоит (P2-3)

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const first =
      currencyError(from) ?? currencyError(to) ?? amountError(af) ?? amountError(at);
    if (first) return setErr(first);
    if (from.trim().toUpperCase() === to.trim().toUpperCase()) return setErr('Валюты должны отличаться');
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/exchanges', {
        from: from.trim().toUpperCase(),
        to: to.trim().toUpperCase(),
        amount_from: parseAmount(af),
        amount_to: parseAmount(at),
        spent_on: on,
        note: note.trim(),
        client_id: cid,
      });
      done('Обмен записан');
    } catch (e) {
      setErr(apiErr(e, 'Не удалось записать — проверьте соединение'));
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div class={`${cardCls} mt-2`}>
      <form onSubmit={(e) => void submit(e)}>
        <div class="flex gap-3">
          <Field label="Из чего">
            <CcySelect value={from} onChange={setFrom} />
          </Field>
          <Field label="Во что">
            <CcySelect value={to} onChange={setTo} />
          </Field>
        </div>
        <div class="flex gap-3">
          <Field label="Отдал">
            <input class={inputCls} inputMode="decimal" placeholder="500" value={af}
              onInput={(e) => setAf((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Получил">
            <input class={inputCls} inputMode="decimal" placeholder="48200" value={at}
              onInput={(e) => setAt((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Дата">
            <input class={inputCls} type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <Field label="Заметка (необязательно)">
          <input class={inputCls} maxLength={200} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
        </Field>
        <FormError msg={err} />
        <button type="submit" class={primaryBtnCls} disabled={busy}>
          {busy ? 'Сохраняю…' : 'Записать обмен'}
        </button>
      </form>
    </div>
  );
}
