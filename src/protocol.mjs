import { AnswerStream, translate as translateWire } from './wire/translate.mjs';
export { prepare } from './wire/prepare.mjs';
export { AnswerStream, errorEvent } from './wire/translate.mjs';
export { ToolParser, checkToolDefinitions } from './tool-emulation.mjs';

// Legacy upstream frames remain supported until the turn driver migrates.
export async function* translate(source, prepared) {
  const answer = new AnswerStream();
  async function* normalized() {
    for await (const frame of source) {
      const text = answer.accept(frame);
      if (text) yield { type: 'delta', index: 0, text };
    }
    answer.finish();
    yield { type: 'finish', reason: 'complete' };
  }
  yield* translateWire(normalized(), prepared);
}
