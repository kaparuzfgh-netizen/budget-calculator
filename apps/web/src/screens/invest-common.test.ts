import { describe, expect, it } from 'vitest';
import { buildBody, emptyForm, formError, normDec, targetsFrom } from './invest-common';

const crypto = { ...emptyForm('crypto'), name: 'BTC', currency: 'usd', quantity: '0,12345678', price: '30000.50' };

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
  it('галочка автоцены: только крипта с тикером из списка сервера', async () => {
    const { autoSupported } = await import('./invest-common');
    const list = ['BTC', 'ETH'];
    expect(autoSupported('crypto', 'btc', list)).toBe(true);
    expect(autoSupported('crypto', 'ZZZ', list)).toBe(false);
    expect(autoSupported('stock', 'BTC', list)).toBe(false);
    expect(autoSupported('crypto', '', list)).toBe(false);
  });

  it('auto_price уходит только у крипты; цена строкой, как раньше', () => {
    const c = { ...crypto, autoPrice: false };
    expect(buildBody(c, { clientId: 'c' }).auto_price).toBe(false);
    expect(buildBody({ ...c, autoPrice: true }, { clientId: 'c' }).auto_price).toBe(true);
    const stock = { ...emptyForm('stock'), name: 'S', currency: 'usd', quantity: '1', price: '2' };
    expect('auto_price' in buildBody(stock, { clientId: 'c' })).toBe(false);
    expect(typeof buildBody(c, { clientId: 'c' }).price).toBe('string');
  });
});
