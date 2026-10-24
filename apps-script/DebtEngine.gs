/**
 * DebtEngine.gs — состояние ипотек, ЧДП, roll-forward, проекции.
 *
 * Источник истины — журнал событий на листе Debt_Engine (строка 19+):
 *   Date | Debt | Event ('payment'|'prepay') | Amount ₽ | Balance After | Payment After | Source
 *
 * Текущее состояние (строки 2–3) всегда выводится replay-проходом по журналу от
 * начального баланса (Initial Balance, Epoch). Это делает пересчёт
 * идемпотентным и самовосстанавливающимся.
 *
 * Математика ЧДП (сохранение срока, снижение платежа — режим банков РФ):
 *   P_new = (B − L) · r(1+r)^n / ((1+r)^n − 1),  n = n0 − payments_made,
 *   где n0 выводится инверсией аннуитета из начальных (B0, r, P0)
 *   (для Сбербанка получается 34.5 мес — совпадает с графиком банка ±50 ₽).
 */

const DebtEngine = {
  STATE_HEADER_ROW: 1,
  STATE_FIRST_ROW: 2,
  LOG_HEADER_ROW: 19,
  LOG_FIRST_ROW: 20,

  // ── базовые формулы ──

  periodsPerYear_: function (type) {
    return type === 'biweekly' ? 26 : 12;
  },

  annuityPayment_: function (balance, annualRate, ppy, periods) {
    if (periods <= 0 || balance <= 0) return 0;
    const r = annualRate / ppy;
    if (r <= 0) return balance / periods;
    return (balance * r * Math.pow(1 + r, periods)) / (Math.pow(1 + r, periods) - 1);
  },

  /** Инверсия аннуитета: сколько периодов осталось при (balance, rate, payment). */
  derivePeriods_: function (balance, annualRate, ppy, payment) {
    const r = annualRate / ppy;
    if (r <= 0) return balance / payment;
    if (payment <= balance * r) return Infinity; // платёж не покрывает проценты
    return -Math.log(1 - (balance * r) / payment) / Math.log(1 + r);
  },

  cfgById_: function (id) {
    const key = String(id || '').toUpperCase();
    return CONFIG.DEBTS.filter(function (d) { return d.id === key; })[0] ||
      CONFIG.DEBTS.filter(function (d) { return d.id.indexOf(key) === 0; })[0];
  },

  // ── чтение состояния ──

  getDebts: function () {
    const sh = sheet_(SHEETS.DEBTS);
    // Блок состояния строго в строках 2–3 (ниже — ЧДП-калькулятор и журнал событий)
    const values = sh.getRange(this.STATE_FIRST_ROW, 1, CONFIG.DEBTS.length, 11).getValues();
    const known = CONFIG.DEBTS.map(function (d) { return d.id; });
    const debts = [];
    values.forEach(function (r, i) {
      if (known.indexOf(String(r[0])) === -1) return;
      debts.push({
        row: DebtEngine.STATE_FIRST_ROW + i,
        id: String(r[0]),
        name: String(r[1] || ''),
        balance: Number(r[2]) || 0,
        payment: Number(r[3]) || 0,
        rate: Number(r[4]) || 0,
        type: String(r[5] || 'monthly'),
        paymentsMade: Number(r[6]) || 0,
        initialBalance: Number(r[7]) || 0,
        epoch: r[8] instanceof Date ? r[8] : new Date(String(r[8])),
        maturity: r[9] ? (r[9] instanceof Date ? r[9] : new Date(String(r[9]))) : null,
      });
    });
    return debts;
  },

  getDebt: function (id) {
    const key = String(id || '').toUpperCase();
    const list = this.getDebts().filter(function (d) { return d.id === key; });
    if (!list.length) throw new Error('Ипотека не найдена: ' + id + ' (доступны SBER, TBANK)');
    return list[0];
  },

  getEvents: function () {
    const rows = readRange_(SHEETS.DEBTS, this.LOG_FIRST_ROW);
    const events = [];
    rows.forEach(function (r) {
      if (!r[0] || !r[1]) return;
      events.push({
        date: r[0] instanceof Date ? r[0] : new Date(String(r[0])),
        debt: String(r[1]),
        event: String(r[2]),
        amount: Number(r[3]) || 0,
      });
    });
    events.sort(function (a, b) { return a.date - b.date; });
    return events;
  },

  initialPayment_: function (debtId) {
    const cfg = this.cfgById_(debtId);
    return cfg ? cfg.payment_amount_rub : 0;
  },

  // ── replay: журнал → живое состояние ──

  replayAll: function () {
    const events = this.getEvents();
    const debts = this.getDebts();
    const sh = sheet_(SHEETS.DEBTS);
    const now = fmtISO_(new Date());

    debts.forEach(function (debt) {
      const ppy = DebtEngine.periodsPerYear_(debt.type);
      const r = debt.rate / ppy;
      let balance = debt.initialBalance;
      let payment = DebtEngine.initialPayment_(debt.id);
      let made = 0;
      const n0 = DebtEngine.derivePeriods_(debt.initialBalance, debt.rate, ppy, payment);
      let n0Eff = n0; // эффективно смещается событиями reconcile

      events.forEach(function (ev) {
        if (ev.debt !== debt.id || !ev.amount) return;
        if (ev.event === 'payment') {
          const interest = balance * r;
          balance = Math.max(0, balance - Math.max(0, ev.amount - interest));
          made += 1;
        } else if (ev.event === 'prepay') {
          balance = Math.max(0, balance - ev.amount);
          const nLeft = Math.max(0, n0Eff - made);
          payment = DebtEngine.annuityPayment_(balance, debt.rate, ppy, nLeft); // срок сохраняется
        } else if (ev.event === 'reconcile') {
          // сверка с банком: факт главнее; платёж не меняется, срок пересчитывается
          balance = Math.max(0, ev.amount);
          n0Eff = made + DebtEngine.derivePeriods_(balance, debt.rate, ppy, payment);
        }
      });

      sh.getRange(debt.row, 3).setValue(balance);
      sh.getRange(debt.row, 4).setValue(payment);
      sh.getRange(debt.row, 7).setValue(made);
      sh.getRange(debt.row, 11).setValue(now);
      debt.balance = balance;
      debt.payment = payment;
      debt.paymentsMade = made;
      debt.periodsPerYear = ppy;
      debt.remainingPeriods = n0 - made;
    });

    this.refreshDerivedState_();
    return this.getDebts();
  },

  /** Обновляет ячейку B7 (n) ЧДП-калькулятора и возвращает долги с полями проекций. */
  refreshDerivedState_: function () {
    const debts = this.getDebts();
    const sber = debts.filter(function (d) { return d.id === 'SBER'; })[0];
    if (sber) {
      // оставшийся срок = инверсия аннуитета от текущего (баланс, ставка, платёж):
      // консистентно и после ЧДП, и после reconcile
      const n = this.derivePeriods_(sber.balance, sber.rate, 12, sber.payment);
      sheet_(SHEETS.DEBTS).getRange('B7').setValue(Math.round(n * 10) / 10);
    }
  },

  // ── операции ──

  appendEvent_: function (debtId, event, amountRUB, source, dateOverride) {
    const when = dateOverride instanceof Date ? dateOverride : new Date();
    sheet_(SHEETS.DEBTS).appendRow([
      when, debtId, event, Number(amountRUB) || 0, '', '', source || 'manual',
    ]);
    return when;
  },

  /** ЧДП: списание из тела + пересчёт платежа с сохранением срока. Возвращает сводку. */
  registerPrepay: function (debtId, amountRUB) {
    const self = this;
    return runWithLock_(function () {
      const debt = self.getDebt(debtId);
      const amount = Number(amountRUB);
      if (!isFinite(amount) || amount <= 0) throw new Error('Сумма ЧДП должна быть положительным числом');
      if (amount > debt.balance) throw new Error('Сумма ЧДП (' + fmtMoney_(amount, 'RUB') + ') больше остатка долга (' + fmtMoney_(debt.balance, 'RUB') + ')');

      const paymentBefore = debt.payment;
      const balanceBefore = debt.balance;

      // сразу пишем событие, затем журнал-обложка: последняя строка лога получает after-значения
      self.appendEvent_(debt.id, 'prepay', amount, 'manual');
      self.replayAll();
      const after = self.getDebt(debt.id);

      // дозаполняем Balance After / Payment After в строке события
      const sh = sheet_(SHEETS.DEBTS);
      const lastRow = sh.getLastRow();
      sh.getRange(lastRow, 5, 1, 2).setValues([[after.balance, after.payment]]);

      return {
        id: debt.id,
        name: debt.name,
        amount: amount,
        balanceBefore: balanceBefore,
        balanceAfter: after.balance,
        paymentBefore: paymentBefore,
        paymentAfter: after.payment,
        paymentSaved: paymentBefore - after.payment,
      };
    });
  },

  /** Ручная отметка планового платежа (если авто-ролл не сработал или сумма иная). */
  logPayment: function (debtId, amountRUB) {
    const self = this;
    return runWithLock_(function () {
      const debt = self.getDebt(debtId);
      const amount = amountRUB === undefined || amountRUB === null || amountRUB === ''
        ? debt.payment
        : Number(amountRUB);
      self.appendEvent_(debt.id, 'payment', amount, 'manual');
      self.replayAll();
      const after = self.getDebt(debt.id);
      const sh = sheet_(SHEETS.DEBTS);
      sh.getRange(sh.getLastRow(), 5, 1, 2).setValues([[after.balance, after.payment]]);
      return after;
    });
  },

  /**
   * Сверка с банком (P1 + Vision): установить ФАКТИЧЕСКИЙ остаток долга из
   * приложения банка. Платёж не меняется — срок пересчитывается.
   * Возвращает { before, after, drift, projection }.
   */
  reconcile: function (debtId, actualBalanceRUB) {
    const self = this;
    return runWithLock_(function () {
      const debt = self.getDebt(debtId);
      const actual = Number(actualBalanceRUB);
      if (!isFinite(actual) || actual < 0) throw new Error('Остаток должен быть неотрицательным числом');
      const before = debt.balance;
      if (Math.abs(before - actual) < 1) {
        return { id: debt.id, name: debt.name, before: before, after: before, drift: 0, unchanged: true };
      }
      self.appendEvent_(debt.id, 'reconcile', actual, 'vision-reconcile');
      self.replayAll();
      const after = self.getDebt(debt.id);
      const sh = sheet_(SHEETS.DEBTS);
      sh.getRange(sh.getLastRow(), 5, 1, 2).setValues([[after.balance, after.payment]]);
      const proj = self.projection(after, 0);
      const bigDrift = Math.abs(actual - before) > before * 0.2; // >20% — подозрительно много
      MetricsEngine.log('recon_drift:' + debt.id + ':' + fmtMonthKey_(new Date()), Math.round(Math.abs(before - actual)));
      logOps_(bigDrift ? 'WARN' : 'INFO', 'reconcile',
        debt.id + ': ' + Math.round(before) + ' → ' + Math.round(actual) + ' ₽' + (bigDrift ? ' (расхождение >20%)' : ''));
      return {
        id: debt.id,
        name: debt.name,
        before: before,
        after: after.balance,
        drift: actual - before,
        unchanged: false,
        bigDrift: bigDrift,
        monthsLeft: proj.monthsLeft,
        payoffISO: proj.payoffISO,
      };
    });
  },

  // ── roll-forward: автопостановка наступивших плановых платежей ──

  checkDuePayments: function () {
    const self = this;
    return runWithLock_(function () {
      const posted = [];
      const events = self.getEvents();
      const today = new Date();

      self.getDebts().forEach(function (debt) {
        if (debt.type === 'monthly') {
          const dueDay = self.cfgById_(debt.id) ? self.cfgById_(debt.id).due_day : 25;
          const alreadyThisMonth = events.some(function (ev) {
            return ev.debt === debt.id && ev.event === 'payment' &&
              ev.date.getFullYear() === today.getFullYear() && ev.date.getMonth() === today.getMonth();
          });
          if (today.getDate() >= dueDay && !alreadyThisMonth) {
            self.appendEvent_(debt.id, 'payment', debt.payment, 'auto');
            posted.push(debt.id);
          }
        } else {
          // biweekly: каждые 14 дней от Epoch (первый платёж через 2 недели)
          const days = Math.floor((today - debt.epoch) / 86400000);
          const expected = Math.floor(days / 14);
          const logged = events.filter(function (ev) {
            return ev.debt === debt.id && ev.event === 'payment';
          }).length;
          let catchUp = Math.min(Math.max(expected - logged, 0), 2); // без пачки задним числом
          while (catchUp-- > 0) {
            self.appendEvent_(debt.id, 'payment', debt.payment, 'auto');
            posted.push(debt.id);
          }
        }
      });

      if (posted.length) {
        self.replayAll();
        const sh = sheet_(SHEETS.DEBTS);
        const from = sh.getLastRow() - posted.length + 1;
        const debts = self.getDebts();
        posted.forEach(function (id, i) {
          const d = debts.filter(function (x) { return x.id === id; })[0];
          sh.getRange(from + i, 5, 1, 2).setValues([[d.balance, d.payment]]);
        });
      }
      return posted;
    });
  },

  // ── агрегаты и проекции ──

  normalizedMonthlyRUB: function (debt) {
    return debt.type === 'biweekly' ? debt.payment * 26 / 12 : debt.payment;
  },

  totalDebtRUB: function (debts) {
    return (debts || this.getDebts()).reduce(function (s, d) { return s + d.balance; }, 0);
  },

  /** Проекция до полного погашения. extraMonthlyRUB — дополнительная досрочка в месяц. */
  projection: function (debt, extraMonthlyRUB) {
    const ppy = this.periodsPerYear_(debt.type);
    const r = debt.rate / ppy;
    const pmt = debt.payment + (Number(extraMonthlyRUB) || 0) * (12 / ppy); // нормализуем в период
    let balance = debt.balance;
    let totalInterest = 0;
    let periods = 0;
    while (balance > 0.01 && periods < 1200) {
      const interest = balance * r;
      totalInterest += interest;
      balance -= Math.max(0, pmt - interest);
      periods += 1;
    }
    const months = periods * (12 / ppy);
    const payoff = new Date();
    payoff.setMonth(payoff.getMonth() + Math.ceil(months));
    return {
      periodsLeft: periods,
      monthsLeft: Math.round(months * 10) / 10,
      payoffISO: fmtISO_(payoff),
      totalInterestRUB: Math.round(totalInterest),
      monthlyPaymentRUB: pmt,
    };
  },

  /** Арбитраж: сумма на вкладе против досрочки Сбербанка. */
  arbitrage: function (amountRUB) {
    const deposit = getSettingNum_('DEPOSIT_RATE_ANNUAL', CONFIG.ARBITRAGE.DEPOSIT_RATE_ANNUAL);
    const debts = this.getDebts();
    const bestRate = debts.reduce(function (m, d) { return Math.max(m, d.rate); }, 0);
    const best = debts.filter(function (d) { return d.rate === bestRate; })[0];
    const delta = amountRUB * (deposit - bestRate);
    return {
      depositRate: deposit,
      bestMortgageRate: bestRate,
      bestMortgageName: best ? best.name : '',
      amountRUB: amountRUB,
      depositYieldRUB: amountRUB * deposit,
      interestSavedRUB: amountRUB * bestRate,
      deltaRUB: delta,
      depositWins: delta > 0,
      verdict: delta > 0
        ? 'Deposit arbitrage active: ' + (deposit * 100).toFixed(1) + '% deposit yields +' +
          fmtMoney_(delta, 'RUB') + '/yr more than paying ' + (best ? best.name : 'mortgage') + ' early.'
        : 'Досрочное погашение выгоднее вклада (+' + fmtMoney_(-delta, 'RUB') + '/yr).',
    };
  },
};
