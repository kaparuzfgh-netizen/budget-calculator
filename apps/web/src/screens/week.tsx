/**
 * week.tsx — «Неделя» и всё про траты.
 *
 * WeekScreen: сводка /api/tma/week (неделя, burn rate, дневной остаток,
 * месяц) + список трат недели /api/tma/expenses → карточка.
 * ExpenseScreen: карточка траты — правка (PATCH: сумма/валюта/заметка)
 * и удаление (DELETE, только с подтверждением); после мутации —
 * обратно на «Неделю», она перемонтируется и перезагрузит данные.
 * SpentAddScreen: форма сумма+валюта+заметка → POST /api/tma/expenses;
 * client_id = crypto.randomUUID() генерируется ОДИН раз при открытии
 * формы (useMemo []): повторный submit по сети-ретраю не дублирует запись.
 */
import { useMemo, useState } from 'preact/hooks';
import { ApiError } from '../api';
import type { Api, CategoriesList, ExpensesList, Profile, WeekStatus } from '../api';
import type { Nav, ScreenProps } from '../app';
import { amountError, currencyError, fmtDay, fmtMinor, fmtPct, noteError, parseAmount, todayIso } from '../fmt';
import { ErrorView, errorView, Field, FormError, Loading, useData } from '../ui';

// ── Неделя ──

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
      <h1>📅 Неделя</h1>
      <div class="card">
        <div class="row">
          <span>Потрачено</span>
          <b>
            {fmtMinor(w.week_spent_minor, c)} из {fmtMinor(w.week_budget_minor, c)}
          </b>
        </div>
        <div class="row">
          <span class="muted">Остаток недели</span>
          <span class={w.week_over ? 'err' : ''}>
            {fmtMinor(w.week_remaining_minor, c)}
            {w.week_over ? ' — перебор' : ''}
          </span>
        </div>
        <div class="row">
          <span class="muted">Burn rate</span>
          <span class={w.burn_rate > 1 ? 'warn' : ''}>{fmtPct(w.burn_rate)}</span>
        </div>
        <div class="row">
          <span class="muted">Можно в день</span>
          <span>
            {fmtMinor(w.daily_allowance_minor, c)} · {w.days_left} дн. до конца месяца
          </span>
        </div>
      </div>

      <h2>Месяц</h2>
      <div class="card">
        <div class="row">
          <span>Потрачено</span>
          <b>
            {fmtMinor(w.month_spent_minor, c)} из {fmtMinor(w.month_cap_minor, c)}
          </b>
        </div>
      </div>
      <p class="muted">Курсы на {w.fx_as_of || '—'}</p>

      <div class="row spread">
        <h2>Траты недели</h2>
        <button type="button" class="btn sm" onClick={() => nav.push({ id: 'spent-add' })}>
          ➕ Трата
        </button>
      </div>
      <div class="card">
        {ex.data.expenses.length ? (
          <ul class="plain">
            {ex.data.expenses.map((e) => (
              <li class="clickable" onClick={() => nav.push({ id: 'expense', expenseId: e.id })}>
                <div class="row">
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
          <p class="muted">Трат за неделю нет.</p>
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
  const q = useData(() => api.get<ExpensesList>('/api/tma/expenses'), onFatal, []);
  const item = q.data?.expenses.find((e) => e.id === expenseId);

  if (q.loading) return <Loading />;
  if (q.error) {
    const v = errorView(q.error);
    return <ErrorView title={v.title} text={v.text} onRetry={q.reload} />;
  }
  if (!item) {
    // запись удалена или ушла с этой недели — назад на список
    return (
      <ErrorView
        title="Запись не найдена"
        text="Трата уже удалена или вне этой недели."
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
      <h1>Трата · {fmtDay(item.spent_on)}</h1>
      <div class="card">
        <form onSubmit={save}>
          <div class="inline">
            <Field label="Сумма">
              <input
                inputMode="decimal"
                value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Валюта">
              <input
                maxLength={5}
                value={ccy}
                onInput={(e) => setCcy((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <Field label="Дата">
            <input
              type="date"
              max={todayIso()}
              min="2000-01-01"
              value={spentOn}
              onInput={(e) => setSpentOn((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Заметка">
            <input
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
          <button type="submit" class="btn" disabled={busy}>
            Сохранить
          </button>
        </form>
      </div>

      {confirmDel ? (
        <div class="confirm">
          <p>
            Удалить трату {fmtMinor(item.amount_minor, item.currency)}? Действие необратимо.
          </p>
          <div class="inline">
            <button type="button" class="btn danger" disabled={busy} onClick={() => void del()}>
              Да, удалить
            </button>
            <button
              type="button"
              class="btn ghost"
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
          class="btn danger"
          disabled={busy}
          onClick={() => setConfirmDel(true)}
        >
          🗑 Удалить трату
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
    <div class="chips">
      <button
        type="button"
        class={`chip${value === null ? ' on' : ''}`}
        onClick={() => onChange(null)}
      >
        {allowNone ? '❔ Без категории' : '✨ Авто'}
      </button>
      {q.data.categories.map((x) => (
        <button
          type="button"
          class={`chip${value === x.id ? ' on' : ''}`}
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
  // «Ещё ▸»: состояние раскрытия живёт, пока смонтирован компонент
  const [more, setMore] = useState(false);
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
        ...(more && spentOn ? { spent_on: spentOn } : {}),
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
      <h1>➕ Трата</h1>
      <div class="card">
        <form onSubmit={submit}>
          <div class="inline">
            <Field label="Сумма">
              <input
                inputMode="decimal"
                placeholder="например, 320"
                value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
                autoFocus
              />
            </Field>
            <Field label={`Валюта (по умолч. ${defCcy})`}>
              <input
                maxLength={5}
                placeholder={defCcy}
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
          <Field label="Категория">
            <CategoryChips api={api} onFatal={onFatal} value={catId} onChange={setCatId} />
          </Field>
          <button type="button" class="more" onClick={() => setMore(!more)}>
            {more ? 'Ещё ▾' : 'Ещё ▸'}
          </button>
          {more && (
            <Field label="Дата">
              <input
                type="date"
                max={todayIso()}
                min="2000-01-01"
                value={spentOn}
                onInput={(e) => setSpentOn((e.target as HTMLInputElement).value)}
              />
            </Field>
          )}
          <FormError msg={err} />
          <button type="submit" class="btn" disabled={busy}>
            {busy ? 'Записываю…' : 'Записать'}
          </button>
        </form>
      </div>
    </>
  );
}
