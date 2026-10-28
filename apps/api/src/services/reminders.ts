/**
 * reminders.ts — cron-сервис напоминаний (веха D, надёжность P1-1).
 * Для каждого онбоарденного с включёнными флагами считаем ЛОКАЛЬНОЕ время
 * (profile.timezone; невалидная → UTC) и шлём В ОКНАХ (часовой тик может
 * пропасть — окно, а не точный час, даёт ретрай):
 *   a) weekly: воскресенье 20:00–23:59 local → «Итоги недели» (через runWeek)
 *   b) payment: 10:00–21:59 local → платежи (commitments и monthly-долги), чей
 *      дедлайн через 2 дня; платёж/долг, уже оплаченный в этом месяце,
 *      не напоминает
 *   c) auto_post: в том же окне автопроводка monthly-долгов и активных
 *      commitments с due_day, чей срок в этом месяце УЖЕ наступил
 *      (catch-up за пропущенные дни). Дата события — день срока, не день
 *      прогона. Claim на объект+месяц ('d:<id>:<YYYY-MM>' / 'c:<id>:<YYYY-MM>')
 *      — удалённая юзером автозапись не воскресает до конца месяца, а
 *      следующий месяц проводится снова. Объект, заведённый после даты
 *      срока этого месяца, начнёт проводиться со следующего месяца.
 *      Уведомление — одно на прогон, best-effort: записи уже корректны,
 *      поэтому при не-403 ошибке отправки claim'ы и события остаются
 *      (дублировать данные нельзя), а день считается failed.
 *   d) loan: 10:00–21:59 local → займы со сроком «сегодня» и «через 3 дня»
 * Идемпотентность: reminder_log claim (INSERT OR IGNORE) — шлём только если
 * changes=1; 403 (бот заблокирован) → отключаем флаги; прочие ошибки
 * отправки (b/d) → снимаем claim — следующий часовой прогон в окне повторит.
 * Ошибка одного пользователя не останавливает цикл. В логах — только
 * счётчики и коды.
 */
import { scoped, accessRepo } from '../db/repo';
import { debtViews, debtView } from './debts';
import { loanViews } from './loans';
import { tgWithKeyboardMigration } from './access';
import type { Env } from '../env';
import { createTelegramClient, TelegramError, sanitizeTelegramError, type TelegramClient } from '../telegram/client';
import { createFrankfurter } from '../fx/frankfurter';
import { getFxRates } from '../fx/service';
import { runWeek } from '../bot/features';
import { periodsPerYear } from '../domain/debt';
import { todayInTz } from '../bot/parse';
import { fmtMoney } from '../bot/format';
import type { InlineButton } from '../telegram/client';

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  dow: number; // 0 = воскресенье
  iso: string; // YYYY-MM-DD локально
}

/** Локальное время now в таймзоне tz (невалидная → UTC). */
export function localParts(tz: string, now: Date): LocalParts {
  let zone = tz;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz }).format(now);
  } catch {
    zone = 'UTC';
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const dayName = parts.weekday ?? '';
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[dayName as 'Sun'] ?? -1;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    dow,
    iso: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Дата дедлайна платежа в текущем (или следующем) месяце: due_day зажат в
 * последний день месяца (due_day 31 → февраль = 28/29). Если дедлайн уже прошёл
 * в этом месяце — берём следующий. Возвращает Date в UTC-полночь локальной даты.
 */
export function dueDateFor(dueDay: number, year: number, month: number): { y: number; m: number; d: number } {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const d = Math.min(dueDay, daysInMonth);
  return { y: year, m: month, d };
}
/** Сдвиг даты на -2 дня от дедлайна (с ролловером месяца/года). */
export function minus2days(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d) - 2 * 86400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const WEEKLY_HOUR = 20; // окно еженедельного итога: вс 20:00–23:59
const PAY_HOUR = 10; // окно платежей: 10:00–21:59
const PAY_HOUR_END = 22;
const HOME_ROW_MK = { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'nv:home' }]] };
const WEEKLY_MK: { inline_keyboard: InlineButton[][] } = {
  inline_keyboard: [
    [
      { text: '➕ Трата', callback_data: 'nv:go:SPENT_ASK' },
      { text: '🏠 Меню', callback_data: 'nv:home' },
    ],
  ],
};
/** Разметка сводного автопоста: ссылки на журналы записанных платежей. */
const autoPostMk = (debts: boolean, commits: boolean): { inline_keyboard: InlineButton[][] } => ({
  inline_keyboard: [
    ...(debts ? [[{ text: '🏦 Кредиты', callback_data: 'nv:go:DEBTS' }]] : []),
    ...(commits ? [[{ text: '🧾 Платежи', callback_data: 'nv:go:PF_COMMITS' }]] : []),
    [{ text: '🏠 Меню', callback_data: 'nv:home' }],
  ],
});
const LOANS_MK: { inline_keyboard: InlineButton[][] } = {
  inline_keyboard: [
    [{ text: '🤝 Долги', callback_data: 'nv:go:LOANS' }],
    [{ text: '🏠 Меню', callback_data: 'nv:home' }],
  ],
};

