/**
 * FXAnalytics.gs — анализ стоимости валют, статистический прогноз и
 * рекомендации по таймингу конвертаций.
 *
 * Данные: лист FX_History — 180 дней ежедневных закрытий GOOGLEFINANCE
 * (EURUSD, USDRUB, USDKGS, EURRUB). EUR/KGS считается кроссом EURUSD×USDKGS.
 *
 * Для каждой конвертации пользователя (EUR→RUB ипотеки, EUR→KGS жизнь,
 * EUR→USD инвестиции) движок отвечает на вопрос «выгодно ли менять сейчас»:
 *   • перцентиль текущего курса в 180-дневном диапазоне (0 — минимум, 100 — максимум);
 *   • RSI(14) — перекупленность/перепроданность;
 *   • SMA20/SMA50 — направление тренда;
 *   • волатильность (σ дневных доходностей, приведена к 30 дням);
 *   • прогноз на 7/30 дней: линейная регрессия ± σ√h (статистика, не гарантия).
 *
 * Логика рекомендации (продаём EUR за X — высокий курс = выгодно):
 *   перцентиль ≥ 70 → конвертировать сейчас; 45–69 → дробить 50/50;
 *   30–44 → по возможности отложить; < 30 → отложить (кроме обязательных платежей).
 */

