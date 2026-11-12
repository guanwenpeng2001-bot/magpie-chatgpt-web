import { BackendError } from '../../backend/guard.mjs';
import {
  selectionPlans,
  wireModels,
  workSelectionPlans,
} from '../../backend/site-adapter/compatibility.mjs';

// These ceilings include the hidden product reserve below. They follow the measured browser
// boundaries used by the reference adapter, with unknown/automatic modes kept on the smallest
// documented boundary so a preflight cannot turn an optimistic estimate into a doomed submission.
export const CHATGPT_WEB_INSTANT_CONTEXT_LIMIT = 41_000;
export const CHATGPT_WEB_REASONING_CONTEXT_LIMIT = 90_000;
export const CHATGPT_WEB_PRO_CONTEXT_LIMIT = 111_001;
export const CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192;
export const CHATGPT_WEB_IMAGE_RESERVE_TOKENS = 4_096;
export const CHATGPT_WEB_ORIGINAL_IMAGE_RESERVE_TOKENS = 8_192;

/**
 * Local pre-tokenizer estimate. It intentionally over-counts ordinary ASCII and CJK-heavy text:
 * no browser or quota tokenizer is exposed. The complete string is measured once so chunking
 * cannot hide a token boundary.
 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let utf8Bytes = 0;
  let nonAsciiCodePoints = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) utf8Bytes += 1;
    else {
      utf8Bytes += codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      nonAsciiCodePoints += 1;
    }
  }
  return Math.ceil(utf8Bytes / 3) + Math.ceil(nonAsciiCodePoints / 2);
}

function requestModelSlug(model) {
  const value = typeof model === 'string' ? model : '';
  return value.startsWith('chatgpt-web/') ? value.slice('chatgpt-web/'.length) : value;
}

export function resolveChatGptWebContextLimit(model) {
  const originalSlug = requestModelSlug(model);
  const bridgedSlug = wireModels[originalSlug]?.uiModel ?? originalSlug;
  const plan = selectionPlans[bridgedSlug];
  if (plan?.effort === 'Pro') {
    return {
      limit: CHATGPT_WEB_PRO_CONTEXT_LIMIT,
      kind: 'ChatGPT Pro model browser',
    };
  }
  if (plan?.effort === 'Instant') {
    return {
      limit: CHATGPT_WEB_INSTANT_CONTEXT_LIMIT,
      kind: 'conservative ChatGPT Web Instant browser',
    };
  }
  if (plan || Object.hasOwn(workSelectionPlans, originalSlug)) {
    return {
      limit: CHATGPT_WEB_REASONING_CONTEXT_LIMIT,
      kind: Object.hasOwn(workSelectionPlans, originalSlug)
        ? 'conservative ChatGPT Web Work browser'
        : 'conservative ChatGPT Web reasoning browser',
    };
  }
  return {
    limit: CHATGPT_WEB_INSTANT_CONTEXT_LIMIT,
    kind: 'conservative ChatGPT Web page-default browser',
  };
}

export function estimatePreparedInput(prepared) {
  const prompt = typeof prepared?.prompt === 'string' ? prepared.prompt : '';
  const history = Array.isArray(prepared?.history) ? prepared.history : [];
  const tools = Array.isArray(prepared?.tools) ? prepared.tools : [];
  const images = Array.isArray(prepared?.images) ? prepared.images : [];
  const promptTokens = estimateTextTokens(prompt);
  const imageTokens = images.reduce((total, image) => total + (
    image?.detail === 'original'
      ? CHATGPT_WEB_ORIGINAL_IMAGE_RESERVE_TOKENS
      : CHATGPT_WEB_IMAGE_RESERVE_TOKENS
  ), 0);
  const historyTokens = history.reduce((total, message) => total + estimateTextTokens(message?.content), 0);
  const systemTokens = estimateTextTokens(prepared?.system);
  const toolSchemaTokens = tools.length ? estimateTextTokens(JSON.stringify(tools)) : 0;
  // Magpie selects efforts through x-magpie-effort on the base model. Use the resolved
  // browser selection for preflight so Instant cannot inherit the base reasoning ceiling.
  const context = resolveChatGptWebContextLimit(prepared?.selectionModel ?? prepared?.model);
  return {
    inputTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + promptTokens + imageTokens,
    promptTokens,
    historyTokens,
    systemTokens,
    toolSchemaTokens,
    imageTokens,
    platformReserveTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
    contextLimit: context.limit,
    contextLimitKind: context.kind,
    estimated: true,
  };
}

// `promptTokens` is the prepared browser text and already contains system, history and tool
// schemas. The component counts are diagnostics and must not be added to it again.
export function assertPreparedInputFits(prepared, estimate = estimatePreparedInput(prepared)) {
  if (estimate.inputTokens < estimate.contextLimit) return estimate;
  throw new BackendError('contextLength', {
    values: {
      estimated: estimate.inputTokens,
      limit: estimate.contextLimit,
      limitKind: estimate.contextLimitKind,
      model: typeof prepared?.model === 'string' ? prepared.model : 'unknown',
    },
  });
}
