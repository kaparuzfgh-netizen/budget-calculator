/**
 * Даты как ISO-строки 'YYYY-MM-DD' (календарные даты от вызывающего кода).
 * Внутри — только UTC-арифметика, без new Date() / Date.now().
 */
import { DomainError } from './errors';

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

function parseIso(iso: string): number {
  const m = RE_ISO.exec(iso);
  if (!m) throw new DomainError('BAD_DATE', `Ожидалась дата 'YYYY-MM-DD', получено '${iso}'`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const dd = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, dd);
  const d = new Date(ms);
  // проверка валидности (2026-02-30 и т.п.)
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== dd) {
    throw new DomainError('BAD_DATE', `Несуществующая дата '${iso}'`);
  }
  return ms;
}

function toIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function daysInMonth(iso: string): number {
  const ms = parseIso(iso);
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Дней до конца месяца включая сегодня. */
export function daysLeftInMonth(todayIso: string): number {
  const ms = parseIso(todayIso);
  const d = new Date(ms);
  return daysInMonth(todayIso) - d.getUTCDate() + 1;
}

/**
 * addMonths с удержанием конца месяца: 31 янв + 1 → 28/29 фев
 * (осознанное улучшение legacy `setMonth`, который проваливался в март).
 */
export function addMonths(iso: string, n: number): string {
  const ms = parseIso(iso);
  if (!Number.isFinite(n)) throw new DomainError('BAD_NUMBER', `n месяцев должно быть конечным, получено ${n}`);
  const d = new Date(ms);
  const day = d.getUTCDate();
  const total = (d.getUTCFullYear() * 12 + d.getUTCMonth()) + Math.trunc(n);
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toIso(Date.UTC(y, m, Math.min(day, lastDay)));
}

/** ISO-8601 неделя: год берётся ISO-недельный (может отличаться от календарного). */
export function isoWeek(iso: string): { year: number; week: number } {
  const ms = parseIso(iso);
  const d = new Date(ms);
  const day = d.getUTCDay() || 7; // вс=7
  const thursday = ms + (4 - day) * DAY_MS;
  const th = new Date(thursday);
  const yearStart = Date.UTC(th.getUTCFullYear(), 0, 1);
  return {
    year: th.getUTCFullYear(),
    week: Math.ceil(((thursday - yearStart) / DAY_MS + 1) / 7),
  };
}

/** День месяца (1..31). */
export function dayOfMonth(iso: string): number {
  return new Date(parseIso(iso)).getUTCDate();
}
