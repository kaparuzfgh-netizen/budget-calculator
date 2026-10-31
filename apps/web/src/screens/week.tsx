/**
 * week.tsx — «Траты»: журнал расходов.
 *
 * WeekScreen: список трат недели /api/tma/expenses → карточка; контекст
 * недели — одной строкой из /api/tma/week (статус бюджета — на «Обзоре»).
 * ExpenseScreen: карточка траты — правка (PATCH: сумма/валюта/заметка)
 * и удаление (DELETE, только с подтверждением); после мутации —
 * обратно на «Траты», экран перемонтируется и перезагрузит данные.
 * SpentAddScreen: форма сумма+валюта+заметка → POST /api/tma/expenses;
 * client_id = crypto.randomUUID() генерируется ОДИН раз при открытии
 * формы (useMemo []): повторный submit по сети-ретраю не дублирует запись.
 */
import { useMemo, useState } from 'preact/hooks';
import {
  CircleHelp,
  Plus,
  Receipt,
  Sparkles,
  Trash2,
} from 'lucide-preact';
import { ApiError } from '../api';
import type { Api, CategoriesList, ExpenseItem, ExpensesList, Profile, WeekStatus } from '../api';
import type { Nav, ScreenProps } from '../app';
import { amountError, currencyError, fmtDay, fmtMinor, noteError, parseAmount, todayIso } from '../fmt';
import {
  cardCls,
  CcySelect,
  confirmCls,
  dangerBtnCls,
  ErrorView,
  errorView,
  Field,
  FormError,
  h1Cls,
  headCls,
  Info,
  inputCls,
  liCls,
  listCardCls,
  Loading,
  mutedCls,
  primaryBtnCls,
  rowCls,
  smBtnCls,
  smDangerFillBtnCls,
  smGhostBtnCls,
  useData,
} from '../ui';
import { ShotButton } from './vision';

const chipCls =
  'inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-zinc-900 px-3.5 py-2 text-[13px] text-zinc-300 transition hover:border-white/20';
const chipOnCls =
  'inline-flex items-center gap-1.5 rounded-full border border-sky-500/60 bg-sky-500/15 px-3.5 py-2 text-[13px] text-sky-300';

// ── Траты ──

