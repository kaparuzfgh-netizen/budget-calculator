/**
 * services/vision.ts — оркестрация vision-флоу (шаг 7, порт v1
 * handlePhoto_/handleDebtBalancePhoto_ из Code.gs):
 *   фото → проверка согласия/лимита → getFile → скачивание → Gemini/Groq →
 *   expense_analytics → одна недельная трата (source 'vision', идемпотентно);
 *   debt_balance → выбор кредита → VIS_RECON → событие reconcile.
 *
 * Приватность: фото уходит провайдеру ТОЛЬКО при profile.vision_enabled = 1;
 * в логи — update_id и provider/status (не текст фото, не file_path, не ключи).
 * Сумма сверки хранится в conversation_state, НЕ в callback_data.
 */
import type { AccessDeps, IncomingMessage } from './access';
import type { ProfileRow, ScopedRepo } from '../db/repo';
import { toMinor } from '../domain/money';
import { fmtMoney } from '../bot/format';
import { todayInTz } from '../bot/parse';
import { runWeek } from '../bot/features';
import { renderDebt } from '../bot/debts';
import { buildDebtCtx } from './debts';
import { cancelBtn, navRow } from '../bot/nav/nav';
import type { ReplyMarkup } from '../telegram/client';
import { getFxRates } from '../fx/service';
import { parseScreenshot, toBase64, VisionError, type VisionResult } from '../vision';
import {
  VISION_DAILY_LIMIT_TEXT,
  VISION_DEBT_NO_AMOUNT,
  VISION_DISABLED,
  VISION_MONTH_NOTE,
  VISION_NOT_CONFIGURED,
  VISION_TOO_BIG,
  visionDebtPickRows,
  visionDebtPickText,
  visionFailText,
  visionHeadText,
  visionHintText,
  visionNote,
  visionReconText,
} from '../bot/vision';

