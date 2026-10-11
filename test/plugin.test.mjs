import test from 'node:test';
import assert from 'node:assert/strict';

const plugin = await import('../src/index.mjs').catch(() => ({}));

test('provider maps the recorded catalogue to complete host model entries', async () => {
  assert.equal(typeof plugin.default?.server, 'function', 'plugin entry must expose the host factory');
  const titles = ['GPT-5.5', 'GPT-5.6 Luna', 'GPT-5.3 Mini', 'GPT-5.5 Mini', 'GPT-5.6 Luna', 'GPT-6', 'GPT-6', 'Auto'];
  const slugs = ['gpt-5-5', 'gpt-5-6', 'gpt-5-3-mini', 'gpt-5-5-mini', 'gpt-5-6-mini', 'gpt-6', 'gpt-6-mini', 'auto'];
  const catalogue = { models: slugs.map((slug, index) => ({ slug, title: titles[index], max_tokens: 34834 })) };
  const hooks = plugin._internal.createHooks({ bridge: { call: async () => catalogue }, profileRoot: '.' });
  const models = await hooks.provider.models({}, { auth: { type: 'oauth', refresh: crypto.randomUUID() } });
  assert.deepEqual(Object.keys(models), ['auto', ...slugs.slice(0, -1)]);
  for (const [index, slug] of slugs.entries()) {
    const name = ['gpt-5-6-mini', 'gpt-6-mini'].includes(slug) ? `${titles[index]} (${slug})` : titles[index];
    assert.deepEqual(models[slug], {
      name, api: { id: slug, url: 'https://chatgpt-web.invalid/v1', npm: '@ai-sdk/anthropic' },
      limit: { context: 200000, output: 34834 },
      capabilities: { reasoning: false, toolcall: true, attachment: false, temperature: false, input: { text: true, image: false }, output: { text: true } },
    });
  }
});

test('unauthenticated models preserve static config and failures remain loud', async () => {
  const { BackendError } = await import('../backend/guard.mjs');
  const hooks = plugin._internal.createHooks({ bridge: { call: async () => { throw new BackendError('expired'); } }, profileRoot: '.' });
  const config = {};
  await hooks.config(config);
  const provider = config.provider['chatgpt-web'];
  assert.equal(await hooks.provider.models(provider), provider.models);
  await assert.rejects(hooks.provider.models(provider, { auth: { type: 'oauth', refresh: crypto.randomUUID() } }), error => error.signIn === 'expired');
  const broken = plugin._internal.createHooks({ bridge: { call: async () => { throw new BackendError('upstream'); } }, profileRoot: '.' });
  await assert.rejects(broken.provider.models(provider, { auth: { type: 'oauth', refresh: crypto.randomUUID() } }), error => error.status === 502);
});

test('refresh returns only changed fields and advertises a 24 hour lead', async () => {
  const changed = { access: crypto.randomUUID(), expires: Date.now() + 10 * 86400000 };
  let command;
  const hooks = plugin._internal.createHooks({ bridge: { call: async value => { command = value; return changed; } }, profileRoot: '.' });
  const auth = { type: 'oauth', refresh: crypto.randomUUID(), access: crypto.randomUUID(), expires: Date.now() - 1, profile: 'fixture', accountId: 'fixture', persona: 'chatgpt-paid' };
  assert.deepEqual(await hooks.auth.refresh(auth), changed);
  assert.deepEqual(command, { method: 'session', auth });
  assert.equal(hooks.auth.refreshLead, 86400000);
});

test('HTTP caller delivers a sanitized expired sign-in header', async () => {
  const { BackendError } = await import('../backend/guard.mjs');
  const marker = crypto.randomUUID();
  const failure = new BackendError('expired');
  failure.retryAfter = marker;
  const hooks = plugin._internal.createHooks({ bridge: { call: async () => { throw failure; } }, profileRoot: '.' });
  const loader = await hooks.auth.loader(async () => ({ type: 'oauth', refresh: crypto.randomUUID() }));
  const response = await loader.fetch('https://chatgpt-web.invalid/v1/messages', {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-magpie-sign-in'), 'expired');
  assert.equal(JSON.stringify([...response.headers]).includes(marker), false);
  assert.equal((await response.text()).includes(marker), false);
});
