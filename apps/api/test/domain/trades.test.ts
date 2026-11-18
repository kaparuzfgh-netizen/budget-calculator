import { describe, expect, it } from 'vitest';
import { divDec, mulDivDec, subDec } from '../../src/domain/decimal';
import { applyTrade, avgCost, foldTrades, sortTrades, startingTrade, unitPrice, EMPTY_STATE, type TradeLike } from '../../src/domain/trades';
import { valuation } from '../../src/domain/portfolio';

const T = (id: number, side: 'buy' | 'sell', quantity: string, amount: string, traded_on = '2026-01-01', is_initial = false): TradeLike => ({
  id, side, quantity, amount, traded_on, is_initial,
});

describe('decimal: subDec / divDec / mulDivDec', () => {
  it('subDec', () => {
    expect(subDec('1', '1')).toBe('0');
    expect(subDec('1', '2')).toBeNull();
    expect(subDec('1.5', '0.25')).toBe('1.25');
    expect(subDec('0.00000003', '0.00000001')).toBe('0.00000002');
    expect(subDec('x', '1')).toBeNull();
  });
  it('divDec', () => {
    expect(divDec('1', '3')).toBe('0.33333333');
    expect(divDec('2', '3')).toBe('0.66666667');
    expect(divDec('1', '0')).toBeNull();
    expect(divDec('10', '4')).toBe('2.5');
    expect(divDec('0.00000001', '3')).toBeNull(); // округлилось в 0
    expect(divDec('999999999999', '0.5')).toBeNull(); // > 12 цифр
  });
  it('mulDivDec: одно округление half-up на 8-м знаке', () => {
    expect(mulDivDec('0.01', '0.00000001', '0.00000003')).toBe('0.00333333');
    expect(mulDivDec('1', '1', '8')).toBe('0.125');
    expect(mulDivDec('1', '1', '16')).toBe('0.0625');
    expect(mulDivDec('1', '1', '3')).toBe('0.33333333');
    expect(mulDivDec('1', '1', '0')).toBeNull();
    expect(mulDivDec('1', '5', '1000000000')).toBe('0.00000001');
  });
});

describe('trades: свёртка журнала', () => {
  it('А: средняя цена, частичная и полная продажа', () => {
    const buys = [T(1, 'buy', '1', '30000'), T(2, 'buy', '1', '50000')];
    let r = foldTrades(buys);
    expect(r.state).toMatchObject({ quantity: '2', invested: '80000' });
    expect(avgCost(r.state)).toBe('40000');
    r = foldTrades([...buys, T(3, 'sell', '0.5', '30000')]);
    expect(r.perTrade.get(3)).toBe(1_000_000);
    expect(r.state).toMatchObject({ quantity: '1.5', invested: '60000', realizedMinor: 1_000_000, closedOn: null });
    r = foldTrades([...buys, T(3, 'sell', '0.5', '30000'), T(4, 'sell', '1.5', '45000', '2026-02-02')]);
    expect(r.perTrade.get(4)).toBe(-1_500_000);
    expect(r.state).toEqual({ quantity: null, invested: null, realizedMinor: -500_000, closedOn: '2026-02-02' });
  });
  it('Б: 8 знаков', () => {
    const r = foldTrades([T(1, 'buy', '0.00000003', '0.01'), T(2, 'sell', '0.00000001', '0.01')]);
    expect(r.perTrade.get(2)).toBe(1);
    expect(r.state.quantity).toBe('0.00000002');
    expect(r.state.invested).toBe('0.00666667');
  });
  it('В: продать больше, чем есть — OVERSELL', () => {
    expect(() => applyTrade({ quantity: '1', invested: '10', realizedMinor: null, closedOn: null }, T(1, 'sell', '1.00000001', '5'))).toThrow(/больше/);
    try {
      applyTrade(EMPTY_STATE, T(1, 'sell', '1', '5'));
    } catch (e) {
      expect((e as { code: string }).code).toBe('OVERSELL');
    }
  });
  it('Г: покупка задним числом меняет результат продажи', () => {
    const base = [T(1, 'buy', '1', '100', '2026-01-10'), T(2, 'sell', '1', '150', '2026-01-20')];
    expect(foldTrades(base).state.realizedMinor).toBe(5000);
    const withEarlier = [...base, T(3, 'buy', '1', '300', '2026-01-05')];
    // порядок: 3 (qty1/300), 1 (qty2/400), продажа 1 по среднему 200 → 150-200
    expect(foldTrades(withEarlier).perTrade.get(2)).toBe(-5000);
  });
  it('Д: удаление покупки, на которой держалась продажа — OVERSELL', () => {
    expect(() => foldTrades([T(2, 'sell', '1', '150', '2026-01-20')])).toThrow();
  });
  it('Е: покупка после закрытия открывает позицию, результат сохраняется', () => {
    const r = foldTrades([T(1, 'buy', '1', '100'), T(2, 'sell', '1', '120', '2026-02-01'), T(3, 'buy', '2', '50', '2026-03-01')]);
    expect(r.state).toEqual({ quantity: '2', invested: '50', realizedMinor: 2000, closedOn: null });
  });
  it('sortTrades: начальная первой даже при поздней дате', () => {
    const s = sortTrades([T(2, 'buy', '1', '1', '2026-01-01'), T(1, 'buy', '1', '1', '2026-05-01', true)]);
    expect(s.map((x) => x.id)).toEqual([1, 2]);
  });
  it('startingTrade: invested, avg_price (T3a) и ничего', () => {
    const base = { opened_on: null, created_at: '2026-03-04 10:00:00' };
    expect(startingTrade({ ...base, quantity: '1', invested: '30000', avg_price: null })).toMatchObject({ amount: '30000', traded_on: '2026-03-04', is_initial: true });
    expect(startingTrade({ ...base, quantity: '1', invested: null, avg_price: '30000', opened_on: '2025-01-01' })).toMatchObject({ amount: '30000', traded_on: '2025-01-01' });
    expect(startingTrade({ ...base, quantity: '1', invested: null, avg_price: null })).toBeNull();
  });
  it('unitPrice и valuation закрытой', () => {
    expect(unitPrice({ quantity: '0.5', amount: '15000' })).toBe('30000');
    expect(valuation({ quantity: null, price: '10', avg_price: null, invested: null, amount_minor: null, closed_on: '2026-01-01' })).toEqual({ valueMinor: 0, pnlMinor: null, atCost: false });
  });
});
