/**
 * schedule.ts — периодичность регулярных платежей (commitments, миграции 0016+0017).
 *
 * Чистые функции над ISO-датами 'YYYY-MM-DD' (как dates.ts): «сегодня» —
 * параметром, внутри только UTC-арифметика. Каденсы:
 *   monthly       — день месяца 1–31, кламп к последнему дню (31 → февр. 28/29);
 *                   every_months > 1 — сроки каждые N месяцев, фаза задаётся
 *                   месяцем anchor_on (0017; обязательны due_day и anchor_on);
 *   interval_days — каждые n дней от якорной даты anchor_on;
 *   yearly        — день+месяц раз в год (тот же кламп; 29.02 → 28 в невисокосном).
 * Платёж без даты возможен только у monthly (due_day = NULL) — тогда сроков нет.
 */
import { DomainError } from './errors';

export type CommitmentFrequency = 'monthly' | 'interval_days' | 'yearly';

/** Поля каденса платежа (подмножество CommitmentRow — домен про БД не знает). */
export interface Cadence {
  frequency: CommitmentFrequency;
  due_day: number | null;
  interval_days: number | null;
  anchor_on: string | null;
  due_month: number | null;
  /** monthly: «каждые N месяцев» 1–24 (0017); NULL/1 — обычный monthly. */
  every_months: number | null;
}

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;
/** Верхняя граница циклов развёртки сроков (interval_days=1 → ~год с запасом). */
const OCCURRENCE_LIMIT = 400;

