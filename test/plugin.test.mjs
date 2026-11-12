import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatGptWebContextLimit } from '../src/usage/context.mjs';

const plugin = await import('../src/index.mjs').catch(() => ({}));

test('provider maps the recorded catalogue to complete host model entries', async () => {
  assert.equal(typeof plugin.default?.server, 'function', 'plugin entry must expose the host factory');
  const titles = ['GPT-5.5', 'GPT-5.6 Luna', 'GPT-5.3 Mini', 'GPT-5.5 Mini', 'GPT-5.6 Luna', 'GPT-6', 'GPT-6', 'Auto'];
  const slugs = ['gpt-5-5', 'gpt-5-6', 'gpt-5-3-mini', 'gpt-5-5-mini', 'gpt-5-6-mini', 'gpt-6', 'gpt-6-mini', 'auto'];
  const catalogue = { models: slugs.map((slug, index) => ({ slug, title: titles[index], max_tokens: 34834 })) };
  const hooks = plugin._internal.createHooks({ bridge: { call: async () => catalogue }, profileRoot: '.' });
  const models = await hooks.provider.models({}, { auth: { type: 'oauth', refresh: crypto.randomUUID() } });
  assert.equal(Object.keys(models)[0], 'auto');
  for (const [index, slug] of slugs.entries()) {
    const name = slug === 'gpt-5-6-mini' ? 'GPT-5.6 Luna (mini)'
      : slug === 'gpt-6-mini' ? `${titles[index]} (${slug}) [not yet supported]`
        : titles[index];
    const reasoning = slug === 'gpt-5-6' || slug === 'gpt-6';
    const expected = {
      name, api: { id: slug },
      limit: { context: resolveChatGptWebContextLimit(slug).limit, output: 34834 },
      prefer_websockets: false,
      capabilities: { reasoning, toolcall: false, attachment: false, temperature: false, input: { text: true, image: false }, output: { text: true } },
      ...(reasoning ? { variants: {
        low: {}, medium: {}, high: {}, xhigh: {}, max: {},
      } } : {}),
    };
    assert.deepEqual(models[slug], expected);
  }
  assert.equal(Object.hasOwn(models, 'gpt-5-6-high'), false);
  assert.equal(Object.hasOwn(models, 'gpt-6-extra-high'), false);
});

test('effort aliases collapse into variants while other catalogue rows remain exposed', async () => {
  const catalogue = { models: [{ slug: 'gpt-5-6', title: 'GPT-5.6 Luna' }, { slug: 'gpt-6-mini', title: 'GPT-6' }] };
  const hooks = plugin._internal.createHooks({ bridge: { call: async () => catalogue }, profileRoot: '.' });
  assert.deepEqual(Object.keys(await hooks.provider.models({}, { auth: { type: 'oauth', refresh: crypto.randomUUID() } })), [
    'gpt-5-6', 'gpt-6-mini',
  ]);
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
  assert.equal((await broken.provider.models(provider, { auth: { type: 'oauth', refresh: crypto.randomUUID() } }))[Symbol.for('magpie.fellBack')], true);
});

test('refresh returns only changed fields and advertises a 24 hour lead', async () => {
  const changed = { access: crypto.randomUUID(), expires: Date.now() + 10 * 86400000 };
  let command;
  const hooks = plugin._internal.createHooks({ bridge: { call: async value => { command = value; return changed; } }, profileRoot: '.' });
  const auth = { type: 'oauth', refresh: crypto.randomUUID(), access: crypto.randomUUID(), expires: Date.now() - 1, profile: 'fixture', accountId: 'fixture', persona: 'chatgpt-paid' };
  assert.deepEqual(await hooks.auth.refresh(auth), changed);
  assert.ok(command.method === 'session' && command.auth === auth && command.profileRoot === '.', 'refresh forwards auth and the browser profile root');
  assert.equal(hooks.auth.refreshLead, 86400000);
});

test('HTTP caller delivers a sanitized expired sign-in header', async () => {
  const { BackendError } = await import('../backend/guard.mjs');
  const marker = crypto.randomUUID();
  const failure = new BackendError('expired');
  failure.retryAfter = marker;
  const hooks = plugin._internal.createHooks({ bridge: { open: async () => { throw failure; } }, profileRoot: '.' });
  const loader = await hooks.auth.loader(async () => ({ type: 'oauth', refresh: crypto.randomUUID() }));
  const response = await loader.fetch('https://chatgpt-web.invalid/v1/messages', { body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'fixture' }] }) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-magpie-sign-in'), 'expired');
  assert.equal(JSON.stringify([...response.headers]).includes(marker), false);
  assert.equal((await response.text()).includes(marker), false);
});
