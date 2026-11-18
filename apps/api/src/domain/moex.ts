/**
 * moex.ts — чистая логика автоцен Московской биржи (T3c): белый список бордов,
 * выбор цены и её времени, цена облигации «% от номинала × номинал / 100 + НКД».
 * Без I/O; числа из JSON — только через decFromProviderNumber (правило 21, без float-арифметики).
 *
 * Сверено живыми запросами к ISS (2026-11-18): у облигаций LAST/MARKETPRICE/PREVPRICE — проценты
 * номинала; FACEVALUE — непогашенный номинал в FACEUNIT; ACCRUEDINT — НКД в деньгах; SYSTIME —
 * текущее серверное московское время (НЕ время котировки), время котировки — UPDATETIME (без даты).
 */
import { addDec, decFromProviderNumber, divDecPow10, mulDec } from './decimal';

export type MoexKind = 'stock' | 'bond';
export type MoexMarket = 'shares' | 'bonds';

export const MOEX_MARKET: Record<MoexKind, MoexMarket> = { stock: 'shares', bond: 'bonds' };

/** Борды по приоритету (бумага на других бордах — SPEQ, SMAL, внебиржа — автоцену не получает). */
export const MOEX_BOARDS: Record<MoexMarket, readonly string[]> = {
  shares: ['TQBR', 'TQTF', 'TQIF'],
  bonds: ['TQOB', 'TQCB', 'TQIR', 'TQOD', 'TQOY'],
};

/** Допустимый SECID (без точки; регистр приводит вызывающий). */
export const MOEX_SECID_RE = /^[A-Z0-9-]{1,12}$/;

/** Нормализованный SECID или null. */
export function moexSecid(ticker: string | null | undefined): string | null {
  const t = (ticker ?? '').trim().toUpperCase();
  return MOEX_SECID_RE.test(t) ? t : null;
}

/** Валюта ISS → ISO: SUR → RUB; кривое → null. */
export function moexCcy(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  const ccy = c === 'SUR' ? 'RUB' : c;
  return /^[A-Z]{3}$/.test(ccy) ? ccy : null;
}

/** 'YYYY-MM-DD HH:MM:SS' (Москва, UTC+3 без перехода на летнее время) → ISO UTC. */
export function mskToIso(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(s.trim());
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}+03:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Цена облигации за 1 шт: pct × face / 100 + aci. aci пуст → 0. null — нет цены/номинала или переполнение. */
export function bondUnitPrice(pct: string, face: string, aci: string | null): string | null {
  const nominal = mulDec(pct, face);
  if (!nominal) return null;
  const base = divDecPow10(nominal, 2);
  if (!base) return null;
  return aci ? addDec(base, aci) : base;
}

type Cell = string | number | null | undefined;
export interface MoexSecRow {
  SECID?: Cell;
  BOARDID?: Cell;
  CURRENCYID?: Cell;
  FACEUNIT?: Cell;
  FACEVALUE?: Cell;
  ACCRUEDINT?: Cell;
  PREVPRICE?: Cell;
  PREVDATE?: Cell;
}
export interface MoexMdRow {
  SECID?: Cell;
  BOARDID?: Cell;
  LAST?: Cell;
  LCURRENTPRICE?: Cell;
  MARKETPRICE?: Cell;
  SYSTIME?: Cell;
  UPDATETIME?: Cell;
}

export interface MoexPick {
  /** Цена за 1 шт, каноническая строка (облигация — с НКД). */
  price: string;
  /** Валюта цены, верхний регистр. */
  vs: string;
  /** ISO-время самой котировки. */
  asOf: string;
}

/** Время котировки: дата из SYSTIME + UPDATETIME (если вышло позже SYSTIME — вчера); иначе SYSTIME. */
function quoteTime(md: MoexMdRow): string | null {
  const sys = mskToIso(md.SYSTIME);
  if (!sys) return null;
  const upd = typeof md.UPDATETIME === 'string' ? /^(\d{2}:\d{2}:\d{2})$/.exec(md.UPDATETIME.trim()) : null;
  if (!upd) return sys;
  const day = String(md.SYSTIME).trim().slice(0, 10);
  const t = Date.parse(`${day}T${upd[1]}+03:00`);
  if (!Number.isFinite(t)) return sys;
  const sysMs = Date.parse(sys);
  return new Date(t > sysMs ? t - 86_400_000 : t).toISOString();
}

const isNum = (v: Cell): v is number => typeof v === 'number';

/** Цена и время одной бумаги на одном борде (3.3): LAST → LCURRENTPRICE → MARKETPRICE → PREVPRICE. */
function pickOnBoard(kind: MoexKind, sec: MoexSecRow | undefined, md: MoexMdRow | undefined): MoexPick | null {
  let raw: string | null = null;
  let asOf: string | null = null;
  if (md) {
    for (const v of [md.LAST, md.LCURRENTPRICE, md.MARKETPRICE]) {
      const p = isNum(v) ? decFromProviderNumber(v) : null;
      if (p) {
        raw = p;
        asOf = quoteTime(md);
        break;
      }
    }
  }
  if (!raw && sec) {
    const p = isNum(sec.PREVPRICE) ? decFromProviderNumber(sec.PREVPRICE) : null;
    const d = typeof sec.PREVDATE === 'string' ? mskToIso(`${sec.PREVDATE.trim()} 18:50:00`) : null;
    if (p && d) {
      raw = p;
      asOf = d;
    }
  }
  if (!raw || !asOf || !sec) return null;
  if (kind === 'stock') {
    const vs = moexCcy(sec.CURRENCYID);
    return vs ? { price: raw, vs, asOf } : null;
  }
  const face = isNum(sec.FACEVALUE) ? decFromProviderNumber(sec.FACEVALUE) : null;
  if (!face) return null;
  const aci = isNum(sec.ACCRUEDINT) ? decFromProviderNumber(sec.ACCRUEDINT) : null;
  const price = bondUnitPrice(raw, face, aci);
  // НКД ISS — в валюте расчётов борда: если она не равна валюте номинала (юаневая бумага на рублёвом TQCB,
  // валютная на TQOD), цена была бы смесью валют — такой борд пропускаем (нужен TQOY и т.п.).
  const vs = moexCcy(sec.FACEUNIT) ?? moexCcy(sec.CURRENCYID);
  const settle = moexCcy(sec.CURRENCYID);
  if (settle && vs && settle !== vs) return null;
  return price && vs ? { price, vs, asOf } : null;
}

/** Выбор борда по приоритету белого списка и цены; ничего подходящего → null (не ошибка). */
export function pickMoexQuote(
  kind: MoexKind,
  secid: string,
  secs: readonly MoexSecRow[],
  mds: readonly MoexMdRow[],
): MoexPick | null {
  for (const board of MOEX_BOARDS[MOEX_MARKET[kind]]) {
    const sec = secs.find((r) => r.SECID === secid && r.BOARDID === board);
    const md = mds.find((r) => r.SECID === secid && r.BOARDID === board);
    if (!sec && !md) continue;
    const p = pickOnBoard(kind, sec, md);
    if (p) return p;
  }
  return null;
}