const FXAnalytics = {

  // ── чтение серий ──

  readSeries_: function (col) {
    const sh = sheet_(SHEETS.FX_HISTORY);
    const last = sh.getLastRow();
    if (last < 4) return [];
    const vals = sh.getRange(4, col, last - 3, 2).getValues(); // строка 3 — заголовок спилла
    const out = [];
    vals.forEach(function (r) {
      if (r[0] instanceof Date && typeof r[1] === 'number' && r[1] > 0) {
        out.push({ date: fmtISO_(r[0]), v: r[1] });
      }
    });
    return out;
  },

  /** Кросс-курс a×b по совпадающим датам (напр. EURKGS = EURUSD × USDKGS). */
  cross_: function (a, b) {
    const mapB = {};
    b.forEach(function (x) { mapB[x.date] = x.v; });
    const out = [];
    a.forEach(function (x) {
      if (mapB[x.date] !== undefined) out.push({ date: x.date, v: x.v * mapB[x.date] });
    });
    return out;
  },

  // ── статистика ──

  mean_: function (a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; },

  std_: function (a) {
    if (a.length < 2) return 0;
    const m = this.mean_(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  },

  sma_: function (closes, n) {
    return this.mean_(closes.slice(-Math.min(n, closes.length)));
  },

  /** RSI(14), простое усреднение (Wilder сглаживается на длине окна 180 дней). */
  rsi_: function (closes, period) {
    period = period || 14;
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
  },

  /** Наклон линейной регрессии за последние n точек, в относительном выражении/день. */
  slopeRel_: function (closes, n) {
    const win = closes.slice(-Math.min(n, closes.length));
    const len = win.length;
    if (len < 3) return 0;
    const cur = win[len - 1];
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < len; i++) {
      sx += i; sy += win[i]; sxy += i * win[i]; sxx += i * i;
    }
    const denom = len * sxx - sx * sx;
    if (denom === 0) return 0;
    return ((len * sxy - sx * sy) / denom) / cur;
  },

  /** Прогноз: середина = тренд, границы = ±σ√h (σ — дневная доходность). */
  forecast_: function (closes, horizonDays) {
    const cur = closes[closes.length - 1];
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
    const sigma = this.std_(rets.slice(-30));
    const slope = this.slopeRel_(closes, 30);
    const h = horizonDays;
    const mid = cur * (1 + slope * h);
    const band = sigma * Math.sqrt(h);
    return {
      low: Math.round(cur * (1 + slope * h - band) * 1e4) / 1e4,
      mid: Math.round(mid * 1e4) / 1e4,
      high: Math.round(cur * (1 + slope * h + band) * 1e4) / 1e4,
    };
  },

  stats_: function (series) {
    const closes = series.map(function (x) { return x.v; });
    const n = closes.length;
    if (n < 30) return null;
    const cur = closes[n - 1];
    const sorted = closes.slice().sort(function (a, b) { return a - b; });
    const percentile = Math.round(100 * sorted.filter(function (v) { return v <= cur; }).length / n);
    const mean180 = this.mean_(closes);
    const std180 = this.std_(closes);
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
    const sigma = this.std_(rets.slice(-30));
    const slope30 = this.slopeRel_(closes, 30);
    const band30 = sigma * Math.sqrt(30);
    return {
      current: cur,
      digits: cur > 20 ? 2 : 4,
      min: sorted[0],
      max: sorted[n - 1],
      percentile: percentile,
      z180: std180 > 0 ? (cur - mean180) / std180 : 0,
      move30: slope30 * 30,        // ожидаемое смещение за 30д по тренду
      band30: band30,              // собственный шум за 30д (±σ)
      sma20: this.mean_(closes.slice(-20)),
      sma50: this.mean_(closes.slice(-50)),
      trendUp: this.sma_(closes, 20) > this.sma_(closes, 50),
      change30dPct: n > 30 ? (cur / closes[n - 31] - 1) : 0,
      rsi14: Math.round(this.rsi_(closes, 14)),
      vol30dPct: Math.round(sigma * Math.sqrt(30) * 10000) / 100,
      forecast7d: this.forecast_(closes, 7),
      forecast30d: this.forecast_(closes, 30),
      series: closes.slice(-90),
    };
  },

  /** Рекомендация: высокий курс = выгодно продавать EUR за эту валюту. */
  signal_: function (st) {
    // боковик: тренд за 30д тише собственного шума, курс у среднего —
    // тайминг не имеет смысла, всегда нейтрально
    const sideways = Math.abs(st.z180) < 0.5 ||
      (st.band30 > 0 && Math.abs(st.move30) < 0.5 * st.band30);
    if (sideways) return { signal: 'split', text: 'Нейтрально (боковик) — меняйте частями 50/50' };
    let score = st.percentile;
    if (st.rsi14 >= 65) score += 5;       // сильный импульс вверх
    if (st.rsi14 <= 35) score -= 5;       // перепроданность — вероятен откат вверх
    if (score >= 70) return { signal: 'convert', text: 'Курс высокий — конвертируйте сейчас' };
    if (score >= 45) return { signal: 'split', text: 'Нейтрально — меняйте частями 50/50' };
    if (score >= 30) return { signal: 'wait', text: 'Ниже среднего — по возможности отложите' };
    return { signal: 'hold', text: 'Низкий диапазон — отложите (кроме обязательных платежей)' };
  },

  makeAction_: function (series, key, label, purpose, emoji) {
    const st = this.stats_(series);
    if (!st) return null;
    const sig = this.signal_(st);
    return {
      key: key, label: label, purpose: purpose, emoji: emoji,
      current: st.current, digits: st.digits, min: st.min, max: st.max,
      percentile: st.percentile, rsi14: st.rsi14, change30d_pct: Math.round(st.change30dPct * 1000) / 10,
      vol30d_pct: st.vol30dPct, trend_up: st.trendUp,
      signal: sig.signal, signal_text: sig.text,
      forecast7d: st.forecast7d, forecast30d: st.forecast30d,
      series: st.series,
    };
  },

  // ── публичное API ──

  build: function () {
    const eur = this.readSeries_(1);
    const usdRub = this.readSeries_(4);
    const usdKgs = this.readSeries_(7);
    const eurRub = this.readSeries_(10);
    const eurKgs = this.cross_(eur, usdKgs);

    if (eur.length < 30 || usdRub.length < 30) {
      return { ok: false, note: 'FX_History ещё не заполнен: откройте этот лист в таблице, чтобы GOOGLEFINANCE рассчитал историю (или выполните setup()).' };
    }

    const actions = [
      this.makeAction_(eurRub, 'eur_rub', 'EUR → RUB', 'платежи по ипотекам (Сбер / Т-Банк)', '🏦'),
      this.makeAction_(eurKgs, 'eur_kgs', 'EUR → KGS', 'жизнь, MBANK', '🛒'),
      this.makeAction_(eur, 'eur_usd', 'EUR → USD', 'инвестиции (DCA) и база учёта', '📈'),
    ].filter(Boolean);

    const rawShort = function (series) {
      const st = FXAnalytics.stats_(series);
      return st ? {
        current: st.current, change30d_pct: Math.round(st.change30dPct * 1000) / 10,
        percentile: st.percentile, rsi14: st.rsi14,
      } : null;
    };

    return {
      ok: true,
      generated_at: nowTz_(),
      actions: actions,
      raw: { EURUSD: rawShort(eur), USDRUB: rawShort(usdRub), USDKGS: rawShort(usdKgs), EURRUB: rawShort(eurRub) },
      disclaimer: 'Статистическая модель (перцентиль + тренд + волатильность). Не является инвестиционной рекомендацией.',
    };
  },

  renderText: function (a) {
    if (!a.ok) return '💱 ' + a.note;
    const L = ['💱 <b>Валютный анализ</b> · ' + a.generated_at];
    a.actions.forEach(function (x) {
      const arrow = x.change30d_pct >= 0 ? '▲' : '▼';
      L.push(x.emoji + ' <b>' + x.label + '</b> (' + x.purpose + '): <b>' +
        fmtMoney_(x.current, x.label.indexOf('RUB') > -1 ? 'RUB' : x.label.indexOf('KGS') > -1 ? 'KGS' : 'USD') + '</b>');
      L.push('     ' + arrow + ' ' + (x.change30d_pct >= 0 ? '+' : '') + fmtPct_(x.change30d_pct / 100) +
        ' за 30д · ' + x.percentile + '-й перцентиль · RSI ' + x.rsi14 +
        ' · тренд ' + (x.trend_up ? 'вверх' : 'вниз'));
      L.push('     ➜ <b>' + x.signal_text + '</b>');
      L.push('     Прогноз 30д: ' + x.forecast30d.low + ' – ' + x.forecast30d.high +
        ' (±σ, модель)' + (x.signal === 'split' ? ' — вторую половину меняйте по графику' : ''));
    });
    L.push('');
    L.push('⚠️ ' + a.disclaimer);
    L.push('ℹ️ Обязательные платежи (алименты, английский, ипотека к дате) конвертируйте в срок — тайминг вторичен.');
    return L.join('\n');
  },

  /** Ежедневное обновление формул истории (форсирует пересчёт GOOGLEFINANCE). */
  refreshFormulas: function () {
    const sh = sheet_(SHEETS.FX_HISTORY);
    FX_HISTORY_BLOCKS.forEach(function (b) {
      sh.getRange(b.anchor).setFormula(
        '=GOOGLEFINANCE("CURRENCY:' + b.pair + '","price",TODAY()-180,TODAY(),"DAILY")'
      );
    });
    SpreadsheetApp.flush();
  },
};
