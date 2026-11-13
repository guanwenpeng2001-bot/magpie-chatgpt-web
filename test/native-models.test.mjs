import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountCapabilities, describeNativeCatalogue, nativeCatalog, nativeRoute } from '../src/native/models.mjs';
import { nativeClient } from '../src/native/index.mjs';
import { describeCatalogue } from '../src/models.mjs';
import { toTextRequest } from '../src/native/fallback.mjs';
import { workModels, wireModels } from '../backend/site-adapter/compatibility.mjs';

const profile = 'model-test';
const id = slug => `native/${profile}/${slug}`;
const core = describeCatalogue({ models: [{ slug: 'gpt-6', title: 'GPT-6' }, { slug: 'gpt-5-6', title: 'GPT-5.6 Sol' }] });

test('catalog entries select OpenAI in Magpie config as well as normalized provider models', () => {
  const expectedProvider = { npm: '@ai-sdk/openai', api: 'http://127.0.0.1:1/v1' };
  const text = describeCatalogue({ models: [
    { slug: 'gpt-6', title: 'GPT-6' },
    { slug: 'gpt-6.1-sol-wm', title: 'GPT-6.1 Sol' },
    { slug: 'gpt-5-6-mini', title: 'Mini' },
    { slug: 'research', title: 'Research', enabled_tools: ['image_gen_tool_enabled'] },
  ] });
  const parentProvider = { npm: '@ai-sdk/anthropic', api: 'https://chatgpt.com/backend-api' };
  for (const model of Object.values(text)) model.provider = { ...parentProvider };
  const before = structuredClone(text);
  for (const catalog of [
    describeNativeCatalogue(text, profile, { solAvailable: true }),
    describeNativeCatalogue(text, profile),
    describeNativeCatalogue(nativeCatalog({ solAvailable: true, proAvailable: true }), profile),
    describeNativeCatalogue(nativeCatalog(), profile),
  ]) {
    const cfg = JSON.parse(JSON.stringify({ ...parentProvider, models: catalog }));
    for (const [key, model] of Object.entries(cfg.models)) {
      assert.deepEqual(model.provider, expectedProvider, key);
      // Magpie internal/plugin/host.js reads m.provider before cfg; top-level
      // m.npm and normalized m.api do not select the transport in config.
      const configuredApi = { id: model.id ?? key,
        npm: model.provider?.npm ?? cfg.npm, url: model.provider?.api ?? cfg.api };
      assert.deepEqual(configuredApi, { id: key, npm: expectedProvider.npm, url: expectedProvider.api });
      assert.deepEqual(model.api, configuredApi);
    }
  }
  assert.deepEqual(text, before);
});

