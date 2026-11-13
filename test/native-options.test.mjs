import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeCatalog, publishedWindow, nativeOptions, providerNativeOptions, describeNativeCatalogue, nativeRoute } from '../src/native/models.mjs';
import { nativeClient, ensureNative, stopNative } from '../src/native/index.mjs';
import { NativeDaemon } from '../src/native/daemon.mjs';
import { authHook } from '../src/hooks/auth.mjs';
import { providerHook } from '../src/hooks/provider.mjs';

const standard = { experimentalBiggerContext: false, useTemporaryChats: true };
const bigger = { experimentalBiggerContext: true, useTemporaryChats: false };
const credentials = { tunnelId: 'fixture', runtimeKey: 'fixture', connectorId: 'c', linkId: 'l' };
async function rootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-options-'));
  t.after(async () => { await stopNative(); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('provider boolean defaults and ordinary-chat retention are explicit', () => {
  assert.deepEqual(nativeOptions(), standard);
  assert.deepEqual(providerNativeOptions(), standard);
  for (const key of Object.keys(standard)) assert.throws(() => nativeOptions({ [key]: 'false' }), TypeError);
  const options = authHook({}).options;
  assert.equal(options.find(row => row.key === 'native-bigger-context').default, false);
  const temporary = options.find(row => row.key === 'native-temporary-chats');
  assert.equal(temporary.default, true);
  for (const key of ['native-bigger-context', 'native-temporary-chats']) assert.match(options.find(row => row.key === key).description, /Takes effect after restarting Magpie \/ 重启 Magpie 后生效/);
  assert.match(temporary.description, /Turn off to save ordinary chats in ChatGPT history/);
});

test('Bigger Context preserves existing Sol/Luna budgets and guards Pro at baseline for every capability tier', () => {
  for (const proAvailable of [false, true]) for (const extraHighAvailable of [false, true]) {
    const rows = nativeCatalog({ solAvailable: true, proAvailable, extraHighAvailable, experimentalBiggerContext: true });
    const expected = {
      'gpt-6-sol-instant': proAvailable ? [111193, 95000] : [41000, 32000],
      'gpt-6-sol': proAvailable ? [240000, 220000] : [120000, 110000],
      'gpt-5.6-sol-instant': proAvailable ? [333579, 285000] : [123000, 96000],
      'gpt-5.6-sol': proAvailable ? [333579, 285000] : [270000, 240000],
      ...(proAvailable ? { 'gpt-6-pro': [112193, 95000], 'gpt-5.6-pro': [112193, 95000] } : {}),
    };
    assert.equal(rows.length, Object.keys(expected).length);
    for (const row of rows) {
      assert.deepEqual([row.context_window, row.auto_compact_token_limit], expected[row.slug.slice(12)]);
      assert.ok(publishedWindow(row) <= row.context_window);
      assert.ok(Math.floor(publishedWindow(row) * 0.9) <= row.auto_compact_token_limit);
      if (row.slug.endsWith('-sol')) assert.equal(row.supported_reasoning_levels.some(x => x.effort === 'xhigh'), extraHighAvailable);
    }
  }
  const [luna] = nativeCatalog({ experimentalBiggerContext: true });
  assert.deepEqual([luna.context_window, luna.auto_compact_token_limit, publishedWindow(luna)], [84000, 59424, 66027]);
});

test('native client sends live settings on provision, runtime and site capabilities; effective catalogue wins', async t => {
  const root = await rootFor(t), profile = 'client';
  const home = join(root, 'accounts', profile);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'native.json'), JSON.stringify({ ...credentials, profile, capabilities: { solAvailable: true } }));
  let settings = standard;
  let effective = standard;
  const commands = [];
  const input = { magpie: { option: (_provider, key) => key === 'native-bigger-context' ? settings.experimentalBiggerContext : key === 'native-temporary-chats' ? settings.useTemporaryChats : true } };
  const bridge = { async call(command) {
    commands.push(command);
    if (command.method === 'models') return { models: [{ slug: 'gpt-5-6', title: 'Sol' }], nativeCapabilities: { solAvailable: true, ...effective } };
    return null;
  } };
  const client = nativeClient({ root, bridge, input });
  await client.provision({ profile });
  settings = bigger;
  await client.runtime({ profile });
  const models = await client.models({ profile }, { 'gpt-5-6': { name: 'Sol' } });
  assert.deepEqual(commands.map(x => [x.method, x.nativeOptions]), [['nativeProvision', standard], ['nativeRuntime', bigger], ['models', bigger]]);
  assert.equal(models['native/client/gpt-5-6'].limit.context, 35556);
  commands.length = 0;
  await providerHook({ bridge, native: client, input }).models({}, { auth: { profile, type: 'oauth', refresh: 'fixture' } });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].nativeOptions, bigger);
  effective = bigger; // restarted daemon; now disable in UI without restarting
  settings = standard;
  const stillBigger = await client.models({ profile }, { 'gpt-5-6': { name: 'Sol' } });
  assert.ok(stillBigger['native/client/gpt-6-sol']);
  assert.equal(stillBigger['native/client/gpt-6-sol'].limit.context, 120000);
  effective = standard;
  const restarted = await client.models({ profile }, { 'gpt-5-6': { name: 'Sol' } });
  assert.equal(restarted['native/client/gpt-6-sol'], undefined);
  settings = bigger;
  const legacy = await client.models({ profile }, { 'gpt-5-6': { name: 'Sol' } }, { models: [{ slug: 'gpt-5-6' }] });
  assert.equal(legacy['native/client/gpt-6-sol'], undefined);
  assert.equal(legacy['native/client/gpt-5-6'].limit.context, 35556);
});

