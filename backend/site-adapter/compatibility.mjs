export const selectionPlans = Object.freeze(Object.fromEntries(
  [['gpt-5-6', 'GPT-5.6 Sol', '5.6'], ['gpt-6', 'GPT-6', '6']].flatMap(([base, family, version]) =>
    [
      ['', 'Medium'], ['-instant', 'Instant'], ['-thinking', 'Medium'],
      ['-high', 'High'], ['-extra-high', 'Extra High'], ['-pro', 'Pro'],
    ].map(([suffix, effort]) =>
      [base + suffix, Object.freeze({ family, version, effort })]))));

const baseWorkModels = Object.freeze({
  'gpt-5.6-sol-wm': 'GPT-5.6 Sol', 'gpt-6-sol-wm': 'GPT-6 Sol',
  'gpt-6-luna-wm': 'GPT-6 Luna', 'gpt-6.1-sol-wm': 'GPT-6.1 Sol',
  'gpt-5.6-terra-wm': 'GPT-5.6 Terra', 'gpt-5.6-luna-wm': 'GPT-5.6 Luna',
  'gpt-6-astra-wm': 'GPT-6 Astra', 'gpt-6.1-terra-wm': 'GPT-6.1 Terra',
});

export const workEfforts = Object.freeze(['Light', 'Medium', 'High', 'Extra High', 'Max', 'Ultra']);
const workEffortSlugs = Object.freeze({
  Light: 'low',
  Medium: 'medium',
  High: 'high',
  'Extra High': 'xhigh',
  Max: 'max',
  Ultra: 'ultra',
});

export const workSelectionPlans = Object.freeze(Object.fromEntries(
  Object.entries(baseWorkModels).flatMap(([slug, family]) => workEfforts.map(effort => {
    const variant = effort === 'Medium' ? slug : `${slug}-${workEffortSlugs[effort]}`;
    return [variant, Object.freeze({ family, effort })];
  })),
));

export const workModels = Object.freeze(Object.fromEntries(
  Object.entries(workSelectionPlans)
    .filter(([, plan]) => plan.effort === 'Medium')
    .map(([slug, plan]) => [slug, plan.family]),
));

export const wireModels = Object.freeze({
  'gpt-5-6-mini': { uiModel: 'gpt-5-6-instant', name: 'GPT-5.6 Luna (mini)' },
  'gpt-5-6-t-mini': { uiModel: 'gpt-5-6-thinking', name: 'GPT-5.6 Luna Thinking (mini)' },
  'gpt-6-t-mini': { uiModel: 'gpt-6-thinking', name: 'GPT-6 Thinking (mini)' },
  chatgpt_alpha_model_external_access_reserved_gate_13: {
    uiModel: 'gpt-6-instant', name: 'Newly create multisys_rollout',
  },
  chatgpt_alpha_model_external_access_reserved_gate_12: {
    uiModel: 'gpt-6-instant', name: 'New multisys_rollout model biz',
  },
});

export const unsupportedModels = Object.freeze({
  'gpt-6-mini': 'The current live web submission returned an empty answer.',
  research: 'The exact research override completed without a rendered answer or research canvas.',
});
export const compatibilityTable = Object.freeze(Object.fromEntries([
  ...Object.entries(unsupportedModels).map(([slug, reason]) => [slug, { knownBroken: reason }]),
  ...Object.entries(workModels).map(([slug, family]) => [slug, { name: `${family} (Work - saved task)` }]),
  ...Object.entries(wireModels).map(([slug, plan]) => [slug, { name: plan.name }]),
]));

export function annotate(slug, title) {
  return { name: title || slug, imageOk: false, knownBroken: Object.hasOwn(unsupportedModels, slug) ? unsupportedModels[slug] : null };
}