/** ISO-дата через n дней после локальной даты lp. */
function plusDays(lp: LocalParts, n: number): string {
  const t = new Date(Date.UTC(lp.year, lp.month - 1, lp.day) + n * 86400_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/** Ближайший дедлайн по дню месяца: текущий месяц, иначе следующий. */
function nextDue(dueDay: number, lp: LocalParts): { y: number; m: number; d: number } {
  let dd = dueDateFor(dueDay, lp.year, lp.month);
  if (dd.d < lp.day) {
    const nm = lp.month === 12 ? { y: lp.year + 1, m: 1 } : { y: lp.year, m: lp.month + 1 };
    dd = dueDateFor(dueDay, nm.y, nm.m);
  }
  return dd;
}

export async function runReminders(
  env: Env,
  now: Date,
  deps?: { telegram?: TelegramClient | undefined; fx?: import('../fx/provider').FxProvider | undefined },
): Promise<void> {
  const tg = deps?.telegram ?? createTelegramClient({ token: env.TELEGRAM_BOT_TOKEN });
  const provider = deps?.fx ?? createFrankfurter();
  const fx = { get: (c: string[]) => getFxRates(env.DB, provider, c, now) };
  const access = accessRepo(env.DB);
  // P2-5 хозчистка — каждый часовой тик: пустой DELETE дёшев, а таблицы
  // не растут бесконечно. Сбой чистки не должен стоить прогоном напоминаний.
  try {
    await access.cleanupProcessedUpdates();
    await access.cleanupReminderLog();
  } catch (e) {
    console.warn(`reminders: cleanup failed (${sanitizeTelegramError(e)})`);
  }
  const ids = await access.listReminderCandidates();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const userId of ids) {
    const repo = scoped(env.DB, userId);
    // исходящие тексты — через одноразовую миграцию снятия reply-клавиатуры
    const tgU = tgWithKeyboardMigration(repo, tg);
    try {
      const p = await repo.getProfile();
      if (!p?.onboarded_at) continue;
      const telegramId = await access.getTelegramId(userId); // P2-6: SQL только в repo.ts
      if (telegramId === null) continue;
      const lp = localParts(p.timezone, now);
      const tz = p.timezone;

      // ── еженедельный опрос: воскресенье 20:00 локально ──
      if (p.reminders_weekly === 1 && lp.dow === 0 && lp.hour >= WEEKLY_HOUR) {
        const claim = await repo.claimReminder('weekly', lp.iso);
        if (claim.meta.changes === 1) {
          try {
            await runWeek(telegramId, tgU, repo, fx, todayInTz(tz, now), '📅 <b>Итоги недели</b>\n\n', WEEKLY_MK);
            sent++;
          } catch (e) {
            if (e instanceof TelegramError && e.status === 403) {
              await repo.patchProfile({ reminders_weekly: 0, reminders_payments: 0 });
              console.warn(`reminders: user ${userId} blocked the bot — reminders disabled`);
            } else {
              await repo.releaseReminder('weekly', lp.iso);
              throw e;
            }
          }
        } else skipped++;
      }

      // ── платежи и сроки: окно 10:00–21:59 локально ──
      if (p.reminders_payments === 1 && lp.hour >= PAY_HOUR && lp.hour < PAY_HOUR_END) {
        /** claim → send → 403 гасит флаги / прочее → release+ретрай (общий цикл трёх уведомлений). */
        const sendClaimed = async (kind: string, text: string, mk: { inline_keyboard: InlineButton[][] }) => {
          const claim = await repo.claimReminder(kind, lp.iso);
          if (claim.meta.changes !== 1) {
            skipped++;
            return;
          }
          try {
            await tgU.sendMessage(telegramId, text, { replyMarkup: mk });
            sent++;
          } catch (e) {
            if (e instanceof TelegramError && e.status === 403) {
              await repo.patchProfile({ reminders_weekly: 0, reminders_payments: 0 });
              console.warn(`reminders: user ${userId} blocked the bot — reminders disabled`);
            } else {
              await repo.releaseReminder(kind, lp.iso);
              throw e;
            }
          }
        };

        // (b) напоминания за 2 дня: commitments + monthly-долги с due_day
        const monthKey = lp.iso.slice(0, 7);
        const dvs = (await debtViews(repo, lp.iso)).filter(
          (v) => v.debt.frequency === 'monthly' && v.debt.due_day && v.balance > 0 && v.payment > 0,
        );
        /** У долга уже есть платёж в этом месяце → не напоминать и не проводить. */
        const paidThisMonth = (v: (typeof dvs)[number]) =>
          v.events.some((e) => e.kind === 'payment' && e.event_on.startsWith(monthKey));
        const in2days = (dueDay: number) => {
          const dd = nextDue(dueDay, lp);
          const r = minus2days(dd.y, dd.m, dd.d);
          return r.y === lp.year && r.m === lp.month && r.d === lp.day;
        };
        const commits = (await repo.listCommitments()).results;
        /** Оплаты юзера за месяц одним запросом — «оплачен в этом месяце» для commitment. */
        const cpays = (await repo.listCommitmentPaymentsSince(`${monthKey}-01`)).results;
        const commitPaidThisMonth = (cId: number) =>
          cpays.some((x) => x.commitment_id === cId && x.paid_on.startsWith(monthKey));
        const dueLines = commits
          .filter((c) => c.due_day && in2days(c.due_day) && !commitPaidThisMonth(c.id))
          .map((c) => `  • ${c.name} — ${fmtMoney(c.amount_minor / 100, c.currency)} (срок ${dd(lp, c.due_day!)})`);
        dueLines.push(
          ...dvs
            .filter((v) => !paidThisMonth(v) && in2days(v.debt.due_day!))
            .map((v) => `  • ${v.debt.name} — ${fmtMoney(v.payment, v.debt.currency)} (срок ${dd(lp, v.debt.due_day!)})`),
        );
        if (dueLines.length) await sendClaimed('payment', `⏰ Через 2 дня платежи:\n${dueLines.join('\n')}`, HOME_ROW_MK);

        // (c) автопроводка: срок ЭТОГО месяца уже наступил (due_day клампится) —
        // catch-up за пропущенные дни. Claim на объект+месяц защищает от
        // ре-проводки после удаления записи юзером; дата события — день срока.
        const isoOf = (d: { y: number; m: number; d: number }) =>
          `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
        const lines: string[] = [];
        let postedDebt = false;
        let postedCommit = false;
        for (const v of dvs) {
          if (paidThisMonth(v)) continue;
          const ddue = dueDateFor(v.debt.due_day!, lp.year, lp.month);
          if (ddue.d > lp.day) continue; // срок этого месяца ещё не наступил
          const evOn = isoOf(ddue);
          if (v.debt.created_at.slice(0, 10) > evOn) continue; // долг заведён после срока — со след. месяца
          const key = `d:${v.debt.id}:${monthKey}`;
          const claim = await repo.claimReminder('auto_post', key);
          if (claim.meta.changes !== 1) continue;
          try {
            // последний платёж короче графика: не выше «остаток + проценты за период» (P3-1)
            const amt = Math.min(v.payment, v.balance + (v.balance * v.debt.rate) / periodsPerYear(v.debt.frequency));
            await repo.addDebtEvent({
              debt_id: v.debt.id,
              kind: 'payment',
              amount_minor: Math.round(amt * 100),
              event_on: evOn,
              source: 'auto',
              source_key: `auto:${v.debt.id}:${monthKey}`,
            });
            const after = await debtView(repo, v.debt, lp.iso);
            lines.push(`  • ${v.debt.name} — ${fmtMoney(amt, v.debt.currency)} → остаток ${fmtMoney(after.balance, v.debt.currency)}`);
            postedDebt = true;
          } catch (e) {
            // запись не удалась — снимаем claim, следующий тик окна повторит
            await repo.releaseReminder('auto_post', key);
            throw e;
          }
        }
        for (const c of commits) {
          if (!c.due_day || commitPaidThisMonth(c.id)) continue;
          const ddue = dueDateFor(c.due_day, lp.year, lp.month);
          if (ddue.d > lp.day) continue;
          const evOn = isoOf(ddue);
          if (c.created_at.slice(0, 10) > evOn) continue;
          const key = `c:${c.id}:${monthKey}`;
          const claim = await repo.claimReminder('auto_post', key);
          if (claim.meta.changes !== 1) continue;
          try {
            await repo.addCommitmentPayment({
              commitment_id: c.id,
              amount_minor: c.amount_minor,
              currency: c.currency,
              paid_on: evOn,
              source: 'auto',
              source_key: `auto:c:${c.id}:${monthKey}`,
            });
            lines.push(`  • ${c.name} — ${fmtMoney(c.amount_minor / 100, c.currency)}`);
            postedCommit = true;
          } catch (e) {
            await repo.releaseReminder('auto_post', key);
            throw e;
          }
        }
        if (lines.length) {
          try {
            await tgU.sendMessage(
              telegramId,
              `✅ Записал автоплатежи (изменить или удалить — в журнале):\n${lines.join('\n')}`,
              { replyMarkup: autoPostMk(postedDebt, postedCommit) },
            );
            sent++;
          } catch (e) {
            if (e instanceof TelegramError && e.status === 403) {
              await repo.patchProfile({ reminders_weekly: 0, reminders_payments: 0 });
              console.warn(`reminders: user ${userId} blocked the bot — reminders disabled`);
            } else {
              // уведомление best-effort: записи корректны, claim'ы не трогаем
              failed++;
              console.error(`reminders: user ${userId} auto_post notify failed (${sanitizeTelegramError(e)})`);
            }
          }
        }

        // (d) займы со сроком: «сегодня» и «через 3 дня»
        const dueLoans = (await loanViews(repo)).filter((v) => v.loan.due_on && v.status !== 'closed');
        const loanLines = dueLoans
          .filter((v) => v.loan.due_on === lp.iso || v.loan.due_on === plusDays(lp, 3))
          .map((v) => {
            const when = v.loan.due_on === lp.iso ? 'Сегодня' : v.loan.due_on!.slice(8) + '.' + v.loan.due_on!.slice(5, 7);
            const act = v.loan.direction === 'owe' ? `вернуть ${v.loan.counterparty}` : `${v.loan.counterparty} должен вернуть`;
            return `  • ${when}: ${act} — ${fmtMoney(v.remaining, v.loan.currency)}`;
          });
        if (loanLines.length) await sendClaimed('loan', `⏰ Сроки по займам:\n${loanLines.join('\n')}`, LOANS_MK);
      }
    } catch (e) {
      failed++;
      console.error(`reminders: user ${userId} failed (${sanitizeTelegramError(e)})`);
    }
  }
  console.log(`reminders: ${sent} sent, ${skipped} deduped, ${failed} failed`);
}

/** День и месяц дедлайна для текста. */
function dd(lp: LocalParts, dueDay: number): string {
  const next = dueDateFor(dueDay, lp.year, lp.month);
  return `${String(next.d).padStart(2, '0')}.${String(next.m).padStart(2, '0')}`;
}
