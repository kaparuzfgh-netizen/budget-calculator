/**
 * profile.tsx — «Профиль».
 *
 * ProfileScreen: GET /api/tma/profile + /api/tma/commitments.
 *   Секции: ДОХОД (валюта + «Базовый доход» под «Ещё ▸»; 0 — вычисляется),
 *   БЮДЖЕТ (living_cap+living_currency+expense_currency — сервер пересчитает
 *   недельный бюджет ×12/52), ЧАСОВОЙ ПОЯС, НАПОМИНАНИЯ (4 переключателя),
 *   ВНЕШНИЙ ВИД (тема — клиентская, localStorage), ДАННЫЕ (экспорт JSON
 *   через getBlob; удаление — в боте).
 * Регулярные платежи — commitments.tsx, редактор каденса — cadence.tsx.
 * После мутации — reload/возврат на экран-источник со свежими данными.
 */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import {
  Banknote,
  Bell,
  CalendarClock,
  Camera,
  Clock,
  Database,
  Globe,
  Pause,
  Plus,
  Receipt,
  Settings,
  SunMoon,
  TrendingUp,
  Upload,
  Users,
  Wallet,
  Zap,
} from 'lucide-preact';
import { ApiError } from '../api';
import type { Api, CommitmentsList, HouseholdInviteResponse, HouseholdResponse, HouseholdSummary, Profile } from '../api';
import type { Nav, ScreenProps } from '../app';
import type { SelectOption } from '../ui';
import { amountError, currencyError, fmtMinor, parseAmount, timezoneError, todayIso } from '../fmt';
import { getTheme, setTheme } from '../theme';
import {
  cardCls,
  CcySelect,
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
  secondaryBtnCls,
  Select,
  smBtnCls,
  useData,
  useFatalOn,
} from '../ui';

/**
 * Часовой пояс: полный список IANA (Intl.supportedValuesOf) с поиском.
 * Первой закреплена текущая зона («Текущая: X»), затем избранные, дальше —
 * весь список. Если API нет (старый WebView) — статичный fallback ~50 зон.
 * Русские имена городов ищутся через hint (SelectOption) — «москва» →
 * Europe/Moscow и т.п. Храним значение = IANA-строку (проверяет сервер).
 */
const TZ_FAVORITES = ['Europe/Moscow', 'Asia/Bishkek', 'Europe/Minsk', 'Asia/Almaty', 'UTC'] as const;
/** Алиасы городов → IANA: ищутся по подстроке (см. SelectOption.hint). */
const TZ_ALIASES: Record<string, string> = {
  'Europe/Moscow': 'москва питер санкт-петербург',
  'Europe/Samara': 'самара',
  'Asia/Bishkek': 'бишкек',
  'Europe/Minsk': 'минск',
  'Asia/Almaty': 'алматы',
  'Europe/Kyiv': 'киев',
  'Europe/Kiev': 'киев',
  'Europe/Berlin': 'берлин',
  'Europe/London': 'лондон',
  'America/New_York': 'нью-йорк',
  'Asia/Dubai': 'дубай',
  'Europe/Istanbul': 'стамбул',
};
/** Статичный список ~50 ходовых зон — fallback без Intl.supportedValuesOf. */
const TZ_FALLBACK: readonly string[] = [
  'UTC',
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon',
  'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Vienna', 'Europe/Zurich',
  'Europe/Warsaw', 'Europe/Prague', 'Europe/Stockholm', 'Europe/Helsinki',
  'Europe/Athens', 'Europe/Bucharest', 'Europe/Istanbul', 'Europe/Kyiv',
  'Europe/Minsk', 'Europe/Moscow', 'Europe/Samara',
  'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Krasnoyarsk',
  'Asia/Irkutsk', 'Asia/Vladivostok', 'Asia/Kamchatka',
  'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Baku', 'Asia/Tashkent',
  'Asia/Almaty', 'Asia/Bishkek', 'Asia/Dubai', 'Asia/Karachi',
  'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Singapore',
  'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland',
  'America/Anchorage', 'America/Los_Angeles', 'America/Chicago',
  'America/New_York', 'America/Mexico_City', 'America/Sao_Paulo',
  'Africa/Cairo', 'Africa/Johannesburg',
];

