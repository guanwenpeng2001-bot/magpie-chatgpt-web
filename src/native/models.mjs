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

export function describeNativeCatalogue(rows, profile) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) return {};
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

export function nativeRoute(model) {
  const match = /^native\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._-]+)$/.exec(model);
  return match ? { profile: match[1], slug: match[2], model: `chatgpt-web/${match[2]}` } : null;
}

export function accountCapabilities(catalogue) {
  const slugs = new Set((catalogue?.models ?? []).map(row => row.slug));
  return { solAvailable: [...slugs].some(slug => /^(gpt-6|gpt-5-6|gpt-5\.6)(?!.*mini)/.test(slug)),
    proAvailable: [...slugs].some(slug => /(?:^|-)pro(?:-|$)/.test(slug)),
    // No inference from subscription: expose Extra High only after an explicit catalog observation.
    extraHighAvailable: (catalogue?.models ?? []).some(row => row.supported_reasoning_levels?.some(level => (level.effort ?? level) === 'xhigh')) };
}
