/**
 * profile.tsx — «Профиль» и регулярные платежи.
 *
 * ProfileScreen: GET /api/tma/profile + /api/tma/commitments.
 *   Секции: ДОХОД (валюта + «Базовый доход» под «Ещё ▸»; 0 — вычисляется),
 *   БЮДЖЕТ (living_cap+living_currency+expense_currency — сервер пересчитает
 *   недельный бюджет ×12/52), ЧАСОВОЙ ПОЯС, НАПОМИНАНИЯ (4 переключателя),
 *   ДАННЫЕ (экспорт JSON через getBlob; удаление — в боте).
 * CommitmentScreen: карточка платежа — PATCH amount + каденс
 *   (monthly/interval_days/yearly) и тогл active; удаление с подтверждением.
 * CommitmentAddScreen: name+amount+currency+каденс → POST.
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
  Clock,
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
  Zap,
} from 'lucide-preact';
import { ApiError } from '../api';
import type {
  Api,
  CommitmentFrequency,
  CommitmentPayment,
  CommitmentPaymentsList,
  CommitmentsList,
  Profile,
} from '../api';
import type { Nav, ScreenProps } from '../app';
import type { SelectOption } from '../ui';
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
  smDangerBtnCls,
  smDangerFillBtnCls,
  smGhostBtnCls,
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

// ── каденс платежа (миграции 0016+0017) ──

/** UI-частота: 'every_months' — это frequency 'monthly' + every_months ≥ 1 (0017). */
type UiFreq = CommitmentFrequency | 'every_months';
const FREQ_OPTIONS: { value: UiFreq; label: string }[] = [
  { value: 'monthly', label: 'Каждый месяц' },
  { value: 'every_months', label: 'Каждые N месяцев' },
  { value: 'interval_days', label: 'Каждые N дней' },
  { value: 'yearly', label: 'Раз в год' },
];
const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/** Поля каденса для POST/PATCH: лишние для каденса поля обнуляем явно. */
function cadenceBody(
  freq: UiFreq,
  day: string,
  month: string,
  every: string,
  anchor: string,
  everyM: string,
): {
  frequency: CommitmentFrequency;
  due_day: number | null;
  due_month: number | null;
  interval_days: number | null;
  anchor_on: string | null;
  every_months: number;
} {
  if (freq === 'every_months') {
    const n = Number(everyM.trim());
    return {
      frequency: 'monthly',
      due_day: day.trim() ? Number(day.trim()) : null,
      due_month: null,
      interval_days: null,
      // якорь — фаза «каждые N мес»; при N=1 — обычный monthly, якорь не нужен
      anchor_on: n > 1 && anchor ? anchor : null,
      every_months: n,
    };
  }
  return {
    frequency: freq,
    due_day: freq === 'interval_days' ? null : day.trim() ? Number(day.trim()) : null,
    due_month: freq === 'yearly' ? Number(month) : null,
    interval_days: freq === 'interval_days' ? Number(every.trim()) : null,
    anchor_on: freq === 'interval_days' && anchor ? anchor : null,
    every_months: 1,
  };
}

/** Клиентская проверка полей каденса перед POST/PATCH (зеркало superRefine в api). */
function cadenceError(
  freq: UiFreq,
  day: string,
  month: string,
  every: string,
  anchor: string,
  everyM: string,
): string | null {
  if (freq === 'every_months') {
    const n = Number(everyM.trim());
    if (!Number.isInteger(n) || n < 1 || n > 24) return 'Каждые N месяцев — целое число от 1 до 24';
    if (!day.trim()) return 'Укажите день месяца (1–31)';
    const dErr = dayError(day);
    if (dErr) return dErr;
    if (n > 1 && !anchor) return 'Укажите дату первого платежа — она задаёт фазу';
    return null;
  }
  if (freq === 'interval_days') {
    const n = Number(every.trim());
    if (!Number.isInteger(n) || n < 1 || n > 366) return 'Интервал — целое число от 1 до 366 дней';
    if (!anchor) return 'Укажите дату первого платежа';
    return null;
  }
  if (freq === 'yearly') {
    if (!day.trim()) return 'Укажите день месяца (1–31)';
    const dErr = dayError(day);
    if (dErr) return dErr;
    if (!month) return 'Укажите месяц платежа';
    return null;
  }
  return dayError(day); // monthly: день необязателен
}

