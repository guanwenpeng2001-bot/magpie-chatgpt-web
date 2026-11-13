// v6.1.18 chatgpt-web-models.ts standard (Bigger Context disabled) catalog.
// /v1/models first forwards to the Codex upstream and needs a separate Codex
// credential. These browser-only rows require only the account capabilities.
export function nativeCatalog({ solAvailable = false, proAvailable = false, extraHighAvailable = false } = {}) {
  const row = (slug, context, efforts) => ({ slug: `chatgpt-web/${slug}`, display_name: slug,
    context_window: context, supported_reasoning_levels: efforts.map(effort => ({ effort })), input_modalities: ['text', 'image'] });
  if (!solAvailable) return [row('gpt-5.6-luna', 1050000, ['low', 'medium'])];
  return ['gpt-6', 'gpt-5.6'].flatMap(family => [
    row(`${family}-sol-instant`, proAvailable ? 111193 : 41000, ['low']),
    row(`${family}-sol`, proAvailable ? 111193 : 90000, ['medium', 'high', ...(extraHighAvailable ? ['xhigh'] : [])]),
    ...(proAvailable ? [row(`${family}-pro`, 112193, ['max'])] : []),
  ]);
}

export function describeNativeCatalogue(source, profile) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) return {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    return Object.fromEntries(Object.entries(source).filter(([, model]) => model && typeof model === 'object').map(([slug, model]) => {
      const id = `native/${profile}/${slug}`;
      const supported = !String(model.name ?? '').includes('[not yet supported]') && slug !== 'chatgpt-image';
      return [id, {
        name: `${model.name ?? slug} (Native tools)`,
        npm: '@ai-sdk/openai',
        api: { id, npm: '@ai-sdk/openai', url: 'http://127.0.0.1:1/v1' },
        limit: { context: model.limit?.context ?? 90000, output: 0 },
        prefer_websockets: false,
        capabilities: {
          ...(model.capabilities ?? {}),
          toolcall: supported,
          temperature: false,
          input: { text: true, image: model.capabilities?.input?.image === true },
          output: { text: true },
        },
        ...(model.variants ? { variants: structuredClone(model.variants) } : {}),
      }];
    }));
  }
  const rows = Array.isArray(source) ? source : [];
  return Object.fromEntries(rows.filter(row => /^chatgpt-web\/[A-Za-z0-9._-]+$/.test(row.slug) && Number.isSafeInteger(row.context_window) && row.context_window > 0).map(row => {
    const id = `native/${profile}/${row.slug.slice('chatgpt-web/'.length)}`;
    return [id, { name: `${row.display_name} (Native tools)`, npm: '@ai-sdk/openai',
      api: { id, npm: '@ai-sdk/openai', url: 'http://127.0.0.1:1/v1' },
      limit: { context: row.context_window, output: 0 }, prefer_websockets: false,
      capabilities: { reasoning: true, toolcall: true, attachment: true, temperature: false,
        input: { text: true, image: row.input_modalities?.includes('image') === true }, output: { text: true } },
      variants: Object.fromEntries(row.supported_reasoning_levels.map(({ effort }) => [effort, {}])),
    }];
  }));
}

const DIRECT_DAEMON_SLUGS = new Set([
  'gpt-6-sol-instant', 'gpt-6-sol', 'gpt-6-pro',
  'gpt-5.6-sol-instant', 'gpt-5.6-sol', 'gpt-5.6-pro',
  'gpt-5.6-luna',
]);

function resolveDaemonTarget(slug, requestedEffort) {
  if (DIRECT_DAEMON_SLUGS.has(slug)) {
    const effort = slug.endsWith('-instant') ? 'low'
      : slug.endsWith('-pro') ? 'max'
        : requestedEffort;
    return { model: `chatgpt-web/${slug}`, ...(effort ? { effort } : {}) };
  }
  if (slug === 'gpt-5-6-mini') return { model: 'chatgpt-web/gpt-5.6-sol-instant', effort: 'low' };
  if (slug === 'gpt-5-6-t-mini') return { model: 'chatgpt-web/gpt-5.6-sol', effort: 'medium' };
  if (slug === 'gpt-6-t-mini') return { model: 'chatgpt-web/gpt-6-sol', effort: 'medium' };
  if (slug === 'chatgpt_alpha_model_external_access_reserved_gate_12'
      || slug === 'chatgpt_alpha_model_external_access_reserved_gate_13') {
    return { model: 'chatgpt-web/gpt-6-sol-instant', effort: 'low' };
  }
  if (slug === 'gpt-6' || slug === 'gpt-5-6' || slug.endsWith('-wm')) {
    const family = slug === 'gpt-5-6' || slug.startsWith('gpt-5.6-') ? 'gpt-5.6' : 'gpt-6';
    if (requestedEffort === 'low') return { model: `chatgpt-web/${family}-sol-instant`, effort: 'low' };
    if (requestedEffort === 'max' || requestedEffort === 'ultra') {
      return { model: `chatgpt-web/${family}-pro`, effort: 'max' };
    }
    const effort = ['medium', 'high', 'xhigh'].includes(requestedEffort) ? requestedEffort : 'high';
    return { model: `chatgpt-web/${family}-sol`, effort };
  }
  return null;
}

export function nativeRoute(model, requestedEffort) {
  const match = /^native\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._-]+)$/.exec(model);
  if (!match) return null;
  const [, profile, slug] = match;
  const target = resolveDaemonTarget(slug, requestedEffort);
  return {
    profile,
    slug,
    model: target?.model ?? `chatgpt-web/${slug}`,
    daemonSupported: target !== null,
    ...(target?.effort ? { effort: target.effort } : {}),
  };
}

export function accountCapabilities(catalogue) {
  const slugs = new Set((catalogue?.models ?? []).map(row => row.slug));
  const solAvailable = [...slugs].some(slug => /^(gpt-6|gpt-5-6|gpt-5\.6)(?!.*mini)/.test(slug));
  return { solAvailable,
    proAvailable: [...slugs].some(slug => /(?:^|-)pro(?:-|$)/.test(slug)),
    extraHighAvailable: solAvailable || (catalogue?.models ?? []).some(row => row.supported_reasoning_levels?.some(level => (level.effort ?? level) === 'xhigh')) };
}
