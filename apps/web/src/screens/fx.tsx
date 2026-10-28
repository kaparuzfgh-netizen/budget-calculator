/**
 * fx.tsx — «💱 Курсы» в Mini App (шаг 8).
 *
 * FxScreen: GET /api/tma/fx — карточки пар (сигнал/перцентиль/RSI/прогноз)
 *   + журнал обменов (раскрытие строки → правка сумм/даты/заметки, удаление).
 * Форма записи — POST /api/tma/exchanges (client_id против дублей, P2-3).
 */
import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import type { Api, ExchangeItem, FxActionItem, FxScreenData } from '../api';
import type { ScreenProps } from '../app';
import { amountError, currencyError, fmtDay, fmtMinor, parseAmount } from '../fmt';
import { ErrorView, errorView, Field, FormError, Loading, useData } from '../ui';

const apiErr = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const todayIso = () => new Date().toISOString().slice(0, 10);
/** Курс для списка/карточки — digits как в боте (>20 → 2 знака, иначе 4). */
const fmtRate = (v: number): string => (v > 20 ? v.toFixed(2) : v.toFixed(4)).replace(/\.?0+$/, '');
const SIGNAL_CLASS: Record<FxActionItem['signal'], string> = {
  convert: 'ok',
  split: '',
  wait: 'warn',
  hold: 'err',
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
      <div class="row spread">
        <h1>💱 Курсы</h1>
        <button type="button" class="btn sm" onClick={() => setShowAdd(!showAdd)}>
          ➕ Записать
        </button>
      </div>

      {showAdd && <ExchangeAddForm api={api} done={done} />}

      <h2>Анализ · {d.analysis.generated_at}</h2>
      {d.analysis.ok ? (
        d.analysis.actions.map((a) => <PairCard key={a.key} a={a} />)
      ) : (
        <div class="card">
          <p class="muted">{d.analysis.note ?? 'Нет данных по валютным парам.'}</p>
        </div>
      )}
      {d.analysis.skipped.length > 0 && <p class="muted">Нет данных: {d.analysis.skipped.join(', ')}</p>}
      <p class="muted">{d.analysis.disclaimer}</p>

      <h2>📒 Журнал обменов</h2>
      <div class="card">
        {d.exchanges.length ? (
          <ul class="plain">
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
          <p class="muted">Пока пусто — запишите первый обмен.</p>
        )}
      </div>
    </>
  );
}

function PairCard({ a }: { a: FxActionItem }) {
  const arrow = a.change30d_pct >= 0 ? '▲' : '▼';
  return (
    <div class="card">
      <div class="row">
        <span>
          {a.emoji} {a.label}
        </span>
        <span class="big">{fmtRate(a.current)}</span>
      </div>
      <div class="row muted">
        <span>
          {arrow} {a.change30d_pct >= 0 ? '+' : ''}
          {a.change30d_pct.toFixed(1)}% за 30д · {a.percentile}-й перцентиль
        </span>
        <span>RSI {a.rsi14}</span>
      </div>
      <div class="row">
        <span class={SIGNAL_CLASS[a.signal]}>{a.signal_text}</span>
      </div>
      <div class="row muted">
        <span>Прогноз 30д</span>
        <span>
          {fmtRate(a.forecast30d.low)} – {fmtRate(a.forecast30d.high)}
        </span>
      </div>
      <div class="row muted">
        <span>{a.purpose}</span>
        <span>
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
    <li>
      <div class={`row clickable${open ? ' on' : ''}`} onClick={onToggle}>
        <span>
          {fmtDay(x.spent_on)} · {fmtMinor(x.amount_from_minor, x.from_ccy)} → {fmtMinor(x.amount_to_minor, x.to_ccy)}
        </span>
        <span class="muted">
          {fmtRate(x.rate)}
          {diff ? ` (${diff})` : ''}
        </span>
      </div>
      {open && (
        <div class="ev-edit">
          {x.note && <p class="muted">Заметка: {x.note}</p>}
          {x.market_rate !== null && <p class="muted">Рынок на дату записи: {fmtRate(x.market_rate)}</p>}
          <form onSubmit={(e) => void save(e)}>
            <div class="inline">
              <Field label={`Сумма (${x.from_ccy})`}>
                <input inputMode="decimal" value={af} onInput={(e) => setAf((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label={`Сумма (${x.to_ccy})`}>
                <input inputMode="decimal" value={at} onInput={(e) => setAt((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="Дата">
                <input type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
              </Field>
            </div>
            <Field label="Заметка">
              <input maxLength={200} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
            </Field>
            <FormError msg={err} />
            <div class="inline">
              <button type="submit" class="btn sm" disabled={busy}>
                ✏️ Сохранить
              </button>
              {confirmDel ? (
                <>
                  <button type="button" class="btn sm danger" disabled={busy} onClick={() => void del()}>
                    Точно удалить?
                  </button>
                  <button type="button" class="btn sm ghost" onClick={() => setConfirmDel(false)}>
                    Нет
                  </button>
                </>
              ) : (
                <button type="button" class="btn sm danger" disabled={busy} onClick={() => setConfirmDel(true)}>
                  🗑
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
    <div class="card">
      <form onSubmit={(e) => void submit(e)}>
        <div class="inline">
          <Field label="Из чего">
            <input maxLength={5} placeholder="EUR" value={from} autoFocus
              onInput={(e) => setFrom((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Во что">
            <input maxLength={5} placeholder="RUB" value={to}
              onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <div class="inline">
          <Field label="Отдал">
            <input inputMode="decimal" placeholder="500" value={af}
              onInput={(e) => setAf((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Получил">
            <input inputMode="decimal" placeholder="48200" value={at}
              onInput={(e) => setAt((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Дата">
            <input type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <Field label="Заметка (необязательно)">
          <input maxLength={200} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
        </Field>
        <FormError msg={err} />
        <button type="submit" class="btn" disabled={busy}>
          {busy ? 'Сохраняю…' : 'Записать обмен'}
        </button>
      </form>
    </div>
  );
}