/** Все IANA-зоны из рантайма; без supportedValuesOf — TZ_FALLBACK. */
function allTimezones(): string[] {
  try {
    const fn = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    const list = fn?.call(Intl, 'timeZone');
    if (list?.length) return list;
  } catch {
    // старый WebView — ниже вернём fallback
  }
  return [...TZ_FALLBACK];
}

/** Опции селекта: «Текущая: X», избранные, полный список (без дублей). */
function tzOptions(current: string): SelectOption[] {
  const all = allTimezones();
  const opt = (z: string, label = z): SelectOption => ({
    value: z,
    label,
    ...(TZ_ALIASES[z] ? { hint: TZ_ALIASES[z] } : {}),
  });
  const head = new Set<string>([current]);
  const favs = TZ_FAVORITES.filter((z) => z !== current && all.includes(z));
  for (const z of favs) head.add(z);
  return [
    opt(current, `Текущая: ${current}`),
    ...favs.map((z) => opt(z)),
    ...all.filter((z) => !head.has(z)).map((z) => opt(z)),
  ];
}


// ── Профиль ──

export function ProfileScreen({ api, nav, onFatal }: ScreenProps) {
  const prof = useData(() => api.get<Profile>('/api/tma/profile'), onFatal, []);
  const com = useData(() => api.get<CommitmentsList>('/api/tma/commitments'), onFatal, []);
  const hh = useData(() => api.get<HouseholdResponse>('/api/tma/household'), onFatal, []);
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
              Аренда, связь, подписки, ЖКХ — то, что списывается каждый месяц,
              каждые N дней или раз в год.
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
          <ul class="divide-y divide-line-soft">
            {com.data.commitments.map((x) => (
              <li
                class={`${liCls} cursor-pointer transition hover:bg-fill${x.active ? '' : ' opacity-50'}`}
                onClick={() => nav.push({ id: 'commitment', commitmentId: x.id })}
              >
                <div class={rowCls}>
                  <span class="flex items-center gap-1.5">
                    {x.name}
                    {x.active ? '' : <Pause size={13} strokeWidth={1.5} class="text-zinc-500" />}
                  </span>
                  <span>
                    {fmtMinor(x.amount_minor, x.currency)}
                    {x.cadence !== 'без даты' ? ` · ${x.cadence}` : ''}
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
        pair={hh.data?.household ?? null}
        pairLoading={hh.loading}
        pairReload={hh.reload}
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
  label: ComponentChildren;
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
        <span class="absolute inset-0 rounded-full bg-fill-3 transition peer-checked:bg-sky-500 peer-disabled:opacity-50" />
        <span class="absolute left-[3px] top-[3px] h-[21px] w-[21px] rounded-full bg-white transition peer-checked:translate-x-[19px]" />
      </span>
    </div>
  );
}

/** Ключи boolean-настроек профиля (PATCH /profile) — и напоминания, и фичи. */
type ToggleKey = 'reminders_weekly' | 'reminders_payments' | 'reminders_digest' | 'fx_alerts_enabled' | 'vision_enabled';

const REMINDERS: {
  key: ToggleKey;
  icon: typeof Bell;
  label: ComponentChildren;
  hint: string;
}[] = [
  { key: 'reminders_weekly', icon: CalendarClock, label: 'Еженедельный итог', hint: 'вс 20:00 — траты недели' },
  { key: 'reminders_payments', icon: Receipt, label: 'Платежи и сроки', hint: 'за 2 дня до срока, 10:00' },
  { key: 'reminders_digest', icon: CalendarClock, label: 'Дайджест месяца', hint: 'итоги в последний день месяца' },
  { key: 'fx_alerts_enabled', icon: TrendingUp, label: 'Алерты по курсам', hint: 'выгодные моменты для обмена' },
];

/** «⚡️ Возможности» — opt-in фичи (не напоминания), тот же PATCH-контракт. */
const FEATURES: {
  key: ToggleKey;
  icon: typeof Bell;
  label: ComponentChildren;
  hint: string;
}[] = [
  {
    key: 'vision_enabled',
    icon: Camera,
    label: (
      <>
        Распознавание скриншотов
        <Info title="Распознавание скриншотов">
          <p>
            Включите — и можно прислать скриншот банковского приложения боту
            ИЛИ загрузить его здесь: кнопка «📷 Из скриншота» в форме траты.
            Строки операций распознаются списком — перед записью их можно
            проверить и поправить.
          </p>
          <p>
            Фото уходит в Google AI (резерв — Groq), хранится только результат.
            Лимит — 20 фото в день.
          </p>
        </Info>
      </>
    ),
    hint: 'фото банка — в боте или в форме траты',
  },
];

/** «Время напоминаний»: «По умолчанию» → null (легаси) + часы 0–23. */
const REM_HOUR_OPTIONS: SelectOption[] = [
  { value: '', label: 'По умолчанию', hint: '10:00 · вс 20:00' },
  ...Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
  })),
];

