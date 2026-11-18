import { describe, expect, it } from 'vitest';
import { buildBody, buildTradeBody, cmpDec, needsPrice, emptyForm, formError, isLocked, normDec, splitPositions, targetsFrom, tradeFormError } from './invest-common';

const crypto = { ...emptyForm('crypto'), name: 'BTC', currency: 'usd', quantity: '0,12345678', invested: '128,5', price: '30000.50' };

describe('invest-common', () => {
  it('normDec: запятая → точка, ноль и мусор отклоняются', () => {
    expect(normDec('0,5')).toBe('0.5');
    expect(normDec(' 12 ')).toBe('12');
    for (const bad of ['0', '', '1e3', '-1', '0.123456789', 'abc']) expect(normDec(bad), bad).toBeNull();
  });

  it('количество и цена уходят СТРОКАМИ (8-й знак не теряется), client_id в теле создания', () => {
    expect(formError(crypto)).toBeNull();
    const b = buildBody(crypto, { clientId: 'cid-1' });
    expect(b.quantity).toBe('0.12345678');
    expect(typeof b.quantity).toBe('string');
    expect(b.price).toBe('30000.50');
    expect(typeof b.price).toBe('string');
    expect(b.kind).toBe('crypto');
    expect(b.client_id).toBe('cid-1');
    expect(b.currency).toBe('USD');
    expect('amount' in b).toBe(false);
  });

  it('повтор той же отправки — тот же client_id (форма хранит его на попытку)', () => {
    const cid = 'same-uuid';
    expect(buildBody(crypto, { clientId: cid }).client_id).toBe(buildBody(crypto, { clientId: cid }).client_id);
  });

  it('вклад: сумма числом, ставка только для вклада/облигаций', () => {
    const dep = { ...emptyForm('deposit'), name: 'Вклад', currency: 'RUB', amount: '1 000,50', rate: '12' };
    expect(formError(dep)).toBeNull();
    const b = buildBody(dep, { clientId: 'c' });
    expect(b.amount).toBe(1000.5);
    expect(b.rate).toBe(12);
    expect('quantity' in b).toBe(false);
    expect(buildBody({ ...dep, kind: 'other' }, {}).rate).toBeNull();
  });

  it('правка: kind/client_id не шлём, неизменённую цену не шлём', () => {
    const same = buildBody({ ...crypto, name: 'BTC2' }, { original: crypto });
    expect('price' in same).toBe(false);
    expect('kind' in same).toBe(false);
    expect('client_id' in same).toBe(false);
    expect(buildBody({ ...crypto, price: '31000' }, { original: crypto }).price).toBe('31000');
  });

  it('валидация формы', () => {
    expect(formError({ ...crypto, name: ' ' })).toMatch(/название/i);
    expect(formError({ ...crypto, currency: 'x' })).toMatch(/Валюта/);
    expect(formError({ ...crypto, quantity: '0' })).toMatch(/Количество/);
    expect(formError({ ...crypto, price: '1,2,3' })).toMatch(/Цена/);
    expect(formError({ ...emptyForm('deposit'), name: 'a', currency: 'USD', amount: '' })).toBeTruthy();
    expect(formError({ ...emptyForm('deposit'), name: 'a', currency: 'USD', amount: '5', openedOn: '2026-02-01', maturesOn: '2026-01-01' })).toMatch(/раньше/);
  });

  it('цели: сумма 100, целые', () => {
    expect(targetsFrom({ deposit: '60', crypto: '40' })).toEqual({ targets: { deposit: 60, crypto: 40 } });
    expect('error' in targetsFrom({ deposit: '50' })).toBe(true);
    expect('error' in targetsFrom({ deposit: '50.5', crypto: '49.5' })).toBe(true);
  });
});

