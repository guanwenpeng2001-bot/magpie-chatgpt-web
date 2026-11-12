import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../src/wire/prepare.mjs';
import {
  CHATGPT_WEB_IMAGE_RESERVE_TOKENS,
  CHATGPT_WEB_INSTANT_CONTEXT_LIMIT,
  CHATGPT_WEB_ORIGINAL_IMAGE_RESERVE_TOKENS,
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  CHATGPT_WEB_PRO_CONTEXT_LIMIT,
  CHATGPT_WEB_REASONING_CONTEXT_LIMIT,
  assertPreparedInputFits,
  estimatePreparedInput,
  estimateTextTokens,
  resolveChatGptWebContextLimit,
} from '../src/usage/context.mjs';

const image = detail => ({
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: 'aGk=',
    ...(detail ? { detail } : {}),
  },
});

test('the local text estimate over-counts ordinary and non-ASCII text deterministically', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('abcd'), 2);
  assert.equal(estimateTextTokens('中'), 2);
  assert.equal(estimateTextTokens('a中'), 3);
});

test('prepared input counts the compiled prompt and image reserves exactly once', () => {
  const prepared = prepare({
    model: 'gpt-6',
    system: 'system instructions',
    messages: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: [{ type: 'text', text: 'inspect this' }, image('original'), image()] },
    ],
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    stream: false,
  });
  const estimate = estimatePreparedInput(prepared);
  assert.equal(estimate.promptTokens, estimateTextTokens(prepared.prompt));
  assert.equal(estimate.platformReserveTokens, CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
  assert.equal(
    estimate.imageTokens,
    CHATGPT_WEB_ORIGINAL_IMAGE_RESERVE_TOKENS + CHATGPT_WEB_IMAGE_RESERVE_TOKENS,
  );
  assert.equal(
    estimate.inputTokens,
    CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + estimate.promptTokens + estimate.imageTokens,
  );
  assert.ok(estimate.historyTokens > 0);
  assert.ok(estimate.systemTokens > 0);
  assert.ok(estimate.toolSchemaTokens > 0);
  assert.equal(estimate.contextLimit, CHATGPT_WEB_REASONING_CONTEXT_LIMIT);
  assert.equal(estimate.estimated, true);
});

test('context limits follow the conservative browser mode rather than the picker planning value', () => {
  const cases = [
    ['auto', CHATGPT_WEB_INSTANT_CONTEXT_LIMIT],
    ['gpt-6-instant', CHATGPT_WEB_INSTANT_CONTEXT_LIMIT],
    ['gpt-5-6-mini', CHATGPT_WEB_INSTANT_CONTEXT_LIMIT],
    ['gpt-6', CHATGPT_WEB_REASONING_CONTEXT_LIMIT],
    ['gpt-6-thinking', CHATGPT_WEB_REASONING_CONTEXT_LIMIT],
    ['gpt-6-t-mini', CHATGPT_WEB_REASONING_CONTEXT_LIMIT],
    ['gpt-6-sol-wm', CHATGPT_WEB_REASONING_CONTEXT_LIMIT],
    ['chatgpt-web/gpt-6-pro', CHATGPT_WEB_PRO_CONTEXT_LIMIT],
  ];
  for (const [model, limit] of cases) {
    assert.equal(resolveChatGptWebContextLimit(model).limit, limit, model);
  }
});

test('over-context is rejected as a typed, actionable error before browser dispatch', () => {
  const prepared = prepare({
    model: 'gpt-6',
    messages: [{ role: 'user', content: 'a'.repeat(300_000) }],
    stream: false,
  });
  const estimate = estimatePreparedInput(prepared);
  assert.throws(() => assertPreparedInputFits(prepared, estimate), error => {
    assert.equal(error.code, 'contextLength');
    assert.equal(error.status, 400);
    assert.match(error.message, /Start a new chat, compact the conversation/);
    assert.match(error.message, /no browser turn was opened/);
    assert.deepEqual(error.toJSON().values, {
      estimated: String(estimate.inputTokens),
      limit: String(CHATGPT_WEB_REASONING_CONTEXT_LIMIT),
      limitKind: 'conservative ChatGPT Web reasoning browser',
      model: 'gpt-6',
    });
    return true;
  });
});