/** Секреты/настройки vision-провайдеров: из env (прод) или deps (тесты). */
export interface VisionProviders {
  geminiKey?: string | undefined;
  geminiModel?: string | undefined;
  groqKey?: string | undefined;
  groqModel?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // вход ≤10 МБ (v1 было 8 МБ — лимит шага 7)
const VISION_DAILY_LIMIT = 20; // скриншотов/день/пользователь — claim-бакеты в reminder_log
const VISION_STEP = 'vs:recon';

const fxGet = (deps: AccessDeps) => (ccys: string[]) =>
  getFxRates(deps.db, deps.fx!, ccys, deps.now ?? new Date());

/**
 * Фото банковского скриншота. Вызывается ТОЛЬКО для онбоарденного
 * пользователя при msg.photoFileId — до любой текстовой маршрутизации
 * (подпись к фото игнорируется, ждущие текстовые шаги не трогаем).
 */
export async function handleVisionPhoto(
  msg: IncomingMessage,
  repo: ScopedRepo,
  deps: AccessDeps,
  profile: ProfileRow,
): Promise<void> {
  const tg = deps.telegram;
  const say = (text: string, markup?: ReplyMarkup) =>
    tg.sendMessage(msg.chatId, text, markup ? { replyMarkup: markup } : {});
  // 1) согласие — фича opt-in: фото наружу не уходит, пока выключено
  if (profile.vision_enabled !== 1) {
    await say(VISION_DISABLED);
    return;
  }
  const v = deps.vision;
  if (!v?.geminiKey && !v?.groqKey) {
    await say(VISION_NOT_CONFIGURED);
    return;
  }
  const now = deps.now ?? new Date();
  const today = todayInTz(profile.timezone, now);
  // 3) дневной лимит 20 — claim-слоты в reminder_log (редоставка webhook
  // не жжёт квоту); A2-9: один SELECT + один claim вместо цикла INSERT.
  if (!(await repo.claimVisionSlot(today, VISION_DAILY_LIMIT))) {
    await say(VISION_DAILY_LIMIT_TEXT);
    return;
  }
  try {
    // 4) typing — best-effort индикатор; отсутствие методов в моке не роняет флоу
    await tg.sendChatAction?.(msg.chatId, 'typing').catch(() => undefined);
    if (!tg.getFile || !tg.downloadFileBytes) {
      throw new VisionError('telegram', 'скачивание файлов недоступно');
    }
    const file = await tg.getFile(msg.photoFileId!);
    if (file.file_size && file.file_size > MAX_IMAGE_BYTES) {
      await say(VISION_TOO_BIG);
      return;
    }
    const bytes = await tg.downloadFileBytes(file.file_path);
    if (bytes.length > MAX_IMAGE_BYTES) {
      await say(VISION_TOO_BIG);
      return;
    }
    const parsed = await parseScreenshot(toBase64(bytes), msg.photoMime || 'image/jpeg', {
      geminiKey: v.geminiKey,
      geminiModel: v.geminiModel,
      groqKey: v.groqKey,
      groqModel: v.groqModel,
      fallbackCcy: profile.living_currency,
      currencies: [...new Set([profile.income_currency, profile.living_currency])],
      fetchImpl: v.fetchImpl,
    });
    await applyVisionResult(msg, repo, deps, profile, parsed, today);
  } catch (e) {
    // Лог — только provider/status (тела ответов, file_path, ключи, текст —
    // никогда). Причина пользователю — уже безопасная короткая строка.
    const reason = e instanceof VisionError ? (e.provider === 'vision' ? e.message : `${e.provider}: ${e.message}`) : null;
    console.error(`vision: update ${msg.updateId} — ${reason ?? 'unexpected'}`);
    await say(visionFailText(reason));
  }
}

/** Маршрутизация разобранного результата — как в v1 handlePhoto_. */
async function applyVisionResult(
  msg: IncomingMessage,
  repo: ScopedRepo,
  deps: AccessDeps,
  profile: ProfileRow,
  parsed: VisionResult,
  today: string,
): Promise<void> {
  const tg = deps.telegram;
  const say = (text: string, markup?: ReplyMarkup) =>
    tg.sendMessage(msg.chatId, text, markup ? { replyMarkup: markup } : {});

  if (parsed.screen_type === 'debt_balance') {
    if (!(parsed.debt_balance > 0)) {
      await say(VISION_DEBT_NO_AMOUNT);
      return;
    }
    const debts = (await repo.listDebts(true)).results; // только свои активные (scoped)
    if (!debts.length) {
      await say(
        `🏦 Остаток долга на скриншоте: <b>${fmtMoney(parsed.debt_balance, parsed.currency)}</b> — ` +
          'но активных кредитов нет. Добавьте: /credits',
      );
      return;
    }
    // сумма — в состоянии диалога, НЕ в callback_data (в v1 была в кнопке)
    await repo.setConversation(VISION_STEP, JSON.stringify({ amount_minor: toMinor(parsed.debt_balance) }));
    await say(visionDebtPickText(parsed), { inline_keyboard: visionDebtPickRows(debts, [cancelBtn('DEBTS')]) });
    return;
  }

  if (parsed.screen_type === 'other' || !(parsed.total_spent > 0)) {
    await say(visionHintText(parsed.provider));
    return;
  }

  const head = visionHeadText(parsed);
  if (parsed.is_full_month_analytics) {
    await say(head + VISION_MONTH_NOTE);
    return;
  }
  // одна недельная трата: source 'vision'; редоставка того же апдейта →
  // тот же source_key → INSERT OR IGNORE не создаёт дубль
  await repo.addExpense({
    spent_on: today,
    amount_minor: toMinor(parsed.total_spent),
    currency: parsed.currency,
    note: visionNote(parsed),
    source: 'vision',
    source_key: `vis:${msg.updateId}`,
  });
  // статус недели — тем же путём, что /week (runWeek: FX + weeklyStatus)
  await runWeek(msg.chatId, tg, repo, { get: fxGet(deps) }, today, `${head}\n\n`);
}

/**
 * Callback-кнопки сверки (vs:rec:<id> → подтверждение VIS_RECON;
 * vs:reconok:<id> → запись reconcile + карточка долга).
 * Чужие/устаревшие id и состояния — молча (R7).
 */
export async function handleVsCallback(
  data: string,
  msg: IncomingMessage,
  repo: ScopedRepo,
  deps: AccessDeps,
  state: { step: string; data: unknown },
  profile: ProfileRow,
): Promise<void> {
  if (state.step !== VISION_STEP) return;
  const d = (state.data ?? {}) as { amount_minor?: unknown; debtId?: unknown };
  const amount_minor = Number(d.amount_minor);
  const mRec = /^vs:rec:(\d+)$/.exec(data);
  const mOk = /^vs:reconok:(\d+)$/.exec(data);
  const id = Number(mRec?.[1] ?? mOk?.[1]);
  if (!Number.isInteger(id) || !Number.isInteger(amount_minor) || amount_minor <= 0) return;
  const debt = await repo.getDebt(id);
  if (!debt || !debt.active) return; // чужой/удалённый id — молча
  const tg = deps.telegram;
  if (mRec) {
    // подтверждение: сумма и id — в состоянии диалога (callback_data чистая)
    await repo.setConversation(VISION_STEP, JSON.stringify({ amount_minor, debtId: id }));
    const nav = navRow('VIS_RECON');
    await tg.sendMessage(msg.chatId, visionReconText(debt.name, amount_minor, debt.currency), {
      replyMarkup: {
        inline_keyboard: [[{ text: '✅ Сверить', callback_data: `vs:reconok:${id}` }], ...(nav ? [nav] : [])],
      },
    });
    return;
  }
  if (!mOk || d.debtId !== id) return; // «сверить» нажата на другой карточке — молча
  const today = todayInTz(profile.timezone, deps.now ?? new Date());
  // сверка — тот же journal event 'reconcile', что и ручная сверка (replay);
  // идемпотентность: source_key с update_id + debt_id
  await repo.addDebtEvent({
    debt_id: id,
    kind: 'reconcile',
    amount_minor,
    event_on: today,
    source: 'manual',
    source_key: `vis:rec:${msg.updateId}:${id}`,
  });
  // карточка долга — тем же рендером, что и /credits → debt:one
  const ctx = await buildDebtCtx(repo, profile, fxGet(deps), deps.now ?? new Date());
  const r = renderDebt('DEBT', { debtId: id }, ctx);
  await repo.setConversation(r.step, JSON.stringify({ debtId: id }));
  await tg.sendMessage(
    msg.chatId,
    `🏦 Сверено: остаток <b>${fmtMoney(amount_minor / 100, debt.currency)}</b>\n\n${r.text}`,
    r.markup ? { replyMarkup: r.markup } : {},
  );
}
