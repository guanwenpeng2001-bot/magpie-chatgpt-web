// The reference v6.1.18 policy was checked 2026-09-19. Current official pages
// confirm bucket relationships but no longer publish those numeric caps. Never
// silently promote historical 50/200/170 values to a current official allowance.
export const POLICY_EVIDENCE = Object.freeze({
  status: 'numeric-caps-unverified', checkedOn: '2026-11-13',
  sources: Object.freeze([
    'https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt',
    'https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers',
  ]),
  reference: 'codex-chatgpt-web v6.1.18 / launcher/electron/limits-policy.json (2026-09-19)',
});

export const REFERENCE_DATE = '2026-09-19';
const RULES = Object.freeze({
  prolite: Object.freeze([{ id: 'shared-week', name: 'Pro合计 · 7天', family: 'shared', window: 'week', cap: 50 }]),
  pro: Object.freeze([
    { id: 'gpt6-week', name: 'GPT-6 Pro · 7天', family: 'gpt-6-pro', window: 'week', cap: 200 },
    { id: 'sol-day', name: '5.6 Pro · 24h', family: 'gpt-5.6-pro', window: 'day', cap: 170 },
    { id: 'shared-day', name: 'Pro合计 · 24h', family: 'shared', window: 'day', cap: 200 },
  ].map(Object.freeze)),
});

function proFamily({ model, effort }) {
  // Accept the text selector spelling in projections from an older reader too.
  model = model.replace(/^gpt-5-6(?=-|$)/, 'gpt-5.6');
  if (model === 'gpt-6-pro' || effort === 'max' && ['gpt-6', 'gpt-6-sol', 'gpt-6-astra'].includes(model)) return 'gpt-6-pro';
  if (model === 'gpt-5.6-pro' || effort === 'max' && ['gpt-5.6', 'gpt-5.6-sol'].includes(model)) return 'gpt-5.6-pro';
  if (model === 'pro-unknown' || effort === 'max' && ['unknown', 'other'].includes(model)) return 'pro-unknown';
  return null;
}

/** Historical budgeting SCENARIO, not an actual remaining-allowance bound.
 * Fixed official reset boundaries and outside/pre-tracking activity are unknown.
 * Unknown Pro families count once in shared buckets and conservatively in each
 * family bucket. Known unsupported models do not acquire invented caps. */
export function referenceScenario(local, { planType, personal } = {}) {
  if (personal !== true || !Object.hasOwn(RULES, planType) || local.status !== 'tracking') return null;
  const groups = local.byModel.map(group => ({ ...group, family: proFamily(group) }));
  return { date: REFERENCE_DATE, tier: planType === 'prolite' ? 'Pro100' : 'Pro200',
    uncertainPro: groups.filter(x => x.family === 'pro-unknown').reduce((n, x) => n + x.week, 0),
    unclassified: groups.filter(x => x.model === 'unknown' && x.family === null).reduce((n, x) => n + x.week, 0),
    windows: RULES[planType].map(rule => {
      const selected = groups.filter(x => x.family === rule.family || x.family === 'pro-unknown'
        || rule.family === 'shared' && x.family !== null);
      const recorded = selected.reduce((n, x) => n + x[rule.window], 0);
      return { ...rule, recorded, budgetLeft: Math.max(0, rule.cap - recorded) };
    }),
  };
}