test('every Work, mini and gate request keeps its exact slug through text fallback at every effort', () => {
  for (const slug of [...Object.keys(workModels), ...Object.keys(wireModels), 'gpt-6-mini', 'research', 'chatgpt-image', 'future-wm']) {
    for (const effort of [undefined, 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      assert.deepEqual(nativeRoute(id(slug), effort), {
        profile, slug, model: `chatgpt-web/${slug}`, daemonSupported: false,
      }, `${slug}/${effort}`);
      const request = toTextRequest({ model: id(slug), input: 'hello', reasoning: { effort } });
      assert.equal(request.model, slug);
      assert.equal(request.reasoning_effort, effort);
    }
  }
});

test('only exact core aliases and reference direct routes select the native daemon', () => {
  for (const [slug, family] of [['gpt-6', 'gpt-6'], ['gpt-5-6', 'gpt-5.6']]) {
    for (const [effort, suffix] of [['low', 'sol-instant'], ['medium', 'sol'], ['high', 'sol'], ['xhigh', 'sol'], ['max', 'pro']]) {
      assert.deepEqual(nativeRoute(id(slug), effort), {
        profile, slug, model: `chatgpt-web/${family}-${suffix}`, daemonSupported: true, effort,
      });
    }
    assert.equal(nativeRoute(id(slug)).effort, 'high');
    assert.equal(nativeRoute(id(slug), 'ultra').daemonSupported, false);
    assert.equal(nativeRoute(id(slug), 'unknown').daemonSupported, false);
  }
  for (const row of [...nativeCatalog({ solAvailable: true, proAvailable: true }), ...nativeCatalog()]) {
    const slug = row.slug.slice('chatgpt-web/'.length);
    const route = nativeRoute(id(slug));
    assert.equal(route.daemonSupported, true);
    assert.equal(route.model, row.slug);
  }
  for (const slug of ['gpt-6.1', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5-6-pro', 'gpt-6-sol-wm-ultra']) {
    assert.equal(nativeRoute(id(slug)).daemonSupported, false, slug);
  }
  for (const model of ['gpt-6', 'native/../gpt-6', 'native/a/chatgpt-web/gpt-6', 'native//gpt-6']) assert.equal(nativeRoute(model), null);
});

test('reference standard windows and efforts are gated independently by explicit account capabilities', () => {
  for (const proAvailable of [false, true]) for (const extraHighAvailable of [false, true]) {
    const rows = nativeCatalog({ solAvailable: true, proAvailable, extraHighAvailable, experimentalBiggerContext: true });
    assert.equal(rows.length, proAvailable ? 6 : 4);
    for (const family of ['gpt-6', 'gpt-5.6']) {
      const row = suffix => rows.find(model => model.slug === `chatgpt-web/${family}-${suffix}`);
      assert.equal(row('sol-instant').context_window, proAvailable ? 111193 : 41000);
      assert.equal(row('sol').context_window, proAvailable ? 111193 : 90000);
      assert.deepEqual(row('sol').supported_reasoning_levels.map(level => level.effort), ['medium', 'high', ...(extraHighAvailable ? ['xhigh'] : [])]);
      if (proAvailable) {
        assert.equal(row('pro').context_window, 112193);
        assert.deepEqual(row('pro').supported_reasoning_levels, [{ effort: 'max' }]);
      } else assert.equal(row('pro'), undefined);
    }
  }
  assert.deepEqual(nativeCatalog({ solAvailable: false, proAvailable: true, extraHighAvailable: true }), nativeCatalog());
  assert.deepEqual(nativeCatalog({ solAvailable: 'true', proAvailable: 'true', extraHighAvailable: 'true' }), nativeCatalog());
});

test('aligned core descriptors use the smallest reference limit across their available efforts', () => {
  const before = structuredClone(core);
  for (const proAvailable of [false, true]) for (const extraHighAvailable of [false, true]) {
    const capabilities = { solAvailable: true, proAvailable, extraHighAvailable };
    const models = describeNativeCatalogue(core, profile, capabilities);
    for (const slug of Object.keys(core)) {
      const descriptor = models[id(slug)];
      assert.match(descriptor.name, /\(Native tools\)$/);
      assert.deepEqual(Object.keys(descriptor.variants), ['low', 'medium', 'high', ...(extraHighAvailable ? ['xhigh'] : []), ...(proAvailable ? ['max'] : [])]);
      assert.equal(descriptor.limit.context, proAvailable ? 111193 : 41000);
      assert.equal(descriptor.limit.output, 0);
      assert.equal(descriptor.capabilities.toolcall, true);
      assert.equal(descriptor.capabilities.reasoning, true);
      for (const effort of Object.keys(descriptor.variants)) {
        const route = nativeRoute(id(slug), effort);
        const reference = nativeCatalog(capabilities).find(row => row.slug === route.model);
        assert.ok(reference.supported_reasoning_levels.some(level => level.effort === route.effort));
        assert.ok(descriptor.limit.context <= reference.context_window);
      }
    }
  }
  assert.deepEqual(core, before);
});

test('fallback descriptors retain text limits and variants without promising native tools', () => {
  const base = describeCatalogue({ models: [
    { slug: 'gpt-6.1-sol-wm', title: 'GPT-6.1 Sol' },
    { slug: 'gpt-5-6-mini', title: 'Mini' },
    { slug: 'research', title: 'Deep Research', enabled_tools: ['image_gen_tool_enabled'] },
  ] });
  const models = describeNativeCatalogue(base, profile, { solAvailable: true, proAvailable: true, extraHighAvailable: true });
  for (const slug of ['gpt-6.1-sol-wm', 'gpt-5-6-mini']) {
    assert.equal(models[id(slug)].name, `${base[slug].name} (Text fallback)`);
    assert.deepEqual(models[id(slug)].limit, base[slug].limit);
    assert.deepEqual(models[id(slug)].variants, base[slug].variants);
    assert.equal(models[id(slug)].capabilities.toolcall, false);
  }
  for (const slug of ['research', 'chatgpt-image']) {
    assert.match(models[id(slug)].name, /\(Native unavailable\)$/);
    assert.equal(models[id(slug)].capabilities.toolcall, false);
  }
  models[id('gpt-6.1-sol-wm')].variants.ultra.changed = true;
  models[id('gpt-5-6-mini')].limit.context = 1;
  assert.deepEqual(base['gpt-6.1-sol-wm'].variants.ultra, {});
  assert.notEqual(base['gpt-5-6-mini'].limit.context, 1);
});

test('missing or Luna-only native capabilities never advertise core native tools', () => {
  for (const capabilities of [undefined, {}, { solAvailable: false, proAvailable: true, extraHighAvailable: true }]) {
    const models = describeNativeCatalogue(core, profile, capabilities);
    for (const slug of Object.keys(core)) {
      assert.equal(models[id(slug)].name, `${core[slug].name} (Text fallback)`);
      assert.equal(models[id(slug)].capabilities.toolcall, false);
      assert.deepEqual(models[id(slug)].limit, core[slug].limit);
    }
  }
});

test('direct catalog arrays cannot advertise arbitrary slugs as native routes', () => {
  const reference = nativeCatalog({ solAvailable: true })[0];
  assert.deepEqual(describeNativeCatalogue([{ ...reference, slug: 'chatgpt-web/gpt-6.1-sol-wm' }], profile), {});
});

test('capability discovery requires ordinary model evidence and never infers Extra High from Sol', () => {
  const none = { solAvailable: false, proAvailable: false, extraHighAvailable: false };
  assert.deepEqual(accountCapabilities(), none);
  assert.deepEqual(accountCapabilities({ models: [
    { slug: 'gpt-6.1-sol-wm', supported_reasoning_levels: ['xhigh', 'max'] },
    { slug: 'gpt-5-6-t-mini' }, { slug: 'gpt-6-pro-wm' }, { slug: 'gpt-60' },
  ] }), none);
  assert.deepEqual(accountCapabilities({ models: [{ slug: 'gpt-6' }] }), { ...none, solAvailable: true });
  assert.deepEqual(accountCapabilities({ models: [{ slug: 'gpt-5-6-pro' }] }), { ...none, solAvailable: true, proAvailable: true });
  assert.deepEqual(accountCapabilities({ models: [{ slug: 'gpt-6-extra-high' }] }), { ...none, solAvailable: true, extraHighAvailable: true });
  assert.deepEqual(accountCapabilities({ models: [{ slug: 'gpt-6', supported_reasoning_levels: [{ effort: 'xhigh' }, 'max'] }] }), {
    solAvailable: true, proAvailable: true, extraHighAvailable: true,
  });
});

test('catalog loads capabilities from each saved native account without starting the daemon', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-model-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = nativeClient({ root, bridge: { call: () => assert.fail('catalog must not start a runtime') } });
  const cases = [
    ['plus', { solAvailable: true }, ['low', 'medium', 'high'], 41000],
    ['pro', { solAvailable: true, proAvailable: true }, ['low', 'medium', 'high', 'max'], 111193],
    ['xhigh', { solAvailable: true, extraHighAvailable: true }, ['low', 'medium', 'high', 'xhigh'], 41000],
    ['legacy', undefined, undefined, 90000],
  ];
  for (const [savedProfile, capabilities, efforts, context] of cases) {
    const home = join(root, 'accounts', savedProfile);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'native.json'), JSON.stringify({ profile: savedProfile, connectorId: 'c1', linkId: 'l1', capabilities }));
    const models = await client.models({ profile: savedProfile, capabilities: { solAvailable: true, proAvailable: true, extraHighAvailable: true } }, core);
    const descriptor = models[`native/${savedProfile}/gpt-6`];
    assert.equal(descriptor.limit.context, context);
    assert.equal(descriptor.capabilities.toolcall, !!efforts);
    if (efforts) assert.deepEqual(Object.keys(descriptor.variants), efforts);
    else assert.match(descriptor.name, /Text fallback/);
  }
  assert.deepEqual(await client.models({ profile: 'not-provisioned' }, core), {});
});
