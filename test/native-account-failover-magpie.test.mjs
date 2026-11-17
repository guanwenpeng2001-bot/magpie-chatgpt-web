import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { prepare, mark, restore, complete, NONCE } from '../src/native/provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.MAGPIE_TEST_EXE || join(process.env.LOCALAPPDATA || '', 'Programs', 'magpie', 'magpie.exe');
const route = 'native/auto/gpt-6-sol';
const profiles = ['account-a', 'account-b'];
const threadId = '22222222-2222-4222-8222-222222222222';
const turnId = '11111111-1111-4111-8111-111111111111';
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../')); };

function request(modelRoute = route, effort = 'high') {
  const turn = { thread_id: threadId, turn_id: turnId, session_id: threadId, request_kind: 'turn',
    sandbox_mode: 'workspace-write', sandbox: 'windows-sandbox', workspaces: { 'C:\\synthetic': { git: { branch: 'fixture' } } } };
  return { model: `chatgpt-web/${modelRoute}`, stream: true, store: false, instructions: 'Synthetic offline task; preserve metadata.',
    prompt_cache_key: threadId, reasoning: { effort, summary: 'auto' }, tool_choice: 'auto', parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'], client_metadata: { 'x-codex-turn-metadata': JSON.stringify(turn), thread_id: threadId, turn_id: turnId, fixture: { preserve: [1, false, null] } },
    input: [
      { type: 'message', role: 'developer', id: 'environment', content: [{ type: 'input_text', text: '<environment_context><cwd>C:\\synthetic</cwd></environment_context>' }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ['environment_context'], extra: { keep: true } } },
      { type: 'message', role: 'user', id: 'task', content: [{ type: 'input_text', text: 'Do not execute any real tool.' }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ['user_message'] } },
      { type: 'function_call', id: 'fc_before', call_id: 'call_before', namespace: 'functions', name: 'echo', arguments: '{"text":"exact"}', encrypted_function_args: [] },
      { type: 'function_call_output', call_id: 'call_before', output: 'synthetic result', internal_chat_message_metadata_passthrough: { turn_id: turnId } },
      { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'synthetic-sealed-reasoning' },
    ],
    tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'echo', description: 'Synthetic echo only',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] },
    { type: 'custom', name: 'apply_patch', description: 'Synthetic patch only', format: { type: 'text' } }],
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  assert.notEqual(server.address().port, 3425);
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
async function run(args, env, cwd) {
  const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = chunk => { output = (output + chunk).slice(-65536); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, `isolated magpie ${args.join(' ')}: ${output}`);
    return output;
  } finally { clearTimeout(timer); }
}
async function events(path) {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Executed only inside the temporary plugin host. Production hooks, provider
// catalogue composition and loader are imported; browsers and Native are fake.
async function fixtureServer(input) {
  log({ stage: 'server', directory: input.directory });
  const native = {
    async models(auth) {
      log({ stage: 'native-models', profile: auth.profile, authType: auth.type });
      if (auth.type !== 'oauth' || !['account-a', 'account-b'].includes(auth.profile)) throw new Error('Non-fixture account refused');
      return describeNativeCatalogue(nativeCatalog({ solAvailable: true, proAvailable: fixtureSlug.endsWith('-pro') })
        .filter(row => row.slug === 'chatgpt-web/' + fixtureSlug), auth.profile);
    },
    async runtime(auth) {
      if (auth.type !== 'oauth' || !['account-a', 'account-b'].includes(auth.profile)) throw new Error('Non-fixture account refused');
      return { health: async () => true,
        async responses(body, headers) {
          firstProfile ??= auth.profile;
          log({ stage: 'native', profile: auth.profile, authType: auth.type, body, headers: Object.fromEntries(new Headers(headers)) });
          const message = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'dummy-native-success', annotations: [] }] };
          const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: body.model, output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
          const frame = event => new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(frame({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }));
              if (scenario.startsWith('quota') && auth.profile === firstProfile) {
                controller.enqueue(frame({ type: 'response.failed', response: { ...response, status: 'failed', output: [], retryable: true,
                  error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Synthetic Native quota exceeded',
                    ...(scenario === 'quota' ? { retry_after: 120 } : {}) } } }));
                controller.close();
                return;
              }
              if (scenario === 'account-model-unavailable' && auth.profile === firstProfile) {
                controller.enqueue(frame({ type: 'response.failed', response: { ...response, status: 'failed', output: [], retryable: false,
                  error: { type: 'server_error', code: 'account_model_unavailable', message: 'Synthetic requested model unavailable for this account.' } } }));
                controller.close();
                return;
              }
              if (scenario.endsWith('after-output') && auth.profile === firstProfile) {
                const call = { type: 'function_call', id: 'fc_partial', call_id: 'call_partial', name: 'echo', namespace: 'functions', arguments: '{}', status: 'completed' };
                controller.enqueue(frame({ type: 'response.output_item.added', output_index: 0, item: call }));
                controller.enqueue(frame({ type: 'response.output_item.done', output_index: 0, item: call }));
                controller.enqueue(frame({ type: 'response.output_text.delta', item_id: message.id, output_index: 1, content_index: 0, delta: 'output-before-failure-' + 'x'.repeat(4096) }));
                (async () => {
                  const until = Date.now() + 8000;
                  while (!existsSync(releaseFile) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
                  const unavailable = scenario === 'account-model-unavailable-after-output';
                  const error = unavailable
                    ? { type: 'server_error', code: 'account_model_unavailable', message: 'Synthetic requested model unavailable after output.', status: 503 }
                    : { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Synthetic cooldown after output', status: 429 };
                  log({ stage: 'late-failure', clientObserved: existsSync(releaseFile), profile: auth.profile, errorCode: error.code });
                  controller.enqueue(frame({ type: 'response.failed', response: { ...response, status: 'failed', output: [call], retryable: !unavailable, error } }));
                  controller.close();
                })().catch(error => { log({ stage: 'stream-cancelled', name: error.name }); });
                return;
              }
              controller.enqueue(frame({ type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'dummy-native-success' }));
              controller.enqueue(frame({ type: 'response.completed', response }));
              controller.close();
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        },
      };
    },
  };
  const bridge = { async call(command) {
    if (command.method !== 'models') throw new Error('Unexpected browser/backend RPC');
    return { models: [{ slug: 'auto', title: 'Fixture text model' }] };
  }, open() { log({ stage: 'text-replay' }); throw new Error('Text replay forbidden'); } };
  const env = { bridge, native, input };
  const provider = providerHook(env);
  const models = provider.models.bind(provider);
  provider.models = async (...args) => {
    const result = await models(...args);
    log({ stage: 'models', profile: args[1]?.auth?.profile, ids: Object.keys(result) });
    return result;
  };
  return {
    config: async config => { config.provider ??= {}; config.provider['chatgpt-web'] = {
      name: 'Offline failover fixture', npm: '@ai-sdk/anthropic', api: fixtureEndpoint, models: {} }; },
    provider,
    auth: { ...authHook(env), methods: [{ type: 'api', label: 'Enable isolated fixture', keyless: true,
      authorize: async () => ({ type: 'success', key: 'synthetic-bootstrap' }) }], loader: async getAuth => {
      const loader = await makeLoader(env)(getAuth);
      return { ...loader, fetch: async (url, init) => {
        const auth = await getAuth();
        log({ stage: 'loader', profile: auth.profile, authType: auth.type, body: JSON.parse(init.body) });
        const response = await loader.fetch(url, init);
        log({ stage: 'loader-response', profile: auth.profile, status: response.status, retryAfter: response.headers.get('retry-after'),
          signIn: response.headers.get('x-magpie-sign-in'), shouldRetry: response.headers.get('x-should-retry'),
          ...([429, 503].includes(response.status) ? { error: (await response.clone().json()).error } : {}) });
        return response;
      } };
    } },
  };
}

