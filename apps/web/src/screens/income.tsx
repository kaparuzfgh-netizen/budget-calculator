/**
 * income.tsx — «Доход»: итог месяца и записи /api/tma/income.
 * Добавление — инлайн-форма (POST с client_id; новый uuid на каждое
 * ОТКРЫТИЕ формы, не на submit). Удаление записи — только после
 * подтверждения; после мутаций список перезагружается (reload).
 */
import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import type { IncomeList } from '../api';
import type { ScreenProps } from '../app';
import { amountError, currencyError, fmtDay, fmtMinor, noteError, parseAmount, todayIso } from '../fmt';
import { ErrorView, errorView, Field, FormError, Loading, useData } from '../ui';

export function IncomeScreen({ api, nav, onFatal }: ScreenProps) {
  const q = useData(() => api.get<IncomeList>('/api/tma/income'), onFatal, []);
  const [form, setForm] = useState<{ open: boolean; clientId: string }>({ open: false, clientId: '' });
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (q.loading) return <Loading />;
  if (q.error || !q.data) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  const d = q.data;

  const del = async (id: number) => {
    setBusyId(id);
    setErr(null);
    try {
      await api.del(`/api/tma/income/${id}`);
      nav.flash('Запись дохода удалена');
      setConfirmId(null);
      q.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось удалить — проверьте соединение');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <h1>💵 Доход · {d.month}</h1>
      <div class="card">
        <div class="big">{fmtMinor(d.total_minor, d.currency)}</div>
        <div class="muted">итог месяца в валюте профиля</div>
      </div>

      <h2>Записи месяца</h2>
      <div class="card">
        {d.entries.length ? (
          <ul class="plain">
            {d.entries.map((e) => (
              <li>
                <div class="row">
                  <span>
                    {e.received_on ? `${fmtDay(e.received_on)} · ` : ''}
                    {fmtMinor(e.amount_minor, e.currency)}
                    {e.note ? ` · ${e.note}` : ''}
                  </span>
                  {confirmId === e.id ? null : (
                    <button
                      type="button"
                      class="rowbtn"
                      disabled={busyId !== null}
                      onClick={() => setConfirmId(e.id)}
                    >
                      🗑
                    </button>
                  )}
                </div>
                {confirmId === e.id && (
                  <div class="confirm">
                    <p>Удалить запись {fmtMinor(e.amount_minor, e.currency)}?</p>
                    <div class="inline">
                      <button
                        type="button"
                        class="btn danger sm"
                        disabled={busyId !== null}
                        onClick={() => void del(e.id)}
                      >
                        Да, удалить
                      </button>
                      <button
                        type="button"
                        class="btn ghost sm"
                        disabled={busyId !== null}
                        onClick={() => setConfirmId(null)}
                      >
                        Отмена
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">Записей за месяц нет — итог считается по типичному доходу.</p>
        )}
        <FormError msg={err} />
      </div>

      {form.open ? (
        <IncomeAddForm
          api={api}
          clientId={form.clientId}
          defaultCcy={d.currency}
          onDone={(msg) => {
            nav.flash(msg);
            setForm({ open: false, clientId: '' });
            q.reload();
          }}
        />
      ) : (
        <button
          type="button"
          class="btn"
          onClick={() => setForm({ open: true, clientId: crypto.randomUUID() })}
        >
          ➕ Добавить доход
        </button>
      )}
    </>
  );
}

function IncomeAddForm({
  api,
  clientId,
  defaultCcy,
  onDone,
}: {
  api: ScreenProps['api'];
  clientId: string; // один uuid на открытие формы — идемпотентность ретраев
  defaultCcy: string;
  onDone: (msg: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [ccy, setCcy] = useState('');
  const [note, setNote] = useState('');
  // «Ещё ▸»: состояние раскрытия живёт, пока смонтирован компонент
  const [more, setMore] = useState(false);
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const aErr = amountError(amount);
    const cErr = ccy.trim() ? currencyError(ccy) : null;
    const nErr = noteError(note);
    if (aErr || cErr || nErr) {
      setErr(aErr ?? cErr ?? nErr);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/income', {
        amount: parseAmount(amount),
        ...(ccy.trim() ? { currency: ccy.trim().toUpperCase() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(more && receivedOn ? { received_on: receivedOn } : {}),
        client_id: clientId,
      });
      onDone('Доход записан');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось записать — проверьте соединение');
      setBusy(false);
    }
  };

  return (
    <div class="card">
      <form onSubmit={submit}>
        <div class="inline">
          <Field label="Сумма">
            <input
              inputMode="decimal"
              placeholder="например, 7500"
              value={amount}
              onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
              autoFocus
            />
          </Field>
          <Field label={`Валюта (по умолч. ${defaultCcy})`}>
            <input
              maxLength={5}
              placeholder={defaultCcy}
              value={ccy}
              onInput={(e) => setCcy((e.target as HTMLInputElement).value)}
            />
          </Field>
        </div>
        <Field label="Заметка">
          <input
            maxLength={200}
            placeholder="необязательно"
            value={note}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
        </Field>
        <button type="button" class="more" onClick={() => setMore(!more)}>
          {more ? 'Ещё ▾' : 'Ещё ▸'}
        </button>
        {more && (
          <Field label="Дата получения">
            <input
              type="date"
              max={todayIso()}
              min="2000-01-01"
              value={receivedOn}
              onInput={(e) => setReceivedOn((e.target as HTMLInputElement).value)}
            />
          </Field>
        )}
        <FormError msg={err} />
        <button type="submit" class="btn" disabled={busy}>
          {busy ? 'Записываю…' : 'Записать доход'}
        </button>
      </form>
    </div>
  );
}
