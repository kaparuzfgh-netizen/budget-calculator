/**
 * AnomalyEngine.gs — детектор невозможных/подозрительных цифр.
 *
 * Зачем: за месяцы работы накапливаются ручные правки, слипшиеся формулы,
 * сбои GOOGLEFINANCE и опечатки в Quantity/суммах. Движок ежедневно проверяет
 * бизнес-инварианты и присылает владельцу только НОВЫЕ аномалии (кулдаун —
 * одни сутки на правило, чтобы не спамить), а всё пишет в Ops_Log.
 *
 * Правила:
 *   D1 crit  остаток ипотеки < 0 или > начального баланса (replay сломан)
 *   D2 crit  платёж Сбербанка вырос >5% без ЧДП/сверок (аннуитет «поплыл»)
 *   D3 warn  |расхождение при сверке| > 20% остатка (возможно, взяли не тот остаток)
 *   T1 warn  >3 событий Т-Банка за месяц (накопились авторолл-платежи)
 *   W1 warn  недельная трата > 4× недельного бюджета (месячную аналитику записали как неделю)
 *   W2 warn  расход жизни за месяц > 2× месячного лимита
 *   M1 warn  доход месяца < 0.3× или > 3× базового (опечатка 62000)
 *   M2 warn  профицит месяца (после жизни) хуже −$500 — дефицит
 *   N1 warn  Net Worth прыгнул >40% между снапшотами (сбой курса/опечатка в Quantity)
 *   P1 crit  позиция портфеля дороже $10 млн (опечатка в Units)
 *   F1 crit  текущий курс отклоняется >25% от медианы 30 дней (глюк GOOGLEFINANCE/кэша)
 *   X1 warn  история FX не обновлялась >5 дней (лист не открывали/формула мертва)
 */

