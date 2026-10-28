/**
 * debts.tsx — «🏦 Кредиты» в Mini App (веха H3).
 *
 * DebtsScreen: GET /api/tma/debts — список с replay-состоянием и итогом USD.
 * DebtScreen: GET /api/tma/debts/:id — карточка: операции (✅ Платёж,
 *   💸 ЧДП с превью обоих режимов, 🏦 Сверка, ✏️ Правки) раскрываются
 *   инлайн-формами; журнал событий — правка (сумма/дата, у ЧДП режим)
 *   и удаление; удаление кредита с подтверждением.
 * DebtAddScreen: POST /api/tma/debts.
 * Идемпотентность мутаций — client_id на форму (retry не задвоит событие).
 */
import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import type {
  Api,
  DebtDetail,
  DebtEvent,
  DebtsList,
  PrepayPreview,
} from '../api';
import type { Nav, ScreenProps } from '../app';
import { amountError, currencyError, dayError, fmtDay, fmtMinor, nameError, parseAmount } from '../fmt';
import { ErrorView, errorView, Field, FormError, Loading, useData } from '../ui';

const EVENT_KIND: Record<DebtEvent['kind'], string> = {
  payment: '✅ Платёж',
  prepay: '💸 ЧДП',
  reconcile: '🏦 Сверка',
};
const MODE_LABEL: Record<string, string> = {
  reduce_payment: 'платёж↓',
  reduce_term: 'срок↓',
};

const clientId = () => crypto.randomUUID();
const todayIso = () => new Date().toISOString().slice(0, 10);
const apiErr = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : fallback;

// ── список ──

