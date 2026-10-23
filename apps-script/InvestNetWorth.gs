/**
 * InvestNetWorth.gs — портфель (GOOGLEFINANCE) и Net Worth = (Cash + Portfolio) − Debt(USD).
 * Целевые доли: broad_market_etf 58% / growth_stocks 23% / crypto_assets 19%.
 */

const InvestNetWorth = {

  getPortfolio: function () {
    const rows = readRange_(SHEETS.PORTFOLIO, 2);
    const holdings = [];
    rows.forEach(function (r) {
      if (!r[0]) return;
      holdings.push({
        ticker: String(r[0]),
        assetClass: String(r[1] || ''),
        units: Number(r[2]) || 0,
        avgCost: Number(r[3]) || 0,
        price: Number(r[4]) || 0,
        valueUSD: Number(r[5]) || 0,
        pnlUSD: Number(r[6]) || 0,
        sharePct: Number(r[8]) || 0,
        targetPct: Number(r[9]) || 0,
        rebalanceUSD: Number(r[10]) || 0,
      });
    });
    const total = holdings.reduce(function (s, h) { return s + h.valueUSD; }, 0);

    const byClass = { broad_market_etf: 0, growth_stocks: 0, crypto_assets: 0 };
    holdings.forEach(function (h) {
      if (byClass[h.assetClass] !== undefined) byClass[h.assetClass] += h.valueUSD;
    });
    const target = {
      broad_market_etf: getSettingNum_('TARGET_ETF', CONFIG.INVEST_SPLIT.broad_market_etf),
      growth_stocks: getSettingNum_('TARGET_STOCKS', CONFIG.INVEST_SPLIT.growth_stocks),
      crypto_assets: getSettingNum_('TARGET_CRYPTO', CONFIG.INVEST_SPLIT.crypto_assets),
    };
    const drift = {};
    Object.keys(byClass).forEach(function (k) {
      drift[k] = { valueUSD: byClass[k], currentPct: total > 0 ? byClass[k] / total : 0, targetPct: target[k], deltaUSD: target[k] * total - byClass[k] };
    });
    return { holdings: holdings, totalUSD: total, byClass: byClass, target: target, drift: drift };
  },

  renderText: function () {
    const p = this.getPortfolio();
    const name = { broad_market_etf: 'ETF (broad market)', growth_stocks: 'Акции роста', crypto_assets: 'Крипта' };
    const L = ['💼 <b>Портфель</b>', 'Итого: <b>' + fmtMoney_(p.totalUSD, 'USD') + '</b>'];
    Object.keys(p.drift).forEach(function (k) {
      const d = p.drift[k];
      const arrow = Math.abs(d.deltaUSD) < 1 ? '✅' : (d.deltaUSD > 0 ? '⬆️ докупить ' + fmtMoney_(d.deltaUSD, 'USD') : '⬇️ лишние ' + fmtMoney_(-d.deltaUSD, 'USD'));
      L.push('• ' + name[k] + ': ' + fmtMoney_(d.valueUSD, 'USD') + ' (' + fmtPct_(d.currentPct) +
        ' / цель ' + fmtPct_(d.targetPct) + ') ' + arrow);
    });
    const top = p.holdings.filter(function (h) { return h.valueUSD > 0; })
      .sort(function (a, b) { return b.valueUSD - a.valueUSD; }).slice(0, 8);
    if (top.length) {
      L.push('Топ позиций:');
      top.forEach(function (h) {
        L.push('  ' + h.ticker + ': ' + fmtMoney_(h.valueUSD, 'USD') + ' (PnL ' + fmtMoney_(h.pnlUSD, 'USD') + ')');
      });
    } else {
      L.push('ℹ️ Заполните Units и Avg Buy в листе Portfolio — цены подтягиваются GOOGLEFINANCE.');
    }
    return L.join('\n');
  },

  netWorth: function () {
    const fx = getFx_();
    const cash = getSettingNum_('CASH_USD', 0);
    const portfolio = this.getPortfolio().totalUSD;
    const debtRUB = DebtEngine.totalDebtRUB();
    const debtUSD = debtRUB / fx.USDRUB;
    return {
      date: fmtISO_(new Date()),
      cashUSD: cash,
      portfolioUSD: portfolio,
      debtRUB: debtRUB,
      debtUSD: debtUSD,
      netWorthUSD: cash + portfolio - debtUSD,
      fx: fx,
    };
  },

  renderNetWorthText: function (nw) {
    return '🧮 <b>Net Worth</b>\n' +
      '💵 Cash: ' + fmtMoney_(nw.cashUSD, 'USD') + '\n' +
      '💼 Portfolio: ' + fmtMoney_(nw.portfolioUSD, 'USD') + '\n' +
      '🏦 Долг: −' + fmtMoney_(nw.debtUSD, 'USD') + ' (' + fmtMoney_(nw.debtRUB, 'RUB') + ')\n' +
      '➖➖➖➖➖➖➖➖➖➖\n' +
      (nw.netWorthUSD >= 0 ? '🟢' : '🔴') + ' <b>' + fmtMoney_(nw.netWorthUSD, 'USD') + '</b>';
  },

  /** Ежедневный снапшот (upsert по дате). */
  takeSnapshot: function () {
    const self = this;
    return runWithLock_(function () {
      const nw = self.netWorth();
      const sh = sheet_(SHEETS.NETWORTH);
      const today = fmtISO_(new Date());
      const last = sh.getLastRow();
      if (last >= 2) {
        const dates = sh.getRange(2, 1, last - 1, 1).getValues();
        for (let i = 0; i < dates.length; i++) {
          const d = dates[i][0];
          const iso = d instanceof Date ? fmtISO_(d) : String(d);
          if (iso === today) {
            sh.getRange(2 + i, 2, 1, 5).setValues([[
              round2_(nw.cashUSD), round2_(nw.portfolioUSD),
              round2_(nw.debtRUB), round2_(nw.debtUSD), round2_(nw.netWorthUSD),
            ]]);
            return nw;
          }
        }
      }
      sh.appendRow([new Date(), round2_(nw.cashUSD), round2_(nw.portfolioUSD),
        round2_(nw.debtRUB), round2_(nw.debtUSD), round2_(nw.netWorthUSD)]);
      return nw;
    });
  },

  /** История для графика Mini App (последние limit записей). */
  history: function (limit) {
    const rows = readRange_(SHEETS.NETWORTH, 2)
      .filter(function (r) { return r[0]; })
      .map(function (r) {
        const d = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
        return { date: fmtISO_(d), netWorthUSD: Number(r[5]) || 0 };
      });
    return rows.slice(-(limit || 90));
  },

  setCash: function (amount, currency) {
    const fx = getFx_();
    const usd = convert_(Number(amount), currency || 'USD', 'USD', fx);
    setSetting_('CASH_USD', round2_(usd));
    return usd;
  },
};
