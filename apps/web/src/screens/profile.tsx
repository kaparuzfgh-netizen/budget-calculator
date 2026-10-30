/**
 * profile.tsx — «Профиль» и регулярные платежи.
 *
 * ProfileScreen: GET /api/tma/profile + /api/tma/commitments.
 *   Секции: ДОХОД (валюта + «Базовый доход» под «Ещё ▸»; 0 — вычисляется),
 *   БЮДЖЕТ (living_cap+living_currency+expense_currency — сервер пересчитает
 *   недельный бюджет ×12/52), ЧАСОВОЙ ПОЯС, НАПОМИНАНИЯ (4 переключателя),
 *   ДАННЫЕ (экспорт JSON через getBlob; удаление — в боте).
 * CommitmentScreen: карточка платежа — PATCH amount/due_day и
 *   тогл active; удаление только с подтверждением.
 * CommitmentAddScreen: name+amount+currency+due_day → POST.
 * После мутации — reload/возврат на экран-источник со свежими данными.
 */
import { useState } from 'preact/hooks';
import { ApiError } from '../api';
import type { Api, CommitmentPayment, CommitmentPaymentsList, CommitmentsList, Profile } from '../api';
import type { Nav, ScreenProps } from '../app';
import {
  amountError,
  currencyError,
  dayError,
  fmtDay,
  fmtMinor,
  nameError,
  parseAmount,
  timezoneError,
  todayIso,
} from '../fmt';
import { ErrorView, errorView, Field, FormError, Loading, useData, useFatalOn } from '../ui';

const TZ_PRESETS = ['Europe/Moscow', 'Asia/Bishkek', 'Europe/Berlin', 'UTC'] as const;

// ── Профиль ──