export function WeekScreen({ api, nav, onFatal }: ScreenProps) {
  const wk = useData(() => api.get<WeekStatus>('/api/tma/week'), onFatal, []);
  const ex = useData(() => api.get<ExpensesList>('/api/tma/expenses'), onFatal, []);
  const ct = useData(() => api.get<CategoriesList>('/api/tma/categories'), onFatal, []);

  if (wk.loading || ex.loading || ct.loading) return <Loading />;
  const err = wk.error ?? ex.error ?? ct.error;
  if (err || !wk.data || !ex.data || !ct.data) {
    const v = errorView(err);
    return (
      <ErrorView
        title={v.title}
        text={v.text}
        onRetry={() => {
          wk.reload();
          ex.reload();
        }}
      />
    );
  }
  const w = wk.data;
  const c = w.currency;
  const catEmoji = new Map(ct.data.categories.map((x) => [x.id, x.emoji]));

  return (
    <>
      <h1 class={h1Cls}>
        <Receipt size={20} strokeWidth={1.5} class="text-sky-400" /> Траты
      </h1>
      <p class={mutedCls}>
        Неделя {fmtDay(w.week_from)} – {fmtDay(w.week_to)} · потрачено{' '}
        {fmtMinor(w.week_spent_minor, c)} · осталось {fmtMinor(w.week_remaining_minor, c)}
      </p>

      <div class="mt-5 flex items-center justify-between">
        <h2 class={headCls}>Записи</h2>
        <button type="button" class={smBtnCls} onClick={() => nav.push({ id: 'spent-add' })}>
          <Plus size={14} strokeWidth={1.5} /> Трата
        </button>
      </div>
      <div class={`${listCardCls} mt-2`}>
        {ex.data.expenses.length ? (
          <ul class="divide-y divide-white/5">
            {ex.data.expenses.map((e) => (
              <li
                class={`${liCls} cursor-pointer transition hover:bg-white/5`}
                onClick={() => nav.push({ id: 'expense', expenseId: e.id })}
              >
                <div class={rowCls}>
                  <span>
                    {fmtDay(e.spent_on)}
                    {e.category_id ? ` ${catEmoji.get(e.category_id) ?? ''}` : ''}
                    {e.note ? ` · ${e.note}` : ''}
                  </span>
                  <span>{fmtMinor(e.amount_minor, e.currency)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class={`${mutedCls} px-4 py-3`}>Трат за неделю нет.</p>
        )}
      </div>
    </>
  );
}

// ── карточка траты ──

export function ExpenseScreen({
  api,
  nav,
  onFatal,
  expenseId,
}: ScreenProps & { expenseId: number }) {
  // по id — запись доступна из любого места (неделя, отчёты), не только из
  // недельного списка
  const q = useData(
    () => api.get<{ expense: ExpenseItem }>(`/api/tma/expenses/${expenseId}`),
    onFatal,
    [expenseId],
  );
  const item = q.data?.expense;

  if (q.loading) return <Loading />;
  if (q.error) {
    // 404 — запись реально удалена; сетевые/прочие ошибки — общий вид
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <ErrorView
          title="Запись не найдена"
          text="Трата уже удалена."
          onRetry={nav.back}
        />
      );
    }
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  if (!item) {
    return (
      <ErrorView
        title="Запись не найдена"
        text="Трата уже удалена."
        onRetry={nav.back}
      />
    );
  }
  return <ExpenseCard api={api} nav={nav} item={item} reload={q.reload} />;
}

function ExpenseCard({
  api,
  nav,
  item,
  reload,
}: {
  api: Api;
  nav: Nav;
  item: ExpensesList['expenses'][number];
  reload: () => void;
}) {
  const [amount, setAmount] = useState(String(item.amount_minor / 100));
  const [ccy, setCcy] = useState(item.currency);
  const [note, setNote] = useState(item.note ?? '');
  const [catId, setCatId] = useState<number | null>(item.category_id);
  const [spentOn, setSpentOn] = useState(item.spent_on);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const save = async (ev: Event) => {
    ev.preventDefault();
    const aErr = amountError(amount);
    const cErr = currencyError(ccy);
    const nErr = noteError(note);
    if (aErr || cErr || nErr) {
      setErr(aErr ?? cErr ?? nErr);
      return;
    }
    if (!spentOn) {
      setErr('Укажите дату траты');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/expenses/${item.id}`, {
        amount: parseAmount(amount),
        currency: ccy.trim().toUpperCase(),
        note: note.trim() || null,
        category_id: catId,
        spent_on: spentOn,
      });
      nav.flash('Трата обновлена');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.del(`/api/tma/expenses/${item.id}`);
      nav.flash('Трата удалена');
      nav.back(); // → «Неделя», перемонтируется и перезагрузит список
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось удалить — проверьте соединение');
      setBusy(false);
    }
  };

  return (
    <>
      <h1 class={h1Cls}>Трата · {fmtDay(item.spent_on)}</h1>
      <div class={cardCls}>
        <form onSubmit={save}>
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
          <Field label="Дата">
            <input
              class={inputCls}
              type="date"
              max={todayIso()}
              min="2000-01-01"
              value={spentOn}
              onInput={(e) => setSpentOn((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Заметка">
            <input
              class={inputCls}
              maxLength={200}
              placeholder="необязательно"
              value={note}
              onInput={(e) => setNote((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Категория">
            <CategoryChips api={api} value={catId} onChange={setCatId} allowNone />
          </Field>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            Сохранить
          </button>
        </form>
      </div>

      {confirmDel ? (
        <div class={`${confirmCls} mt-3`}>
          <p class="text-sm">
            Удалить трату {fmtMinor(item.amount_minor, item.currency)}? Действие необратимо.
          </p>
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
          <Trash2 size={16} strokeWidth={1.5} /> Удалить трату
        </button>
      )}
    </>
  );
}

// ── чипы категорий ──

function CategoryChips({
  api,
  onFatal = () => {},
  value,
  onChange,
  allowNone = false,
}: {
  api: Api;
  onFatal?: () => void;
  value: number | null;
  onChange: (v: number | null) => void;
  allowNone?: boolean;
}) {
  const q = useData(() => api.get<CategoriesList>('/api/tma/categories'), onFatal, []);
  if (q.loading || q.error || !q.data) return null;
  return (
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        class={value === null ? chipOnCls : chipCls}
        onClick={() => onChange(null)}
      >
        {allowNone ? (
          <>
            <CircleHelp size={14} strokeWidth={1.5} /> Без категории
          </>
        ) : (
          <>
            <Sparkles size={14} strokeWidth={1.5} /> Авто
          </>
        )}
      </button>
      {q.data.categories.map((x) => (
        <button
          type="button"
          class={value === x.id ? chipOnCls : chipCls}
          onClick={() => onChange(x.id)}
        >
          {x.emoji} {x.name}
        </button>
      ))}
    </div>
  );
}

// ── +Трата ──

export function SpentAddScreen({ api, nav, onFatal }: ScreenProps) {
  // client_id идемпотентности — ровно один раз при открытии формы:
  // повторный submit/ретрай переиспользует его → сервер ответит duplicate.
  const clientId = useMemo(() => crypto.randomUUID(), []);
  const prof = useData(() => api.get<Profile>('/api/tma/profile'), onFatal, []);
  const [amount, setAmount] = useState('');
  const [ccy, setCcy] = useState('');
  const [note, setNote] = useState('');
  const [catId, setCatId] = useState<number | null>(null);
  const [spentOn, setSpentOn] = useState(todayIso());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (prof.loading) return <Loading />;
  if (prof.error) {
    const v = errorView(prof.error);
    return <ErrorView title={v.title} text={v.text} onRetry={prof.reload} />;
  }
  const defCcy = prof.data?.expense_currency ?? prof.data?.living_currency ?? 'USD';

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
      await api.post('/api/tma/expenses', {
        amount: parseAmount(amount),
        ...(ccy.trim() ? { currency: ccy.trim().toUpperCase() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(catId !== null ? { category_id: catId } : {}),
        ...(spentOn ? { spent_on: spentOn } : {}),
        client_id: clientId,
      });
      nav.flash('Трата записана');
      nav.back(); // → экран-источник с заново загруженными данными
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось записать — проверьте соединение');
      setBusy(false);
    }
  };

  return (
    <>
      <h1 class={h1Cls}>
        <Plus size={20} strokeWidth={1.5} class="text-sky-400" /> Трата
      </h1>
      <div class={cardCls}>
        <form onSubmit={submit}>
          <div class="flex gap-3">
            <Field label="Сумма">
              <input
                class={inputCls}
                inputMode="decimal"
                placeholder="например, 320"
                value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
                autoFocus
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
          <div class="flex gap-3">
            <Field label="Заметка">
              <input
                class={inputCls}
                maxLength={200}
                placeholder="необязательно"
                value={note}
                onInput={(e) => setNote((e.target as HTMLInputElement).value)}
              />
            </Field>
            <div class="w-36 flex-none">
              <Field label="Дата">
                <input
                  class={inputCls}
                  type="date"
                  max={todayIso()}
                  min="2000-01-01"
                  value={spentOn}
                  onInput={(e) => setSpentOn((e.target as HTMLInputElement).value)}
                />
              </Field>
            </div>
          </div>
          <Field
            label={
              <>
                Категория
                <Info title="Категория «Авто»">
                  Категория подбирается по словам заметки: «такси» → Транспорт,
                  «аптека» → Здоровье, «подписка» → Связь и подписки. Свои категории
                  распознаются по названию. Если совпадения нет — трата останется
                  без категории. При разборе скриншота «Авто» работает так же.
                </Info>
              </>
            }
          >
            <CategoryChips api={api} onFatal={onFatal} value={catId} onChange={setCatId} />
          </Field>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            {busy ? 'Записываю…' : 'Записать'}
          </button>
        </form>
      </div>

      {/* 📷 загрузка банковского скриншота — opt-in (Профиль → ⚡️ Возможности) */}
      <ShotButton api={api} nav={nav} onFatal={onFatal} enabled={!!prof.data?.vision_enabled} />
    </>
  );
}