async function gatewayFixture(t, scenario) {
  const slug = scenario.startsWith('account-model-unavailable') ? 'gpt-6-pro' : 'gpt-6-sol';
  const selectedRoute = 'native/auto/' + slug;
  const temporary = await mkdtemp(join(tmpdir(), 'magpie-native-failover-'));
  const plugin = join(temporary, 'plugin');
  await mkdir(plugin);
  const eventsFile = join(temporary, 'events.jsonl'), releaseFile = join(temporary, 'release'), stopFile = join(temporary, 'stop');
  const blocked = [];
  const proxy = createServer((req, res) => { blocked.push(req.url); res.writeHead(502).end('Offline fixture: network blocked'); });
  proxy.on('connect', (req, socket) => { blocked.push(req.url); socket.end('HTTP/1.1 502 Offline fixture\r\n\r\n'); });
  const proxyPort = await listen(proxy);
  const reservation = createServer();
  const gatewayPort = await listen(reservation);
  await close(reservation);
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache'),
    APPDATA: join(temporary, 'appdata'), LOCALAPPDATA: join(temporary, 'localappdata'), CODEX_HOME: join(temporary, 'codex'),
    MAGPIE_NO_ACCOUNTS: '1', MAGPIE_PLUGIN_MARKET: 'off', MAGPIE_PLUGIN_CATALOG: 'off', MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`,
    MAGPIE_BUN: process.env.MAGPIE_BUN || 'bun', HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    ALL_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1,localhost' });
  const source = name => pathToFileURL(join(root, name)).href;
  const logging = `import { appendFileSync, existsSync } from 'node:fs';\nconst log = event => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event) + '\\n');`;
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'native-failover-fixture', version: '0.0.0', type: 'module', main: './index.mjs',
    magpie: { hooks: './hooks.mjs', middleware: './middleware.js' } }));
  await writeFile(join(plugin, 'hooks.mjs'), `${logging}
    import * as hooks from ${JSON.stringify(source('src/native/hooks.mjs'))};
    export function onRequest(body, ctx) { log({stage:'onRequest',body,ctx}); return hooks.onRequest(body,ctx); }
    export function onResponse(body, ctx) { log({stage:'onResponse',body,ctx}); return hooks.onResponse(body,ctx); }
  `);
  await writeFile(join(plugin, 'middleware.js'), await readFile(join(root, 'src/native/middleware.js'), 'utf8'));
  await writeFile(join(plugin, 'index.mjs'), `${logging}
    import { makeLoader } from ${JSON.stringify(source('src/loader.mjs'))};
    import { providerHook } from ${JSON.stringify(source('src/hooks/provider.mjs'))};
    import { authHook } from ${JSON.stringify(source('src/hooks/auth.mjs'))};
    import { nativeCatalog, describeNativeCatalogue } from ${JSON.stringify(source('src/native/models.mjs'))};
    const scenario=${JSON.stringify(scenario)}, fixtureSlug=${JSON.stringify(slug)}, releaseFile=${JSON.stringify(releaseFile)}, fixtureEndpoint=${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)};
    let firstProfile;
    setInterval(()=>{ if(existsSync(${JSON.stringify(stopFile)}))process.exit(0); },100).unref();
    export default {id:'native-failover-fixture',server:${fixtureServer.toString()}};
  `);
  let gateway, gatewayLog = '';
  t.after(async () => {
    await writeFile(stopFile, 'stop owned fixture hosts');
    if (gateway && gateway.exitCode === null) {
      const exited = new Promise(resolve => gateway.once('exit', resolve));
      gateway.kill(); await exited;
    }
    await close(proxy);
    assert.equal(dirname(temporary), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  const version = (await run(['--version'], env, temporary)).trim();
  await run(['plugin', 'add', plugin], env, temporary);
  // Register this provider with the host using its noninteractive, keyless
  // fixture method. Replace that bootstrap row before starting the gateway;
  // every tested account and Native attempt below must be OAuth.
  await run(['plugin', 'login', 'chatgpt-web'], env, temporary);
  const starts = (await events(eventsFile)).filter(event => event.stage === 'server');
  assert.ok(starts.length, 'fixture host must identify its isolated auth directory');
  for (const directory of new Set(starts.map(event => event.directory))) {
    assert.equal(typeof directory, 'string');
    assert.ok(within(temporary, resolve(directory)), 'never seed a non-fixture auth registry');
    await writeFile(join(directory, 'plugin-auth.json'), JSON.stringify(Object.fromEntries(profiles.map(profile => [
      `chatgpt-web#${profile}`, { type: 'oauth', profile, accountId: `${profile}@example.test`, refresh: `synthetic-${profile}`, access: `synthetic-${profile}`, expires: 4102444800000 },
    ]))));
  }
  gateway = spawn(executable, ['serve'], { env, cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = chunk => { gatewayLog = (gatewayLog + chunk).slice(-65536); };
  gateway.stdout.on('data', collect); gateway.stderr.on('data', collect);
  const base = `http://127.0.0.1:${gatewayPort}`;
  let catalogue;
  for (let n = 0; n < 200; n++) {
    try {
      const response = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(1000) });
      catalogue = await response.json();
      if (JSON.stringify(catalogue).includes(selectedRoute)) break;
    } catch { /* startup is bounded below */ }
    assert.equal(gateway.exitCode, null, gatewayLog);
    await delay(100);
  }
  assert.ok(JSON.stringify(catalogue).includes(selectedRoute), gatewayLog + '\n' + JSON.stringify(await events(eventsFile)));
  return { base, eventsFile, releaseFile, version, blocked, route: selectedRoute, slug, log: () => gatewayLog };
}