test('different pending options serialize, remain deferred on the live owner, persist across stop and cancel safely', async t => {
  const root = await rootFor(t);
  const account = { profile: 'pending', chromeExecutablePath: 'fixture', capabilities: { solAvailable: true }, context: { storageState: async () => ({}) } };
  let releaseInstall;
  const installed = new Promise(resolve => { releaseInstall = resolve; });
  let stopped = 0, creates = 0;
  const options = { root, nativeOptions: standard, install: () => installed,
    createDaemon: settings => {
      creates++;
      return { config: settings.nativeOptions, browserEndpoint: undefined,
        configure(next) { this.next = next; }, descriptor() { return { capabilities: { ...settings.capabilities, ...this.config } }; },
        health: async () => true, start: async () => {}, stop: async () => { stopped++; } };
    }, provision: async () => credentials };
  const first = ensureNative(account, options);
  assert.equal(ensureNative(account, options), first);
  const changed = ensureNative(account, { ...options, provision: undefined, resumeOnly: true, nativeOptions: bigger });
  const controller = new AbortController();
  const cancelled = ensureNative(account, { ...options, catalogOnly: true, nativeOptions: standard, signal: controller.signal });
  controller.abort();
  releaseInstall({});
  const daemon = await first;
  assert.equal(await changed, daemon);
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(stopped, 0);
  assert.equal(creates, 1);
  assert.deepEqual(daemon.next, bigger);
  const state = await ensureNative(account, { root, catalogOnly: true, nativeOptions: bigger });
  assert.equal(state.capabilities.experimentalBiggerContext, false);
  const saved = JSON.parse(await readFile(join(root, 'accounts/pending/native.json'), 'utf8'));
  assert.deepEqual(saved.nativeOptions, bigger);
  await stopNative();
  const resumed = await ensureNative(account, { ...options, nativeOptions: undefined, provision: undefined, resumeOnly: true });
  assert.deepEqual(resumed.config, bigger);
  assert.equal(creates, 2);
  assert.equal(await ensureNative({ profile: 'other' }, { root, catalogOnly: true, nativeOptions: standard }), null);
});

