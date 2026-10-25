/**
 * hidden-utils.mjs — чистая логика маскировки ввода (без node:* — тестируется в workerd).
 * askHidden в scripts/ask-hidden.mjs — тонкая readline-обёртка над maskChunk.
 */

/**
 * Что вывести в терминал вместо chunk при скрытом вводе:
 *   символ → '*' (по одному на символ — видно длину, не значение);
 *   Backspace → '\b \b' (стираем звёздочку, правка работает);
 *   Enter/newline → '\n'.
 */
export function maskChunk(chunk) {
  if (chunk.includes('\b') || chunk.includes('\x7f') || chunk.includes('')) return '\b \b';
  if (chunk === '\r\n' || chunk === '\n' || chunk === '\r') return '\n';
  return '*'.repeat([...chunk].length) || '*';
}