function msOf(iso: string): number {
  const m = RE_ISO.exec(iso);
  if (!m) throw new DomainError('BAD_DATE', `Ожидалась дата 'YYYY-MM-DD', получено '${iso}'`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    throw new DomainError('BAD_DATE', `Несуществующая дата '${iso}'`);
  return t;
}

function isoOf(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** iso + n дней (ролловер месяца/года). */
export function addDaysIso(iso: string, n: number): string {
  return isoOf(msOf(iso) + n * DAY_MS);
}

const p2 = (n: number) => String(n).padStart(2, '0');
const mkIso = (y: number, m: number, d: number) => `${y}-${p2(m)}-${p2(d)}`;

/**
 * Дата срока в месяце (y, m): due_day зажат в последний день месяца
 * (due_day 31 → февраль 28/29). Перенесено из services/reminders.ts —
 * та же семантика, что и была.
 */
export function dueDateFor(dueDay: number, year: number, month: number): { y: number; m: number; d: number } {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { y: year, m: month, d: Math.min(dueDay, daysInMonth) };
}

/** Срок в (y, m) как ISO-строка с клампом дня к концу месяца. */
function monthlyIso(dueDay: number, y: number, m: number): string {
  const dd = dueDateFor(dueDay, y, m);
  return mkIso(dd.y, dd.m, dd.d);
}

/** (y, m) следующего месяца с ролловером года. */
const nextMonth = (y: number, m: number): [number, number] => (m === 12 ? [y + 1, 1] : [y, m + 1]);
const prevMonth = (y: number, m: number): [number, number] => (m === 1 ? [y - 1, 12] : [y, m - 1]);

/** anchor_on валиден как календарная дата. */
function anchorMs(c: Cadence): number | null {
  if (!c.anchor_on || !RE_ISO.test(c.anchor_on)) return null;
  try {
    return msOf(c.anchor_on);
  } catch {
    return null;
  }
}

/** Абсолютный индекс месяца: y*12 + m - 1 («месяцы от нуля»). */
const monthIdx = (y: number, m: number) => y * 12 + (m - 1);
/** Индекс месяца → (год, месяц). */
const idxToYm = (i: number): [number, number] => [Math.floor(i / 12), (i % 12) + 1];

/**
 * «Каждые N месяцев» (0017): при every_months > 1 индекс месяца якоря —
 * фаза отсчёта сроков (месяцы сроков ≡ якорному mod N). Вызывается только
 * при em > 1; якорь обязателен по контракту API — битый/пустой → null
 * (каденс неполный, как interval без якоря → сроков нет).
 */
function everyMonthsAnchorIdx(c: Cadence): number | null {
  if (anchorMs(c) === null || !c.anchor_on) return null;
  return monthIdx(Number(c.anchor_on.slice(0, 4)), Number(c.anchor_on.slice(5, 7)));
}

/** Самая поздняя дата срока ≤ iso; null — нет сроков или iso раньше первого. */
function onOrBefore(c: Cadence, iso: string): string | null {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  switch (c.frequency) {
    case 'monthly': {
      if (!c.due_day) return null;
      const em = c.every_months ?? 1;
      if (em > 1) {
        // «каждые N мес»: ближайший phase-месяц ≤ (y,m); его срок позже iso —
        // берём предыдущий phase-месяц (фаза бесконечна в обе стороны).
        const am = everyMonthsAnchorIdx(c);
        if (am === null) return null;
        const idx = am + Math.floor((monthIdx(y, m) - am) / em) * em;
        const occ = monthlyIso(c.due_day, ...idxToYm(idx));
        if (occ <= iso) return occ;
        return monthlyIso(c.due_day, ...idxToYm(idx - em));
      }
      const occ = monthlyIso(c.due_day, y, m);
      if (occ <= iso) return occ;
      const [py, pm] = prevMonth(y, m);
      return monthlyIso(c.due_day, py, pm);
    }
    case 'interval_days': {
      if (!c.interval_days) return null;
      const a = anchorMs(c);
      if (a === null) return null;
      const diff = msOf(iso) - a;
      if (diff < 0) return null;
      const k = Math.floor(diff / DAY_MS / c.interval_days);
      return isoOf(a + k * c.interval_days * DAY_MS);
    }
    case 'yearly': {
      if (!c.due_day || !c.due_month) return null;
      const occ = monthlyIso(c.due_day, y, c.due_month);
      if (occ <= iso) return occ;
      return monthlyIso(c.due_day, y - 1, c.due_month);
    }
  }
}

/**
 * Ближайший срок ≥ fromIso; null — полей каденса не хватает
 * (monthly без дня, interval без якоря/шага, yearly без дня/месяца).
 */
export function nextDueOn(c: Cadence, fromIso: string): string | null {
  msOf(fromIso); // валидация входа
  const y = Number(fromIso.slice(0, 4));
  const m = Number(fromIso.slice(5, 7));
  switch (c.frequency) {
    case 'monthly': {
      if (!c.due_day) return null;
      const em = c.every_months ?? 1;
      if (em > 1) {
        // «каждые N мес»: ближайший phase-месяц ≥ (y,m); его срок раньше
        // fromIso — следующий phase-месяц. Каждый срок считается от месяца
        // якоря + k·N месяцев — без дрейфа дней от клампнутой даты.
        const am = everyMonthsAnchorIdx(c);
        if (am === null) return null;
        const idx = am + Math.ceil((monthIdx(y, m) - am) / em) * em;
        const occ = monthlyIso(c.due_day, ...idxToYm(idx));
        if (occ >= fromIso) return occ;
        return monthlyIso(c.due_day, ...idxToYm(idx + em));
      }
      const occ = monthlyIso(c.due_day, y, m);
      if (occ >= fromIso) return occ;
      const [ny, nm] = nextMonth(y, m);
      return monthlyIso(c.due_day, ny, nm);
    }
    case 'interval_days': {
      if (!c.interval_days) return null;
      const a = anchorMs(c);
      if (a === null) return null;
      const diff = msOf(fromIso) - a;
      if (diff <= 0) return c.anchor_on;
      const k = Math.ceil(diff / DAY_MS / c.interval_days);
      return isoOf(a + k * c.interval_days * DAY_MS);
    }
    case 'yearly': {
      if (!c.due_day || !c.due_month) return null;
      const occ = monthlyIso(c.due_day, y, c.due_month);
      if (occ >= fromIso) return occ;
      return monthlyIso(c.due_day, y + 1, c.due_month);
    }
  }
}

/** Самый поздний срок строго раньше dateIso; null — не было/нет сроков. */
export function prevDueOn(c: Cadence, dateIso: string): string | null {
  msOf(dateIso);
  return onOrBefore(c, addDaysIso(dateIso, -1));
}

/**
 * Все сроки в окне [fromIso, toIso] (включительно). Развёртка ограничена
 * OCCURRENCE_LIMIT записями — защита от interval_days=1 на больших окнах.
 */
export function occurrencesInRange(c: Cadence, fromIso: string, toIso: string): string[] {
  msOf(fromIso);
  msOf(toIso);
  const out: string[] = [];
  if (fromIso > toIso) return out;
  let cur = nextDueOn(c, fromIso);
  while (cur !== null && cur <= toIso && out.length < OCCURRENCE_LIMIT) {
    out.push(cur);
    cur = nextDueOn(c, addDaysIso(cur, 1));
  }
  return out;
}

/**
 * Срок D платежа оплачен, если есть запись оплаты с paid_on ∈ (prevDueOn(D), D].
 * Ранний платёж засчитывает ближайший срок вперёд, поздний — не покрывает
 * уже пропущенный (он навсегда «просрочен», его закрывает автопроводка
 * или ручная запись с датой внутри периода).
 */
export function isOccurrencePaid(c: Cadence, occurrenceIso: string, paidOns: string[]): boolean {
  const prev = prevDueOn(c, occurrenceIso);
  return paidOns.some((p) => p <= occurrenceIso && (prev === null || p > prev));
}

/**
 * Эквивалент платежа в месяц: monthly → amount/every_months;
 * interval → amount·30.4375/n; yearly → amount/12.
 * Округление — на потребителе (round2).
 */
export function monthlyAmount(c: Cadence & { amount_minor: number }): number {
  const a = c.amount_minor / 100;
  switch (c.frequency) {
    case 'interval_days':
      return c.interval_days ? (a * 30.4375) / c.interval_days : a;
    case 'yearly':
      return a / 12;
    default: {
      const em = c.every_months ?? 1;
      return em > 1 ? a / em : a;
    }
  }
}

const MONTHS_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/**
 * Короткая подпись каденса: «1 числа» · «каждые 3 мес (31-го)» ·
 * «каждые 14 дн» · «15 марта» · «без даты».
 */
export function cadenceLabel(c: Cadence): string {
  switch (c.frequency) {
    case 'interval_days':
      return c.interval_days ? `каждые ${c.interval_days} дн` : 'без даты';
    case 'yearly':
      return c.due_day && c.due_month ? `${c.due_day} ${MONTHS_GEN[c.due_month - 1]}` : 'без даты';
    default: {
      const em = c.every_months ?? 1;
      if (em > 1) return c.due_day ? `каждые ${em} мес (${c.due_day}-го)` : `каждые ${em} мес`;
      return c.due_day ? `${c.due_day} числа` : 'без даты';
    }
  }
}
