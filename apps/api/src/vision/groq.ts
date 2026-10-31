/**
 * vision/groq.ts — резервный провайдер Groq (порт v1 parseWithGroq_):
 * OpenAI-compatible chat/completions, ключ — только в Authorization.
 */
import { VisionError, type VisionResult } from './types';
import { sanitizeVision } from './parse';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_DEFAULT_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const VISION_TIMEOUT_MS = 20_000;

export interface GroqOpts {
  key: string;
  model?: string | undefined;
  prompt: string;
  fallbackCcy: string;
  fetchImpl?: typeof fetch | undefined;
}

/** Ответ choices[0].message.content (JSON) → sanitizeVision('groq'). */
export async function parseWithGroq(b64: string, mime: string, opts: GroqOpts): Promise<VisionResult> {
  const f = opts.fetchImpl ?? fetch;
  const body = {
    model: opts.model || GROQ_DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              opts.prompt +
              '\nВерни JSON с полями: screen_type, period, total_spent, currency, ' +
              'top_categories[{category,amount}], is_full_month_analytics, bank, debt_balance, ' +
              'transactions[{date,amount,note,category}].',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
  };
  const res = await f(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!res.ok) throw new VisionError('groq', `HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new VisionError('groq', 'пустой ответ модели');
  try {
    return sanitizeVision(JSON.parse(content), 'groq', opts.fallbackCcy);
  } catch (e) {
    throw e instanceof VisionError ? e : new VisionError('groq', 'битый JSON модели');
  }
}
