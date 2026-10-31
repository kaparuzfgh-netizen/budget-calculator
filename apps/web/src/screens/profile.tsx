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
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import {
  Banknote,
  Bell,
  Bot,
  CalendarClock,
  Camera,
  CircleCheck,
  Database,
  Globe,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  Receipt,
  Settings,
  Trash2,
  TrendingUp,
  Upload,
  Wallet,
} from 'lucide-preact';
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
import {
  cardCls,
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
  Info,
  inputCls,
  liCls,
  listCardCls,
  Loading,
  mutedCls,
  primaryBtnCls,
  rowCls,
  secondaryBtnCls,
  smBtnCls,
  smDangerBtnCls,
  smDangerFillBtnCls,
  smGhostBtnCls,
  useData,
  useFatalOn,
} from '../ui';

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

  const payments = (
    <>
      <div class="mt-6 flex items-center justify-between">
        <h2 class={headCls}>
          <CalendarClock size={16} strokeWidth={1.5} /> Регулярные платежи
          <Info title="Регулярные платежи">
            <p>
              Аренда, связь, подписки, ЖКХ — то, что списывается каждый месяц.
            </p>
            <p>
              В день срока бот отметит оплату сам и напомнит за 2 дня. Кредиты —
              отдельный раздел, здесь их добавлять не нужно.
            </p>
          </Info>
        </h2>
        <button
          type="button"
          class={smBtnCls}
          onClick={() => nav.push({ id: 'commitment-add' })}
        >
          <Plus size={14} strokeWidth={1.5} /> Добавить
        </button>
      </div>
      <div class={`${listCardCls} mt-2`}>
        {com.data.commitments.length ? (
          <ul class="divide-y divide-white/5">
            {com.data.commitments.map((x) => (
              <li
                class={`${liCls} cursor-pointer transition hover:bg-white/5${x.active ? '' : ' opacity-50'}`}
                onClick={() => nav.push({ id: 'commitment', commitmentId: x.id })}
              >
                <div class={rowCls}>
                  <span class="flex items-center gap-1.5">
                    {x.name}
                    {x.active ? '' : <Pause size={13} strokeWidth={1.5} class="text-zinc-500" />}
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
          <p class={`${mutedCls} px-4 py-3`}>Регулярных платежей нет — добавьте первый.</p>
        )}
      </div>
    </>
  );

  return (
    <>
      <h1 class={h1Cls}>
        <Settings size={20} strokeWidth={1.5} class="text-sky-400" /> Профиль
      </h1>
      <ProfileForms
        key={profileKey(p)}
        api={api}
        nav={nav}
        p={p}
        reload={prof.reload}
        payments={payments}
      />
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
  icon,
  label,
  hint,
  checked,
  busy,
  onToggle,
}: {
  icon: ComponentChildren;
  label: string;
  hint?: string | undefined;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div class="flex items-center justify-between gap-3 px-4 py-3">
      <span class="flex items-center gap-2.5 text-[15px] text-zinc-100">
        {icon}
        <span>
          {label}
          {hint ? <span class="mt-0.5 block text-xs text-zinc-400">{hint}</span> : null}
        </span>
      </span>
      <span class="relative inline-flex h-[27px] w-[46px] flex-none cursor-pointer items-center">
        <input
          type="checkbox"
          class="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
          checked={checked}
          disabled={busy}
          onChange={() => onToggle()}
        />
        <span class="absolute inset-0 rounded-full bg-white/15 transition peer-checked:bg-sky-500 peer-disabled:opacity-50" />
        <span class="absolute left-[3px] top-[3px] h-[21px] w-[21px] rounded-full bg-white transition peer-checked:translate-x-[19px]" />
      </span>
    </div>
  );
}

const REMINDERS: {
  key: 'reminders_weekly' | 'reminders_payments' | 'fx_alerts_enabled' | 'vision_enabled';
  icon: typeof Bell;
  label: string;
  hint: string;
}[] = [
  { key: 'reminders_weekly', icon: CalendarClock, label: 'Еженедельный итог', hint: 'вс 20:00 — траты недели' },
  { key: 'reminders_payments', icon: Receipt, label: 'Платежи и сроки', hint: 'за 2 дня до срока, 10:00' },
  { key: 'fx_alerts_enabled', icon: TrendingUp, label: 'Алерты по курсам', hint: 'выгодные моменты для обмена' },
  { key: 'vision_enabled', icon: Camera, label: 'Скриншоты банка', hint: 'распознавание — фото уходит в Google AI' },
];

function ProfileForms({
  api,
  nav,
  p,
  reload,
  payments,
}: {
  api: Api;
  nav: Nav;
  p: Profile;
  reload: () => void;
  payments: ComponentChildren;
}) {
  // базовый доход (0/пусто = «вычисляется»: платежи + бюджет + кредиты)
  const [inc, setInc] = useState(String((p.typical_income_minor ?? 0) / 100 || ''));
  const [incCcy, setIncCcy] = useState(p.income_currency ?? 'USD');
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
      <h2 class={headCls}>
        <Wallet size={16} strokeWidth={1.5} /> Бюджет
      </h2>
      <div class={`${cardCls} mt-2`}>
        <form onSubmit={saveCap}>
          <div class="flex gap-3">
            <Field
              label={
                <>
                  Бюджет на месяц
                  <Info title="Бюджет на месяц">
                    <p>
                      Сколько вы готовы тратить в месяц на повседневное: еда,
                      кафе, транспорт, мелочи.
                    </p>
                    <p>
                      Регулярные платежи и кредиты сюда не входят — они считаются
                      отдельно. Недельный бюджет = месячный × 12 / 52.
                    </p>
                  </Info>
                </>
              }
            >
              <input
                class={inputCls}
                inputMode="decimal"
                value={cap}
                onInput={(e) => setCap((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Валюта">
              <input
                class={inputCls}
                maxLength={5}
                value={capCcy}
                onInput={(e) => setCapCcy((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <Field
            label={
              <>
                Валюта повседневных трат (по умолчанию)
                <Info title="Валюта трат по умолчанию">
                  <p>
                    Эту валюту приложение предлагает при новой трате. Пусто —
                    как валюта бюджета.
                  </p>
                  <p>В форме траты всегда можно выбрать другую валюту.</p>
                </Info>
              </>
            }
          >
            <input
              class={inputCls}
              maxLength={5}
              placeholder={capCcy}
              value={expCcy}
              onInput={(e) => setExpCcy((e.target as HTMLInputElement).value)}
            />
          </Field>
          <p class={`${mutedCls} mb-3`}>
            Недельный бюджет: {fmtMinor(p.weekly_budget_minor ?? 0, p.living_currency ?? 'USD')}
          </p>
          <FormError msg={capErr} />
          <button type="submit" class={primaryBtnCls} disabled={capBusy}>
            Сохранить
          </button>
        </form>
      </div>

      {payments}

      <h2 class={`${headCls} mt-6`}>
        <Banknote size={16} strokeWidth={1.5} /> Доход
      </h2>
      <div class={`${cardCls} mt-2`}>
        <form onSubmit={saveIncome}>
          <Field
            label={
              <>
                Валюта доходов (по умолчанию)
                <Info title="Валюта доходов">
                  <p>
                    Эту валюту предлагают формы дохода и по ней считается отчёт.
                  </p>
                  <p>В форме дохода можно выбрать другую валюту.</p>
                </Info>
              </>
            }
          >
            <input
              class={inputCls}
              maxLength={5}
              value={incCcy}
              onInput={(e) => setIncCcy((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field
            label={
              <>
                Базовый доход
                <Info title="Базовый доход">
                  <p>
                    Ориентир «сколько обычно получаю в месяц». Показывается как
                    доход месяца, пока в нём нет записей, и служит базой для
                    расчёта превышения дохода (досрочки и инвестиции — следующие
                    шаги).
                  </p>
                  <p>
                    Пусто или 0 — вычисляется сам: регулярные платежи + бюджет +
                    платежи по кредитам. Записи дохода важнее: когда они есть,
                    база используется только для расчётов.
                  </p>
                </Info>
              </>
            }
          >
            <input
              class={inputCls}
              inputMode="decimal"
              placeholder="например, 6200"
              value={inc}
              onInput={(e) => setInc((e.target as HTMLInputElement).value)}
            />
          </Field>
          {p.baseline_source === 'computed' && (p.typical_income_minor ?? 0) === 0 ? (
            <p class={`${mutedCls} mb-3`}>
              Сейчас вычисляется: ≈ {fmtMinor(p.baseline_income_minor ?? 0, p.income_currency ?? 'USD')}
            </p>
          ) : null}
          <FormError msg={incErr} />
          <button type="submit" class={primaryBtnCls} disabled={incBusy}>
            Сохранить
          </button>
        </form>
      </div>

      <h2 class={`${headCls} mt-6`}>
        <Globe size={16} strokeWidth={1.5} /> Часовой пояс
      </h2>
      <div class={`${cardCls} mt-2`}>
        <form onSubmit={saveTz}>
          <Field label="Таймзона (IANA)">
            <select
              class={inputCls}
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
                class={inputCls}
                placeholder="например, Asia/Almaty"
                value={tzCustom}
                onInput={(e) => setTzCustom((e.target as HTMLInputElement).value)}
              />
            </Field>
          )}
          <FormError msg={tzErr} />
          <button type="submit" class={primaryBtnCls} disabled={tzBusy}>
            Сохранить пояс
          </button>
        </form>
      </div>

      <h2 class={`${headCls} mt-6`}>
        <Bell size={16} strokeWidth={1.5} /> Напоминания
      </h2>
      <div class={`${listCardCls} mt-2`}>
        <ul class="divide-y divide-white/5">
          {REMINDERS.map((r) => (
            <li key={r.key}>
              <Switch
                icon={<r.icon size={17} strokeWidth={1.5} class="flex-none text-zinc-400" />}
                label={r.label}
                hint={r.hint}
                checked={!!p[r.key]}
                busy={remBusy}
                onToggle={() => void toggleReminder(r.key, !p[r.key])}
              />
            </li>
          ))}
        </ul>
        {remErr && <p class="px-4 pb-3 text-sm text-red-400">{remErr}</p>}
      </div>

      <h2 class={`${headCls} mt-6`}>
        <Database size={16} strokeWidth={1.5} /> Данные
      </h2>
      <div class={`${cardCls} mt-2`}>
        <p class={`${mutedCls} mb-3`}>Экспорт — JSON со всеми вашими данными (профиль, платежи, траты, доход).</p>
        <button type="button" class={secondaryBtnCls} disabled={expBusy} onClick={() => void doExport()}>
          <Upload size={16} strokeWidth={1.5} /> {expBusy ? 'Готовлю файл…' : 'Экспорт данных (JSON)'}
        </button>
        <FormError msg={expErr} />
        <p class={`${mutedCls} mt-3`}>
          Удаление данных — через бота: /profile → 🗄 Мои данные → 🗑 Удалить всё.
          <Info title="Почему удаление — в боте">
            <p>
              Полное удаление необратимо, поэтому оно намеренно вынесено в бота —
              там оно требует явной команды и подтверждения, случайно не нажать.
            </p>
          </Info>
        </p>
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
          <div class="flex gap-3">
            <Field label="Сумма">
              <input
                class={inputCls}
                inputMode="decimal"
                value={amount}
                onInput={(e) => setAmount((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="День месяца (1–31, пусто — без дня)">
              <input
                class={inputCls}
                inputMode="numeric"
                maxLength={2}
                placeholder="—"
                value={day}
                onInput={(e) => setDay((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <p class={`${mutedCls} mb-2`}>Валюта: {item.currency}</p>
          <p class={`${mutedCls} mb-2 flex items-center gap-1`}>
            Этот месяц:{' '}
            {item.paid_this_month ? (
              <>
                <CircleCheck size={14} strokeWidth={1.5} class="text-emerald-400" />
                <span class="text-emerald-400">оплачен{item.last_paid_on ? ` ${fmtDay(item.last_paid_on)}` : ''}</span>
              </>
            ) : (
              'не оплачен'
            )}
          </p>
          <p class={`${mutedCls} mb-3`}>В день срока бот отметит оплату сам, напомнит за 2 дня.</p>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            Сохранить
          </button>
        </form>
      </div>

      {!item.paid_this_month && (
        <button type="button" class={`${secondaryBtnCls} mt-3`} disabled={busy} onClick={() => void markPaid()}>
          <CircleCheck size={16} strokeWidth={1.5} /> Отметить оплаченным
        </button>
      )}

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

      <h2 class={`${headCls} mt-6`}>
        <History size={16} strokeWidth={1.5} /> Журнал оплат
      </h2>
      <div class={`${listCardCls} mt-2`}>
        {payments.length ? (
          <ul class="divide-y divide-white/5">
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
            <Field label={`Валюта (по умолч. ${defCcy})`}>
              <input
                class={inputCls}
                maxLength={5}
                placeholder={defCcy}
                value={ccy}
                onInput={(e) => setCcy((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="День (1–31)">
              <input
                class={inputCls}
                inputMode="numeric"
                maxLength={2}
                placeholder="—"
                value={day}
                onInput={(e) => setDay((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <FormError msg={err} />
          <button type="submit" class={primaryBtnCls} disabled={busy}>
            {busy ? 'Сохраняю…' : 'Добавить платёж'}
          </button>
        </form>
      </div>
    </>
  );
}
