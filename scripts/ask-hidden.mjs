/**
 * ask-hidden.mjs — скрытый ввод секретов в консоли (общий для setup.mjs и
 * telegram-webhook.mjs). Вопрос печатается обычно; вводимые символы — '*'.
 * Поддерживает вставку из буфера и Backspace; ничего не сохраняет.
 */
import readline from 'node:readline';
import { maskChunk } from './hidden-utils.mjs';

export function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // вопрос — обычным текстом; маскируется только echo ввода
    process.stdout.write(question);
    rl._writeToOutput = (chunk) => rl.output.write(maskChunk(chunk));
    rl.question('', (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}
