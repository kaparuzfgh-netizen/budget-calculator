/**
 * vision/index.ts — точка входа: base64 → цепочка провайдеров
 * (Gemini → Groq) → VisionResult. Порт v1 parseExpenseScreenshot_.
 */
import { VisionError, type VisionResult } from './types';
import { visionPrompt } from './parse';
import { parseWithGemini } from './gemini';
import { parseWithGroq } from './groq';

export { VisionError } from './types';
export type { VisionProvider, VisionResult, VisionScreenType } from './types';
export { sanitizeVision, visionPrompt, VISION_SCHEMA } from './parse';
export { parseWithGemini } from './gemini';
export { parseWithGroq } from './groq';

export interface VisionCallOpts {
  geminiKey?: string | undefined;
  /** Модель Gemini (GEMINI_MODEL); по умолчанию gemini-3.5-flash-lite. */
  geminiModel?: string | undefined;
  groqKey?: string | undefined;
  /** Модель Groq (GROQ_MODEL); по умолчанию llama-4-scout — как в v1 CONFIG. */
  groqModel?: string | undefined;
  /** Валюта-фолбэк sanitize (profile.living_currency). */
  fallbackCcy: string;
  /** Валюты профиля пользователя — вставляются в промпт. */
  currencies: string[];
  /** Подменяемый fetch (тесты). */
  fetchImpl?: typeof fetch | undefined;
}

const detail = (e: unknown, provider: string) => (e instanceof VisionError ? `${provider}: ${e.message}` : `${provider}: сбой`);

/**
 * Скриншот → структурированный разбор. Пробует Gemini, при неудаче — Groq.
 * Бросает VisionError с собранными причинами (provider+status, без тел).
 */
export async function parseScreenshot(b64: string, mime: string, opts: VisionCallOpts): Promise<VisionResult> {
  const errors: string[] = [];
  const prompt = visionPrompt(opts.currencies);
  const common = { prompt, fallbackCcy: opts.fallbackCcy, fetchImpl: opts.fetchImpl };
  if (opts.geminiKey) {
    try {
      return await parseWithGemini(b64, mime, { key: opts.geminiKey, model: opts.geminiModel, ...common });
    } catch (e) {
      errors.push(detail(e, 'gemini'));
    }
  } else {
    errors.push('gemini: ключ не задан');
  }
  if (opts.groqKey) {
    try {
      return await parseWithGroq(b64, mime, { key: opts.groqKey, model: opts.groqModel, ...common });
    } catch (e) {
      errors.push(detail(e, 'groq'));
    }
  } else {
    errors.push('groq: ключ не задан');
  }
  throw new VisionError('vision', errors.join('; '));
}

/**
 * Uint8Array → base64 чанками по 32 КБ: String.fromCharCode(...bytes) на
 * массиве целиком падает (лимит аргументов). btoa требует binary-строку.
 */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