/** Селектор периодичности + поля под выбранный каденс (форма платежа). */
function CadenceFields({
  freq,
  setFreq,
  day,
  setDay,
  month,
  setMonth,
  every,
  setEvery,
  anchor,
  setAnchor,
  everyM,
  setEveryM,
}: {
  freq: UiFreq;
  setFreq: (f: UiFreq) => void;
  day: string;
  setDay: (s: string) => void;
  month: string;
  setMonth: (s: string) => void;
  every: string;
  setEvery: (s: string) => void;
  anchor: string;
  setAnchor: (s: string) => void;
  everyM: string;
  setEveryM: (s: string) => void;
}) {
  return (
    <>
      <Field label="Периодичность">
        <Select value={freq} options={FREQ_OPTIONS} onChange={(v) => setFreq(v as UiFreq)} />
      </Field>
      {freq === 'monthly' && (
        <Field
          label={
            <>
              День месяца
              <Info title="День платежа">
                <p>Число месяца 1–31. Пусто — платёж без даты.</p>
                <p>
                  Если такого дня в месяце нет, срок — последний день месяца:
                  31-е в феврале означает 28/29 февраля.
                </p>
                <p>
                  В день срока бот отметит оплату сам, за 2 дня до срока —
                  напомнит. Без дня ни автопроводки, ни напоминаний нет.
                </p>
              </Info>
            </>
          }
        >
          <input
            class={inputCls}
            inputMode="numeric"
            maxLength={2}
            placeholder="—"
            value={day}
            onInput={(e) => setDay((e.target as HTMLInputElement).value)}
          />
        </Field>
      )}
      {freq === 'every_months' && (
        <>
          <div class="flex gap-3">
            <Field
              label={
                <>
                  Каждые N месяцев
                  <Info title="Каждые N месяцев">
                    <p>3 = раз в квартал, 12 = раз в год; дата фиксируется по дню месяца.</p>
                    <p>
                      Сроки — указанный день в каждом N-м месяце, отсчёт от месяца
                      первого платежа. Дня 31-е в коротком месяце нет — срок
                      клампится к его последнему дню (31.01 → 30.04).
                    </p>
                  </Info>
                </>
              }
            >
              <input
                class={inputCls}
                inputMode="numeric"
                maxLength={2}
                placeholder="3"
                value={everyM}
                onInput={(e) => setEveryM((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="День месяца">
              <input
                class={inputCls}
                inputMode="numeric"
                maxLength={2}
                placeholder="31"
                value={day}
                onInput={(e) => setDay((e.target as HTMLInputElement).value)}
              />
            </Field>
          </div>
          {Number(everyM.trim()) > 1 && (
            <Field label="Дата первого платежа (месяц задаёт фазу)">
              <input
                class={inputCls}
                type="date"
                value={anchor}
                onInput={(e) => setAnchor((e.target as HTMLInputElement).value)}
              />
            </Field>
          )}
        </>
      )}
      {freq === 'interval_days' && (
        <div class="flex gap-3">
          <Field label="Интервал, дней">
            <input
              class={inputCls}
              inputMode="numeric"
              maxLength={3}
              placeholder="30"
              value={every}
              onInput={(e) => setEvery((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field
            label={
              <>
                Первый платёж
                <Info title="Якорная дата">
                  <p>
                    Дата, от которой считается каждый N-й день. Следующие
                    сроки — через каждые N дней после неё.
                  </p>
                </Info>
              </>
            }
          >
            <input
              class={inputCls}
              type="date"
              value={anchor}
              onInput={(e) => setAnchor((e.target as HTMLInputElement).value)}
            />
          </Field>
        </div>
      )}
      {freq === 'yearly' && (
        <div class="flex gap-3">
          <Field label="День">
            <input
              class={inputCls}
              inputMode="numeric"
              maxLength={2}
              placeholder="15"
              value={day}
              onInput={(e) => setDay((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Месяц">
            <Select
              value={month}
              options={[
                { value: '', label: '—' },
                ...MONTH_NAMES.map((m, i) => ({ value: String(i + 1), label: m })),
              ]}
              onChange={setMonth}
            />
          </Field>
        </div>
      )}
    </>
  );
}

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
        <span class="absolute inset-0 rounded-full bg-white/15 transition peer-checked:bg-sky-500 peer-disabled:opacity-50" />
        <span class="absolute left-[3px] top-[3px] h-[21px] w-[21px] rounded-full bg-white transition peer-checked:translate-x-[19px]" />
      </span>
    </div>
  );
}

/** Ключи boolean-настроек профиля (PATCH /profile) — и напоминания, и фичи. */
type ToggleKey = 'reminders_weekly' | 'reminders_payments' | 'fx_alerts_enabled' | 'vision_enabled';

const REMINDERS: {
  key: ToggleKey;
  icon: typeof Bell;
  label: ComponentChildren;
  hint: string;
}[] = [
  { key: 'reminders_weekly', icon: CalendarClock, label: 'Еженедельный итог', hint: 'вс 20:00 — траты недели' },
  { key: 'reminders_payments', icon: Receipt, label: 'Платежи и сроки', hint: 'за 2 дня до срока, 10:00' },
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
        <ul class="divide-y divide-white/5">
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
        <ul class="divide-y divide-white/5">
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
