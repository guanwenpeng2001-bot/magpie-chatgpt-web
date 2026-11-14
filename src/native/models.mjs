// v6.1.18 chatgpt-web-models.ts automatic-mode measured transport limits.
export function nativeOptions(value = {}) {
  for (const key of ['experimentalBiggerContext', 'useTemporaryChats']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new TypeError(`Invalid native option: ${key}`);
  }
  return { experimentalBiggerContext: value.experimentalBiggerContext === true, useTemporaryChats: value.useTemporaryChats !== false };
}

export function providerNativeOptions(input) {
  return nativeOptions({
    experimentalBiggerContext: input?.magpie?.option?.('chatgpt-web', 'native-bigger-context'),
    useTemporaryChats: input?.magpie?.option?.('chatgpt-web', 'native-temporary-chats'),
  });
}
// /v1/models first forwards to the Codex upstream and needs a separate Codex
// credential. These browser-only rows require only the account capabilities.
export function nativeCatalog(capabilities = {}) {
  const solAvailable = capabilities?.solAvailable === true;
  const proAvailable = capabilities?.proAvailable === true;
  const extraHighAvailable = capabilities?.extraHighAvailable === true;
  const row = (slug, context, autoCompact, efforts) => {
    // Live 275K retention failed with both original and Pro-only staging.
    // Keep Pro at its baseline transport/compaction budget until revalidated.
    if (capabilities.experimentalBiggerContext === true && slug !== 'gpt-6-sol-instant' && !slug.endsWith('-pro')) {
      if (slug === 'gpt-5.6-luna') { context = 84000; autoCompact = 59424; }
      // All fragments arrived in the Pro-capable account stress runs, but
      // only 7/12 (GPT-6) and 4/12 (GPT-5.6) markers survived compaction.
      // Baseline is a conservative fallback,
      // not a newly measured retention capacity. Leave other tiers unchanged.
      else if (slug === 'gpt-6-sol') { if (!proAvailable) { context = 120000; autoCompact = 110000; } }
      else if (!(proAvailable && slug === 'gpt-5.6-sol')) { context *= 3; autoCompact *= 3; }
    }
    return { slug: `chatgpt-web/${slug}`, display_name: slug,
    context_window: context, auto_compact_token_limit: autoCompact,
    supported_reasoning_levels: efforts.map(effort => ({ effort })), input_modalities: ['text', 'image'] };
  };
  if (!solAvailable) return [row('gpt-5.6-luna', 1050000, 1050000, ['low', 'medium'])];
  return ['gpt-6', 'gpt-5.6'].flatMap(family => [
    row(`${family}-sol-instant`, proAvailable ? 111193 : 41000, proAvailable ? 95000 : 32000, ['low']),
    row(`${family}-sol`, proAvailable ? 111193 : 90000, proAvailable ? 95000 : 80000, ['medium', 'high', ...(extraHighAvailable ? ['xhigh'] : [])]),
    ...(proAvailable ? [row(`${family}-pro`, 112193, 95000, ['max'])] : []),
  ]);
}

// Codex compacts at 90% of a model's window when the catalog names no
// threshold, and a plugin cannot name one through Magpie. Publishing the
// window whose 90% is the reference's measured auto-compact limit makes Codex
// compact where the reference does, never above the real window.
const CODEX_COMPACT_RATIO = 0.9;
export function publishedWindow(row) {
  const auto = Number.isSafeInteger(row.auto_compact_token_limit) ? row.auto_compact_token_limit : row.context_window;
  return Math.min(row.context_window, Math.ceil(auto / CODEX_COMPACT_RATIO));
}

function coreFamily(slug) {
  return slug === 'gpt-6' ? 'gpt-6' : slug === 'gpt-5-6' ? 'gpt-5.6' : null;
}

function nativeDescriptor(id, name, rows) {
  const image = rows.every(row => row.input_modalities?.includes('image'));
  return {
    name: `${name} (Native tools)`, npm: '@ai-sdk/openai',
    provider: { npm: '@ai-sdk/openai', api: 'http://127.0.0.1:1/v1' },
    api: { id, npm: '@ai-sdk/openai', url: 'http://127.0.0.1:1/v1' },
    // Core aliases group Instant, reasoning and Pro. The published limit must
    // fit every advertised effort, including the smallest Instant window.
    limit: { context: Math.min(...rows.map(publishedWindow)), output: 0 },
    prefer_websockets: false,
    capabilities: { reasoning: true, toolcall: true, attachment: image, temperature: false,
      input: { text: true, image }, output: { text: true } },
    variants: Object.fromEntries(rows.flatMap(row => row.supported_reasoning_levels.map(({ effort }) => [effort, {}]))),
  };
}