const AnomalyEngine = {

  median_: function (arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  },

  /** Все проверки: [{id, sev:'crit'|'warn', text}] */
  run: function () {
    const out = [];
    const now = new Date();
    const monthKey = fmtMonthKey_(now);
    const push = function (id, sev, text) { out.push({ id: id, sev: sev, text: text }); };

    // ── Ипотеки ──
    try {
      const events = DebtEngine.getEvents();
      const hasAdjust = events.some(function (ev) {
        return ev.event === 'prepay' || ev.event === 'reconcile';
      });
      DebtEngine.getDebts().forEach(function (d) {
        if (d.balance < 0 || d.balance > d.initialBalance * 1.001) {
          push('D1', 'crit', d.name + ': остаток ' + fmtMoney_(d.balance, 'RUB') +
            ' вне диапазона [0; ' + fmtMoney_(d.initialBalance, 'RUB') + '] — проверьте журнал Debt_Engine');
        }
        const initialPmt = DebtEngine.initialPayment_(d.id);
        if (d.payment > initialPmt * 1.05 && !hasAdjust) {
          push('D2', 'crit', d.name + ': платёж ' + fmtMoney_(d.payment, 'RUB') +
            ' вырос против исходного ' + fmtMoney_(initialPmt, 'RUB') + ' без событий ЧДП/сверки');
        }
      });
      const tbankThisMonth = events.filter(function (ev) {
        return ev.debt === 'TBANK' && ev.event === 'payment' &&
          ev.date.getFullYear() === now.getFullYear() && ev.date.getMonth() === now.getMonth();
      }).length;
      if (tbankThisMonth > 3) {
        push('T1', 'warn', 'Т-Банк: ' + tbankThisMonth + ' платежей за месяц (норма 2–3) — проверьте Epoch/журнал');
      }
    } catch (e) { push('DX', 'warn', 'Ипотеки не проверены: ' + e.message); }

    // ── Расходы ──
    try {
      const weeklyBudget = getSettingNum_('WEEKLY_BUDGET_RUB', CONFIG.LIVING.WEEKLY_BUDGET_RUB);
      const cap = getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB);
      let monthRUB = 0;
      readRange_(SHEETS.WEEKLY, 2).forEach(function (r) {
        const d = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
        if (isNaN(d)) return;
        const rub = Number(r[3]) || 0;
        if (rub > weeklyBudget * 4) {
          push('W1', 'warn', 'Трата ' + fmtISO_(d) + ': ' + fmtMoney_(rub, 'RUB') +
            ' > 4× недельного бюджета — похоже, месячную аналитику записали как недельную');
        }
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) monthRUB += rub;
      });
      if (monthRUB > cap * 2) {
        push('W2', 'warn', 'Расход жизни за месяц ' + fmtMoney_(monthRUB, 'RUB') +
          ' > 2× лимита (' + fmtMoney_(cap, 'RUB') + ') — проверьте записи Weekly_Expenses');
      }
    } catch (e) { push('WX', 'warn', 'Расходы не проверены: ' + e.message); }

    // ── Месяц ──
    try {
      const base = getSettingNum_('BASE_INCOME_USD', CONFIG.PROFILE.BASE_INCOME_USD);
      const cap = getSettingNum_('MONTHLY_CAP_RUB', CONFIG.LIVING.MONTHLY_CAP_RUB);
      const fx = getFx_();
      readRange_(SHEETS.MONTHLY, 2).forEach(function (r) {
        if (String(r[0]) !== monthKey) return;
        const incomeUSD = Number(r[3]) || 0;
        const mandatory = Number(r[4]) || 0;
        if (incomeUSD > 0 && (incomeUSD < base * 0.3 || incomeUSD > base * 3)) {
          push('M1', 'warn', 'Доход месяца ' + fmtMoney_(incomeUSD, 'USD') +
            ' вне диапазона 0.3–3× базы (' + fmtMoney_(base, 'USD') + ') — опечатка в /income?');
        }
        const surplusAfterLiving = incomeUSD - mandatory - cap / fx.USDRUB;
        if (surplusAfterLiving < -500) {
          push('M2', 'warn', 'Профицит месяца после жизни: ' + fmtMoney_(surplusAfterLiving, 'USD') +
            ' (дефицит) — доход не покрывает обязательства');
        }
      });
    } catch (e) { push('MX', 'warn', 'Месяц не проверен: ' + e.message); }

    // ── Net Worth и портфель ──
    try {
      const hist = InvestNetWorth.history(2);
      if (hist.length === 2) {
        const prev = hist[0].netWorthUSD, last = hist[1].netWorthUSD;
        if (Math.abs(prev) > 100 && Math.abs(last - prev) / Math.abs(prev) > 0.4) {
          push('N1', 'warn', 'Net Worth прыгнул ' + fmtMoney_(prev, 'USD') + ' → ' + fmtMoney_(last, 'USD') +
            ' (>40% за день) — сбой курса или опечатка в Quantity/CASH');
        }
      }
      InvestNetWorth.getPortfolio().holdings.forEach(function (h) {
        if (h.valueUSD > 1e7) {
          push('P1', 'crit', 'Позиция ' + h.ticker + ': ' + fmtMoney_(h.valueUSD, 'USD') +
            ' — похоже, опечатка в Units');
        }
      });
    } catch (e) { push('NX', 'warn', 'Net Worth не проверен: ' + e.message); }

    // ── Курсы ──
    try {
      const fx = getFx_();
      const live = [
        { name: 'EUR/USD', cur: fx.EURUSD, series: FXAnalytics.readSeries_(1) },
        { name: 'USD/RUB', cur: fx.USDRUB, series: FXAnalytics.readSeries_(4) },
        { name: 'USD/KGS', cur: fx.USDKGS, series: FXAnalytics.readSeries_(7) },
      ];
      live.forEach(function (p) {
        if (p.series.length < 10) return;
        const med = AnomalyEngine.median_(p.series.slice(-30).map(function (x) { return x.v; }));
        if (med > 0 && Math.abs(p.cur - med) / med > 0.25) {
          push('F1', 'crit', p.name + ': текущий ' + p.cur + ' отклоняется >25% от медианы 30д (' +
            med.toFixed(p.cur > 20 ? 2 : 4) + ') — глюк GOOGLEFINANCE/резервных курсов, конвертации неверны');
        }
        const lastDate = new Date(p.series[p.series.length - 1].date);
        if ((now - lastDate) / 86400000 > 5) {
          push('X1', 'warn', p.name + ': история не обновлялась с ' + p.series[p.series.length - 1].date +
            ' (>5 дней) — откройте лист FX_History / проверьте формулы');
        }
      });
      if (fx.FALLBACK_USED) {
        push('F1', 'crit', 'Курсы идут на резервных значениях (GOOGLEFINANCE недоступен) — все конвертации примерные');
      }
    } catch (e) { push('FX', 'warn', 'Курсы не проверены: ' + e.message); }

    return out;
  },

  /** Проверить, записать в Ops_Log и уведомить о НОВЫХ (кулдаун 1 день на правило). */
  runAndNotify: function () {
    const chatId = getProp_(PROP.CHAT_ID, '');
    const found = this.run();
    const today = fmtISO_(new Date());
    found.forEach(function (f) {
      logOps_(f.sev === 'crit' ? 'ERROR' : 'WARN', 'anomaly', f.id + ': ' + f.text.replace(/<[^>]+>/g, ''));
      const key = 'ANOM_' + f.id;
      if (getSetting_(key, '') !== today) {
        setSetting_(key, today);
        if (chatId) {
          sendMessage_(chatId,
            (f.sev === 'crit' ? '🚫 <b>КРИТИЧНАЯ аномалия</b>' : '⚠️ <b>Аномалия</b>') + ' [' + f.id + ']\n' + f.text +
            '\n\nДетали: /anomalies · журнал: лист Ops_Log');
        }
      }
    });
    return found;
  },

  renderText: function () {
    const found = this.run();
    if (!found.length) return '✅ <b>Аномалий нет</b> — все инварианты соблюдены (' + nowTz_() + ').';
    return '🩺 <b>Проверка аномалий</b> · ' + nowTz_() + '\n\n' +
      found.map(function (f) {
        return (f.sev === 'crit' ? '🚫' : '⚠️') + ' <b>[' + f.id + ']</b> ' + f.text;
      }).join('\n\n');
  },
};

/** Ручной запуск проверки из редактора/бота. */
function testAnomalies() {
  const text = AnomalyEngine.renderText();
  console.log(text.replace(/<[^>]+>/g, ''));
  return text;
}
