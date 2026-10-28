/**
 * loans.tsx — «🤝 Долги» (личные займы) в Mini App (веха H3).
 *
 * LoansScreen: GET /api/tma/loans — секции «Я должен»/«Мне должны» + итоги USD.
 * LoanScreen: GET /api/tma/loans/:id — карточка: 💸 Возврат (сумма/дата,
 *   «💯 Вся сумма»), ⏳ срок (дата или «без срока»), заметка, ✅ Закрыть
 *   (остаток прощается), 🗑 Удалить; журнал возвратов — правка/удаление.
 * LoanAddScreen: POST /api/tma/loans.
 */
import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import type { Api, LoanDetail, LoanEvent, LoanItem, LoansList } from '../api';
import type { Nav, ScreenProps } from '../app';
import { amountError, currencyError, fmtDay, fmtMinor, nameError, parseAmount } from '../fmt';
import { ErrorView, errorView, Field, FormError, Loading, useData } from '../ui';

const STATUS_LABEL = { open: 'открыт', partial: 'возвращается', closed: 'закрыт' } as const;
const apiErr = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : fallback;
const todayIso = () => new Date().toISOString().slice(0, 10);

// ── список ──

export function LoansScreen({ api, nav, onFatal }: ScreenProps) {
  const q = useData(() => api.get<LoansList>('/api/tma/loans'), onFatal, []);

  if (q.loading) return <Loading />;
  if (q.error || !q.data) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  const d = q.data;

  const section = (title: string, items: LoanItem[], total: number | null) => (
    <>
      <h2>{title}</h2>
      <div class="card">
        {items.length ? (
          <ul class="plain">
            {items.map((x) => (
              <li class={`clickable${x.closed ? ' off' : ''}`} onClick={() => nav.push({ id: 'loan', loanId: x.id })}>
                <div class="row">
                  <span>
                    {x.counterparty}
                    {x.closed ? ' · ✅' : ''}
                  </span>
                  <span>{fmtMinor(x.closed ? x.amount_minor : x.remaining_minor, x.currency)}</span>
                </div>
                <div class="row muted">
                  <span>
                    {STATUS_LABEL[x.status]}
                    {x.due_on && !x.closed ? ` · до ${fmtDay(x.due_on)}` : ''}
                  </span>
                  <span>{x.repaid_minor > 0 && !x.closed ? `вернул ${fmtMinor(x.repaid_minor, x.currency)}` : ''}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">Пусто.</p>
        )}
      </div>
      {total !== null && items.length > 0 && <p class="muted">Итого: ≈ {fmtMinor(total, 'USD')}</p>}
    </>
  );

  return (
    <>
      <div class="row spread">
        <h1>🤝 Долги</h1>
        <button type="button" class="btn sm" onClick={() => nav.push({ id: 'loan-add' })}>
          ➕ Добавить
        </button>
      </div>
      {section('Я должен', d.owe, d.owe_usd_minor)}
      {section('Мне должны', d.owed, d.owed_usd_minor)}
    </>
  );
}

// ── карточка ──

type Action = 'repay' | 'due' | null;

export function LoanScreen({ api, nav, onFatal, loanId }: ScreenProps & { loanId: number }) {
  const q = useData(() => api.get<LoanDetail>(`/api/tma/loans/${loanId}`), onFatal, [loanId]);
  const [action, setAction] = useState<Action>(null);
  const [openEv, setOpenEv] = useState<number | null>(null);

  if (q.loading) return <Loading />;
  if (q.error) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  if (!q.data) return <ErrorView title="Заём не найден" text="Заём уже удалён." onRetry={nav.back} />;
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

  return (
    <>
      <h1>
        {v.counterparty}
        {v.closed ? ' · ✅ закрыт' : ''}
      </h1>
      <div class="card">
        <div class="row">
          <span>{v.direction === 'owe' ? 'Я должен' : 'Мне должны'}</span>
          <span class="big">{fmtMinor(v.remaining_minor, v.currency)}</span>
        </div>
        <div class="row muted">
          <span>
            Заём {fmtMinor(v.amount_minor, v.currency)}
            {v.repaid_minor > 0 ? ` · возвращено ${fmtMinor(v.repaid_minor, v.currency)}` : ''}
          </span>
          <span>{STATUS_LABEL[v.status]}</span>
        </div>
        {v.due_on && !v.closed && (
          <div class="row muted">
            <span>Срок</span>
            <span>{fmtDay(v.due_on)}</span>
          </div>
        )}
        {v.closed && v.last_event_on && (
          <div class="row muted">
            <span>Закрыт</span>
            <span>{fmtDay(v.last_event_on)}</span>
          </div>
        )}
        {v.note && <p class="muted">Заметка: {v.note}</p>}
      </div>

      {/* закрыт по журналу (status) ИЛИ вручную (closed_at) — операций нет, журнал доступен */}
      {v.status !== 'closed' && (
        <div class="menu">
          <button type="button" class={`btn${action === 'repay' ? ' on' : ''}`} onClick={() => toggle('repay')}>
            💸 Возврат
          </button>
          <button type="button" class={`btn${action === 'due' ? ' on' : ''}`} onClick={() => toggle('due')}>
            ⏳ Срок
          </button>
        </div>
      )}

      {action === 'repay' && <RepayForm api={api} loan={v} done={done} />}
      {action === 'due' && <DueForm api={api} loan={v} done={done} />}

      <h2>📜 Журнал</h2>
      <div class="card">
        {v.events.length ? (
          <ul class="plain">
            {[...v.events].reverse().map((e) => (
              <LoanEventRow
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
          <p class="muted">Возвратов пока не было.</p>
        )}
      </div>

      {v.status !== 'closed' && <CloseLoan api={api} loan={v} done={done} />}
      <DeleteLoan api={api} nav={nav} loan={v} />
    </>
  );
}

// ── формы ──

function RepayForm({ api, loan, done }: { api: Api; loan: LoanDetail; done: (m: string) => void }) {
  const [amount, setAmount] = useState('');
  const [on, setOn] = useState(todayIso());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cid] = useState(() => crypto.randomUUID());

  const submit = async (ev: Event, amountOverride?: number) => {
    ev.preventDefault();
    const a = amountOverride ?? parseAmount(amount);
    const remaining = loan.remaining_minor / 100;
    if (a === null || a <= 0) return setErr('Сумма — число больше нуля');
    if (a > remaining + 0.005) return setErr(`Больше остатка (${fmtMinor(loan.remaining_minor, loan.currency)})`);
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/tma/loans/${loan.id}/events`, { amount: a, event_on: on, client_id: cid });
      done('Возврат записан');
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
          <Field label={`Сумма (остаток ${fmtMinor(loan.remaining_minor, loan.currency)})`}>
            <input inputMode="decimal" value={amount}
              onInput={(e) => setAmount((e.target as HTMLInputElement).value)} autoFocus />
          </Field>
          <Field label="Дата">
            <input type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <FormError msg={err} />
        <div class="inline">
          <button type="submit" class="btn" disabled={busy}>Записать</button>
          <button type="button" class="btn ghost" disabled={busy}
            onClick={(e) => void submit(e, loan.remaining_minor / 100)}>
            💯 Вся сумма
          </button>
        </div>
      </form>
    </div>
  );
}

function DueForm({ api, loan, done }: { api: Api; loan: LoanDetail; done: (m: string) => void }) {
  const [on, setOn] = useState(loan.due_on ?? todayIso());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (due_on: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/loans/${loan.id}`, { due_on });
      done(due_on ? 'Срок обновлён' : 'Срок снят');
    } catch (e) {
      setErr(apiErr(e, 'Не удалось сохранить'));
      setBusy(false);
    }
  };

  return (
    <div class="card">
      <form onSubmit={(e) => { e.preventDefault(); void save(on); }}>
        <Field label={`Срок возврата (сейчас ${loan.due_on ? fmtDay(loan.due_on) : 'без срока'})`}>
          <input type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
        </Field>
        <FormError msg={err} />
        <div class="inline">
          <button type="submit" class="btn" disabled={busy}>Сохранить</button>
          {loan.due_on && (
            <button type="button" class="btn ghost" disabled={busy} onClick={() => void save(null)}>
              Без срока
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function CloseLoan({ api, loan, done }: { api: Api; loan: LoanDetail; done: (m: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const close = async () => {
    setBusy(true);
    try {
      await api.post(`/api/tma/loans/${loan.id}/close`);
      done('Заём закрыт');
    } catch (e) {
      setErr(apiErr(e, 'Не удалось закрыть'));
      setBusy(false);
    }
  };
  return confirm ? (
    <div class="confirm">
      <p>Закрыть заём? Остаток {fmtMinor(loan.remaining_minor, loan.currency)} будет прощён.</p>
      <div class="inline">
        <button type="button" class="btn danger" disabled={busy} onClick={() => void close()}>Да, закрыть</button>
        <button type="button" class="btn ghost" onClick={() => setConfirm(false)}>Отмена</button>
      </div>
      <FormError msg={err} />
    </div>
  ) : (
    <button type="button" class="btn" onClick={() => setConfirm(true)}>✅ Закрыть заём</button>
  );
}

function DeleteLoan({ api, nav, loan }: { api: Api; nav: Nav; loan: LoanDetail }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const del = async () => {
    setBusy(true);
    try {
      await api.del(`/api/tma/loans/${loan.id}`);
      nav.flash('Заём удалён');
      nav.back();
    } catch (e) {
      setErr(apiErr(e, 'Не удалось удалить'));
      setBusy(false);
    }
  };
  return confirm ? (
    <div class="confirm">
      <p>Удалить заём «{loan.counterparty}» вместе с журналом?</p>
      <div class="inline">
        <button type="button" class="btn danger" disabled={busy} onClick={() => void del()}>Да, удалить</button>
        <button type="button" class="btn ghost" onClick={() => setConfirm(false)}>Отмена</button>
      </div>
      <FormError msg={err} />
    </div>
  ) : (
    <button type="button" class="btn danger" onClick={() => setConfirm(true)}>❌ Удалить заём</button>
  );
}

// ── журнал возвратов ──

function LoanEventRow({
  api, ev, currency, open, onToggle, onDone,
}: {
  api: Api;
  ev: LoanEvent;
  currency: string;
  open: boolean;
  onToggle: () => void;
  onDone: (m: string) => void;
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
      await api.patch(`/api/tma/loan-events/${ev.id}`, { amount: parseAmount(amount), event_on: on });
      onDone('Возврат обновлён — остаток пересчитан');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось сохранить'));
      setBusy(false);
    }
    return undefined;
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.del(`/api/tma/loan-events/${ev.id}`);
      onDone('Возврат удалён — остаток пересчитан');
    } catch (ex) {
      setErr(apiErr(ex, 'Не удалось удалить'));
      setBusy(false);
    }
  };

  return (
    <li>
      <div class={`row clickable${open ? ' on' : ''}`} onClick={onToggle}>
        <span>💸 Возврат</span>
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

// ── мастер добавления ──

export function LoanAddScreen({ api, nav }: ScreenProps) {
  const [direction, setDirection] = useState<'owe' | 'owed'>('owe');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [ccy, setCcy] = useState('');
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const nErr = nameError(name);
    const aErr = amountError(amount);
    const cErr = currencyError(ccy);
    const first = nErr ?? aErr ?? cErr;
    if (first) return setErr(first);
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/loans', {
        counterparty: name.trim(),
        direction,
        amount: parseAmount(amount),
        currency: ccy.trim().toUpperCase(),
        due_on: due || null,
        note: note.trim() || null,
      });
      nav.flash('Заём добавлен');
      nav.back();
    } catch (e) {
      setErr(apiErr(e, 'Не удалось добавить — проверьте соединение'));
      setBusy(false);
    }
    return undefined;
  };

  return (
    <>
      <h1>➕ Заём</h1>
      <div class="card">
        <form onSubmit={(e) => void submit(e)}>
          <Field label="Направление">
            <div class="inline">
              <button type="button" class={`btn sm${direction === 'owe' ? ' on' : ''}`} onClick={() => setDirection('owe')}>
                Я должен
              </button>
              <button type="button" class={`btn sm${direction === 'owed' ? ' on' : ''}`} onClick={() => setDirection('owed')}>
                Мне должны
              </button>
            </div>
          </Field>
          <Field label="Кому / кто">
            <input maxLength={60} placeholder="например, Вася" value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)} autoFocus />
          </Field>
          <div class="inline">
            <Field label="Сумма">
              <input inputMode="decimal" placeholder="300" value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Валюта">
              <input maxLength={5} placeholder="USD" value={ccy}
                onInput={(e) => setCcy((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Срок (пусто — без срока)">
              <input type="date" value={due} onInput={(e) => setDue((e.target as HTMLInputElement).value)} />
            </Field>
          </div>
          <Field label="Заметка (необязательно)">
            <input maxLength={200} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          </Field>
          <FormError msg={err} />
          <button type="submit" class="btn" disabled={busy}>
            {busy ? 'Сохраняю…' : 'Добавить заём'}
          </button>
        </form>
      </div>
    </>
  );
}