function ProfileForms({
  api,
  nav,
  p,
  reload,
  payments,
  pair,
  pairLoading,
  pairReload,
}: {
  api: Api;
  nav: Nav;
  p: Profile;
  reload: () => void;
  payments: ComponentChildren;
  pair: HouseholdSummary | null;
  pairLoading: boolean;
  pairReload: () => void;
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

  // таймзона — полный список IANA с поиском (в т.ч. по-русски через hint)
  const cur = p.timezone ?? 'UTC';
  const [tz, setTz] = useState(cur);
  const [tzErr, setTzErr] = useState<string | null>(null);
  const [tzBusy, setTzBusy] = useState(false);

  // напоминания и фичи — переключатели сразу PATCH'ат; ошибка — в своей карточке
  const [remBusy, setRemBusy] = useState(false);
  const [remErr, setRemErr] = useState<string | null>(null);
  const [featErr, setFeatErr] = useState<string | null>(null);

  // экспорт
  const [expBusy, setExpBusy] = useState(false);
  const [expErr, setExpErr] = useState<string | null>(null);

  // тема — клиентская настройка (localStorage), применяется мгновенно
  const [light, setLight] = useState(() => getTheme() === 'light');

  // каскад бонуса: доли дельты дохода → досрочка/накопления (проценты 0–100)
  const [bnPrepay, setBnPrepay] = useState(String(Math.round((p.bonus_prepay_share ?? 0) * 100) || ''));
  const [bnDca, setBnDca] = useState(String(Math.round((p.bonus_dca_share ?? 0) * 100) || ''));
  const [bnErr, setBnErr] = useState<string | null>(null);
  const [bnBusy, setBnBusy] = useState(false);

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

  const toggleReminder = async (
    key: ToggleKey,
    value: boolean,
    flash = 'Напоминания обновлены',
    setErr = setRemErr,
  ) => {
    setRemBusy(true);
    setErr(null);
    try {
      await api.patch('/api/tma/profile', { [key]: value });
      nav.flash(flash);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setRemBusy(false);
    }
  };

  // «Время напоминаний»: '' → null (легаси 10:00/вс 20:00), иначе час 0–23
  const saveRemHour = async (v: string) => {
    setRemBusy(true);
    setRemErr(null);
    try {
      await api.patch('/api/tma/profile', { reminder_hour: v === '' ? null : Number(v) });
      nav.flash('Время напоминаний сохранено');
      reload();
    } catch (e) {
      setRemErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setRemBusy(false);
    }
  };

  // доли каскада: проценты 0–100, сумма ≤ 100 (0/0 — каскад выкл)
  const saveBonus = async (ev: Event) => {
    ev.preventDefault();
    const a = bnPrepay.trim() === '' ? 0 : Number(bnPrepay.replace(',', '.'));
    const d = bnDca.trim() === '' ? 0 : Number(bnDca.replace(',', '.'));
    if (!Number.isFinite(a) || !Number.isFinite(d) || a < 0 || d < 0 || a > 100 || d > 100)
      return setBnErr('Доли — числа от 0 до 100');
    if (a + d > 100) return setBnErr('Сумма долей больше 100% — остаток должен остаться свободным');
    setBnBusy(true);
    setBnErr(null);
    try {
      await api.patch('/api/tma/profile', { bonus_prepay_share: a / 100, bonus_dca_share: d / 100 });
      nav.flash('Каскад бонуса сохранён');
      reload();
    } catch (e) {
      setBnErr(e instanceof ApiError ? e.message : 'Не удалось сохранить — проверьте соединение');
    } finally {
      setBnBusy(false);
    }
    return undefined;
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
              <CcySelect value={capCcy} onChange={setCapCcy} extra={[p.living_currency]} />
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
            <CcySelect
              value={expCcy}
              onChange={setExpCcy}
              extra={[capCcy]}
              allowEmpty
              emptyLabel={`Как у бюджета (${capCcy.toUpperCase() || '—'})`}
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
            <CcySelect value={incCcy} onChange={setIncCcy} extra={[p.income_currency]} />
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
        <TrendingUp size={16} strokeWidth={1.5} /> Каскад бонуса
        <Info title="Каскад бонуса">
          <p>
            Если доход месяца выше базового — разница («дельта») распределяется:
            доля на досрочное погашение кредита с максимальной ставкой и доля
            на накопления. Остаток остаётся свободными деньгами.
          </p>
          <p>
            Рекомендация видна в плане месяца («/plan» и экран «План»).
            Оба нуля — каскад выключен.
          </p>
        </Info>
      </h2>
      <div class={`${cardCls} mt-2`}>
        <form onSubmit={saveBonus}>
          <div class="flex gap-3">
            <Field label="На досрочку, %">
              <input
                class={inputCls}
                inputMode="decimal"
                placeholder="0"
                value={bnPrepay}
                onInput={(e) => setBnPrepay((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="На накопления, %">
              <input
                class={inputCls}
                inputMode="decimal"
                placeholder="0"
                value={bnDca}
                onInput={(e) => setBnDca((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          <FormError msg={bnErr} />
          <button type="submit" class={primaryBtnCls} disabled={bnBusy}>
            Сохранить
          </button>
        </form>
      </div>

      <h2 class={`${headCls} mt-6`}>
        <Globe size={16} strokeWidth={1.5} /> Часовой пояс
      </h2>
      <div class={`${cardCls} mt-2`}>
        <form onSubmit={saveTz}>
          <Field
            label={
              <>
                Таймзона
                <Info title="Часовой пояс">
                  <p>
                    Полный список IANA — начните печатать в поиске: Europe/Berlin,
                    Asia/Almaty… Или по-русски: «москва», «бишкек», «киев».
                  </p>
                  <p>По этому поясу бот считает «сегодня» и время напоминаний.</p>
                </Info>
              </>
            }
          >
            <Select value={tz} options={tzOptions(cur)} onChange={setTz} searchable />
          </Field>
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
        <ul class="divide-y divide-line-soft">
          {REMINDERS.map((r) => (
            <li key={r.key}>
              <Switch
                icon={<r.icon size={17} strokeWidth={1.5} class="flex-none text-zinc-400" />}
                label={r.label}
                hint={
                  r.key === 'reminders_weekly' && p.reminder_hour != null
                    ? `вс ${String(p.reminder_hour).padStart(2, '0')}:00 — траты недели`
                    : r.key === 'reminders_payments' && p.reminder_hour != null
                      ? `за 2 дня до срока, с ${String(p.reminder_hour).padStart(2, '0')}:00`
                      : r.hint
                }
                checked={!!p[r.key]}
                busy={remBusy}
                onToggle={() => void toggleReminder(r.key, !p[r.key])}
              />
            </li>
          ))}
          <li class="flex items-center justify-between gap-3 px-4 py-3">
            <span class="flex items-center gap-2.5 text-[15px] text-zinc-100">
              <Clock size={17} strokeWidth={1.5} class="flex-none text-zinc-400" />
              <span>
                Время напоминаний
                <Info title="Время напоминаний">
                  <p>Одна настройка для обоих: и платежей, и итога недели.</p>
                  <p>
                    Час — начало окна: напоминание срабатывает в первый час
                    после заданного времени (крон тикает раз в час).
                  </p>
                  <p>По умолчанию: платежи — с 10:00, итог недели — вс с 20:00.</p>
                </Info>
                <span class="mt-0.5 block text-xs text-zinc-400">
                  {p.reminder_hour == null
                    ? 'платежи с 10:00 · итог — вс с 20:00'
                    : `оба — с ${String(p.reminder_hour).padStart(2, '0')}:00`}
                </span>
              </span>
            </span>
            <span class="w-[7.5rem] flex-none">
              <Select
                value={p.reminder_hour == null ? '' : String(p.reminder_hour)}
                options={REM_HOUR_OPTIONS}
                onChange={(v) => void saveRemHour(v)}
                disabled={remBusy}
              />
            </span>
          </li>
        </ul>
        {remErr && <p class="px-4 pb-3 text-sm text-red-400">{remErr}</p>}
      </div>

      <h2 class={`${headCls} mt-6`}>
        <Zap size={16} strokeWidth={1.5} /> Возможности
      </h2>
      <div class={`${listCardCls} mt-2`}>
        <ul class="divide-y divide-line-soft">
          {FEATURES.map((f) => (
            <li key={f.key}>
              <Switch
                icon={<f.icon size={17} strokeWidth={1.5} class="flex-none text-zinc-400" />}
                label={f.label}
                hint={f.hint}
                checked={!!p[f.key]}
                busy={remBusy}
                onToggle={() => void toggleReminder(f.key, !p[f.key], 'Настройка сохранена', setFeatErr)}
              />
            </li>
          ))}
        </ul>
        {featErr && <p class="px-4 pb-3 text-sm text-red-400">{featErr}</p>}
      </div>

      <h2 class={`${headCls} mt-6`}>
        <SunMoon size={16} strokeWidth={1.5} /> Внешний вид
      </h2>
      <div class={`${listCardCls} mt-2`}>
        <Switch
          icon={<SunMoon size={17} strokeWidth={1.5} class="flex-none text-zinc-400" />}
          label="Светлая тема"
          hint="по умолчанию — как в Telegram"
          checked={light}
          busy={false}
          onToggle={() => {
            const t = light ? 'dark' : 'light';
            setTheme(t);
            setLight(t === 'light');
          }}
        />
      </div>

      <h2 class={`${headCls} mt-6`}>
        <Users size={16} strokeWidth={1.5} /> Семья
        <Info title="Общий бюджет на двоих">
          <p>
            Один недельный лимит на пару — траты обоих идут в общий котёл.
            Партнёр присоединяется по одноразовой ссылке. Суммы трат друг
            друга видны, строки и категории — нет.
          </p>
        </Info>
      </h2>
      {pairLoading ? (
        <div class={`${cardCls} mt-2`}>
          <p class={mutedCls}>Загрузка…</p>
        </div>
      ) : (
        <FamilyCard key={pair ? `hh` : 'none'} api={api} nav={nav} pair={pair} reload={pairReload} />
      )}

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

// ── Семья: общий бюджет пары ──

function FamilyCard({
  api,
  nav,
  pair,
  reload,
}: {
  api: Api;
  nav: Nav;
  pair: HouseholdSummary | null;
  reload: () => void;
}) {
  const [cap, setCap] = useState(String((pair?.living_cap_minor ?? 0) / 100 || ''));
  const [ccy, setCcy] = useState(pair?.currency ?? 'USD');
  const [joinCode, setJoinCode] = useState('');
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : 'Не удалось — проверьте соединение');

  const createInvite = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<HouseholdInviteResponse>('/api/tma/household/invite');
      setInvite(r.link ?? r.code);
      nav.flash('Приглашение создано — отправьте ссылку партнёру');
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const join = async (ev: Event) => {
    ev.preventDefault();
    if (!joinCode.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/household/join', { code: joinCode });
      nav.flash('Вы в общем бюджете');
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const saveCap = async (ev: Event) => {
    ev.preventDefault();
    const aErr = amountError(cap);
    const cErr = currencyError(ccy);
    if (aErr || cErr) return setErr(aErr ?? cErr);
    setBusy(true);
    setErr(null);
    try {
      await api.patch('/api/tma/household', { living_cap: parseAmount(cap), living_currency: ccy.trim().toUpperCase() });
      nav.flash('Общий лимит сохранён');
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
    return undefined;
  };

  const leave = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/tma/household/leave');
      nav.flash('Вы вышли из общего бюджета');
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!pair) {
    return (
      <div class={`${cardCls} mt-2`}>
        <p class={`${mutedCls} mb-3`}>
          Общий недельный бюджет на двоих. Создайте пару — партнёр присоединится по ссылке —
          или введите код приглашения от партнёра.
        </p>
        {invite ? (
          <div class={`${cardCls} bg-fill/40 mb-3 break-all text-[13px]`}>
            <p class={mutedCls}>Передайте партнёру (одноразовая, 48 ч):</p>
            <p class="mt-1 font-mono text-sky-400">{invite}</p>
          </div>
        ) : (
          <button type="button" class={primaryBtnCls} disabled={busy} onClick={() => void createInvite()}>
            <Users size={16} strokeWidth={1.5} /> Создать общий бюджет
          </button>
        )}
        <form class="mt-3 flex gap-2" onSubmit={(e) => void join(e)}>
          <input
            class={`${inputCls} flex-1`}
            placeholder="Код приглашения или ссылка"
            value={joinCode}
            onInput={(e) => setJoinCode((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class={smBtnCls} disabled={busy || !joinCode.trim()}>
            Вступить
          </button>
        </form>
        <FormError msg={err} />
      </div>
    );
  }

  return (
    <div class={`${cardCls} mt-2`}>
      {pair.members.map((m) => (
        <div key={m.user_id} class={rowCls}>
          <span>{m.is_me ? 'Вы' : (m.name ?? 'Партнёр')}</span>
          <span class={mutedCls}>
            {fmtMinor(m.spent_week_minor, pair.currency)} за неделю{m.role === 'owner' ? ' · создатель' : ''}
          </span>
        </div>
      ))}
      <form class="mt-4" onSubmit={(e) => void saveCap(e)}>
        <Field label="Месячный лимит пары">
          <div class="flex gap-2">
            <input
              class={`${inputCls} flex-1`}
              inputMode="decimal"
              value={cap}
              onInput={(e) => setCap((e.target as HTMLInputElement).value)}
            />
            <input
              class={`${inputCls} w-20`}
              maxLength={5}
              value={ccy}
              onInput={(e) => setCcy((e.target as HTMLInputElement).value)}
            />
          </div>
        </Field>
        <button type="submit" class={`${primaryBtnCls} mt-3`} disabled={busy}>
          Сохранить лимит
        </button>
      </form>
      <button type="button" class={`${secondaryBtnCls} mt-2 text-red-400`} disabled={busy} onClick={() => void leave()}>
        Выйти из общего бюджета
      </button>
      <FormError msg={err} />
    </div>
  );
}
