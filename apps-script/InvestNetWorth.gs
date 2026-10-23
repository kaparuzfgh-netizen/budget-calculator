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

  /** Мультивалютный кэш: CASH_USD + CASH_EUR + CASH_RUB + CASH_KGS → USD. */
  cashBreakdown_: function (fx) {
    fx = fx || getFx_();
    const raw = {
      USD: getSettingNum_('CASH_USD', 0),
      EUR: getSettingNum_('CASH_EUR', 0),
      RUB: getSettingNum_('CASH_RUB', 0),
      KGS: getSettingNum_('CASH_KGS', 0),
    };
    const usd = {
      USD: raw.USD,
      EUR: raw.EUR * fx.EURUSD,
      RUB: raw.RUB / fx.USDRUB,
      KGS: raw.KGS / fx.USDKGS,
    };
    return { raw: raw, usd: usd, totalUSD: usd.USD + usd.EUR + usd.RUB + usd.KGS };
  },

  /** Вклады как актив (лист Deposits): только Active. */
  depositsSummary: function () {
    const fx = getFx_();
    let totalUSD = 0, weighted = 0, sumOriginal = 0, count = 0;
    const names = [];
    readRange_(SHEETS.DEPOSITS, 2).forEach(function (r) {
      const active = r[6] === true || String(r[6]).toUpperCase() === 'TRUE';
      if (!active) return;
      const amount = Number(r[2]) || 0;
      const cur = String(r[3] || 'RUB').toUpperCase();
      const rate = Number(r[4]) || 0;
      totalUSD += convert_(amount, cur, 'USD', fx);
      weighted += amount * rate;
      sumOriginal += amount;
      count += 1;
      if (names.length < 3) names.push(String(r[1] || 'Вклад'));
    });
    return {
      count: count,
      totalUSD: totalUSD,
      avgRate: sumOriginal > 0 ? weighted / sumOriginal : 0,
      names: names,
    };
  },

  netWorth: function () {
    const fx = getFx_();
    const cash = this.cashBreakdown_(fx);
    const deposits = this.depositsSummary();
    const portfolio = this.getPortfolio().totalUSD;
    const debtRUB = DebtEngine.totalDebtRUB();
    const debtUSD = debtRUB / fx.USDRUB;
    return {
      date: fmtISO_(new Date()),
      cashUSD: cash.totalUSD,
      cashRaw: cash.raw,
      depositsUSD: deposits.totalUSD,
      portfolioUSD: portfolio,
      debtRUB: debtRUB,
      debtUSD: debtUSD,
      netWorthUSD: cash.totalUSD + deposits.totalUSD + portfolio - debtUSD,
      fx: fx,
    };
  },

  renderNetWorthText: function (nw) {
    const cash = this.cashBreakdown_(nw.fx);
    const parts = [];
    if (cash.raw.EUR) parts.push(fmtMoney_(cash.raw.EUR, 'EUR'));
    if (cash.raw.RUB) parts.push(fmtMoney_(cash.raw.RUB, 'RUB'));
    if (cash.raw.KGS) parts.push(fmtMoney_(cash.raw.KGS, 'KGS'));
    if (cash.raw.USD) parts.push(fmtMoney_(cash.raw.USD, 'USD'));
    const dep = this.depositsSummary();
    return '🧮 <b>Net Worth</b>\n' +
      '💵 Cash: ' + fmtMoney_(nw.cashUSD, 'USD') +
      (parts.length > 1 ? ' (' + parts.join(' · ') + ')' : '') + '\n' +
      '🏦 Вклады: ' + (dep.count ? fmtMoney_(dep.totalUSD, 'USD') + ' (' + dep.count + ' шт.)' : 'нет — учтите в листе Deposits') + '\n' +
      '💼 Portfolio: ' + fmtMoney_(nw.portfolioUSD, 'USD') + '\n' +
      '🏚 Долг: −' + fmtMoney_(nw.debtUSD, 'USD') + ' (' + fmtMoney_(nw.debtRUB, 'RUB') + ')\n' +
      '➖➖➖➖➖➖➖➖➖➖\n' +
      (nw.netWorthUSD >= 0 ? '🟢' : '🔴') + ' <b>' + fmtMoney_(nw.netWorthUSD, 'USD') + '</b>';
  },

  /** Ежедневный снапшот (upsert по дате). Колонки: Cash | Deposits | Portfolio | Debt ₽ | Debt $ | NetWorth. */
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
            sh.getRange(2 + i, 2, 1, 6).setValues([[
              round2_(nw.cashUSD), round2_(nw.depositsUSD), round2_(nw.portfolioUSD),
              round2_(nw.debtRUB), round2_(nw.debtUSD), round2_(nw.netWorthUSD),
            ]]);
            return nw;
          }
        }
      }
      sh.appendRow([new Date(), round2_(nw.cashUSD), round2_(nw.depositsUSD), round2_(nw.portfolioUSD),
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
        // NetWorth в колонке F (6); при новых 7-колоночных строках — G (7)
        const net = Number(r[6]) || Number(r[5]) || 0;
        return { date: fmtISO_(d), netWorthUSD: net };
      });
    return rows.slice(-(limit || 90));
  },

  /** Кэш в конкретной валюте: /cash 12000 kgs → CASH_KGS = 12000 (перезапись). */
  setCash: function (amount, currency) {
    const cur = (currency || 'USD').toUpperCase();
    if (['USD', 'EUR', 'RUB', 'KGS'].indexOf(cur) === -1) throw new Error('Валюта кэша: USD/EUR/RUB/KGS');
    setSetting_('CASH_' + cur, round2_(Number(amount)));
    return this.cashBreakdown_().totalUSD;
  },
};