test('daemon applies deferred config only on next launch, owns checkpoint home and retains account lease', async t => {
  const home = await rootFor(t);
  const children = [], calls = [];
  const spawn = (_file, args, options) => {
    calls.push({ args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => child.emit('exit', 0);
    if (args.includes('serve')) children.push(child);
    else queueMicrotask(() => { child.stdout.end(JSON.stringify(args[1] === 'list' ? { aliases: [] } : { process_running: true, healthy: true, ready: true })); child.emit('close', 0); });
    return child;
  };
  const options = { home, runtimeCommand: ['fixture'], tunnelBinary: 'fixture', storageState: async () => ({}), spawn,
    capabilities: { solAvailable: true }, env: { MAGPIE_NATIVE_CHECKPOINT_HOME: 'untrusted-external-home' },
    fetch: async url => {
      if (url.endsWith('/shutdown')) children.at(-1).emit('exit', 0);
      return Response.json(url.includes('/admin/') ? { status: 'ok' } : { service: 'codex-chatgpt-web', mode: 'full' });
    } };
  const daemon = new NativeDaemon(options);
  t.after(() => daemon.stop());
  await daemon.start(credentials);
  assert.equal(daemon.config.experimentalBiggerContext, false);
  assert.equal(daemon.config.useTemporaryChats, true);
  daemon.configure(bigger);
  await daemon.start(credentials);
  assert.equal(children.length, 1);
  assert.equal(daemon.descriptor().capabilities.experimentalBiggerContext, false);
  const contender = new NativeDaemon(options);
  await assert.rejects(contender.start(credentials), /startup failed/);
  await contender.stop();
  await daemon.restart();
  assert.equal(children.length, 2);
  assert.equal(daemon.config.experimentalBiggerContext, true);
  assert.equal(daemon.config.useTemporaryChats, false);
  await daemon.stop(); // Include shutdown tunnel cleanup in the isolation check.
  const serves = calls.filter(call => call.args.includes('serve'));
  const tunnelCommands = calls.filter(call => !call.args.includes('serve'));
  assert.equal(serves.length, 2);
  assert.ok(tunnelCommands.some(call => call.args.includes('connect')));
  assert.ok(tunnelCommands.some(call => call.args.includes('stop')));
  for (const call of serves) assert.equal(call.options.env.MAGPIE_NATIVE_CHECKPOINT_HOME, home);
  for (const call of tunnelCommands) {
    assert.equal(Object.hasOwn(call.options.env, 'MAGPIE_NATIVE_CHECKPOINT_HOME'), false, call.args.join(' '));
    assert.equal(call.options.env.CODEX_CHATGPT_WEB_HOME, home, 'tunnel retains its ordinary account configuration');
  }
  assert.equal(daemon.childEnv.MAGPIE_NATIVE_CHECKPOINT_HOME, home, 'filtering tunnel env must not mutate serve env');
  const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.equal(saved.useTemporaryChats, false);
});



test('Pro selectors keep guarded budgets and names across Bigger Context toggles while preserving 38/40 counts', () => {
  const source = Object.fromEntries(['gpt-6', 'gpt-5-6', ...Array.from({ length: 16 }, (_, i) => `fixture-${i}`)]
    .map(slug => [slug, { name: slug, limit: { context: 90000 }, variants: {} }]));
  for (const proAvailable of [false, true]) for (const extraHighAvailable of [false, true]) {
    const caps = { solAvailable: true, proAvailable, extraHighAvailable };
    const off = describeNativeCatalogue(source, 'counts', caps);
    const on = describeNativeCatalogue(source, 'counts', { ...caps, experimentalBiggerContext: true });
    assert.equal(Object.keys({ ...source, ...off }).length, proAvailable ? 38 : 36);
    assert.equal(Object.keys({ ...source, ...on }).length, proAvailable ? 40 : 38);
    assert.deepEqual(on['native/counts/gpt-6'], off['native/counts/gpt-6']);
    for (const key of Object.keys(off)) assert.ok(Object.hasOwn(on, key));
    const added = Object.keys(on).filter(key => !Object.hasOwn(off, key));
    for (const key of added) {
      assert.match(on[key].name, /Bigger Context/);
      assert.match(key, /-sol$/);
      assert.deepEqual(Object.keys(on[key].variants), ['medium', 'high', ...(extraHighAvailable ? ['xhigh'] : [])]);
      for (const effort of Object.keys(on[key].variants)) {
        const route = nativeRoute(key, effort);
        assert.equal(route.daemonSupported, true);
        assert.equal(route.model, `chatgpt-web/${key.split('/').at(-1)}`);
        assert.equal(route.effort, effort);
      }
    }
    assert.equal(on['native/counts/gpt-6-sol'].limit.context, proAvailable ? 240000 : 120000);
    for (const family of ['gpt-6', 'gpt-5.6']) {
      const key = `native/counts/${family}-pro`;
      if (proAvailable) {
        assert.equal(off[key].limit.context, 105556);
        assert.equal(on[key].limit.context, 105556);
        assert.doesNotMatch(off[key].name, /Bigger Context/);
        assert.doesNotMatch(on[key].name, /Bigger Context/);
        assert.deepEqual(on[key], off[key]);
        assert.deepEqual(Object.keys(off[key].variants), ['max']);
        assert.deepEqual(Object.keys(on[key].variants), ['max']);
        assert.equal(nativeRoute(key, 'high').effort, 'max');
      } else {
        assert.equal(off[key], undefined);
        assert.equal(on[key], undefined);
      }
    }
    assert.equal(on['native/counts/gpt-5.6-sol'].limit.context, proAvailable ? 316667 : 266667);
    const duplicate = { ...source, 'gpt-6-sol': { name: 'Existing Sol' } };
    const merged = describeNativeCatalogue(duplicate, 'counts', { ...caps, experimentalBiggerContext: true });
    assert.equal(merged['native/counts/gpt-6-sol'].name, 'Existing Sol (Native tools)');
    assert.equal(Object.keys(merged).length, Object.keys(on).length);
  }
  const free = describeNativeCatalogue(source, 'counts', { experimentalBiggerContext: true });
  assert.equal(Object.keys(free).length, 18);
});

for (const family of ['gpt-6', 'gpt-5.6']) {
  test(`${family} Pro raw and published limits remain baseline with Bigger Context on or off`, () => {
    for (const experimentalBiggerContext of [undefined, false, true]) {
      const rows = nativeCatalog({ solAvailable: true, proAvailable: true, experimentalBiggerContext });
      const pro = rows.find(row => row.slug === `chatgpt-web/${family}-pro`);
      assert.equal(pro.context_window, 112193);
      assert.equal(pro.auto_compact_token_limit, 95000);
      assert.equal(publishedWindow(pro), 105556, 'published context retains the 95K auto-compaction budget');
      assert.deepEqual(pro.supported_reasoning_levels, [{ effort: 'max' }]);
      const descriptor = describeNativeCatalogue(rows, 'guarded')[`native/guarded/${family}-pro`];
      assert.equal(descriptor.limit.context, 105556, 'array catalogue also advertises the guarded budget');
      assert.doesNotMatch(descriptor.name, /Bigger Context/);
    }
  });
}

test('Pro-capable Core aliases retain conservative context across Bigger Context toggles', () => {
  const source = { 'gpt-6': { name: 'GPT-6' }, 'gpt-5-6': { name: 'GPT-5.6' } };
  for (const extraHighAvailable of [false, true]) {
    const caps = { solAvailable: true, proAvailable: true, extraHighAvailable };
    const off = describeNativeCatalogue(source, 'guarded', caps);
    const on = describeNativeCatalogue(source, 'guarded', { ...caps, experimentalBiggerContext: true });
    for (const slug of Object.keys(source)) {
      const key = `native/guarded/${slug}`;
      assert.equal(on[key].limit.context, 105556);
      assert.deepEqual(on[key], off[key]);
      assert.equal(nativeRoute(key, 'max').model, `chatgpt-web/${slug === 'gpt-6' ? 'gpt-6' : 'gpt-5.6'}-pro`);
    }
  }
});
