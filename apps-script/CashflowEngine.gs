/**
 * CashflowEngine.gs — водопад месяца, каскад профицита, недельные расходы.
 *
 * Правила ТЗ:
 *   Surplus = Income(USD) − Mandatory(USD)          (реестр активных обязательств + ипотеки)
 *   Каскад дельты бонуса: если Income > базы $5 800 →
 *     50% дельты → Debt Prepayment (Сбербанк / арбитраж с вкладом 16%)
 *     50% дельты → инвестиционный пул: 58% ETF / 23% Tech / 19% Crypto
 */

const CashflowEngine = {

  /** Активные обязательства из реестра, разбивка по категориям (USD). */
  registrySummary: function () {
    const rows = readRange_(SHEETS.COMMITMENTS, 2);
    let total = 0, mortgages = 0, other = 0, rubItems = 0;
    rows.forEach(function (r) {
      const active = r[6] === true || String(r[6]).toUpperCase() === 'TRUE';
      if (!active) return;
      const usd = Number(r[4]) || 0;
      total += usd;
      if (String(r[0]) === 'Mortgages') mortgages += usd;
      else {
        other += usd;
        if (String(r[3]).toUpperCase() === 'RUB') rubItems += usd;
      }
    });
    return { total: total, mortgages: mortgages, other: other, otherNonRub: other - rubItems, rubItems: rubItems };
  },

  /**
   * Полный водопад месяца.
   * opts: { incomeAmount, incomeCurrency, extraPrepayRUB, extraDcaUSD }
   */
  computeWaterfall: function (opts) {
    opts = opts || {};
    const fx = getFx_();
    const baseIncome = getSettingNum_('BASE_INCOME_USD', CONFIG.PROFILE.BASE_INCOME_USD);
    const capRUB = getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB);
    const weeklyRUB = getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB);

    const income = (opts.incomeAmount !== undefined && opts.incomeAmount !== null && opts.incomeAmount !== '')
      ? Number(opts.incomeAmount)
      : baseIncome;
    const incomeCur = (opts.incomeCurrency || CONFIG.PROFILE.INCOME_CURRENCY).toUpperCase();
    const incomeUSD = convert_(income, incomeCur, 'USD', fx);

    const reg = this.registrySummary();
    const livingUSD = capRUB / fx.USDRUB;
    const surplusUSD = incomeUSD - reg.total - livingUSD;

    const bonusDelta = Math.max(0, incomeUSD - baseIncome);
    const prepayShare = getSettingNum_('BONUS_PREPAY_SHARE', CONFIG.SURPLUS.BONUS_PREPAY_SHARE);
    const dcaShare = getSettingNum_('BONUS_DCA_SHARE', CONFIG.SURPLUS.BONUS_DCA_SHARE);
    const extraPrepayUSD = (Number(opts.extraPrepayRUB) || 0) / fx.USDRUB;
    const extraDcaUSD = Number(opts.extraDcaUSD) || 0;

    const toPrepayUSD = bonusDelta * prepayShare + extraPrepayUSD;
    const toDcaUSD = bonusDelta * dcaShare + extraDcaUSD;
    const split = {
      broad_market_etf: toDcaUSD * getSettingNum_('TARGET_ETF', CONFIG.INVEST_SPLIT.broad_market_etf),
      growth_stocks: toDcaUSD * getSettingNum_('TARGET_STOCKS', CONFIG.INVEST_SPLIT.growth_stocks),
      crypto_assets: toDcaUSD * getSettingNum_('TARGET_CRYPTO', CONFIG.INVEST_SPLIT.crypto_assets),
    };

    const debts = DebtEngine.getDebts();
    // Досрочка направляется в самый дорогой долг (Сбербанк 11.9%)
    const target = debts.slice().sort(function (a, b) { return b.rate - a.rate; })[0];
    const toPrepayRUB = toPrepayUSD * fx.USDRUB;
    const arbitrage = DebtEngine.arbitrage(toPrepayRUB);
    const baseProjection = target ? DebtEngine.projection(target, 0) : null;
    const prepayProjection = target ? DebtEngine.projection(target, toPrepayRUB) : null;

    return {
      monthKey: fmtMonthKey_(new Date()),
      fx: fx,
      income: income,
      incomeCurrency: incomeCur,
      incomeUSD: incomeUSD,
      baseIncomeUSD: baseIncome,
      registry: reg,
      livingCapRUB: capRUB,
      livingUSD: livingUSD,
      weeklyBudgetRUB: weeklyRUB,
      surplusUSD: surplusUSD,
      bonusDeltaUSD: bonusDelta,
      toPrepayUSD: toPrepayUSD,
      toDcaUSD: toDcaUSD,
      split: split,
      prepayTargetName: target ? target.name : '',
      arbitrage: arbitrage,
      baseProjection: baseProjection,
      prepayProjection: prepayProjection,
      debts: debts,
    };
  },

  /** Текстовое представление для бота (HTML). */
  renderText: function (w) {
    const L = [];
    L.push('📊 <b>План-водопад на ' + w.monthKey + '</b>');
    L.push('💵 Доход: <b>' + fmtMoney_(w.incomeUSD, 'USD') + '</b>' +
      (w.incomeCurrency !== 'USD' ? ' (' + fmtMoney_(w.income, w.incomeCurrency) + ')' : '') +
      ' · база ' + fmtMoney_(w.baseIncomeUSD, 'USD'));
    L.push('🧾 Обязательства (реестр): −' + fmtMoney_(w.registry.total, 'USD'));
    L.push('     • жильё/подписки: ' + fmtMoney_(w.registry.otherNonRub, 'USD') +
      ' · RUB-позиции: ' + fmtMoney_(w.registry.rubItems, 'USD'));
    L.push('     • ипотеки: ' + fmtMoney_(w.registry.mortgages, 'USD'));
    L.push('🍽 Лимит жизни: −' + fmtMoney_(w.livingUSD, 'USD') + ' (' + fmtMoney_(w.livingCapRUB, 'RUB') + ')');
    L.push('➖➖➖➖➖➖➖➖➖➖➖➖');
    L.push('💚 <b>Свободный профицит: ' + fmtMoney_(w.surplusUSD, 'USD') + '</b>');
    if (w.bonusDeltaUSD > 0) {
      L.push('🎁 Дельта бонуса: +' + fmtMoney_(w.bonusDeltaUSD, 'USD'));
      L.push('     → досрочка/вклад (50%): <b>' + fmtMoney_(w.toPrepayUSD, 'USD') + '</b>');
      L.push('     → DCA (50%): <b>' + fmtMoney_(w.toDcaUSD, 'USD') + '</b>');
    }
    L.push('📈 DCA-расклад: ETF ' + fmtMoney_(w.split.broad_market_etf, 'USD') +
      ' · Акции ' + fmtMoney_(w.split.growth_stocks, 'USD') +
      ' · Крипта ' + fmtMoney_(w.split.crypto_assets, 'USD'));
    if (w.arbitrage.amountRUB > 0) {
      L.push('⚖️ ' + (w.arbitrage.depositWins ? '⚠️ ' : '✅ ') + w.arbitrage.verdict);
    }
    if (w.baseProjection) {
      const monthsSaved = Math.max(0, w.baseProjection.monthsLeft - w.prepayProjection.monthsLeft);
      const interestSaved = Math.max(0, w.baseProjection.totalInterestRUB - w.prepayProjection.totalInterestRUB);
      L.push('🏦 ' + w.prepayTargetName + ': ' +
        w.prepayProjection.monthsLeft + ' мес (−' + monthsSaved.toFixed(1) + ' к сроку), экономия ' +
        fmtMoney_(interestSaved, 'RUB') + ' процентов');
    }
    return L.join('\n');
  },

  /** Создать/обновить строку месяца в Monthly_Cycles (статус proposal/applied). */
  upsertMonth: function (w, status) {
    return runWithLock_(function () {
      const sh = sheet_(SHEETS.MONTHLY);
      const last = Math.max(sh.getLastRow(), 1);
      const months = sh.getRange(2, 1, Math.max(last - 1, 1), 1).getValues();
      let row = 0;
      for (let i = 0; i < months.length; i++) {
        if (String(months[i][0]) === w.monthKey) { row = 2 + i; break; }
      }
      if (!row) {
        sh.appendRow([w.monthKey, null, null, null, null, null, null, null, null, null, null]);
        row = sh.getLastRow();
      }
      const curF = { EUR: '=B{r}*FX_and_Settings!$B$2', USD: '=B{r}', RUB: '=B{r}/FX_and_Settings!$B$3', KGS: '=B{r}/FX_and_Settings!$B$4' }[w.incomeCurrency] || '=B{r}';
      sh.getRange(row, 1, 1, 11).setValues([[
        w.monthKey, w.income, w.incomeCurrency,
        null, null, null,
        round2_(w.toPrepayUSD), round2_(w.split.broad_market_etf),
        round2_(w.split.growth_stocks), round2_(w.split.crypto_assets), status || 'proposal',
      ]]);
      sh.getRange(row, 4).setFormula(curF.replace('{r}', row));
      sh.getRange(row, 5).setFormula(
        '=SUMIFS(Commitments_Registry!$E$2:$E$100,Commitments_Registry!$G$2:$G$100,TRUE)'
      );
      sh.getRange(row, 6).setFormula('=D' + row + '-E' + row);
      return row;
    });
  },

  setMonthStatus: function (monthKey, status) {
    const sh = sheet_(SHEETS.MONTHLY);
    const last = sh.getLastRow();
    if (last < 2) return;
    const months = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < months.length; i++) {
      if (String(months[i][0]) === monthKey) {
        sh.getRange(2 + i, 11).setValue(status);
        return;
      }
    }
  },

  // ─────────────────── Недельные расходы (Weekly_Expenses) ───────────────────

  /**
   * Записать недельную трату. amount в валюте currency (KGS/RUB/USD/EUR),
   * в лист кладётся нормализовано в KGS, формулы конвертируют в ₽/$ сами.
   */
  logWeeklyExpense: function (opts) {
    const self = this;
    return runWithLock_(function () {
      const fx = getFx_();
      const amountKGS = convert_(opts.amount, opts.currency || 'KGS', 'KGS', fx);
      const rubEq = convert_(opts.amount, opts.currency || 'KGS', 'RUB', fx);
      // защита от миспарса (месячная аналитика как неделя, лишний ноль):
      if (rubEq > 1000000) {
        throw new Error('Сумма ' + fmtMoney_(opts.amount, opts.currency) + ' (≈' + fmtMoney_(rubEq, 'RUB') +
          ') выглядит нереально для недельной траты. Проверьте скриншот/сумму.');
      }
      const budget = getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB);
      const sh = sheet_(SHEETS.WEEKLY);
      sh.appendRow([
        new Date(), null, round2_(amountKGS), null, null,
        safeCellText_(opts.cat1), safeCellText_(opts.cat2), budget, null, safeCellText_(opts.note),
      ]);
      const r = sh.getLastRow();
      sh.getRange(r, 2).setFormula('=ISOWEEKNUM(A' + r + ')');
      sh.getRange(r, 4).setFormula('=IFERROR($C' + r + '/FX_and_Settings!$B$4*FX_and_Settings!$B$3,0)');
      sh.getRange(r, 5).setFormula('=IFERROR($C' + r + '/FX_and_Settings!$B$4,0)');
      sh.getRange(r, 9).setFormula('=FX_and_Settings!$B$11-D' + r); // B11 = WEEKLY_BUDGET_RUB
      return self.weeklyStatus();
    });
  },

  /** Текущее состояние недельного/месячного бюджета + допустимый дневной расход. */
  weeklyStatus: function () {
    const fx = getFx_();
    const cap = getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB);
    const weekly = getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB);
    const now = new Date();
    const curWeek = isoWeek_(now);
    let weekRUB = 0, monthRUB = 0;
    readRange_(SHEETS.WEEKLY, 2).forEach(function (r) {
      const d = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
      if (isNaN(d)) return;
      const rub = Number(r[3]) || 0;
      if (d.getFullYear() === now.getFullYear() && isoWeek_(d) === curWeek) weekRUB += rub;
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) monthRUB += rub;
    });
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const dailyAllowance = Math.max(0, cap - monthRUB) / daysLeftInMonth_();
    return {
      weekRUB: weekRUB,
      weekBudgetRUB: weekly,
      weekOver: weekRUB > weekly,
      weekRemainingRUB: weekly - weekRUB,
      monthRUB: monthRUB,
      monthCapRUB: cap,
      monthRemainingRUB: cap - monthRUB,
      burnRate: monthRUB / Math.max(1, daysElapsed) / (cap / daysInMonth), // >1 = тратим быстрее плана
      dailyAllowanceRUB: dailyAllowance,
      daysLeft: daysLeftInMonth_(),
      fx: fx,
    };
  },

  renderWeeklyText: function (s) {
    const bar = s.weekOver ? '🔴' : '🟢';
    const lines = [
      '📅 <b>Недельный бюджет</b>',
      bar + ' Израсходовано: <b>' + fmtMoney_(s.weekRUB, 'RUB') + '</b> из ' + fmtMoney_(s.weekBudgetRUB, 'RUB') +
        ' (остаток ' + fmtMoney_(s.weekRemainingRUB, 'RUB') + ')',
      '🗓 Месяц: ' + fmtMoney_(s.monthRUB, 'RUB') + ' из ' + fmtMoney_(s.monthCapRUB, 'RUB') +
        ' · burn rate ' + fmtPct_(s.burnRate, 0) + (s.burnRate > 1 ? ' ⚠️ быстрее плана' : ' ✅ в плане'),
      '💵 Можно в день до конца месяца: <b>' + fmtMoney_(s.dailyAllowanceRUB, 'RUB') + '</b> (' + s.daysLeft + ' дн.)',
    ];
    return lines.join('\n');
  },
};

function round2_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