export function ProfileScreen({ api, nav, onFatal }: ScreenProps) {
  const prof = useData(() => api.get<Profile>('/api/tma/profile'), onFatal, []);
  const com = useData(() => api.get<CommitmentsList>('/api/tma/commitments'), onFatal, []);
  // профиль без онбординга — как «нет доступа» (завершить /start в боте)
  useFatalOn(prof.data !== undefined && !prof.data.onboarded, onFatal);

  if (prof.loading || com.loading) return <Loading />;
  const err = prof.error ?? com.error;
  if (err || !prof.data || !com.data || !prof.data.onboarded) {
    const v = errorView(err);
    return (
      <ErrorView
        title={v.title}
        text={v.text}
        onRetry={() => {
          prof.reload();
          com.reload();
        }}
      />
    );
  }
  const p = prof.data;

  return (
    <>
      <h1>⚙️ Профиль</h1>
      <ProfileForms key={profileKey(p)} api={api} nav={nav} p={p} reload={prof.reload} />

      <div class="row spread">
        <h2>🧾 Регулярные платежи</h2>
        <button
          type="button"
          class="btn sm"
          onClick={() => nav.push({ id: 'commitment-add' })}
        >
          ➕ Добавить
        </button>
      </div>
      <p class="muted">Аренда, связь, подписки — списываются каждый месяц. Кредиты — отдельно в 🏦.</p>
      <div class="card">
        {com.data.commitments.length ? (
          <ul class="plain">
            {com.data.commitments.map((x) => (
              <li
                class={`clickable${x.active ? '' : ' off'}`}
                onClick={() => nav.push({ id: 'commitment', commitmentId: x.id })}
              >
                <div class="row">
                  <span>
                    {x.name}
                    {x.active ? '' : ' · ⏸'}
                  </span>
                  <span>
                    {fmtMinor(x.amount_minor, x.currency)}
                    {x.due_day ? ` · ${x.due_day} числа` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">Регулярных платежей нет.</p>
        )}
      </div>
    </>
  );
}

/** fingerprint профиля — remount форм при изменении значений после PATCH. */
function profileKey(p: Profile): string {
  return [
    p.typical_income_minor,
    p.income_currency,
    p.living_cap_minor,
    p.living_currency,
    p.expense_currency,
    p.timezone,
  ].join('|');
}

// ── формы профиля ──

/** Переключатель-«тогл» в стиле iOS: PATCH по change, без submit-кнопки. */
function Switch({
  label,
  hint,
  checked,
  busy,
  onToggle,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div class="row spread switch-row">
      <span>
        {label}
        {hint ? <span class="muted switch-hint">{hint}</span> : null}
      </span>
      <label class="switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={() => onToggle()}
        />
        <i />
      </label>
    </div>
  );
}

const REMINDERS: { key: 'reminders_weekly' | 'reminders_payments' | 'fx_alerts_enabled' | 'vision_enabled'; label: string; hint: string }[] = [
  { key: 'reminders_weekly', label: 'Еженедельный итог', hint: 'вс 20:00 — траты недели' },
  { key: 'reminders_payments', label: 'Платежи и сроки', hint: 'за 2 дня до срока, 10:00' },
  { key: 'fx_alerts_enabled', label: '💱 Алерты по курсам', hint: 'выгодные моменты для обмена' },
  { key: 'vision_enabled', label: '📷 Скриншоты банка', hint: 'распознавание — фото уходит в Google AI' },
];

function ProfileForms({
  api,
  nav,
  p,
  reload,
}: {
  api: Api;
  nav: Nav;
  p: Profile;
  reload: () => void;
}) {
  // базовый доход (0 = «вычисляется» — поле скрыто за «Ещё ▸»)
  const [inc, setInc] = useState(String((p.typical_income_minor ?? 0) / 100 || ''));
  const [incCcy, setIncCcy] = useState(p.income_currency ?? 'USD');
  const [incMore, setIncMore] = useState(false);
  const [incErr, setIncErr] = useState<string | null>(null);
  const [incBusy, setIncBusy] = useState(false);

  // бюджет (месячный + валюта трат по умолчанию)
  const [cap, setCap] = useState(String((p.living_cap_minor ?? 0) / 100 || ''));
  const [capCcy, setCapCcy] = useState(p.living_currency ?? 'USD');
  const [expCcy, setExpCcy] = useState(p.expense_currency ?? '');
  const [capErr, setCapErr] = useState<string | null>(null);
  const [capBusy, setCapBusy] = useState(false);

  // таймзона
  const cur = p.timezone ?? 'UTC';
  const preset = (TZ_PRESETS as readonly string[]).includes(cur);
  const [tzSel, setTzSel] = useState<string>(preset ? cur : '__custom');
  const [tzCustom, setTzCustom] = useState(preset ? '' : cur);
  const [tzErr, setTzErr] = useState<string | null>(null);
  const [tzBusy, setTzBusy] = useState(false);

  // напоминания — переключатели сразу PATCH'ат
  const [remBusy, setRemBusy] = useState(false);
  const [remErr, setRemErr] = useState<string | null>(null);

  // экспорт
  const [expBusy, setExpBusy] = useState(false);
  const [expErr, setExpErr] = useState<string | null>(null);

  const saveIncome = async (ev: Event) => {
    ev.preventDefault();
    const n = parseAmount(inc);
    if (n === null || n < 0) return setIncErr('Сумма — число ≥ 0 (0 — вычисляется)');
    if (n > 1e9) return setIncErr('Слишком большая сумма');
    const cErr = currencyError(incCcy);
    if (cErr) return setIncErr(cErr);
    setIncBusy(true);
    setIncErr(null);
    try {
      await api.patch('/api/tma/profile', {
        typical_income: n,
        income_currency: incCcy.trim().toUpperCase(),
      });
      nav.flash('Доход сохранён');
      reload();
    } catch (e) {
      setIncErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setIncBusy(false);
    }
    return undefined;
  };

  const saveCap = async (ev: Event) => {
    ev.preventDefault();
    const aErr = amountError(cap);
    const cErr = currencyError(capCcy);
    const eErr = expCcy.trim() ? currencyError(expCcy) : null;
    if (aErr || cErr || eErr) {
      setCapErr(aErr ?? cErr ?? eErr);
      return;
    }
    setCapBusy(true);
    setCapErr(null);
    try {
      await api.patch('/api/tma/profile', {
        living_cap: parseAmount(cap),
        living_currency: capCcy.trim().toUpperCase(),
        // пусто → null: валюта трат снова = валюта бюджета
        expense_currency: expCcy.trim() ? expCcy.trim().toUpperCase() : null,
      });
      nav.flash('Бюджет сохранён — недельный пересчитан');
      reload();
    } catch (e) {
      setCapErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setCapBusy(false);
    }
  };

  const saveTz = async (ev: Event) => {
    ev.preventDefault();
    const tz = tzSel === '__custom' ? tzCustom : tzSel;
    const tErr = timezoneError(tz);
    if (tErr) {
      setTzErr(tErr);
      return;
    }
    setTzBusy(true);
    setTzErr(null);
    try {
      await api.patch('/api/tma/profile', { timezone: tz.trim() });
      nav.flash('Таймзона сохранена');
      reload();
    } catch (e) {
      setTzErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setTzBusy(false);
    }
  };

  const toggleReminder = async (key: (typeof REMINDERS)[number]['key'], value: boolean) => {
    setRemBusy(true);
    setRemErr(null);
    try {
      await api.patch('/api/tma/profile', { [key]: value });
      nav.flash('Напоминания обновлены');
      reload();
    } catch (e) {
      setRemErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setRemBusy(false);
    }
  };

  const doExport = async () => {
    setExpBusy(true);
    setExpErr(null);
    try {
      const blob = await api.getBlob('/api/tma/export');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `budget-export-${todayIso()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      nav.flash('Экспорт скачан');
    } catch (e) {
      setExpErr(e instanceof ApiError ? e.message : 'Не удалось выгрузить — проверьте соединение');
    } finally {
      setExpBusy(false);
    }
  };

  return (
    <>
      <h2>💵 Доход</h2>
      <div class="card">
        <div class="row">
          <span>Записи месяца — факт дохода</span>
          <button type="button" class="rowbtn" onClick={() => nav.push({ id: 'income' })}>
            Открыть →
          </button>
        </div>
        <form onSubmit={saveIncome}>
          <Field label="Валюта доходов (по умолчанию)">
            <input
              maxLength={5}
              value={incCcy}
              onInput={(e) => setIncCcy((e.target as HTMLInputElement).value)}
            />
          </Field>
          {p.baseline_source === 'computed' && (p.typical_income_minor ?? 0) === 0 ? (
            <p class="muted">
              Базовый доход: ≈ {fmtMinor(p.baseline_income_minor ?? 0, p.income_currency ?? 'USD')} — вычисляется:
              платежи + бюджет + кредиты
            </p>
          ) : null}
          <button type="button" class="more" onClick={() => setIncMore(!incMore)}>
            {incMore ? 'Ещё ▾' : 'Ещё ▸'}
          </button>
          {incMore && (
            <>
              <Field label="Базовый доход">
                <input
                  inputMode="decimal"
                  placeholder="например, 6200"
                  value={inc}
                  onInput={(e) => setInc((e.target as HTMLInputElement).value)}
                />
              </Field>
              <p class="muted">0 — вычисляется: платежи + бюджет + кредиты</p>
            </>
          )}
          <FormError msg={incErr} />
          <button type="submit" class="btn" disabled={incBusy}>
            Сохранить
          </button>
        </form>
      </div>

      <h2>💸 Бюджет</h2>
      <div class="card">
        <form onSubmit={saveCap}>
          <div class="inline">
            <Field label="Бюджет на месяц">
              <input
                inputMode="decimal"
                value={cap}
                onInput={(e) => setCap((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Валюта">
              <input
                maxLength={5}
                value={capCcy}
                onInput={(e) => setCapCcy((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <Field label="Валюта повседневных трат (по умолчанию)">
            <input
              maxLength={5}
              placeholder={capCcy}
              value={expCcy}
              onInput={(e) => setExpCcy((e.target as HTMLInputElement).value)}
            />
          </Field>
          <p class="muted">пусто — как валюта бюджета; в форме траты можно выбрать другую</p>
          <p class="muted">
            Недельный бюджет: {fmtMinor(p.weekly_budget_minor ?? 0, p.living_currency ?? 'USD')}
          </p>
          <FormError msg={capErr} />
          <button type="submit" class="btn" disabled={capBusy}>
            Сохранить
          </button>
        </form>
      </div>

      <h2>🌍 Часовой пояс</h2>
      <div class="card">
        <form onSubmit={saveTz}>
          <Field label="Таймзона (IANA)">
            <select
              value={tzSel}
              onChange={(e) => setTzSel((e.target as HTMLSelectElement).value)}
            >
              {TZ_PRESETS.map((tz) => (
                <option value={tz}>{tz}</option>
              ))}
              <option value="__custom">Другая…</option>
            </select>
          </Field>
          {tzSel === '__custom' && (
            <Field label="Своя таймзона">
              <input
                placeholder="например, Asia/Almaty"
                value={tzCustom}
                onInput={(e) => setTzCustom((e.target as HTMLInputElement).value)}
              />
            </Field>
          )}
          <FormError msg={tzErr} />
          <button type="submit" class="btn" disabled={tzBusy}>
            Сохранить пояс
          </button>
        </form>
      </div>

      <h2>🔔 Напоминания</h2>
      <div class="card">
        {REMINDERS.map((r) => (
          <Switch
            key={r.key}
            label={r.label}
            hint={r.hint}
            checked={!!p[r.key]}
            busy={remBusy}
            onToggle={() => void toggleReminder(r.key, !p[r.key])}
          />
        ))}
        <FormError msg={remErr} />
      </div>

      <h2>🗄 Данные</h2>
      <div class="card">
        <p class="muted">Экспорт — JSON со всеми вашими данными (профиль, платежи, траты, доход).</p>
        <button type="button" class="btn" disabled={expBusy} onClick={() => void doExport()}>
          {expBusy ? 'Готовлю файл…' : '📤 Экспорт данных (JSON)'}
        </button>
        <FormError msg={expErr} />
        <p class="muted">Удаление данных — через бота: /profile → 🗄 Мои данные → 🗑 Удалить всё.</p>
      </div>
    </>
  );
}

// ── карточка платежа ──

export function CommitmentScreen({
  api,
  nav,
  onFatal,
  commitmentId,
}: ScreenProps & { commitmentId: number }) {
  const q = useData(() => api.get<CommitmentsList>('/api/tma/commitments'), onFatal, []);
  const pays = useData(() => api.get<CommitmentPaymentsList>(`/api/tma/commitments/${commitmentId}/payments`), onFatal, [commitmentId]);
  const item = q.data?.commitments.find((x) => x.id === commitmentId);

  if (q.loading || pays.loading) return <Loading />;
  const qErr = q.error ?? pays.error;
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
      reload={() => {
        q.reload();
        pays.reload();
      }}
    />
  );
}

function CommitmentCard({
  api,
  nav,
  item,
  payments,
  reload,
}: {
  api: Api;
  nav: Nav;
  item: CommitmentsList['commitments'][number];
  payments: CommitmentPayment[];
  reload: () => void;
}) {
  const [amount, setAmount] = useState(String(item.amount_minor / 100));
  const [day, setDay] = useState(item.due_day ? String(item.due_day) : '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [openEv, setOpenEv] = useState<number | null>(null);
  // client_id стабилен на время жизни формы — повторные тапы не дублируют запись
  const [paidCid] = useState(() => crypto.randomUUID());

  const save = async (ev: Event) => {
    ev.preventDefault();
    const aErr = amountError(amount);
    const dErr = dayError(day);
    if (aErr || dErr) {
      setErr(aErr ?? dErr);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/api/tma/commitments/${item.id}`, {
        amount: parseAmount(amount),
        due_day: day.trim() ? Number(day.trim()) : null,
      });
      nav.flash('Платёж обновлён');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setBusy(false);
    }
  };

  const markPaid = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/tma/commitments/${item.id}/payments`, { client_id: paidCid });
      nav.flash('Оплата записана');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось записать — проверьте соединение');
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
      <h1>
        {item.name}
        {item.active ? '' : ' · ⏸ выключен'}
      </h1>
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
            <Field label="День месяца (1–31, пусто — без дня)">
              <input
                inputMode="numeric"
                maxLength={2}
                placeholder="—"
                value={day}
                onInput={(e) => setDay((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <p class="muted">Валюта: {item.currency}</p>
          <p class="muted">
            Этот месяц:{' '}
            {item.paid_this_month ? `✅ оплачен ${item.last_paid_on ? fmtDay(item.last_paid_on) : ''}` : 'не оплачен'}
          </p>
          <p class="muted">В день срока бот отметит оплату сам, напомнит за 2 дня.</p>
          <FormError msg={err} />
          <button type="submit" class="btn" disabled={busy}>
            Сохранить
          </button>
        </form>
      </div>

      {!item.paid_this_month && (
        <button type="button" class="btn" disabled={busy} onClick={() => void markPaid()}>
          ✅ Отметить оплаченным
        </button>
      )}

      <button type="button" class="btn ghost" disabled={busy} onClick={() => void toggle()}>
        {item.active ? '⏸ Выключить платёж' : '▶ Включить платёж'}
      </button>

      <h2>📜 Журнал оплат</h2>
      <div class="card">
        {payments.length ? (
          <ul class="plain">
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
          <p class="muted">Оплат пока не было.</p>
        )}
      </div>

      {confirmDel ? (
        <div class="confirm">
          <p>Удалить платёж «{item.name}»? Действие необратимо.</p>
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
          🗑 Удалить платёж
        </button>
      )}
    </>
  );
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
    <li>
      <div class={`row clickable${open ? ' on' : ''}`} onClick={onToggle}>
        <span>💸 Оплата{ev.source === 'auto' ? ' 🤖' : ''}</span>
        <span>
          {fmtDay(ev.paid_on)} · {fmtMinor(ev.amount_minor, ev.currency)}
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

// ── новый платёж ──

export function CommitmentAddScreen({ api, nav, onFatal }: ScreenProps) {
  const prof = useData(() => api.get<Profile>('/api/tma/profile'), onFatal, []);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [ccy, setCcy] = useState('');
  const [day, setDay] = useState('');
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
    const dErr = dayError(day);
    const first = nErr ?? aErr ?? cErr ?? dErr;
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
        due_day: day.trim() ? Number(day.trim()) : null,
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
      <h1>➕ Платёж</h1>
      <div class="card">
        <form onSubmit={submit}>
          <Field label="Название">
            <input
              maxLength={60}
              placeholder="например, Интернет"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              autoFocus
            />
          </Field>
          <div class="inline">
            <Field label="Сумма">
              <input
                inputMode="decimal"
                placeholder="600"
                value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
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
            <Field label="День (1–31)">
              <input
                inputMode="numeric"
                maxLength={2}
                placeholder="—"
                value={day}
                onInput={(e) => setDay((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <FormError msg={err} />
          <button type="submit" class="btn" disabled={busy}>
            {busy ? 'Сохраняю…' : 'Добавить платёж'}
          </button>
        </form>
      </div>
    </>
  );
}