test('auto provenance permits identical cross-account retries, while changed retries and pinned routes stay blocked', () => {
  for (const shared of [true, false]) {
    const body = request();
    if (!shared) body.model = 'chatgpt-web/native/account-a/gpt-6-sol';
    prepare(body, { protocol: 'responses', origin: 'local', state: {} });
    const nonce = body.client_metadata[NONCE];
    try {
      body.model = body.model.slice('chatgpt-web/'.length);
      mark(body, { provider: { id: 'chatgpt-web', model: body.model } });
      const first = restore(structuredClone(body), 'account-a');
      if (shared) {
        assert.deepEqual(restore(structuredClone(body), 'account-b'), first);
        const changed = structuredClone(body); changed.input[1].content[0].text += 'changed';
        assert.throws(() => restore(changed, 'account-b'), /retry changed/);
      } else assert.throws(() => restore(structuredClone(body), 'account-b'), /account or routing proof/);
      complete(nonce);
      assert.throws(() => restore(structuredClone(body), 'account-a'), /account or routing proof/);
    } finally { complete(nonce); }
  }
});

for (const scenario of ['quota', 'quota-no-hint', 'after-output', 'account-model-unavailable', 'account-model-unavailable-after-output']) test(`installed Magpie auto-account ${scenario} uses two isolated fake OAuth accounts`, {
  skip: !existsSync(executable) && 'magpie.exe is not installed', timeout: 120_000,
}, async t => {
  const fixture = await gatewayFixture(t, scenario);
  const original = request(fixture.route, fixture.slug.endsWith('-pro') ? 'max' : 'high');
  const response = await fetch(fixture.base + '/v1/responses', { method: 'POST', headers: {
    'content-type': 'application/json', authorization: 'Bearer synthetic-local-client', 'user-agent': 'codex_cli_rs/0.162.1',
    originator: 'codex_cli_rs', session_id: threadId,
  }, body: JSON.stringify(original), signal: AbortSignal.timeout(40_000) });
  let output = '', observed = false;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    output += decoder.decode(chunk, { stream: true });
    if (!observed && output.includes('output-before-failure-')) {
      observed = true;
      await writeFile(fixture.releaseFile, 'client received output');
    }
    assert.ok(output.length < 1024 * 1024, 'fixture output exceeded its bound');
  }
  output += decoder.decode();
  let captured;
  for (let n = 0; n < 100; n++) {
    captured = await events(fixture.eventsFile);
    if (captured.some(event => event.stage === 'onResponse')) break;
    await delay(20);
  }
  const calls = captured.filter(event => event.stage === 'native');
  const catalogue = captured.filter(event => event.stage === 'models' && profiles.includes(event.profile) && event.ids.includes(fixture.route));
  assert.deepEqual(new Set(catalogue.map(event => event.profile)), new Set(profiles));
  assert.equal(captured.some(event => event.stage === 'text-replay'), false);
  const expected = { ...original, model: 'chatgpt-web/' + fixture.slug };
  for (const call of calls) {
    assert.equal(call.authType, 'oauth');
    assert.deepEqual(call.body, expected, 'canonical metadata, tools and input must survive every account attempt');
  }
  if (!scenario.endsWith('after-output')) {
    assert.equal(response.status, 200, output + '\n' + fixture.log());
    assert.match(output, /dummy-native-success/);
    assert.equal(calls.length, 2, JSON.stringify(captured));
    assert.notEqual(calls[0].profile, calls[1].profile);
    const unavailable = scenario === 'account-model-unavailable';
    assert.deepEqual(captured.filter(event => event.stage === 'loader-response').map(event => [event.status, event.retryAfter]), [[unavailable ? 503 : 429, scenario === 'quota' ? '120' : null], [200, null]]);
    const refusal = captured.find(event => event.stage === 'loader-response');
    assert.deepEqual(refusal.error, unavailable
      ? { type: 'server_error', code: 'account_model_unavailable', message: 'Synthetic requested model unavailable for this account.', status: 503 }
      : { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Synthetic Native quota exceeded',
        ...(scenario === 'quota' ? { retry_after: 120 } : {}), status: 429 });
    assert.equal(refusal.signIn, 'kept');
    assert.equal(refusal.shouldRetry, null, 'an account refusal must allow host account failover');
    const loaders = captured.filter(event => event.stage === 'loader');
    assert.equal(loaders[0].body.client_metadata[NONCE], loaders[1].body.client_metadata[NONCE], 'failover must keep the original nonce');
    assert.deepEqual(loaders[0].body, loaders[1].body, 'vendor projections must also stay identical');
  } else {
    assert.equal(response.status, 200, 'an already started stream must not become an HTTP refusal');
    assert.equal(observed, true, 'host did not expose output before failure; no no-replay claim is possible');
    assert.equal(captured.find(event => event.stage === 'late-failure')?.clientObserved, true);
    assert.equal(captured.find(event => event.stage === 'late-failure')?.errorCode,
      scenario.startsWith('account-model-unavailable') ? 'account_model_unavailable' : 'rate_limit_exceeded');
    assert.equal(calls.length, 1, 'host replayed an already visible Native turn');
    assert.deepEqual(captured.filter(event => event.stage === 'loader-response').map(event => event.status), [200]);
    assert.doesNotMatch(output, /dummy-native-success/);
  }
  assert.equal(captured.filter(event => event.stage === 'onRequest').length, 1);
  assert.equal(captured.filter(event => event.stage === 'onResponse').length, 1);
  t.diagnostic(JSON.stringify({ installed: fixture.version, scenario, accountAttempts: calls.map(event => event.profile),
    model: fixture.route, exactCanonical: true, clientObservedBeforeFailure: observed, externalRequestsBlocked: fixture.blocked.length }));
});
