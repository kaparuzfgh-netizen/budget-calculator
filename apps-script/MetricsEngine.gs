/**
 * MetricsEngine.gs — продуктовые метрики и месячный digest «факт vs план».
 *
 * Лист Metrics: Date | Key | Value. Ключи:
 *   weekly_ask:<weekKey>     — воскресный опрос отправлен
 *   weekly_answer:<weekKey>  — пользователь ответил (число/скрин) в течение недели
 *   cascade_applied:<month>  — каскад месяца применён кнопкой Apply
 *   recon_ok:<month>         — ипотеки сверены с банком
 *   recon_drift:<id>:<month> — расхождение при сверке, Value = |Δ| ₽
 *   vision_fix:<date>        — исправление категории вручную (/alias)
 *   savings_rate:<month>     — (доход − расходы)/доход, Value = доля
 *   fx_alert:<pair>:<hi|lo>  — отправлен алерт по валюте (для кулдауна)
 *
 * Digest присылается утром последнего дня месяца: план против факта + метрики.
 */

const MetricsEngine = {

  log: function (key, value) {
    sheet_(SHEETS.METRICS).appendRow([new Date(), key, String(value)]);
  },

  /** Записать метрику, только если такой (key) ещё нет за указанный период. */
  logOnce: function (key, value) {
    const self = this;
    return runWithLock_(function () {
      const rows = readRange_(SHEETS.METRICS, 2);
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][1]) === key) {
          if (rows[i][2] !== undefined && String(rows[i][2]) !== '') return false;
        }
      }
      self.log(key, value);
      return true;
    });
  },

  /** Все значения с данным префиксом ключа. */
  byPrefix: function (prefix) {
    const out = [];
    readRange_(SHEETS.METRICS, 2).forEach(function (r) {
      const k = String(r[1] || '');
      if (k.indexOf(prefix) === 0) out.push({ key: k, value: String(r[2]), date: r[0] });
    });
    return out;
  },

  value: function (key) {
    const rows = this.byPrefix(key);
    return rows.length ? rows[rows.length - 1].value : null;
  },

  // ── Производные метрики ──

  /** % недель с ответом среди отправленных опросов. */
  weeklyResponseRate: function () {
    const asks = this.byPrefix('weekly_ask:');
    if (!asks.length) return null;
    const answered = this.byPrefix('weekly_answer:');
    const answeredWeeks = {};
    answered.forEach(function (a) { answeredWeeks[a.key.replace('weekly_answer:', 'weekly_ask:')] = 1; });
    let hit = 0;
    asks.forEach(function (a) { if (answeredWeeks[a.key]) hit++; });
    return hit / asks.length;
  },

  /** Доля ручных исправлений категорий к числу vision-записей. */
  visionAccuracy: function () {
    const fixes = this.byPrefix('vision_fix:').length;
    let visionRows = 0;
    readRange_(SHEETS.WEEKLY, 2).forEach(function (r) {
      if (String(r[9] || '').indexOf('vision') === 0) visionRows++;
    });
    if (!visionRows) return null;
    return { fixes: fixes, visionRows: visionRows, fixRate: fixes / (fixes + visionRows) };
  },

  // ── Digest «факт vs план» (последний день месяца) ──

  buildMonthDigest: function () {
    const now = new Date();
    const monthKey = fmtMonthKey_(now);
    const fx = getFx_();
    const fxWarn = fx.FALLBACK_USED ? '\n⚠️ Курсы резервные — цифры примерные.' : '';

    // План: строка месяца в Monthly_Cycles
    let plan = null;
    readRange_(SHEETS.MONTHLY, 2).forEach(function (r) {
      if (String(r[0]) === monthKey) {
        plan = { incomeUSD: Number(r[3]) || 0, mandatoryUSD: Number(r[4]) || 0, surplusUSD: Number(r[5]) || 0, status: String(r[10] || '') };
      }
    });

    // Факт: траты месяца (Weekly_Expenses в ₽) + автоплатежи ипотек (журнал Debt_Engine)
    let livingRUB = 0;
    readRange_(SHEETS.WEEKLY, 2).forEach(function (r) {
      const d = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
      if (!isNaN(d) && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
        livingRUB += Number(r[3]) || 0;
      }
    });
    let mortgagesRUB = 0;
    DebtEngine.getEvents().forEach(function (ev) {
      if (ev.event === 'payment' && ev.date.getFullYear() === now.getFullYear() && ev.date.getMonth() === now.getMonth()) {
        mortgagesRUB += ev.amount;
      }
    });

    const L = ['📌 <b>Digest месяца ' + monthKey + '</b> (факт против плана)'];

    if (!plan) {
      L.push('⚠️ Строка месяца не найдена в Monthly_Cycles — доход не был записан через /income.');
    } else {
      const livingActualUSD = livingRUB / fx.USDRUB;
      const surplusActual = plan.incomeUSD - plan.mandatoryUSD - livingActualUSD;
      const surplusDelta = surplusActual - plan.surplusUSD;
      const savingsRate = plan.incomeUSD > 0 ? surplusActual / plan.incomeUSD : 0;

      L.push('💵 Доход: ' + fmtMoney_(plan.incomeUSD, 'USD') + (plan.status === 'applied' ? ' · каскад применён ✅' : ' · каскад НЕ применён ⚠️'));
      L.push('🧾 Обязательства (план): ' + fmtMoney_(plan.mandatoryUSD, 'USD'));
      L.push('🍽 Жизнь: план ' + fmtMoney_(getSettingNum_('MONTHLY_CAP_RUB', 60000) / fx.USDRUB, 'USD') +
        ' → факт ' + fmtMoney_(livingActualUSD, 'USD') + ' (' + fmtMoney_(livingRUB, 'RUB') + ')' +
        (livingRUB > getSettingNum_('MONTHLY_CAP_RUB', 60000) ? ' ⚠️ перерасход' : ' ✅'));
      L.push('🏦 Ипотеки выплачено: ' + fmtMoney_(mortgagesRUB, 'RUB') + ' (' + fmtMoney_(mortgagesRUB / fx.USDRUB, 'USD') + ')');
      L.push('💚 Профицит: план ' + fmtMoney_(plan.surplusUSD, 'USD') + ' → факт <b>' + fmtMoney_(surplusActual, 'USD') + '</b>' +
        ' (' + (surplusDelta >= 0 ? '+' : '') + fmtMoney_(surplusDelta, 'USD') + ')');
      L.push('📉 <b>Savings rate: ' + fmtPct_(savingsRate) + '</b>');

      this.logOnce('savings_rate:' + monthKey, Math.round(savingsRate * 1000) / 1000);
      this.logOnce('cascade_applied:' + monthKey + ':observed', plan.status === 'applied' ? 1 : 0);
    }

    // Метрики продукта
    const wrr = this.weeklyResponseRate();
    const va = this.visionAccuracy();
    const Lm = ['\n📊 <b>Метрики</b>'];
    Lm.push('Воскресные опросы: ответов ' + (wrr === null ? '—' : fmtPct_(wrr, 0)) +
      ' из отправленных (' + this.byPrefix('weekly_ask:').length + ' нед.)' + (wrr !== null && wrr < 0.8 ? ' ⚠️ цель >80%' : ''));
    if (va) Lm.push('Vision: исправлений категорий ' + va.fixes + ' из ' + (va.fixes + va.visionRows) + ' записей (' + fmtPct_(va.fixRate, 0) + ', цель <10%)');
    const reconCount = this.byPrefix('recon_ok:').filter(function (r) { return r.key === 'recon_ok:' + monthKey; }).length;
    Lm.push('Сверка ипотек в этом месяце: ' + (reconCount ? '✅ была' : 'не было'));

    return L.concat(Lm).join('\n') + fxWarn + '\n\n🗓 Завтра — новый месяц: запишите доход /income 6200 eur';
  },
};

/** Тест digest из редактора. */
function testDigest() {
  const chatId = getProp_(PROP.CHAT_ID, '');
  const text = MetricsEngine.buildMonthDigest();
  console.log(text.replace(/<[^>]+>/g, ''));
  if (chatId) sendMessage_(chatId, text);
}
