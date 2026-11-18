import { describe, expect, it } from 'vitest';
import { addDec, divDecPow10, mulDec } from '../../src/domain/decimal';
import {
  MOEX_BOARDS,
  bondUnitPrice,
  moexCcy,
  moexSecid,
  mskToIso,
  pickMoexQuote,
  type MoexMdRow,
  type MoexSecRow,
} from '../../src/domain/moex';
import shares from '../fixtures/moex/shares.json';
import bonds from '../fixtures/moex/bonds.json';

type Block = { columns: string[]; data: (string | number | null)[][] };
const rows = <T>(b: Block): T[] => b.data.map((r) => Object.fromEntries(b.columns.map((c, i) => [c, r[i]])) as T);

describe('decimal: mulDec/addDec/divDecPow10', () => {
  it('точно, half-up до 8 знаков', () => {
    expect(mulDec('96.1', '1000')).toBe('96100');
    expect(mulDec('0.000000015', '1')).toBe('0.00000002');
    expect(divDecPow10('9610', 2)).toBe('96.1');
    expect(addDec('96.1', '12.34')).toBe('108.44');
    expect(addDec('0.1', '0.2')).toBe('0.3');
  });
  it('переполнение и ноль → null', () => {
    expect(mulDec('999999999999', '10')).toBeNull();
    expect(mulDec('0', '5')).toBeNull();
    expect(addDec('x', '1')).toBeNull();
  });
});

describe('moex: bondUnitPrice', () => {
  it('96.1% × 1000 + НКД 12.34', () => {
    expect(bondUnitPrice('96.1', '1000', '12.34')).toBe('973.34');
  });
  it('амортизированный номинал 600 и НКД пуст', () => {
    expect(bondUnitPrice('99.5', '600', null)).toBe('597');
  });
  it('8-й знак half-up и переполнение', () => {
    expect(bondUnitPrice('0.000001', '1.5', null)).toBe('0.00000002');
    expect(bondUnitPrice('999999999', '999999999', null)).toBeNull();
  });
});

describe('moex: время и валюта', () => {
  it('mskToIso', () => {
    expect(mskToIso('2026-11-13 18:49:59')).toBe('2026-11-13T15:49:59.000Z');
    expect(mskToIso('вчера')).toBeNull();
    expect(mskToIso(null)).toBeNull();
  });
  it('moexCcy / moexSecid', () => {
    expect(moexCcy('SUR')).toBe('RUB');
    expect(moexCcy('cny')).toBe('CNY');
    expect(moexCcy('??')).toBeNull();
    expect(moexSecid(' sber ')).toBe('SBER');
    expect(moexSecid('RU.X')).toBeNull();
  });
});

