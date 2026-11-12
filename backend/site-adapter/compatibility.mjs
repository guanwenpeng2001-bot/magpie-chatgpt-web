export const selectionPlans = Object.freeze(Object.fromEntries(
  [['gpt-5-6', 'GPT-5.6 Sol', '5.6'], ['gpt-6', 'GPT-6', '6']].flatMap(([base, family, version]) =>
    [['', 'Medium'], ['-instant', 'Instant'], ['-thinking', 'Medium'], ['-pro', 'Pro']].map(([suffix, effort]) =>
      [base + suffix, Object.freeze({ family, version, effort })]))));

export const unsupportedModels = Object.freeze({
  'gpt-5.6-sol-wm': 'Work mode has no selector in this ordinary chat surface.',
  'gpt-6-sol-wm': 'Work mode has no selector in this ordinary chat surface.',
  'gpt-6-luna-wm': 'Work mode has no selector in this ordinary chat surface.',
  'gpt-6.1-sol-wm': 'Work mode has no selector in this ordinary chat surface.',
  'gpt-5.6-terra-wm': 'Work mode has no selector in this ordinary chat surface.',
  'gpt-5.6-luna-wm': 'Work mode has no selector in this ordinary chat surface.',
  'gpt-6-astra-wm': 'Work mode has no selector in this ordinary chat surface.',
  'gpt-6.1-terra-wm': 'Work mode has no selector in this ordinary chat surface.',
  'gpt-5-6-mini': 'No distinct mini model selector was found.',
  'gpt-5-6-t-mini': 'No distinct mini model selector was found.',
  'gpt-6-mini': 'No distinct mini model selector was found.',
  'gpt-6-t-mini': 'No distinct mini model selector was found.',
  research: 'Deep Research requires a separate workflow not implemented by this chat adapter.',
  chatgpt_alpha_model_external_access_reserved_gate_13: 'No corresponding experimental model selector was found.',
  chatgpt_alpha_model_external_access_reserved_gate_12: 'No corresponding experimental model selector was found.',
});
export const compatibilityTable = Object.freeze(Object.fromEntries(Object.entries(unsupportedModels).map(([slug, reason]) => [slug, { knownBroken: reason }])));

export function annotate(slug, title) {
  return { name: title || slug, imageOk: false, knownBroken: Object.hasOwn(unsupportedModels, slug) ? unsupportedModels[slug] : null };
}
