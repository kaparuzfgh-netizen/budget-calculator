/**
 * vision/gemini.ts — клиент Gemini generateContent (порт v1 parseWithGemini_).
 * Имена полей тела — snake_case, как в v1 (inline_data / mime_type /
 * response_mime_type / response_schema). Ключ идёт в ?key= — протокол
 * провайдера; URL не логируется, в ошибках — только HTTP-статус.
 */
import { VisionError, type VisionResult } from './types';
import { sanitizeVision, VISION_SCHEMA } from './parse';

/** Дефолт — flash-lite GA (июль 2026): самый дешёвый/бесплатный класс;
 *  переопределяется env GEMINI_MODEL (напр., gemini-3.8-flash). */
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const VISION_TIMEOUT_MS = 20_000;

export interface GeminiOpts {
  key: string;
  prompt: string;
  fallbackCcy: string;
  /** Модель без префикса 'models/' (env GEMINI_MODEL). */
  model?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** Ответ candidates[0].content.parts[0].text → sanitizeVision('gemini'). */
export async function parseWithGemini(b64: string, mime: string, opts: GeminiOpts): Promise<VisionResult> {
  const f = opts.fetchImpl ?? fetch;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: opts.prompt }, { inline_data: { mime_type: mime, data: b64 } }],
      },
    ],
    generationConfig: {
      temperature: 0,
      response_mime_type: 'application/json',
      response_schema: VISION_SCHEMA,
    },
  };

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await f(`${GEMINI_URL}${opts.model ?? DEFAULT_MODEL}:generateContent?key=${opts.key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new VisionError('gemini', `временно недоступен (HTTP ${res.status})`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // без тела ответа — статуса достаточно, тело может нести эхо запроса
      if (!res.ok) throw new VisionError('gemini', `HTTP ${res.status}`);
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const part = json.candidates?.[0]?.content?.parts?.[0];
      if (!part?.text) throw new VisionError('gemini', 'пустой ответ модели');
      return sanitizeVision(JSON.parse(part.text), 'gemini', opts.fallbackCcy);
    } catch (e) {
      lastErr = e instanceof VisionError ? e : new VisionError('gemini', 'сбой запроса');
      // ретраим только 429/5xx («временно недоступен» выставлен выше) — как в v1
      if (!(e instanceof VisionError && e.message.includes('временно недоступен'))) break;
    }
  }
  throw lastErr ?? new VisionError('gemini', 'неизвестная ошибка');
}
