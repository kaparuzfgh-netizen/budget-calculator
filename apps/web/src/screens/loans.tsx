/**
 * loans.tsx — «Долги» (личные займы) в Mini App (веха H3).
 *
 * LoansScreen: GET /api/tma/loans — секции «Я должен»/«Мне должны» + итоги USD.
 * LoanScreen: GET /api/tma/loans/:id — карточка: Возврат (сумма/дата,
 *   «Вся сумма»), срок (дата или «без срока»), заметка, Закрыть
 *   (остаток прощается), Удалить; журнал возвратов — правка/удаление.
 * LoanAddScreen: POST /api/tma/loans.
 */
import { useState } from 'preact/hooks';
import {
  Banknote,
  CircleCheck,
  HandCoins,
  Handshake,
  History,
  Hourglass,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-preact';
import { ApiError } from '../api';
import type { Api, LoanDetail, LoanEvent, LoanItem, LoansList } from '../api';
import type { Nav, ScreenProps } from '../app';
import { amountError, currencyError, fmtDay, fmtMinor, nameError, parseAmount } from '../fmt';
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
  liCls,
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

const STATUS_LABEL = { open: 'открыт', partial: 'возвращается', closed: 'закрыт' } as const;
const apiErr = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : fallback;
const todayIso = () => new Date().toISOString().slice(0, 10);

const actionTileCls =
  'flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-zinc-900/80 py-3 text-[14px] font-medium text-zinc-100 transition hover:bg-zinc-800/80';
const actionTileOnCls =
  'flex items-center justify-center gap-1.5 rounded-xl border border-sky-500/60 bg-sky-500/15 py-3 text-[14px] font-medium text-sky-300';

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
      <h2 class={`${headCls} mt-6`}>{title}</h2>
      <div class={`${listCardCls} mt-2`}>
        {items.length ? (
          <ul class="divide-y divide-white/5">
            {items.map((x) => (
              <li
                class={`${liCls} cursor-pointer transition hover:bg-white/5${x.closed ? ' opacity-50' : ''}`}
                onClick={() => nav.push({ id: 'loan', loanId: x.id })}
              >
                <div class={rowCls}>
                  <span class="flex items-center gap-1.5 text-[15px] text-zinc-100">
                    {x.counterparty}
                    {x.closed ? <CircleCheck size={14} strokeWidth={1.5} class="text-emerald-400" /> : ''}
                  </span>
                  <span>{fmtMinor(x.closed ? x.amount_minor : x.remaining_minor, x.currency)}</span>
                </div>
                <div class={`${rowCls} mt-1`}>
                  <span class={mutedCls}>
                    {STATUS_LABEL[x.status]}
                    {x.due_on && !x.closed ? ` · до ${fmtDay(x.due_on)}` : ''}
                  </span>
                  <span class={mutedCls}>{x.repaid_minor > 0 && !x.closed ? `вернул ${fmtMinor(x.repaid_minor, x.currency)}` : ''}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class={`${mutedCls} px-4 py-3`}>Пусто.</p>
        )}
      </div>
      {total !== null && items.length > 0 && <p class={`${mutedCls} mt-2`}>Итого: ≈ {fmtMinor(total, 'USD')}</p>}
    </>
  );

  return (
    <>
      <div class="mb-5 flex items-center justify-between">
        <h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Handshake size={20} strokeWidth={1.5} class="text-sky-400" /> Долги
        </h1>
        <button type="button" class={smBtnCls} onClick={() => nav.push({ id: 'loan-add' })}>
          <Plus size={14} strokeWidth={1.5} /> Добавить
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
      <h1 class={h1Cls}>
        {v.counterparty}
        {v.closed ? (
          <span class="flex items-center gap-1 text-sm font-normal text-emerald-400">
            <CircleCheck size={15} strokeWidth={1.5} /> закрыт
          </span>
        ) : (
          ''
        )}
      </h1>
      <div class={cardCls}>
        <div class={rowCls}>
          <span>{v.direction === 'owe' ? 'Я должен' : 'Мне должны'}</span>
          <span class="text-2xl font-semibold">{fmtMinor(v.remaining_minor, v.currency)}</span>
        </div>
        <div class={`${rowCls} mt-2`}>
          <span class={mutedCls}>
            Заём {fmtMinor(v.amount_minor, v.currency)}
            {v.repaid_minor > 0 ? ` · возвращено ${fmtMinor(v.repaid_minor, v.currency)}` : ''}
          </span>
          <span class={mutedCls}>{STATUS_LABEL[v.status]}</span>
        </div>
        {v.due_on && !v.closed && (
          <div class={`${rowCls} mt-2`}>
            <span class={mutedCls}>Срок</span>
            <span class={mutedCls}>{fmtDay(v.due_on)}</span>
          </div>
        )}
        {v.closed && v.last_event_on && (
          <div class={`${rowCls} mt-2`}>
            <span class={mutedCls}>Закрыт</span>
            <span class={mutedCls}>{fmtDay(v.last_event_on)}</span>
          </div>
        )}
        {v.note && <p class={`${mutedCls} mt-2`}>Заметка: {v.note}</p>}
      </div>

      {/* закрыт по журналу (status) ИЛИ вручную (closed_at) — операций нет, журнал доступен */}
      {v.status !== 'closed' && (
        <div class="mt-4 grid grid-cols-2 gap-2.5">
          <button type="button" class={action === 'repay' ? actionTileOnCls : actionTileCls} onClick={() => toggle('repay')}>
            <HandCoins size={16} strokeWidth={1.5} /> Возврат
          </button>
          <button type="button" class={action === 'due' ? actionTileOnCls : actionTileCls} onClick={() => toggle('due')}>
            <Hourglass size={16} strokeWidth={1.5} /> Срок
          </button>
        </div>
      )}

      {action === 'repay' && <RepayForm api={api} loan={v} done={done} />}
      {action === 'due' && <DueForm api={api} loan={v} done={done} />}

      <h2 class={`${headCls} mt-6`}>
        <History size={16} strokeWidth={1.5} /> Журнал
      </h2>
      <div class={`${listCardCls} mt-2`}>
        {v.events.length ? (
          <ul class="divide-y divide-white/5">
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
          <p class={`${mutedCls} px-4 py-3`}>Возвратов пока не было.</p>
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
    <div class={`${cardCls} mt-3`}>
      <form onSubmit={(e) => void submit(e)}>
        <div class="flex gap-3">
          <Field
            label={
              <>
                Сумма <span class="text-zinc-500">· остаток {fmtMinor(loan.remaining_minor, loan.currency)}</span>
              </>
            }
          >
            <input class={inputCls} inputMode="decimal" value={amount}
              onInput={(e) => setAmount((e.target as HTMLInputElement).value)} autoFocus />
          </Field>
          <Field label="Дата">
            <input class={inputCls} type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
        <FormError msg={err} />
        <div class="flex gap-2">
          <button type="submit" class={primaryBtnCls} disabled={busy}>Записать</button>
          <button type="button" class={ghostBtnCls} disabled={busy}
            onClick={(e) => void submit(e, loan.remaining_minor / 100)}>
            Вся сумма
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
    <div class={`${cardCls} mt-3`}>
      <form onSubmit={(e) => { e.preventDefault(); void save(on); }}>
        <Field
          label={
            <>
              Срок возврата <span class="text-zinc-500">· сейчас {loan.due_on ? fmtDay(loan.due_on) : 'без срока'}</span>
            </>
          }
        >
          <input class={inputCls} type="date" value={on} onInput={(e) => setOn((e.target as HTMLInputElement).value)} />
        </Field>
        <FormError msg={err} />
        <div class="flex gap-2">
          <button type="submit" class={primaryBtnCls} disabled={busy}>Сохранить</button>
          {loan.due_on && (
            <button type="button" class={ghostBtnCls} disabled={busy} onClick={() => void save(null)}>
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
    <div class={`${confirmCls} mt-3`}>
      <p class="text-sm">Закрыть заём? Остаток {fmtMinor(loan.remaining_minor, loan.currency)} будет прощён.</p>
      <div class="mt-2 flex gap-2">
        <button type="button" class={smDangerFillBtnCls} disabled={busy} onClick={() => void close()}>Да, закрыть</button>
        <button type="button" class={smGhostBtnCls} onClick={() => setConfirm(false)}>Отмена</button>
      </div>
      <FormError msg={err} />
    </div>
  ) : (
    <button type="button" class={`${primaryBtnCls} mt-3`} onClick={() => setConfirm(true)}>
      <CircleCheck size={16} strokeWidth={1.5} /> Закрыть заём
    </button>
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
    <div class={`${confirmCls} mt-3`}>
      <p class="text-sm">Удалить заём «{loan.counterparty}» вместе с журналом?</p>
      <div class="mt-2 flex gap-2">
        <button type="button" class={smDangerFillBtnCls} disabled={busy} onClick={() => void del()}>Да, удалить</button>
        <button type="button" class={smGhostBtnCls} onClick={() => setConfirm(false)}>Отмена</button>
      </div>
      <FormError msg={err} />
    </div>
  ) : (
    <button type="button" class={`${dangerBtnCls} mt-3`} onClick={() => setConfirm(true)}>
      <Trash2 size={16} strokeWidth={1.5} /> Удалить заём
    </button>
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
    <li class="px-4 py-3">
      <div class={`${rowCls} cursor-pointer`} onClick={onToggle}>
        <span class="flex items-center gap-1.5">
          <Banknote size={15} strokeWidth={1.5} class="text-zinc-500" /> Возврат
        </span>
        <span class={open ? 'text-sky-300' : ''}>
          {fmtDay(ev.event_on)} · {fmtMinor(ev.amount_minor, currency)}
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
  const [cid] = useState(() => crypto.randomUUID()); // client_id на форму — retry не задвоит (P2-3)

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
        client_id: cid,
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
      <h1 class={h1Cls}>
        <Plus size={20} strokeWidth={1.5} class="text-sky-400" /> Заём
      </h1>
      <div class={cardCls}>
        <form onSubmit={(e) => void submit(e)}>
          <Field label="Направление">
            <div class="flex gap-2">
              <button type="button" class={`${direction === 'owe' ? actionTileOnCls : actionTileCls} flex-1`} onClick={() => setDirection('owe')}>
                Я должен
              </button>
              <button type="button" class={`${direction === 'owed' ? actionTileOnCls : actionTileCls} flex-1`} onClick={() => setDirection('owed')}>
                Мне должны
              </button>
            </div>
          </Field>
          <Field label="Кому / кто">
            <input class={inputCls} maxLength={60} placeholder="например, Вася" value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)} autoFocus />
          </Field>
          <div class="flex gap-3">
            <Field label="Сумма">
              <input class={inputCls} inputMode="decimal" placeholder="300" value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Валюта">
              <CcySelect value={ccy} onChange={setCcy} />
            </Field>
            <Field
              label={
                <>
                  Срок <span class="text-zinc-500">· пусто — без срока</span>
                </>
              }
            >
              <input class={inputCls} type="date" value={due} onInput={(e) => setDue((e.target as HTMLInputElement).value)} />
            </Field>
          </div>
          <Field label="Заметка (необязательно)">
            <input class={inputCls} maxLength={200} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          </Field>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            {busy ? 'Сохраняю…' : 'Добавить заём'}
          </button>
        </form>
      </div>
    </>
  );
}
