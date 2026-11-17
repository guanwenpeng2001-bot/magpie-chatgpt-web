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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.MAGPIE_TEST_EXE || join(process.env.LOCALAPPDATA || '', 'Programs', 'magpie', 'magpie.exe');
const profile = 'compact-fixture', route = `native/${profile}/gpt-5.6-sol`;
const thread = '11111111-1111-4111-8111-111111111111';
const sourceTurn = '22222222-2222-4222-8222-222222222222';
const compactTurn = '33333333-3333-4333-8333-333333333333';
const summary = 'OFFLINE_COMPACTION_SUMMARY: original task remains pending; no tool executed.';
// Observed from the installed host, not a production normalization helper.
const hostControl = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
const within = (parent, child) => { const p = relative(parent, child); return p === '' || (!isAbsolute(p) && p !== '..' && !p.startsWith('..\\') && !p.startsWith('../')); };

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  assert.notEqual(server.address().port, 3425);
  return server.address().port;
}
async function close(server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
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

// Only browser/daemon boundaries are fake. The installed host, hooks,
// provenance rejection and production loader are real. No nonce is fabricated.
async function fixtureServer(input) {
  log({ stage: 'server', directory: input.directory });
  const native = { async runtime(auth) {
    if (auth.type !== 'oauth' || auth.profile !== fixtureProfile) throw new Error('Non-fixture account refused');
    log({ stage: 'runtime' });
    return { health: async () => true,
      async responses() { log({ stage: 'ordinary-native' }); throw new Error('Unproven host compaction must not authorize ordinary tools'); },
      async compaction(body, headers, _signal, path) {
        log({ stage: 'read-only-compaction', body, headers: Object.fromEntries(new Headers(headers)), path });
        const message = { type: 'message', id: 'summary_fixture', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: fixtureSummary, annotations: [] }] };
        const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: body.model,
          output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        const sequence = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } },
          { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: fixtureSummary },
          { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: fixtureSummary },
          { type: 'response.output_item.done', output_index: 0, item: message }, { type: 'response.completed', response }];
        return new Response(sequence.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } });
      },
    };
  } };
  const bridge = { open() { log({ stage: 'text-fallback' }); throw new Error('Text fallback forbidden'); },
    call() { log({ stage: 'backend-rpc' }); throw new Error('Browser/backend RPC forbidden'); } };
  const env = { input, native, bridge };
  return {
    config: async config => { config.provider ??= {}; config.provider['chatgpt-web'] = {
      name: 'Offline compaction fixture', npm: '@ai-sdk/anthropic', api: fixtureEndpoint,
      models: { [fixtureRoute]: { id: fixtureRoute, name: 'Offline Native fixture', npm: '@ai-sdk/openai',
        api: { id: fixtureRoute, npm: '@ai-sdk/openai', url: fixtureEndpoint }, provider: { npm: '@ai-sdk/openai', api: fixtureEndpoint },
        tool_call: true, limit: { context: 90000, output: 8000 } } } }; },
    auth: { ...authHook(env), methods: [{ type: 'api', label: 'Isolated bootstrap', keyless: true,
      authorize: async () => ({ type: 'success', key: 'synthetic-bootstrap' }) }], loader: async getAuth => {
      const loader = await makeLoader(env)(getAuth);
      return { ...loader, fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        log({ stage: 'loader', body, path: new URL(url).pathname });
        try {
          restore(structuredClone(body), fixtureProfile);
          log({ stage: 'provenance-accepted' });
        } catch (error) { log({ stage: 'provenance-rejected', reason: error.message }); }
        const response = await loader.fetch(url, init);
        log({ stage: 'loader-response', status: response.status });
        return response;
      } };
    } },
  };
}