describe('автоцены (T3b)', () => {
  it('автоцена: крипта из списка сервера или бумага с кодом биржи', async () => {
    const { autoSupported } = await import('./invest-common');
    const list = ['BTC', 'ETH'];
    expect(autoSupported('crypto', 'btc', list)).toBe(true);
    expect(autoSupported('crypto', 'ZZZ', list)).toBe(false);
    expect(autoSupported('stock', 'BTC', list)).toBe(true); // T3c: акция с кодом — источник биржа
    expect(autoSupported('deposit', 'BTC', list)).toBe(false);
    expect(autoSupported('crypto', '', list)).toBe(false);
  });

  it('T10: «Потрачено» строкой; цена сейчас — только если автоцены нет', () => {
    const list = ['BTC'];
    const btc = { ...crypto, ticker: 'btc', price: '' };
    expect(needsPrice(btc, list)).toBe(false);
    expect(formError(btc, list)).toBeNull();
    const b = buildBody(btc, { clientId: 'c', supported: list });
    expect(b.invested).toBe('128.5');
    expect(typeof b.invested).toBe('string');
    expect('price' in b).toBe(false);
    expect('auto_price' in b).toBe(false);
    expect('avg_price' in b).toBe(false);
    // монета вне списка и акция — цена обязательна
    const zzz = { ...btc, ticker: 'zzz' };
    expect(formError(zzz, list)).toMatch(/Цена сейчас/);
    expect(buildBody({ ...zzz, price: '2' }, { clientId: 'c', supported: list }).price).toBe('2');
    expect(formError({ ...emptyForm('stock'), name: 'S', currency: 'usd', quantity: '1', invested: '5' }, list)).toMatch(/Цена сейчас/);
    expect(formError({ ...btc, invested: '' }, list)).toMatch(/Потрачено/);
  });
});

describe('T3c: акции и облигации Мосбиржи', () => {
  const stock = { ...emptyForm('stock'), name: 'Сбер', currency: 'rub', quantity: '10', invested: '2900', ticker: 'sber' };
  it('тикер акции/облигации → цена не нужна, в тело не уходит', () => {
    expect(needsPrice(stock, [])).toBe(false);
    expect(formError(stock, [])).toBeNull();
    const b = buildBody(stock, { clientId: 'c', supported: [] });
    expect('price' in b).toBe(false);
    expect(b.ticker).toBe('SBER');
    expect(needsPrice({ ...stock, kind: 'bond', ticker: 'SU26238RMFS4' }, [])).toBe(false);
  });
  it('без тикера или с точкой — цена обязательна', () => {
    expect(needsPrice({ ...stock, ticker: '' }, [])).toBe(true);
    expect(formError({ ...stock, ticker: '' }, [])).toMatch(/Цена сейчас/);
    expect(needsPrice({ ...stock, ticker: 'RU.X' }, [])).toBe(true);
  });
  it('крипта не зависит от бирожевого правила', () => {
    expect(needsPrice({ ...emptyForm('crypto'), ticker: 'SBER' }, ['BTC'])).toBe(true);
  });
});

describe('журнал сделок (T3d1)', () => {
  const tf = { side: 'sell' as const, quantity: '0,5', amount: '100', tradedOn: '2026-01-02', note: ' x ' };
  it('cmpDec: BigInt, 8-й знак', () => {
    expect(cmpDec('1.00000001', '1')).toBe(1);
    expect(cmpDec('1', '1.00000000')).toBe(0);
    expect(cmpDec('0,5', '0.50000001')).toBe(-1);
  });
  it('tradeFormError: пусто/ноль/больше остатка/будущее', () => {
    expect(tradeFormError({ ...tf, quantity: '' }, '1')).toMatch(/Количество/);
    expect(tradeFormError({ ...tf, amount: '0' }, '1')).toMatch(/Сумма/);
    expect(tradeFormError({ ...tf, quantity: '1.00000001' }, '1')).toMatch(/Нельзя продать больше/);
    expect(tradeFormError(tf, null)).toMatch(/Нельзя продать/);
    expect(tradeFormError(tf, '0.5')).toBeNull();
    expect(tradeFormError({ ...tf, side: 'buy', quantity: '999' }, null)).toBeNull();
    expect(tradeFormError({ ...tf, tradedOn: '2999-01-01' }, '1', '2026-01-02')).toMatch(/будущем/);
  });
  it('buildTradeBody: строки и client_id', () => {
    const b = buildTradeBody(tf, 'cid');
    expect(b).toEqual({ side: 'sell', quantity: '0.5', amount: '100', traded_on: '2026-01-02', note: 'x', client_id: 'cid' });
  });
  it('isLocked и buildBody без quantity/invested/currency', () => {
    expect(isLocked({ trades_count: 2 })).toBe(true);
    expect(isLocked({ trades_count: 0 })).toBe(false);
    const b = buildBody(crypto, { original: crypto, locked: true });
    for (const k of ['quantity', 'invested', 'currency']) expect(k in b, k).toBe(false);
  });
  it('splitPositions: открытые / закрытые / скрытые', () => {
    const mk = (closed_on: string | null, hidden: boolean) => ({ closed_on, hidden }) as never;
    const r = splitPositions([mk(null, false), mk('2026-01-01', false), mk('2026-01-01', true)]);
    expect([r.open.length, r.closed.length, r.hidden.length]).toEqual([1, 1, 1]);
  });
});
