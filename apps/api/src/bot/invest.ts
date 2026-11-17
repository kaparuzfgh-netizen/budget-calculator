/**
 * invest.ts — экран INVEST (/invest): итог ручного портфеля в валюте бюджета
 * и доли по видам. Только просмотр: позиции вводятся и правятся в Mini App.
 * Рендер — один источник с Mini App (services/portfolio.portfolioView).
 * Это учёт, а не инвестиционная рекомендация. В логи ничего не пишем.
 */
import type { FxResult } from '../fx/service';
import type { ScopedRepo } from '../db/repo';
import type { TelegramClient } from '../telegram/client';
import { escapeHtml } from '../telegram/client';
import { HOLDING_KINDS } from '../domain/portfolio';
import { INVEST_DISCLAIMER, KIND_LABEL, portfolioView, type PortfolioView } from '../services/portfolio';
import type { PriceSource } from '../prices/service';
import { fmtMoney } from './format';
import { withNav } from './nav/nav';

/** Чистый рендер итога (HTML для Telegram). */
export function renderInvest(v: PortfolioView): string {
  const lines = ['💼 <b>Инвестиции</b>'];
  if (!v.items.length) {
    lines.push('Позиций пока нет. Добавьте вклад, облигации, крипту или акции в приложении (кнопка у поля ввода).');
  } else {
    lines.push(
      v.total.minor === null
        ? `Итого: курсы недоступны — сумма не посчитана (${v.items.length} поз.)`
        : `Итого: <b>${fmtMoney(v.total.minor / 100, v.total.currency)}</b> · позиций: ${v.items.length}`,
    );
    const cur = v.allocation.current;
    const shares = HOLDING_KINDS.filter((k) => cur[k]).map((k) => `${KIND_LABEL[k].toLowerCase()} ${cur[k]}%`);
    if (shares.length) lines.push(`Доли: ${shares.join(' · ')}`);
    const tg = v.allocation.targets;
    if (tg) {
      const goals = HOLDING_KINDS.filter((k) => tg[k]).map((k) => `${KIND_LABEL[k].toLowerCase()} ${tg[k]}%`);
      lines.push(`Цели: ${goals.join(' · ')}`);
    }
    if (v.total.missing_rates.length)
      lines.push(`⚠️ Нет курса для ${escapeHtml(v.total.missing_rates.join(', '))} — эти позиции не в итоге.`);
    if (v.total.fx_stale) lines.push('<i>Курсы устарели — провайдер недоступен.</i>');
    const autoN = v.items.filter((i) => i.price_source === 'auto').length;
    if (autoN) {
      const at = v.auto.as_of ? new Date(v.auto.as_of).toISOString().slice(11, 16) : '';
      lines.push(
        `Автоцены крипты: ${autoN} поз.${at ? ` · ${at} UTC` : ''}${v.auto.stale ? ' (устарели — провайдер недоступен)' : ''}`,
      );
      lines.push(`<a href="${v.auto.attribution.url}">${v.auto.attribution.text}</a>`);
    }
    const atCost = v.items.filter((i) => i.valued_at_cost).length;
    if (atCost) lines.push(`Без цены (оценены по сумме покупки): ${atCost} поз.`);
    lines.push('<i>Позиции правятся в приложении.</i>');
  }
  lines.push(`<i>${INVEST_DISCLAIMER}</i>`);
  return lines.join('\n');
}

export async function runInvest(
  chatId: number,
  tg: TelegramClient,
  repo: ScopedRepo,
  fx: { get(ccys: string[]): Promise<FxResult> },
  today: string,
  prices?: PriceSource | null,
): Promise<void> {
  const p = await repo.getProfile();
  if (!p?.onboarded_at) {
    await tg.sendMessage(chatId, 'Сначала настройка — /start');
    return;
  }
  const v = await portfolioView(repo, p, (c) => fx.get(c), today, prices);
  const markup = withNav('INVEST');
  await tg.sendMessage(chatId, renderInvest(v), markup ? { replyMarkup: markup } : {});
}
