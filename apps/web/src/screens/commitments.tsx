/**
 * commitments.tsx — регулярные платежи.
 *
 * CommitmentScreen: карточка платежа — PATCH amount + каденс
 *   (monthly/interval_days/yearly) и тогл active; удаление с подтверждением.
 * CommitmentAddScreen: name+amount+currency+каденс → POST.
 * После мутации — reload/возврат на экран-источник со свежими данными.
 */
import { useState } from 'preact/hooks';
import { Banknote, Bot, CircleCheck, History, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-preact';
import { ApiError } from '../api';
import type { Api, CommitmentChange, CommitmentChangesList, CommitmentPayment, CommitmentPaymentsList, CommitmentsList, Profile } from '../api';
import type { Nav, ScreenProps } from '../app';
import { amountError, currencyError, fmtDay, fmtMinor, nameError, parseAmount, todayIso } from '../fmt';
import {
  cardCls,
  CcySelect,
  confirmCls,
  dangerBtnCls,
  ErrorView,
  errorView,
  evEditCls,
  Field,
  FormError,
  ghostBtnCls,
  h1Cls,
  headCls,
  inputCls,
  listCardCls,
  Loading,
  mutedCls,
  primaryBtnCls,
  rowCls,
  smBtnCls,
  smDangerBtnCls,
  smDangerFillBtnCls,
  smGhostBtnCls,
  useData,
} from '../ui';

import { CadenceFields, cadenceBody, cadenceError, type UiFreq } from './cadence';

// ── карточка платежа ──

export function CommitmentScreen({
  api,
  nav,
  onFatal,
  commitmentId,
}: ScreenProps & { commitmentId: number }) {
  const q = useData(() => api.get<CommitmentsList>('/api/tma/commitments'), onFatal, []);
  const pays = useData(() => api.get<CommitmentPaymentsList>(`/api/tma/commitments/${commitmentId}/payments`), onFatal, [commitmentId]);
  const chg = useData(() => api.get<CommitmentChangesList>(`/api/tma/commitments/${commitmentId}/changes`), onFatal, [commitmentId]);
  const item = q.data?.commitments.find((x) => x.id === commitmentId);

  if (q.loading || pays.loading || chg.loading) return <Loading />;
  const qErr = q.error ?? pays.error ?? chg.error;
  if (qErr) {
    const v = errorView(qErr);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  if (!item) {
    return (
      <ErrorView
        title="Платёж не найден"
        text="Платёж уже удалён."
        onRetry={nav.back}
      />
    );
  }
  return (
    <CommitmentCard
      api={api}
      nav={nav}
      item={item}
      payments={pays.data?.payments ?? []}
      changes={chg.data?.changes ?? []}
      reload={() => {
        q.reload();
        pays.reload();
        chg.reload();
      }}
    />
  );
}

function CommitmentCard({
  api,
  nav,
  item,
  payments,
  changes,
  reload,
}: {
  api: Api;
  nav: Nav;
  item: CommitmentsList['commitments'][number];
  payments: CommitmentPayment[];
  changes: CommitmentChange[];
  reload: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [amount, setAmount] = useState(String(item.amount_minor / 100));
  const [ccy, setCcy] = useState(item.currency);
  const [freq, setFreq] = useState<UiFreq>(
    item.frequency === 'monthly' && item.every_months > 1 ? 'every_months' : item.frequency,
  );
  const [day, setDay] = useState(item.due_day ? String(item.due_day) : '');
  const [month, setMonth] = useState(item.due_month ? String(item.due_month) : '');
  const [every, setEvery] = useState(item.interval_days ? String(item.interval_days) : '');
  const [anchor, setAnchor] = useState(item.anchor_on ?? todayIso());
  const [everyM, setEveryM] = useState(item.every_months > 1 ? String(item.every_months) : '3');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [openEv, setOpenEv] = useState<number | null>(null);

  const save = async (ev: Event) => {
    ev.preventDefault();
    const nErr = nameError(name);
    const aErr = amountError(amount);
    const cErr = currencyError(ccy);
    const cdErr = cadenceError(freq, day, month, every, anchor, everyM);
    const first = nErr ?? aErr ?? cErr ?? cdErr;
    if (first) {
      setErr(first);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/commitments/${item.id}`, {
        name: name.trim(),
        amount: parseAmount(amount),
        currency: ccy.trim().toUpperCase(),
        ...cadenceBody(freq, day, month, every, anchor, everyM),
      });
      nav.flash('Платёж обновлён');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/commitments/${item.id}`, { active: !item.active });
      nav.flash(item.active ? 'Платёж выключен' : 'Платёж включён');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось переключить — проверьте соединение');
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.del(`/api/tma/commitments/${item.id}`);
      nav.flash('Платёж удалён');
      nav.back(); // → список платежей в профиле, перезагрузится
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось удалить — проверьте соединение');
      setBusy(false);
    }
  };

  return (
    <>
      <h1 class={h1Cls}>
        {item.name}
        {item.active ? '' : (
          <span class="flex items-center gap-1 text-sm font-normal text-zinc-500">
            <Pause size={14} strokeWidth={1.5} /> выключен
          </span>
        )}
      </h1>
      <div class={cardCls}>
        <form onSubmit={save}>
          <Field label="Название">
            <input
              class={inputCls}
              maxLength={60}
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </Field>
          <div class="flex gap-3">
            <Field label="Сумма">
              <input
                class={inputCls}
                inputMode="decimal"
                value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Валюта">
              <CcySelect value={ccy} onChange={setCcy} extra={[item.currency]} />
            </Field>
          </div>
          <CadenceFields
            freq={freq}
            setFreq={setFreq}
            day={day}
            setDay={setDay}
            month={month}
            setMonth={setMonth}
            every={every}
            setEvery={setEvery}
            anchor={anchor}
            setAnchor={setAnchor}
            everyM={everyM}
            setEveryM={setEveryM}
          />
          <p class={`${mutedCls} mb-2 flex items-center gap-1`}>
            {item.next_due_on ? `Срок ${fmtDay(item.next_due_on)}` : 'Этот месяц'}:{' '}
            {item.paid_this_month ? (
              <>
                <CircleCheck size={14} strokeWidth={1.5} class="text-emerald-400" />
                <span class="text-emerald-400">оплачен{item.last_paid_on ? ` ${fmtDay(item.last_paid_on)}` : ''}</span>
              </>
            ) : (
              'не оплачен'
            )}
          </p>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            Сохранить
          </button>
        </form>
      </div>

      <button type="button" class={`${ghostBtnCls} mt-1`} disabled={busy} onClick={() => void toggle()}>
        {item.active ? (
          <>
            <Pause size={16} strokeWidth={1.5} /> Выключить платёж
          </>
        ) : (
          <>
            <Play size={16} strokeWidth={1.5} /> Включить платёж
          </>
        )}
      </button>
      <p class={`${mutedCls} mt-1`}>
        Пауза — платёж останется в списке и журнале, но выпадет из «К оплате»
        и напоминаний.
      </p>

      <h2 class={`${headCls} mt-6`}>
        <History size={16} strokeWidth={1.5} /> Журнал оплат
      </h2>
      <div class={`${listCardCls} mt-2`}>
        {payments.length ? (
          <ul class="divide-y divide-line-soft">
            {[...payments].reverse().map((e) => (
              <PaymentRow
                key={e.id}
                api={api}
                ev={e}
                open={openEv === e.id}
                onToggle={() => setOpenEv(openEv === e.id ? null : e.id)}
                onDone={(m) => {
                  setOpenEv(null);
                  nav.flash(m);
                  reload();
                }}
              />
            ))}
          </ul>
        ) : (
          <p class={`${mutedCls} px-4 py-3`}>Оплат пока не было.</p>
        )}
      </div>

      {changes.length ? (
        <>
          <h2 class={`${headCls} mt-6`}>
            <Pencil size={16} strokeWidth={1.5} /> История изменений
          </h2>
          <ul class={`${listCardCls} mt-2 divide-y divide-line-soft`}>
            {changes.map((ch) => (
              <li key={ch.id} class="px-4 py-2 text-sm">
                <span class={mutedCls}>{fmtDay(ch.changed_at.slice(0, 10))} · </span>
                {changeText(ch, item.currency)}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {confirmDel ? (
        <div class={`${confirmCls} mt-3`}>
          <p class="text-sm">Удалить платёж «{item.name}»? Действие необратимо.</p>
          <div class="mt-2 flex gap-2">
            <button type="button" class={smDangerFillBtnCls} disabled={busy} onClick={() => void del()}>
              Да, удалить
            </button>
            <button
              type="button"
              class={smGhostBtnCls}
              disabled={busy}
              onClick={() => setConfirmDel(false)}
            >
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          class={`${dangerBtnCls} mt-3`}
          disabled={busy}
          onClick={() => setConfirmDel(true)}
        >
          <Trash2 size={16} strokeWidth={1.5} /> Удалить платёж
        </button>
      )}
    </>
  );
}

// ── история изменений ──

const FIELD_LABEL: Record<CommitmentChange['field'], string> = {
  name: 'Название',
  amount: 'Сумма',
  currency: 'Валюта',
  due_day: 'День платежа',
  active: 'Статус',
  cadence: 'Расписание',
};

function changeText(ch: CommitmentChange, ccy: string): string {
  const v = (x: string | null): string => {
    if (x === null || x === '') return '—';
    if (ch.field === 'amount') return fmtMinor(Number(x), ccy);
    if (ch.field === 'active') return x === '1' ? 'включён' : 'пауза';
    return x;
  };
  if (ch.field === 'cadence') return 'Расписание изменено';
  return `${FIELD_LABEL[ch.field]}: ${v(ch.old)} → ${v(ch.new)}`;
}

// ── журнал оплат ──

function PaymentRow({
  api,
  ev,
  open,
  onToggle,
  onDone,
}: {
  api: Api;
  ev: CommitmentPayment;
  open: boolean;
  onToggle: () => void;
  onDone: (m: string) => void;
}) {
  const [amount, setAmount] = useState(String(ev.amount_minor / 100));
  const [on, setOn] = useState(ev.paid_on);
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
      await api.patch(`/api/tma/commitment-payments/${ev.id}`, { amount: parseAmount(amount), paid_on: on });
      onDone('Оплата обновлена');
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : 'Не удалось сохранить');
      setBusy(false);
    }
    return undefined;
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.del(`/api/tma/commitment-payments/${ev.id}`);
      onDone('Оплата удалена');
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : 'Не удалось удалить');
      setBusy(false);
    }
  };

  return (
    <li class="px-4 py-3">
      <div class={`${rowCls} cursor-pointer`} onClick={onToggle}>
        <span class="flex items-center gap-1.5">
          <Banknote size={15} strokeWidth={1.5} class="text-zinc-500" /> Оплата
          {ev.source === 'auto' ? <Bot size={14} strokeWidth={1.5} class="text-zinc-500" /> : ''}
        </span>
        <span class={open ? 'text-sky-300' : ''}>
          {fmtDay(ev.paid_on)} · {fmtMinor(ev.amount_minor, ev.currency)}
        </span>
      </div>
      {open && (
        <div class={evEditCls}>
          <form onSubmit={(e) => void save(e)}>
            <div class="flex gap-3">
              <Field label="Сумма">
                <input class={inputCls} inputMode="decimal" value={amount}
                  onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
              </Field>
              <Field label="Дата">
                <input class={inputCls} type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
              </Field>
            </div>
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
                  <button type="button" class={smBtnCls} onClick={() => setConfirmDel(false)}>Нет</button>
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

// ── новый платёж ──

export function CommitmentAddScreen({ api, nav, onFatal }: ScreenProps) {
  const prof = useData(() => api.get<Profile>('/api/tma/profile'), onFatal, []);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [ccy, setCcy] = useState('');
  const [freq, setFreq] = useState<UiFreq>('monthly');
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [every, setEvery] = useState('');
  const [anchor, setAnchor] = useState(todayIso());
  const [everyM, setEveryM] = useState('3');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (prof.loading) return <Loading />;
  if (prof.error) {
    const v = errorView(prof.error);
    return <ErrorView title={v.title} text={v.text} onRetry={prof.reload} />;
  }
  const defCcy = prof.data?.income_currency ?? 'USD';

  const submit = async (ev: Event) => {
    ev.preventDefault();
    const nErr = nameError(name);
    const aErr = amountError(amount);
    const cErr = ccy.trim() ? currencyError(ccy) : null;
    const cdErr = cadenceError(freq, day, month, every, anchor, everyM);
    const first = nErr ?? aErr ?? cErr ?? cdErr;
    if (first) {
      setErr(first);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/commitments', {
        name: name.trim(),
        amount: parseAmount(amount),
        ...(ccy.trim() ? { currency: ccy.trim().toUpperCase() } : {}),
        ...cadenceBody(freq, day, month, every, anchor, everyM),
      });
      nav.flash('Платёж добавлен');
      nav.back(); // → список платежей, перезагрузится
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось добавить — проверьте соединение');
      setBusy(false);
    }
  };

  return (
    <>
      <h1 class={h1Cls}>
        <Plus size={20} strokeWidth={1.5} class="text-sky-400" /> Платёж
      </h1>
      <div class={cardCls}>
        <form onSubmit={submit}>
          <Field label="Название">
            <input
              class={inputCls}
              maxLength={60}
              placeholder="например, Интернет"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              autoFocus
            />
          </Field>
          <div class="flex gap-3">
            <Field label="Сумма">
              <input
                class={inputCls}
                inputMode="decimal"
                placeholder="600"
                value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Валюта">
              <CcySelect
                value={ccy}
                onChange={setCcy}
                extra={[defCcy]}
                allowEmpty
                emptyLabel={`${defCcy} · по умолч.`}
              />
            </Field>
          </div>
          <CadenceFields
            freq={freq}
            setFreq={setFreq}
            day={day}
            setDay={setDay}
            month={month}
            setMonth={setMonth}
            every={every}
            setEvery={setEvery}
            anchor={anchor}
            setAnchor={setAnchor}
            everyM={everyM}
            setEveryM={setEveryM}
          />
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            {busy ? 'Сохраняю…' : 'Добавить платёж'}
          </button>
        </form>
      </div>
    </>
  );
}