export function describeNativeCatalogue(source, profile, capabilities = {}) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) return {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const available = nativeCatalog(capabilities);
    const descriptors = Object.fromEntries(Object.entries(source).filter(([slug, model]) => /^[A-Za-z0-9._-]+$/.test(slug) && model && typeof model === 'object').map(([slug, model]) => {
      const id = `native/${profile}/${slug}`;
      const unavailable = String(model.name ?? '').includes('[not yet supported]') || slug === 'chatgpt-image';
      const family = coreFamily(slug);
      const rows = unavailable ? [] : available.filter(row => family
        ? [`chatgpt-web/${family}-sol-instant`, `chatgpt-web/${family}-sol`, `chatgpt-web/${family}-pro`].includes(row.slug)
        : row.slug === `chatgpt-web/${slug}`);
      if (rows.length) return [id, nativeDescriptor(id, model.name ?? slug, rows)];
      // Keep the exact text model's limits, variants and modalities. A Native
      // namespace entry alone is not evidence that the daemon can serve it.
      return [id, {
        ...structuredClone(model),
        name: `${model.name ?? slug} (${unavailable ? 'Native unavailable' : 'Text fallback'})`,
        npm: '@ai-sdk/openai',
        provider: { npm: '@ai-sdk/openai', api: 'http://127.0.0.1:1/v1' },
        api: { id, npm: '@ai-sdk/openai', url: 'http://127.0.0.1:1/v1' },
        prefer_websockets: false,
        capabilities: {
          ...structuredClone(model.capabilities ?? {}),
          toolcall: false,
          temperature: false,
        },
      }];
    }));
    // Pro is a stable model selection, independent of the experimental window.
    // Core aliases retain their Instant-safe limit; Bigger additionally exposes
    // dedicated reasoning routes without replacing any existing model identity.
    if (capabilities.solAvailable === true) {
      const bigger = capabilities.experimentalBiggerContext === true;
      for (const row of available.filter(row => row.slug.endsWith('-pro') || bigger && row.slug.endsWith('-sol'))) {
        const slug = row.slug.slice('chatgpt-web/'.length);
        const id = `native/${profile}/${slug}`;
        if (!Object.hasOwn(descriptors, id)) {
          const baseline = nativeCatalog({ ...capabilities, experimentalBiggerContext: false }).find(item => item.slug === row.slug);
          const expanded = bigger && baseline && publishedWindow(row) > publishedWindow(baseline);
          descriptors[id] = nativeDescriptor(id, `${row.display_name}${expanded ? ' — Bigger Context' : ''}`, [row]);
        }
      }
    }
    return descriptors;
  }
  const rows = Array.isArray(source) ? source : [];
  return Object.fromEntries(rows.filter(row => typeof row?.slug === 'string' && row.slug.startsWith('chatgpt-web/')
    && DIRECT_DAEMON_SLUGS.has(row.slug.slice('chatgpt-web/'.length))
    && Number.isSafeInteger(row.context_window) && row.context_window > 0).map(row => {
    const id = `native/${profile}/${row.slug.slice('chatgpt-web/'.length)}`;
    return [id, nativeDescriptor(id, row.display_name, [row])];
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
  const family = coreFamily(slug);
  if (family) {
    if (requestedEffort === 'low') return { model: `chatgpt-web/${family}-sol-instant`, effort: 'low' };
    if (requestedEffort === 'max') {
      return { model: `chatgpt-web/${family}-pro`, effort: 'max' };
    }
    const effort = requestedEffort ?? 'high';
    if (!['medium', 'high', 'xhigh'].includes(effort)) return null;
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
  // Work and mini catalogs expose different selectors. Their names and effort
  // lists cannot establish access to ordinary Sol, Pro or Extra High.
  const rows = (Array.isArray(catalogue?.models) ? catalogue.models : []).filter(row =>
    /^(?:chatgpt-web\/)?(?:gpt-6|gpt-5-6|gpt-5\.6)(?:-(?:sol(?:-instant)?|instant|thinking|high|extra-high|pro))?$/.test(row?.slug));
  const hasEffort = effort => rows.some(row => Array.isArray(row.supported_reasoning_levels)
    && row.supported_reasoning_levels.some(level => (level?.effort ?? level) === effort));
  return { solAvailable: rows.length > 0,
    proAvailable: rows.some(row => row.slug.endsWith('-pro')) || hasEffort('max'),
    extraHighAvailable: rows.some(row => row.slug.endsWith('-extra-high')) || hasEffort('xhigh') };
}