describe('moex: pickMoexQuote (фикстуры живого ISS)', () => {
  const sh = { s: rows<MoexSecRow>(shares.securities), m: rows<MoexMdRow>(shares.marketdata) };
  const bd = { s: rows<MoexSecRow>(bonds.securities), m: rows<MoexMdRow>(bonds.marketdata) };

  it('акция: TQBR, LAST, время котировки = UPDATETIME', () => {
    const q = pickMoexQuote('stock', 'SBER', sh.s, sh.m);
    expect(q).toEqual({ price: '298.24', vs: 'RUB', asOf: '2026-11-18T09:05:13.000Z' });
  });
  it('борд вне белого списка (только SPEQ) → нет котировки', () => {
    const s: MoexSecRow[] = [{ SECID: 'X', BOARDID: 'SPEQ', CURRENCYID: 'SUR', PREVPRICE: 10, PREVDATE: '2026-11-17' }];
    expect(pickMoexQuote('stock', 'X', s, [])).toBeNull();
  });
  it('цепочка LAST → LCURRENTPRICE → MARKETPRICE → PREVPRICE', () => {
    const s: MoexSecRow[] = [{ SECID: 'A', BOARDID: 'TQBR', CURRENCYID: 'SUR', PREVPRICE: 5, PREVDATE: '2026-11-13' }];
    const md = (o: Partial<MoexMdRow>): MoexMdRow[] => [
      { SECID: 'A', BOARDID: 'TQBR', LAST: null, LCURRENTPRICE: null, MARKETPRICE: null, SYSTIME: '2026-11-14 12:00:00', UPDATETIME: '11:45:00', ...o },
    ];
    expect(pickMoexQuote('stock', 'A', s, md({ LAST: 1 }))?.price).toBe('1');
    expect(pickMoexQuote('stock', 'A', s, md({ LCURRENTPRICE: 2 }))?.price).toBe('2');
    expect(pickMoexQuote('stock', 'A', s, md({ MARKETPRICE: 3 }))?.price).toBe('3');
    const prev = pickMoexQuote('stock', 'A', s, md({}));
    expect(prev).toEqual({ price: '5', vs: 'RUB', asOf: '2026-11-13T15:50:00.000Z' });
    expect(pickMoexQuote('stock', 'A', [{ SECID: 'A', BOARDID: 'TQBR', CURRENCYID: 'SUR' }], md({ LAST: 0 }))).toBeNull();
  });
  it('UPDATETIME позже SYSTIME (смена суток) → вчера', () => {
    const s: MoexSecRow[] = [{ SECID: 'A', BOARDID: 'TQBR', CURRENCYID: 'SUR' }];
    const m: MoexMdRow[] = [{ SECID: 'A', BOARDID: 'TQBR', LAST: 1, SYSTIME: '2026-11-14 00:05:00', UPDATETIME: '23:50:00' }];
    expect(pickMoexQuote('stock', 'A', s, m)?.asOf).toBe('2026-11-13T20:50:00.000Z');
  });
  it('TQBR приоритетнее TQTF', () => {
    const s: MoexSecRow[] = [
      { SECID: 'F', BOARDID: 'TQTF', CURRENCYID: 'SUR' },
      { SECID: 'F', BOARDID: 'TQBR', CURRENCYID: 'SUR' },
    ];
    const m: MoexMdRow[] = [
      { SECID: 'F', BOARDID: 'TQTF', LAST: 2, SYSTIME: '2026-11-18 12:00:00', UPDATETIME: '11:45:00' },
      { SECID: 'F', BOARDID: 'TQBR', LAST: 1, SYSTIME: '2026-11-18 12:00:00', UPDATETIME: '11:45:00' },
    ];
    expect(pickMoexQuote('stock', 'F', s, m)?.price).toBe('1');
    expect(MOEX_BOARDS.shares[0]).toBe('TQBR');
  });
  it('ОФЗ: 51.041% × 1000 + НКД 32.87 = 543.28', () => {
    const q = pickMoexQuote('bond', 'SU26238RMFS4', bd.s, bd.m);
    expect(q?.price).toBe('543.28');
    expect(q?.vs).toBe('RUB');
  });
  it('юаневая облигация: рублёвый TQCB и TQOD пропущены, берётся TQOY в CNY', () => {
    const q = pickMoexQuote('bond', 'RU000A1087C3', bd.s, bd.m);
    expect(q).toMatchObject({ vs: 'CNY', price: '100.7068' });
  });
  it('нет номинала → нет котировки; НКД null → 0', () => {
    const m: MoexMdRow[] = [{ SECID: 'B', BOARDID: 'TQOB', LAST: 90, SYSTIME: '2026-11-18 12:00:00', UPDATETIME: '11:45:00' }];
    expect(pickMoexQuote('bond', 'B', [{ SECID: 'B', BOARDID: 'TQOB', CURRENCYID: 'SUR', FACEUNIT: 'SUR' }], m)).toBeNull();
    expect(
      pickMoexQuote('bond', 'B', [{ SECID: 'B', BOARDID: 'TQOB', CURRENCYID: 'SUR', FACEUNIT: 'SUR', FACEVALUE: 1000, ACCRUEDINT: null }], m)?.price,
    ).toBe('900');
  });
});

import { MOEX_POLICY, effectivePrice } from '../../src/domain/portfolio';
import { priceRefFor } from '../../src/domain/price-ref';

describe('effectivePrice с MOEX_POLICY', () => {
  const h = { kind: 'stock' as const, price: '250', price_on: '2026-10-01' };
  const nowIso = '2026-11-15T12:00:00.000Z'; // воскресенье
  it('пятничная котировка (~2 дня) свежая и бьёт ручную', () => {
    const e = effectivePrice(h, { price: '300', asOf: '2026-11-13T15:49:00.000Z' }, '2026-11-15', nowIso, true, MOEX_POLICY);
    expect(e).toMatchObject({ price: '300', source: 'auto', stale: false });
  });
  it('15 дней — котировка не используется', () => {
    const e = effectivePrice(h, { price: '300', asOf: '2026-10-31T10:00:00.000Z' }, '2026-11-15', nowIso, true, MOEX_POLICY);
    expect(e.source).toBe('manual');
  });
  it('5 дней: новее ручной → авто, но stale', () => {
    const e = effectivePrice(h, { price: '300', asOf: '2026-11-10T10:00:00.000Z' }, '2026-11-15', nowIso, true, MOEX_POLICY);
    expect(e).toMatchObject({ source: 'auto', stale: true });
  });
  it('политика по умолчанию (крипта) для акции тоже работает по AUTO_KINDS, other — нет', () => {
    expect(effectivePrice({ ...h, kind: 'other' }, { price: '1', asOf: nowIso }, '2026-11-15', nowIso).source).toBe('manual');
  });
});

describe('priceRefFor', () => {
  it('источники', () => {
    expect(priceRefFor('stock', 'SBER')).toMatchObject({ source: 'moex', id: 'SBER', market: 'shares' });
    expect(priceRefFor('bond', 'su26238rmfs4')).toMatchObject({ source: 'moex', market: 'bonds' });
    expect(priceRefFor('crypto', 'BTC')).toEqual({ source: 'coingecko', id: 'bitcoin' });
    expect(priceRefFor('crypto', 'SBER')).toBeNull();
    expect(priceRefFor('bond', 'RU.X')).toBeNull();
    expect(priceRefFor('deposit', 'SBER')).toBeNull();
    expect(priceRefFor('stock', null)).toBeNull();
  });
});
