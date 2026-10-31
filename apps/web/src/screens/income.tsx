/**
 * income.tsx — «Доход»: итог месяца и записи /api/tma/income.
 * Добавление — инлайн-форма (POST с client_id; новый uuid на каждое
 * ОТКРЫТИЕ формы, не на submit). Удаление записи — только после
 * подтверждения; после мутаций список перезагружается (reload).
 */
import { useState } from 'preact/hooks';
import { Banknote, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-preact';
import { ApiError } from '../api';
import type { IncomeList } from '../api';
import type { ScreenProps } from '../app';
import { amountError, currencyError, fmtDay, fmtMinor, noteError, parseAmount, todayIso } from '../fmt';
import {
  cardCls,
  confirmCls,
  ErrorView,
  errorView,
  Field,
  FormError,
  h1Cls,
  headCls,
  inputCls,
  listCardCls,
  Loading,
  mutedCls,
  primaryBtnCls,
  rowBtnCls,
  rowCls,
  smDangerFillBtnCls,
  smGhostBtnCls,
  useData,
} from '../ui';

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
      <h1 class={h1Cls}>
        <Banknote size={20} strokeWidth={1.5} class="text-sky-400" /> Доход · {d.month}
      </h1>
      <div class={cardCls}>
        <div class="text-2xl font-semibold">{fmtMinor(d.total_minor, d.currency)}</div>
        <div class={`${mutedCls} mt-0.5`}>итог месяца в валюте профиля</div>
      </div>

      <h2 class={`${headCls} mt-6`}>Записи месяца</h2>
      <div class={`${listCardCls} mt-2`}>
        {d.entries.length ? (
          <ul class="divide-y divide-white/5">
            {d.entries.map((e) => (
              <li class="px-4 py-3">
                <div class={rowCls}>
                  <span>
                    {e.received_on ? `${fmtDay(e.received_on)} · ` : ''}
                    {fmtMinor(e.amount_minor, e.currency)}
                    {e.note ? ` · ${e.note}` : ''}
                  </span>
                  {confirmId === e.id ? null : (
                    <button
                      type="button"
                      class={`${rowBtnCls} hover:text-red-400`}
                      disabled={busyId !== null}
                      onClick={() => setConfirmId(e.id)}
                    >
                      <Trash2 size={15} strokeWidth={1.5} />
                    </button>
                  )}
                </div>
                {confirmId === e.id && (
                  <div class={confirmCls}>
                    <p class="text-sm">Удалить запись {fmtMinor(e.amount_minor, e.currency)}?</p>
                    <div class="mt-2 flex gap-2">
                      <button
                        type="button"
                        class={smDangerFillBtnCls}
                        disabled={busyId !== null}
                        onClick={() => void del(e.id)}
                      >
                        Да, удалить
                      </button>
                      <button
                        type="button"
                        class={smGhostBtnCls}
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
          <p class={`${mutedCls} px-4 py-3`}>Записей за месяц нет — итог считается по базовому доходу.</p>
        )}
        {err && <p class="px-4 pb-3 text-sm text-red-400">{err}</p>}
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
          class={`${primaryBtnCls} mt-4`}
          onClick={() => setForm({ open: true, clientId: crypto.randomUUID() })}
        >
          <Plus size={16} strokeWidth={1.5} /> Добавить доход
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
    <div class={`${cardCls} mt-4`}>
      <form onSubmit={submit}>
        <div class="flex gap-3">
          <Field label="Сумма">
            <input
              class={inputCls}
              inputMode="decimal"
              placeholder="например, 7500"
              value={amount}
              onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
              autoFocus
            />
          </Field>
          <Field label={`Валюта (по умолч. ${defaultCcy})`}>
            <input
              class={inputCls}
              maxLength={5}
              placeholder={defaultCcy}
              value={ccy}
              onInput={(e) => setCcy((e.target as HTMLInputElement).value)}
            />
          </Field>
        </div>
        <Field label="Заметка">
          <input
            class={inputCls}
            maxLength={200}
            placeholder="необязательно"
            value={note}
            onInput={(e) => setNote((e.target as HTMLInputElement).value)}
          />
        </Field>
        <button
          type="button"
          class="mb-3 flex items-center gap-1 text-[13px] text-sky-400 transition hover:text-sky-300"
          onClick={() => setMore(!more)}
        >
          {more ? (
            <>
              Ещё <ChevronDown size={14} strokeWidth={1.5} />
            </>
          ) : (
            <>
              Ещё <ChevronRight size={14} strokeWidth={1.5} />
            </>
          )}
        </button>
        {more && (
          <Field label="Дата получения">
            <input
              class={inputCls}
              type="date"
              max={todayIso()}
              min="2000-01-01"
              value={receivedOn}
              onInput={(e) => setReceivedOn((e.target as HTMLInputElement).value)}
            />
          </Field>
        )}
        <FormError msg={err} />
        <button type="submit" class={primaryBtnCls} disabled={busy}>
          {busy ? 'Записываю…' : 'Записать доход'}
        </button>
      </form>
    </div>
  );
}