test('installed Magpie compaction bypasses hooks and stays on the unproven read-only Native route', {
  skip: !existsSync(executable) && 'magpie.exe is not installed', timeout: 90_000,
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'magpie-compaction-host-'));
  const plugin = join(temporary, 'plugin'); await mkdir(plugin);
  const eventsFile = join(temporary, 'events.jsonl'), stopFile = join(temporary, 'stop');
  const blocked = [];
  const proxy = createServer((req, res) => { blocked.push(req.url); res.writeHead(502).end('Offline fixture'); });
  proxy.on('connect', (req, socket) => { blocked.push(req.url); socket.end('HTTP/1.1 502 Offline fixture\r\n\r\n'); });
  const proxyPort = await listen(proxy), reservation = createServer(), port = await listen(reservation);
  await close(reservation);
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const key of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR']) env[key] = temporary;
  Object.assign(env, { XDG_CONFIG_HOME: join(temporary, 'config'), XDG_CACHE_HOME: join(temporary, 'cache'), APPDATA: join(temporary, 'appdata'),
    LOCALAPPDATA: join(temporary, 'localappdata'), CODEX_HOME: join(temporary, 'codex'), MAGPIE_NO_ACCOUNTS: '1',
    MAGPIE_PLUGIN_MARKET: 'off', MAGPIE_PLUGIN_CATALOG: 'off', MAGPIE_ADDR: `127.0.0.1:${port}`, MAGPIE_BUN: process.env.MAGPIE_BUN || 'bun',
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, ALL_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1,localhost' });
  const source = name => pathToFileURL(join(root, name)).href;
  const logging = `import {appendFileSync,existsSync} from 'node:fs';\nconst log=event=>appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify(event)+'\\n');`;
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'native-compaction-host-fixture', version: '0.0.0', type: 'module',
    main: './index.mjs', magpie: { hooks: './hooks.mjs', middleware: './middleware.js' } }));
  await writeFile(join(plugin, 'hooks.mjs'), `${logging}
    import * as hooks from ${JSON.stringify(source('src/native/hooks.mjs'))};
    export function onRequest(body,ctx){log({stage:'onRequest',body,ctx});return hooks.onRequest(body,ctx);}
    export function onResponse(body,ctx){log({stage:'onResponse',body,ctx});return hooks.onResponse(body,ctx);}
  `);
  await writeFile(join(plugin, 'middleware.js'), await readFile(join(root, 'src/native/middleware.js'), 'utf8'));
  await writeFile(join(plugin, 'index.mjs'), `${logging}
    import {makeLoader} from ${JSON.stringify(source('src/loader.mjs'))};
    import {authHook} from ${JSON.stringify(source('src/hooks/auth.mjs'))};
    import {restore} from ${JSON.stringify(source('src/native/provenance.mjs'))};
    const fixtureProfile=${JSON.stringify(profile)},fixtureRoute=${JSON.stringify(route)},fixtureSummary=${JSON.stringify(summary)},fixtureEndpoint=${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)};
    setInterval(()=>{if(existsSync(${JSON.stringify(stopFile)}))process.exit(0)},100).unref();
    export default {id:'native-compaction-host-fixture',server:${fixtureServer.toString()}};
  `);
  let gateway, gatewayLog = '';
  t.after(async () => {
    await writeFile(stopFile, 'stop owned fixture host');
    if (gateway && gateway.exitCode === null) {
      const exited = new Promise(resolve => gateway.once('exit', resolve)); gateway.kill(); await exited;
    }
    await close(proxy);
    assert.equal(dirname(temporary), resolve(tmpdir()));
    await rm(temporary, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  const version = (await run(['--version'], env, temporary)).trim();
  await run(['plugin', 'add', plugin], env, temporary);
  await run(['plugin', 'login', 'chatgpt-web'], env, temporary);
  const directories = new Set((await events(eventsFile)).filter(event => event.stage === 'server').map(event => event.directory));
  assert.ok(directories.size);
  for (const directory of directories) {
    assert.ok(typeof directory === 'string' && within(temporary, resolve(directory)), 'never write real auth storage');
    await writeFile(join(directory, 'plugin-auth.json'), JSON.stringify({ 'chatgpt-web': { type: 'oauth', profile,
      accountId: 'synthetic@example.test', refresh: 'synthetic-refresh', access: 'synthetic-access', expires: 4102444800000 } }));
  }
  gateway = spawn(executable, ['serve'], { env, cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = chunk => { gatewayLog = (gatewayLog + chunk).slice(-65536); };
  gateway.stdout.on('data', collect); gateway.stderr.on('data', collect);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 150; n++) {
    try {
      const response = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(500) });
      if ((await response.text()).includes(route)) { ready = true; break; }
    } catch { /* bounded isolated startup */ }
    assert.equal(gateway.exitCode, null, gatewayLog); await delay(100);
  }
  assert.ok(ready, gatewayLog);
  const metadata = { thread_id: thread, turn_id: compactTurn, request_kind: 'compaction',
    compaction: { trigger: 'auto', phase: 'pre_turn', implementation: 'native', strategy: 'memento' } };
  const originals = [
    { type: 'message', role: 'user', id: 'environment-original', content: [{ type: 'input_text', text: '<environment_context><cwd>C:\\synthetic</cwd></environment_context>' }],
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurn, content_item_kinds: ['environment_context'] } },
    { type: 'message', role: 'user', id: 'user-original', content: [{ type: 'input_text', text: 'ORIGINAL_TASK_MARKER: continue the synthetic work.' }],
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurn, content_item_kinds: ['user_message'], extra: { preserve: true } } },
    { type: 'function_call', id: 'past-call', call_id: 'fixture-call', name: 'never_execute', arguments: '{"fixture":true}' },
    { type: 'function_call_output', call_id: 'fixture-call', output: 'ORIGINAL_TOOL_RESULT_MARKER', internal_chat_message_metadata_passthrough: { turn_id: sourceTurn } },
  ];
  const body = { model: 'chatgpt-web/' + route, stream: true, store: false, reasoning: { effort: 'high' },
    prompt_cache_key: thread, client_metadata: { 'x-codex-turn-metadata': JSON.stringify(metadata), fixture: 'retain-when-possible' },
    input: [...originals, { type: 'compaction_trigger' }],
    tools: [{ type: 'function', name: 'never_execute', description: 'Must not gain a tool capability during read-only compaction.',
      parameters: { type: 'object', properties: { fixture: { type: 'boolean' } } } }],
  };
  const response = await fetch(base + '/backend-api/codex/responses', { method: 'POST', headers: {
    'content-type': 'application/json', authorization: 'Bearer synthetic-local-client', 'user-agent': 'codex_cli_rs/0.162.1',
    originator: 'codex_cli_rs', session_id: thread, 'x-codex-turn-metadata': JSON.stringify(metadata),
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const output = await response.text(), captured = await events(eventsFile);
  const fetched = captured.find(event => event.stage === 'loader'), compact = captured.find(event => event.stage === 'read-only-compaction');
  t.diagnostic(JSON.stringify({ installed: version, status: response.status, stages: captured.map(event => event.stage),
    loaderItemKeys: fetched?.body.input.map(item => Object.keys(item)), metadata: fetched?.body.client_metadata,
    terminalControl: fetched?.body.input.at(-1), externalRequestsBlocked: blocked.length }));
  assert.equal(response.status, 200, output + '\n' + gatewayLog);
  assert.equal(captured.filter(event => event.stage === 'onRequest').length, 0, 'actual codexCompact must not be mistaken for the hooked ordinary route');
  assert.equal(captured.filter(event => event.stage === 'onResponse').length, 0);
  assert.equal(captured.filter(event => event.stage === 'loader').length, 1);
  assert.equal(captured.filter(event => event.stage === 'read-only-compaction').length, 1);
  assert.equal(captured.some(event => ['ordinary-native', 'text-fallback', 'backend-rpc', 'provenance-accepted'].includes(event.stage)), false);
  assert.match(captured.find(event => event.stage === 'provenance-rejected')?.reason ?? '', /provenance is missing|nonce is missing/);
  for (const payload of [fetched.body, compact.body]) {
    assert.equal(payload.client_metadata?.['x-magpie-native-nonce'], undefined);
    assert.equal(payload.client_metadata?.['x-magpie-native-checked'], undefined);
    assert.equal(payload.input.some(item => item.type === 'compaction_trigger'), false);
    assert.ok(payload.input.every(item => item.internal_chat_message_metadata_passthrough === undefined));
    assert.deepEqual(payload.tools, [], 'client tool schemas must not become Native execution capabilities');
    assert.equal(payload.parallel_tool_calls, false);
    assert.deepEqual(JSON.parse(payload.client_metadata['x-codex-turn-metadata']),
      { ...metadata, compaction: { ...metadata.compaction, implementation: 'responses' } });
    assert.deepEqual(payload.input.slice(0, -1), originals.map(({ internal_chat_message_metadata_passthrough, ...item }) => item),
      'record IDs/text/tool data survive, but stripped item metadata cannot be restored without proof');
    assert.deepEqual(payload.input.at(-1), { type: 'message', role: 'user', content: [{ type: 'input_text', text: hostControl }] },
      'the host synthetic control is unlabelled and must never supply ordinary tool authority');
  }
  assert.deepEqual(compact.body, { ...fetched.body, model: 'chatgpt-web/gpt-5.6-sol' });
  const frames = output.split(/\r?\n/).filter(line => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]').map(line => JSON.parse(line.slice(5)));
  const completed = frames.find(event => event.type === 'response.completed')?.response;
  assert.equal(completed?.status, 'completed');
  assert.equal(completed.output.length, 1);
  assert.equal(completed.output[0].type, 'compaction');
  assert.equal(completed.output[0].encrypted_content, 'magpie1:' + Buffer.from(summary).toString('base64'));
  assert.equal(frames.some(event => ['function_call', 'custom_tool_call', 'tool_search_call'].includes(event.item?.type)), false);
});