export function DebtsScreen({ api, nav, onFatal }: ScreenProps) {
  const q = useData(() => api.get<DebtsList>('/api/tma/debts'), onFatal, []);

  if (q.loading) return <Loading />;
  if (q.error || !q.data) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  const d = q.data;
  return (
    <>
      <div class="row spread">
        <h1>🏦 Кредиты</h1>
        <button type="button" class="btn sm" onClick={() => nav.push({ id: 'debt-add' })}>
          ➕ Добавить
        </button>
      </div>
      <div class="card">
        {d.debts.length ? (
          <ul class="plain">
            {d.debts.map((x) => (
              <li class="clickable" onClick={() => nav.push({ id: 'debt', debtId: x.id })}>
                <div class="row">
                  <span>{x.name}</span>
                  <span>{fmtMinor(x.balance_minor, x.currency)}</span>
                </div>
                <div class="row muted">
                  <span>
                    {fmtMinor(x.payment_minor, x.currency)}
                    {x.frequency === 'biweekly' ? '/2 нед' : '/мес'}
                    {x.due_day ? ` · ${x.due_day} числа` : ''}
                  </span>
                  <span>{x.months_left > 0 ? `~${Math.ceil(x.months_left)} мес` : 'закрыт'}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">Кредитов нет. Добавьте первый — остаток, ставка и платёж.</p>
        )}
      </div>
      {d.total_usd_minor !== null && d.debts.length > 0 && (
        <p class="muted">Итого долг: ≈ {fmtMinor(d.total_usd_minor, 'USD')}</p>
      )}
    </>
  );
}

// ── карточка ──

type Action = 'pay' | 'prepay' | 'reconcile' | 'edit' | null;

export function DebtScreen({ api, nav, onFatal, debtId }: ScreenProps & { debtId: number }) {
  const q = useData(() => api.get<DebtDetail>(`/api/tma/debts/${debtId}`), onFatal, [debtId]);
  const [action, setAction] = useState<Action>(null);
  const [openEv, setOpenEv] = useState<number | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  if (!q.data) {
    return <ErrorView title="Кредит не найден" text="Кредит уже удалён." onRetry={nav.back} />;
  }
  const v = q.data;
  const toggle = (a: Action) => {
    setAction(action === a ? null : a);
    setOpenEv(null);
  };
  const done = (msg: string) => {
    setAction(null);
    setOpenEv(null);
    nav.flash(msg);
    q.reload();
  };
  const props = { api, debt: v, done };

  return (
    <>
      <h1>{v.name}</h1>
      <div class="card">
        <div class="row">
          <span>Остаток</span>
          <span class="big">{fmtMinor(v.balance_minor, v.currency)}</span>
        </div>
        <div class="row">
          <span>Платёж</span>
          <span>
            {fmtMinor(v.payment_minor, v.currency)}
            {v.frequency === 'biweekly' ? '/2 нед' : '/мес'} · ставка {v.rate}%
          </span>
        </div>
        <div class="row muted">
          <span>Платежей: {v.payments_made}</span>
          <span>
            {v.months_left > 0 ? `~${Math.ceil(v.months_left)} мес · до ${fmtDay(v.payoff_date)}` : 'погашен'}
          </span>
        </div>
        {v.due_day !== null && (
          <div class="row muted">
            <span>День платежа</span>
            <span>{v.due_day} числа</span>
          </div>
        )}
      </div>

      <div class="menu">
        <button type="button" class={`btn${action === 'pay' ? ' on' : ''}`} onClick={() => toggle('pay')}>
          ✅ Платёж
        </button>
        <button type="button" class={`btn${action === 'prepay' ? ' on' : ''}`} onClick={() => toggle('prepay')}>
          💸 ЧДП
        </button>
        <button type="button" class={`btn${action === 'reconcile' ? ' on' : ''}`} onClick={() => toggle('reconcile')}>
          🏦 Сверка
        </button>
        <button type="button" class={`btn${action === 'edit' ? ' on' : ''}`} onClick={() => toggle('edit')}>
          ✏️ Изменить
        </button>
      </div>

      {action === 'pay' && <PayForm {...props} />}
      {action === 'prepay' && <PrepayForm {...props} />}
      {action === 'reconcile' && <ReconcileForm {...props} />}
      {action === 'edit' && <EditForm {...props} />}

      <h2>📜 Журнал</h2>
      <div class="card">
        {v.events.length ? (
          <ul class="plain">
            {[...v.events].reverse().map((e) => (
              <EventRow
                key={e.id}
                api={api}
                ev={e}
                currency={v.currency}
                open={openEv === e.id}
                onToggle={() => setOpenEv(openEv === e.id ? null : e.id)}
                onDone={done}
              />
            ))}
          </ul>
        ) : (
          <p class="muted">Событий пока нет — платежи, ЧДП и сверки появятся здесь.</p>
        )}
      </div>

      <DeleteDebt api={api} nav={nav} debt={v} />
    </>
  );
}

// ── формы операций ──

interface FormProps {
  api: Api;
  debt: DebtDetail;
  done: (msg: string) => void;
}

/** Общие куски формы события: сумма + дата. */
function useEventForm() {
  const [amount, setAmount] = useState('');
  const [on, setOn] = useState(todayIso());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cid] = useState(clientId); // стабильный client_id на форму — retry не задвоит
  return { amount, setAmount, on, setOn, err, setErr, busy, setBusy, cid };
}

function PayForm({ api, debt, done }: FormProps) {
  const f = useEventForm();
  const submit = async (ev: Event, amountOverride?: number) => {
    ev.preventDefault();
    const a = amountOverride ?? parseAmount(f.amount);
    if (a === null || a <= 0 || a > 1e9) return f.setErr(amountError(f.amount) ?? 'Сумма недопустима');
    f.setBusy(true);
    f.setErr(null);
    try {
      await api.post(`/api/tma/debts/${debt.id}/events`, {
        kind: 'payment', amount: a, event_on: f.on, client_id: f.cid,
      });
      done('Платёж записан');
    } catch (e) {
      f.setErr(apiErr(e, 'Не удалось записать — проверьте соединение'));
      f.setBusy(false);
    }
    return undefined;
  };
  const scheduled = debt.payment_minor / 100;
  return (
    <div class="card">
      <form onSubmit={(e) => void submit(e)}>
        <div class="inline">
          <Field label={`Сумма (по графику ${fmtMinor(debt.payment_minor, debt.currency)})`}>
            <input inputMode="decimal" placeholder={String(scheduled)} value={f.amount}
              onInput={(e) => f.setAmount((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Дата">
            <input type="date" value={f.on} onInput={(e) => f.setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <FormError msg={f.err} />
        <div class="inline">
          <button type="submit" class="btn" disabled={f.busy}>Записать</button>
          <button type="button" class="btn ghost" disabled={f.busy} onClick={(e) => void submit(e, scheduled)}>
            По графику
          </button>
        </div>
      </form>
    </div>
  );
}

function PrepayForm({ api, debt, done }: FormProps) {
  const f = useEventForm();
  const [preview, setPreview] = useState<PrepayPreview | null>(null);

  const showPreview = async (ev: Event) => {
    ev.preventDefault();
    const a = parseAmount(f.amount);
    if (a === null || a <= 0 || a > debt.balance_minor / 100) {
      setPreview(null);
      return f.setErr(a === null || a <= 0 ? 'Сумма — число больше нуля' : 'Сумма больше остатка долга');
    }
    f.setBusy(true);
    f.setErr(null);
    try {
      setPreview(await api.get<PrepayPreview>(`/api/tma/debts/${debt.id}/prepay-preview?amount=${a}`));
    } catch (e) {
      f.setErr(apiErr(e, 'Не удалось посчитать — проверьте соединение'));
      setPreview(null);
    } finally {
      f.setBusy(false);
    }
  };

  const record = async (mode: 'reduce_payment' | 'reduce_term') => {
    f.setBusy(true);
    f.setErr(null);
    try {
      await api.post(`/api/tma/debts/${debt.id}/events`, {
        kind: 'prepay', amount: parseAmount(f.amount), event_on: f.on, mode, client_id: f.cid,
      });
      done('ЧДП записан');
    } catch (e) {
      f.setErr(apiErr(e, 'Не удалось записать — проверьте соединение'));
      f.setBusy(false);
    }
  };

  return (
    <div class="card">
      <form onSubmit={(e) => void showPreview(e)}>
        <div class="inline">
          <Field label="Сумма ЧДП">
            <input inputMode="decimal" value={f.amount}
              onInput={(e) => f.setAmount((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Дата">
            <input type="date" value={f.on} onInput={(e) => f.setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <FormError msg={f.err} />
        <button type="submit" class="btn ghost" disabled={f.busy}>
          Посчитать
        </button>
      </form>
      {preview && (
        <div class="preview">
          <div class="row">
            <span>Остаток</span>
            <span>
              {fmtMinor(preview.balance_before_minor, debt.currency)} →{' '}
              {fmtMinor(preview.balance_after_minor, debt.currency)}
            </span>
          </div>
          <div class="row">
            <span>📉 Платёж↓</span>
            <span>
              {fmtMinor(preview.payment_before_minor, debt.currency)} →{' '}
              {fmtMinor(preview.payment_after_minor, debt.currency)}
            </span>
          </div>
          <div class="row">
            <span>⏳ Срок↓</span>
            <span>−{preview.months_saved} мес при том же платеже</span>
          </div>
          <p class="muted">Что уменьшаем?</p>
          <div class="inline">
            <button type="button" class="btn" disabled={f.busy} onClick={() => void record('reduce_payment')}>
              📉 Платёж (−{fmtMinor(preview.payment_saved_minor, debt.currency)})
            </button>
            <button type="button" class="btn" disabled={f.busy} onClick={() => void record('reduce_term')}>
              ⏳ Срок (−{preview.months_saved} мес)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReconcileForm({ api, debt, done }: FormProps) {
  const f = useEventForm();
  const submit = async (ev: Event) => {
    ev.preventDefault();
    const a = parseAmount(f.amount);
    if (a === null || a < 0 || a > 1e9) return f.setErr('Остаток — число ≥ 0');
    f.setBusy(true);
    f.setErr(null);
    try {
      await api.post(`/api/tma/debts/${debt.id}/events`, {
        kind: 'reconcile', amount: a, event_on: f.on, client_id: f.cid,
      });
      done('Сверка записана — график пересчитан с фактического остатка');
    } catch (e) {
      f.setErr(apiErr(e, 'Не удалось записать — проверьте соединение'));
      f.setBusy(false);
    }
    return undefined;
  };
  return (
    <div class="card">
      <form onSubmit={(e) => void submit(e)}>
        <div class="inline">
          <Field label={`Факт. остаток по выписке (сейчас ${fmtMinor(debt.balance_minor, debt.currency)})`}>
            <input inputMode="decimal" placeholder={String(debt.balance_minor / 100)} value={f.amount}
              onInput={(e) => f.setAmount((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Дата">
            <input type="date" value={f.on} onInput={(e) => f.setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <FormError msg={f.err} />
        <button type="submit" class="btn" disabled={f.busy}>Записать сверку</button>
      </form>
    </div>
  );
}

function EditForm({ api, debt, done }: FormProps) {
  const [name, setName] = useState(debt.name);
  const [rate, setRate] = useState(String(debt.rate));
  const [payment, setPayment] = useState(String(debt.payment_minor / 100));
  const [day, setDay] = useState(debt.due_day ? String(debt.due_day) : '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const nErr = nameError(name);
    const r = parseAmount(rate);
    const rErr = r === null || r < 0 || r > 100 ? 'Ставка — число 0–100' : null;
    const pErr = amountError(payment);
    const dErr = dayError(day);
    const first = nErr ?? rErr ?? pErr ?? dErr;
    if (first) return setErr(first);
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/debts/${debt.id}`, {
        name: name.trim(),
        rate: r,
        payment: parseAmount(payment),
        due_day: day.trim() ? Number(day.trim()) : null,
      });
      done('Параметры обновлены');
    } catch (e) {
      setErr(apiErr(e, 'Не удалось сохранить — проверьте соединение'));
      setBusy(false);
    }
    return undefined;
  };

  return (
    <div class="card">
      <form onSubmit={(e) => void submit(e)}>
        <Field label="Название">
          <input maxLength={60} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        <div class="inline">
          <Field label="Ставка, % годовых">
            <input inputMode="decimal" value={rate} onInput={(e) => setRate((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Платёж за период">
            <input inputMode="decimal" value={payment} onInput={(e) => setPayment((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="День (пусто — без дня)">
            <input inputMode="numeric" maxLength={2} placeholder="—" value={day}
              onInput={(e) => setDay((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <FormError msg={err} />
        <button type="submit" class="btn" disabled={busy}>Сохранить</button>
      </form>
    </div>
  );
}

// ── журнал ──

function EventRow({
  api, ev, currency, open, onToggle, onDone,
}: {
  api: Api;
  ev: DebtEvent;
  currency: string;
  open: boolean;
  onToggle: () => void;
  onDone: (msg: string) => void;
}) {
  const [amount, setAmount] = useState(String(ev.amount_minor / 100));
  const [on, setOn] = useState(ev.event_on);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const save = async (e: Event) => {
    e.preventDefault();
    const aErr = amountError(amount);
    if (aErr) return setErr(aErr);
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/debt-events/${ev.id}`, {
        amount: parseAmount(amount),
        event_on: on,
      });
      onDone('Событие обновлено — остаток пересчитан');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось сохранить'));
      setBusy(false);
    }
    return undefined;
  };
  const flipMode = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/debt-events/${ev.id}`, {
        mode: ev.mode === 'reduce_term' ? 'reduce_payment' : 'reduce_term',
      });
      onDone('Режим ЧДП переключён');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось переключить режим'));
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.del(`/api/tma/debt-events/${ev.id}`);
      onDone('Событие удалено — остаток пересчитан');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось удалить'));
      setBusy(false);
    }
  };

  return (
    <li>
      <div class={`row clickable${open ? ' on' : ''}`} onClick={onToggle}>
        <span>
          {EVENT_KIND[ev.kind]}
          {ev.kind === 'prepay' && ev.mode ? ` (${MODE_LABEL[ev.mode]})` : ''}
        </span>
        <span>
          {fmtDay(ev.event_on)} · {fmtMinor(ev.amount_minor, currency)}
        </span>
      </div>
      {open && (
        <div class="ev-edit">
          <form onSubmit={(e) => void save(e)}>
            <div class="inline">
              <Field label="Сумма">
                <input inputMode="decimal" value={amount}
                  onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="Дата">
                <input type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
              </Field>
            </div>
            <FormError msg={err} />
            <div class="inline">
              <button type="submit" class="btn sm" disabled={busy}>✏️ Сохранить</button>
              {ev.kind === 'prepay' && (
                <button type="button" class="btn sm ghost" disabled={busy} onClick={() => void flipMode()}>
                  🔀 Режим
                </button>
              )}
              {confirmDel ? (
                <>
                  <button type="button" class="btn sm danger" disabled={busy} onClick={() => void del()}>
                    Точно удалить?
                  </button>
                  <button type="button" class="btn sm ghost" onClick={() => setConfirmDel(false)}>Нет</button>
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

function DeleteDebt({ api, nav, debt }: { api: Api; nav: Nav; debt: DebtDetail }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const del = async () => {
    setBusy(true);
    try {
      await api.del(`/api/tma/debts/${debt.id}`);
      nav.flash('Кредит удалён');
      nav.back();
    } catch (e) {
      setErr(apiErr(e, 'Не удалось удалить'));
      setBusy(false);
    }
  };
  return confirm ? (
    <div class="confirm">
      <p>Удалить «{debt.name}» вместе с журналом? Действие необратимо.</p>
      <div class="inline">
        <button type="button" class="btn danger" disabled={busy} onClick={() => void del()}>Да, удалить</button>
        <button type="button" class="btn ghost" onClick={() => setConfirm(false)}>Отмена</button>
      </div>
      <FormError msg={err} />
    </div>
  ) : (
    <button type="button" class="btn danger" onClick={() => setConfirm(true)}>🗑 Удалить кредит</button>
  );
}

// ── мастер добавления ──

export function DebtAddScreen({ api, nav }: ScreenProps) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [ccy, setCcy] = useState('');
  const [rate, setRate] = useState('');
  const [payment, setPayment] = useState('');
  const [freq, setFreq] = useState<'monthly' | 'biweekly'>('monthly');
  const [day, setDay] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const nErr = nameError(name);
    const aErr = amountError(amount);
    const cErr = currencyError(ccy);
    const r = parseAmount(rate);
    const rErr = r === null || r < 0 || r > 100 ? 'Ставка — число 0–100' : null;
    const pErr = amountError(payment);
    const dErr = dayError(day);
    const first = nErr ?? aErr ?? cErr ?? rErr ?? pErr ?? dErr;
    if (first) return setErr(first);
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/debts', {
        name: name.trim(),
        amount: parseAmount(amount),
        currency: ccy.trim().toUpperCase(),
        rate: r,
        payment: parseAmount(payment),
        frequency: freq,
        due_day: day.trim() ? Number(day.trim()) : null,
      });
      nav.flash('Кредит добавлен');
      nav.back();
    } catch (e) {
      setErr(apiErr(e, 'Не удалось добавить — проверьте соединение'));
      setBusy(false);
    }
    return undefined;
  };

  return (
    <>
      <h1>➕ Кредит</h1>
      <div class="card">
        <form onSubmit={(e) => void submit(e)}>
          <Field label="Название">
            <input maxLength={60} placeholder="например, Ипотека" value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)} autoFocus />
          </Field>
          <div class="inline">
            <Field label="Остаток долга">
              <input inputMode="decimal" placeholder="999000" value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Валюта (USD, RUB, KGS…)">
              <input maxLength={5} placeholder="USD" value={ccy}
                onInput={(e) => setCcy((e.target as HTMLInputElement).value)} />
            </Field>
          </div>
          <div class="inline">
            <Field label="Ставка, % годовых">
              <input inputMode="decimal" placeholder="12.5" value={rate}
                onInput={(e) => setRate((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Платёж за период">
              <input inputMode="decimal" placeholder="11000" value={payment}
                onInput={(e) => setPayment((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Периодичность">
              <select value={freq} onChange={(e) => setFreq((e.target as HTMLSelectElement).value as 'monthly' | 'biweekly')}>
                <option value="monthly">ежемесячно</option>
                <option value="biweekly">раз в 2 недели</option>
              </select>
            </Field>
          </div>
          <Field label="День платежа (1–31, пусто — без дня)">
            <input inputMode="numeric" maxLength={2} placeholder="—" value={day}
              onInput={(e) => setDay((e.target as HTMLInputElement).value)} />
          </Field>
          <FormError msg={err} />
          <button type="submit" class="btn" disabled={busy}>
            {busy ? 'Сохраняю…' : 'Добавить кредит'}
          </button>
        </form>
      </div>
    </>
  );
}
