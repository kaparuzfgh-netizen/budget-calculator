/**
 * cadence.tsx — каденс регулярного платежа (миграции 0016+0017): тело запроса,
 * валидация и поля формы. Общий для карточки платежа и мастера добавления.
 */
import type { CommitmentFrequency } from '../api';
import { dayError } from '../fmt';
import { Field, Info, inputCls, Select } from '../ui';


/** UI-частота: 'every_months' — это frequency 'monthly' + every_months ≥ 1 (0017). */
export type UiFreq = CommitmentFrequency | 'every_months';
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
export function cadenceBody(
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
export function cadenceError(
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
export function CadenceFields({
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
