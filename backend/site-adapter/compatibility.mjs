export const selectionPlans = Object.freeze(Object.fromEntries(
  [['gpt-5-6', 'GPT-5.6 Sol', '5.6'], ['gpt-6', 'GPT-6', '6']].flatMap(([base, family, version]) =>
    [['', 'Medium'], ['-instant', 'Instant'], ['-thinking', 'Medium'], ['-pro', 'Pro']].map(([suffix, effort]) =>
      [base + suffix, Object.freeze({ family, version, effort })]))));

export const workModels = Object.freeze({
  'gpt-5.6-sol-wm': 'GPT-5.6 Sol', 'gpt-6-sol-wm': 'GPT-6 Sol',
  'gpt-6-luna-wm': 'GPT-6 Luna', 'gpt-6.1-sol-wm': 'GPT-6.1 Sol',
  'gpt-5.6-terra-wm': 'GPT-5.6 Terra', 'gpt-5.6-luna-wm': 'GPT-5.6 Luna',
  'gpt-6-astra-wm': 'GPT-6 Astra', 'gpt-6.1-terra-wm': 'GPT-6.1 Terra',
});

export const wireModels = Object.freeze({
  'gpt-5-6-mini': { uiModel: 'gpt-5-6-instant', name: 'GPT-5.6 Luna (mini)' },
  'gpt-5-6-t-mini': { uiModel: 'gpt-5-6-thinking', name: 'GPT-5.6 Luna Thinking (mini)' },
  chatgpt_alpha_model_external_access_reserved_gate_13: {
    uiModel: 'gpt-6-instant', name: 'Newly create multisys_rollout',
  },
  chatgpt_alpha_model_external_access_reserved_gate_12: {
    uiModel: 'gpt-6-instant', name: 'New multisys_rollout model biz',
  },
});

export const unsupportedModels = Object.freeze({
  'gpt-6-mini': 'The current live web submission returned an empty answer.',
  'gpt-6-t-mini': 'The current live web submission returned a hidden/empty answer.',
  research: 'No Deep Research entry is present in the current account surface.',
});
export const compatibilityTable = Object.freeze(Object.fromEntries([
  ...Object.entries(unsupportedModels).map(([slug, reason]) => [slug, { knownBroken: reason }]),
  ...Object.entries(workModels).map(([slug, family]) => [slug, { name: `${family} (Work - saved task)` }]),
  ...Object.entries(wireModels).map(([slug, plan]) => [slug, { name: plan.name }]),
]));

export function annotate(slug, title) {
  return { name: title || slug, imageOk: false, knownBroken: Object.hasOwn(unsupportedModels, slug) ? unsupportedModels[slug] : null };
}
