/**
 * TmaApi.gs — REST для Telegram Mini App.
 *
 * GET  ?action=overview            — полный срез данных (чтение, без авторизации)
 * GET  ?action=scenario&income=&cur=&extra_prepay_rub=&extra_dca_usd= — водопад сценария
 * POST {action, init_data, ...}    — записи (ЧДП, трата, кэш); требует валидный initData
 *
 * POST приходит с content-type text/plain (Mini App), чтобы избежать CORS-preflight,
 * который Apps Script не обслуживает. Тело парсится как JSON в doPost.
 */

function doGet(e) {
  const action = String((e && e.parameter && e.parameter.action) || 'health');
  try {
    // Чтение финансовых данных: если задан TMA_READ_TOKEN — требуем его или подпись initData
    if (action !== 'health' && !checkReadAccess_(e)) {
      return json_({ ok: false, error: 'unauthorized: нужен read_token (или откройте из Telegram)' });
    }
    if (action === 'overview') return json_(buildOverview_());
    if (action === 'scenario') {
      const p = e.parameter;
      const w = CashflowEngine.computeWaterfall({
        incomeAmount: p.income !== undefined && p.income !== '' ? Number(p.income) : null,
        incomeCurrency: p.cur || undefined,
        extraPrepayRUB: Number(p.extra_prepay_rub) || 0,
        extraDcaUSD: Number(p.extra_dca_usd) || 0,
      });
      return json_(waterfallPayload_(w));
    }
    if (action === 'health') {
      return json_({ ok: true, app: CONFIG.APP_NAME, version: CONFIG.VERSION, time: nowTz_() });
    }
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/**
 * Доступ на чтение: OPEN, если TMA_READ_TOKEN не задан (демо-режим);
 * иначе — совпадение read_token ИЛИ валидная подпись Mini App (initData).
 */
function checkReadAccess_(e) {
  const required = getProp_('TMA_READ_TOKEN', '');
  if (!required) return true;
  const provided = String((e && e.parameter && e.parameter.read_token) || '');
  if (provided && provided === required) return true;
  const init = String((e && e.parameter && e.parameter.init_data) || '');
  if (init && validateInitData_(init)) return true;
  return false;
}

function tmaHandlePost_(e, body) {
  try {
    if (!body || !body.action) return json_({ ok: false, error: 'no action' });
    if (!validateInitData_(body.init_data || '')) {
      return json_({ ok: false, error: 'unauthorized: записи доступны только из Telegram (initData)' });
    }
    let result;
    switch (String(body.action)) {
      case 'apply_prepay':
        result = DebtEngine.registerPrepay(body.debt_id, Number(body.amount_rub));
        return json_({ ok: true, prepay: result });
      case 'log_week': {
        const st = CashflowEngine.logWeeklyExpense({
          amount: Number(body.amount), currency: body.currency || 'KGS', note: 'mini app', source: 'tma',
        });
        return json_({ ok: true, weekly: st });
      }
      case 'set_cash':
        InvestNetWorth.setCash(Number(body.amount), body.currency || 'USD');
        return json_({ ok: true, net_worth: InvestNetWorth.netWorth() });
      default:
        return json_({ ok: false, error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────── Данные ───────────────────────────

function debtPayload_(d) {
  const ppy = DebtEngine.periodsPerYear_(d.type);
  const proj = DebtEngine.projection(d, 0);
  const n0 = DebtEngine.derivePeriods_(d.initialBalance, d.rate, ppy, DebtEngine.initialPayment_(d.id));
  return {
    id: d.id,
    name: d.name,
    balance_rub: round2_(d.balance),
    payment_rub: round2_(d.payment),
    payment_type: d.type,
    normalized_monthly_rub: round2_(DebtEngine.normalizedMonthlyRUB(d)),
    periods_per_year: ppy,
    rate_annual: d.rate,
    remaining_periods: Math.max(0, Math.round((n0 - d.paymentsMade) * 10) / 10),
    initial_balance_rub: d.initialBalance,
    months_left: proj.monthsLeft,
    payoff_date: proj.payoffISO,
    total_interest_rub: proj.totalInterestRUB,
  };
}

function waterfallPayload_(w) {
  return {
    month_key: w.monthKey,
    income_usd: round2_(w.incomeUSD),
    income: w.income,
    income_currency: w.incomeCurrency,
    base_income_usd: w.baseIncomeUSD,
    commitments_usd: {
      total: round2_(w.registry.total),
      non_mortgage: round2_(w.registry.other),
      mortgages: round2_(w.registry.mortgages),
    },
    living_usd: round2_(w.livingUSD),
    living_cap_rub: w.livingCapRUB,
    surplus_usd: round2_(w.surplusUSD),
    bonus_delta_usd: round2_(w.bonusDeltaUSD),
    to_prepay_usd: round2_(w.toPrepayUSD),
    to_dca_usd: round2_(w.toDcaUSD),
    dca_split_usd: {
      etf: round2_(w.split.broad_market_etf),
      stocks: round2_(w.split.growth_stocks),
      crypto: round2_(w.split.crypto_assets),
    },
    arbitrage: w.arbitrage,
    prepay_target: w.prepayTargetName,
    base_projection: w.baseProjection,
    prepay_projection: w.prepayProjection,
  };
}

function buildOverview_() {
  const debts = DebtEngine.replayAll();
  const w = CashflowEngine.computeWaterfall({});
  const portfolio = InvestNetWorth.getPortfolio();
  const nw = InvestNetWorth.takeSnapshot();
  const weekly = CashflowEngine.weeklyStatus();
  return {
    ok: true,
    generated_at: nowTz_(),
    version: CONFIG.VERSION,
    fx: {
      EURUSD: Math.round(w.fx.EURUSD * 10000) / 10000,
      USDRUB: Math.round(w.fx.USDRUB * 10000) / 10000,
      USDKGS: Math.round(w.fx.USDKGS * 10000) / 10000,
    },
    net_worth: {
      cash_usd: round2_(nw.cashUSD),
      portfolio_usd: round2_(nw.portfolioUSD),
      debt_rub: round2_(nw.debtRUB),
      debt_usd: round2_(nw.debtUSD),
      total_usd: round2_(nw.netWorthUSD),
    },
    net_worth_history: InvestNetWorth.history(90),
    weekly: {
      week_rub: round2_(weekly.weekRUB),
      week_budget_rub: weekly.weekBudgetRUB,
      month_rub: round2_(weekly.monthRUB),
      month_cap_rub: weekly.monthCapRUB,
      burn_rate: Math.round(weekly.burnRate * 100) / 100,
      daily_allowance_rub: round2_(weekly.dailyAllowanceRUB),
      days_left: weekly.daysLeft,
    },
    waterfall: waterfallPayload_(w),
    debts: debts.map(debtPayload_),
    portfolio: {
      total_usd: round2_(portfolio.totalUSD),
      by_class: {
        broad_market_etf: round2_(portfolio.byClass.broad_market_etf),
        growth_stocks: round2_(portfolio.byClass.growth_stocks),
        crypto_assets: round2_(portfolio.byClass.crypto_assets),
      },
      target: portfolio.target,
      holdings: portfolio.holdings.map(function (h) {
        return {
          ticker: h.ticker, asset_class: h.assetClass, units: h.units,
          price_usd: round2_(h.price), value_usd: round2_(h.valueUSD), pnl_usd: round2_(h.pnlUSD),
        };
      }),
    },
    settings: {
      base_income_usd: getSettingNum_('BASE_INCOME_USD', CONFIG.PROFILE.BASE_INCOME_USD),
      weekly_budget_rub: getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB),
      monthly_cap_rub: getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB),
      deposit_rate: getSettingNum_('DEPOSIT_RATE_ANNUAL', CONFIG.ARBITRAGE.DEPOSIT_RATE_ANNUAL),
      bonus_prepay_share: getSettingNum_('BONUS_PREPAY_SHARE', CONFIG.SURPLUS.BONUS_PREPAY_SHARE),
      bonus_dca_share: getSettingNum_('BONUS_DCA_SHARE', CONFIG.SURPLUS.BONUS_DCA_SHARE),
      income_currency: getSetting_('INCOME_CURRENCY', CONFIG.PROFILE.INCOME_CURRENCY),
    },
  };
}

// ─────────────────────────── Валидация initData (HMAC-SHA256) ───────────────────────────

/**
 * Проверка подписи Telegram Mini App:
 * secret = HMAC_SHA256(key=bot_token, msg="WebAppData")
 * hash   = HMAC_SHA256(key=secret, msg=data_check_string)
 */
function validateInitData_(initData) {
  if (!initData) return false;
  try {
    const params = new URLSearchParams(String(initData));
    const hash = (params.get('hash') || '').toLowerCase();
    if (!hash) return false;

    const keys = [];
    params.forEach(function (v, k) { if (k !== 'hash') keys.push(k); });
    keys.sort();
    const checkString = keys.map(function (k) { return k + '=' + params.get(k); }).join('\n');

    const secretBytes = Utilities.computeHmacSha256Signature('WebAppData', tgToken_());
    const computed = Utilities.computeHmacSha256Signature(checkString, secretBytes)
      .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
      .join('');

    if (computed !== hash) return false;

    const authDate = Number(params.get('auth_date')) || 0;
    if (authDate && Date.now() / 1000 - authDate > 86400) return false; // старше суток
    return true;
  } catch (e) {
    console.warn('initData: ' + e.message);
    return false;
  }
}
