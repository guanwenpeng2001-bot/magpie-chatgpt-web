import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.MAGPIE_TEST_EXE || join(process.env.LOCALAPPDATA || '', 'Programs', 'magpie', 'magpie.exe');
const route = 'native/account-a/gpt-6-sol';
const turnId = '11111111-1111-1111-1111-111111111111';
const threadId = '22222222-2222-2222-2222-222222222222';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }
async function run(args, env, cwd) {
  const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, `magpie ${args.join(' ')}: ${output}`);
    return output;
  } finally { clearTimeout(timer); }
}

test('installed Magpie preserves native provenance through both Responses routes', {
  skip: !existsSync(executable) && 'magpie.exe is not installed', timeout: 120000,
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'magpie-native-provenance-'));
  const plugin = join(temporary, 'plugin');
  await mkdir(plugin);
  const eventsFile = join(temporary, 'events.jsonl');
  const calls = [], blocked = [];
  const upstream = createServer(async (req, res) => {
    if (req.url !== '/v1/responses') { blocked.push(req.url); res.writeHead(502).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: req.url, headers: req.headers, body });
    if (body.client_metadata?.extra === 'custom-probe') {
      const custom = { type: 'custom_tool_call', id: 'ctc_fixture', call_id: 'call_custom', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch', status: 'completed' };
      const spaced = { type: 'function_call', id: 'fc_spaced', call_id: 'call_spaced', namespace: 'mcp__fixture', name: 'echo', arguments: '{\"x\":1}', status: 'completed' };
      const response = { id: 'resp_custom', object: 'response', created_at: 1, status: 'completed', model: body.model, output: [custom, spaced], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...custom, input: '', status: 'in_progress' } },
        { type: 'response.custom_tool_call_input.delta', item_id: custom.id, output_index: 0, delta: custom.input },
        { type: 'response.custom_tool_call_input.done', item_id: custom.id, output_index: 0, input: custom.input },
        { type: 'response.output_item.done', output_index: 0, item: custom },
        { type: 'response.output_item.added', output_index: 1, item: { ...spaced, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', item_id: spaced.id, output_index: 1, delta: spaced.arguments },
        { type: 'response.function_call_arguments.done', item_id: spaced.id, output_index: 1, arguments: spaced.arguments },
        { type: 'response.output_item.done', output_index: 1, item: spaced },
        { type: 'response.completed', response }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
    const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', model: body.model,
      output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture-ok', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'fixture-ok' },
      { type: 'response.completed', response }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  upstream.on('connect', (req, socket) => { blocked.push(req.url); socket.end('HTTP/1.1 502 Blocked\r\n\r\n'); });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const gatewayPort = await listen(reservation);
  await close(reservation);
  assert.notEqual(gatewayPort, 3425);
  const endpoint = `http://127.0.0.1:${upstreamPort}/v1`;
  // Only the child receives these homes. No real Magpie or Codex config is read.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/(?:_API_KEY|_ACCESS_TOKEN)$/.test(key)) delete env[key];
  Object.assign(env, { HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: join(temporary, 'config'),
    XDG_CACHE_HOME: join(temporary, 'cache'), APPDATA: join(temporary, 'appdata'), LOCALAPPDATA: join(temporary, 'localappdata'),
    CODEX_HOME: join(temporary, 'codex'), MAGPIE_NO_ACCOUNTS: '1', MAGPIE_PLUGIN_MARKET: 'off', MAGPIE_PLUGIN_CATALOG: 'off',
    MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`, MAGPIE_BUN: process.env.MAGPIE_BUN || 'bun',
    HTTP_PROXY: `http://127.0.0.1:${upstreamPort}`, HTTPS_PROXY: `http://127.0.0.1:${upstreamPort}`,
    ALL_PROXY: `http://127.0.0.1:${upstreamPort}`, NO_PROXY: '127.0.0.1,localhost' });
  const nativeUrl = pathToFileURL(join(root, 'src/native/')).href;
  const logCode = `import { appendFileSync } from 'node:fs';
    const log = event => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event) + '\\n');`;
  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(packageInfo.magpie.hooks, './src/native/hooks.mjs');
  assert.equal(packageInfo.magpie.middleware, './src/native/middleware.js');
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'native-provenance-fixture', version: '0.0.0', type: 'module',
    main: './index.mjs', magpie: { hooks: './hooks.mjs', middleware: './middleware.js' } }));
  await writeFile(join(plugin, 'hooks.mjs'), `${logCode}
    import * as hooks from ${JSON.stringify(nativeUrl + 'hooks.mjs')};
    export function onRequest(body, ctx) {
      log({stage:'onRequest', body, ctx});
      if (body.client_metadata.extra === 'mutation-probe') body.input[0].internal_chat_message_metadata_passthrough.hook_mutation = true;
      ctx.state.probe = 'hook-state';
      const result = hooks.onRequest(body, ctx);
      log({stage:'prepared', body: result, ctx});
      return result;
    }
    export function onResponse(body, ctx) { log({stage:'onResponse', body, ctx}); hooks.onResponse(body, ctx); }
  `);
  const middleware = await readFile(join(root, 'src/native/middleware.js'), 'utf8');
  await writeFile(join(plugin, 'middleware.js'), middleware.replace('export function onProvider', 'function nativeOnProvider') + `
    export function onProvider(body, ctx) {
      const snapshot = JSON.parse(JSON.stringify({body, ctx}));
      if (body.client_metadata.extra === 'mutation-probe') body.input[0].internal_chat_message_metadata_passthrough.middleware_mutation = true;
      const result = nativeOnProvider(body, ctx) || body;
      result.__probeProvider = snapshot;
      result.__probeMiddlewareMutation = body.input[0].internal_chat_message_metadata_passthrough.middleware_mutation === true;
      return result;
    }
  `);
  await writeFile(join(plugin, 'index.mjs'), `${logCode}
    import { restore } from ${JSON.stringify(nativeUrl + 'provenance.mjs')};
    export default { id: 'native-provenance-fixture', server: async () => ({
      config: async config => { config.provider ??= {}; config.provider['chatgpt-web'] = {
        name: 'Local fixture', npm: '@ai-sdk/anthropic', api: ${JSON.stringify(endpoint)},
        models: { ${JSON.stringify(route)}: { id: ${JSON.stringify(route)}, name: 'Local fixture', reasoning: true,
          npm:'@ai-sdk/openai', api:{id:${JSON.stringify(route)}, npm:'@ai-sdk/openai', url:${JSON.stringify(endpoint)}},
          provider:{npm:'@ai-sdk/openai',api:${JSON.stringify(endpoint)}},
          tool_call: true, limit: {context: 90000, output: 8000} } } }; },
      auth: { provider: 'chatgpt-web', methods: [{type:'api', label:'Local fixture', keyless:true,
        authorize: async () => ({type:'success', key:'fixture-local'})}],
        loader: async () => ({baseURL: ${JSON.stringify(endpoint)}, fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          log({stage:'fetch', url, headers:Object.fromEntries(init.headers), body});
          delete body.__probeProvider;
          delete body.__probeMiddlewareMutation;
          restore(body, 'account-a');
          if (!url.startsWith(${JSON.stringify(endpoint + '/')})) throw new Error('Non-loopback fixture destination');
          return fetch(url, {...init, body:JSON.stringify(body)});
        }}) }
    })};
  `);
  let gateway, gatewayLog = '';
  try {
    await run(['plugin', 'add', plugin], env, temporary);
    await run(['plugin', 'login', 'chatgpt-web'], env, temporary);
    gateway = spawn(executable, ['serve'], { env, cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    gateway.stdout.on('data', data => { gatewayLog += data; });
    gateway.stderr.on('data', data => { gatewayLog += data; });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, { signal: AbortSignal.timeout(500) }); ready = true; break; }
      catch { assert.equal(gateway.exitCode, null, gatewayLog); await delay(100); }
    }
    assert.ok(ready, gatewayLog);
    // The local redacted Codex 0.162.1 capture supplies the real top-level shape.
    // Replace its messages/tools/identifiers with synthetic values before sending.
    const templatePath = resolve(root, '../magpie-web-gpt/vendor/magpie/internal/redact/testdata/codex-0.162.1-request.json');
    const template = existsSync(templatePath) ? JSON.parse(await readFile(templatePath, 'utf8')) : {
      store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: true, tool_choice: 'auto', reasoning: {summary:'auto'} };
    const turn = { thread_id: threadId, turn_id: turnId, session_id: threadId, parent_thread_id: 'parent-fixture',
      agent_name: '/root/worker', subagent_kind: 'thread_spawn', request_kind: 'turn', turn_trigger: 'exec',
      sandbox: 'windows-sandbox', sandbox_mode: 'workspace-write', workspaces: {'C:\\fixture': {git: {branch:'fixture'}}},
      auto_review_enabled: false, window_number: 0 };
    const metadata = {turn_id: turnId, content_item_kinds: ['environments.environment_context'], extension: {fixture: true}};
    const original = { ...template, model: `chatgpt-web/${route}`, stream: true, prompt_cache_key: threadId,
      client_metadata: {'x-codex-turn-metadata': JSON.stringify(turn), thread_id: threadId, turn_id: turnId, extra:'keep'},
      input: [{type:'message', id:'msg_environment', role:'user', content:[{type:'input_text', text:'<environment_context><cwd>C:\\fixture</cwd></environment_context>'}],
        internal_chat_message_metadata_passthrough: metadata, phase:'commentary', fixture_extension:{value:7}, encrypted_content:'sealed-message-fixture'},
        {type:'message', id:'msg_user', role:'user', content:[{type:'input_text', text:'fixture task'}], internal_chat_message_metadata_passthrough:{turn_id:turnId, content_item_kinds:['user_message']}},
        {type:'function_call', id:'fc_fixture', call_id:'call_fixture', name:'fixture_echo', arguments:'{}', encrypted_function_args:[]},
        {type:'function_call_output', call_id:'call_fixture', output:'fixture result', internal_chat_message_metadata_passthrough:{turn_id:turnId}},
        {type:'agent_message', id:'agent_fixture', author:'/root', recipient:'/root/worker', content:'fixture delegation', encrypted_content:'sealed-agent-fixture'},
        {type:'reasoning', id:'rs_fixture', summary:[], encrypted_content:'sealed-reasoning-fixture'}],
      tools: [{type:'function', name:'fixture_echo', description:'Local fixture', parameters:{type:'object', properties:{}}}] };
    const paths = ['/backend-api/codex/responses', '/v1/responses'];
    // Two exact round-trips, then a controlled mutation proves that both
    // callbacks can edit the metadata before the vendor conversion strips it.
    const requests = paths.map(path => ({path, body:original}));
    const mutation = structuredClone(original);
    mutation.client_metadata.extra = 'mutation-probe';
    requests.push({path:paths[0], body:mutation});
    const lite = structuredClone(original);
    const tools = lite.tools;
    delete lite.tools;
    lite.input.unshift({type:'additional_tools', role:'system', tools:[{type:'namespace', name:'functions', tools}],
      internal_chat_message_metadata_passthrough:{turn_id:turnId, content_item_kinds:['additional_tools']}});
    lite.input[3].namespace = 'functions';
    lite.reasoning = {...lite.reasoning, context:'all_turns'};
    lite.client_metadata.ws_request_header_x_openai_internal_codex_responses_lite = 'true';
    requests.push(...paths.map(path => ({path, body:lite})));
    for (const {path, body} of requests) {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}${path}`, {method:'POST',
        headers:{'content-type':'application/json', authorization:'Bearer fixture', 'user-agent':'codex_cli_rs/0.162.1',
          originator:'codex_cli_rs', 'x-codex-turn-metadata':JSON.stringify(turn), session_id:threadId},
        body:JSON.stringify(body), signal:AbortSignal.timeout(30000)});
      const output = await response.text();
      assert.equal(response.status, 200, `${output}\n${gatewayLog}`);
      assert.match(output, /fixture-ok/);
      for (let i = 0; i < 100; i++) {
        const events = (await readFile(eventsFile, 'utf8')).trim().split('\n').map(JSON.parse);
        if (events.filter(event => event.stage === 'onResponse').length === calls.length) break;
        await delay(20);
      }
    }
    const events = (await readFile(eventsFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, requests.length);
    assert.deepEqual(events.map(event => event.stage), requests.flatMap(() => ['onRequest', 'prepared', 'fetch', 'onResponse']));
    for (let index = 0; index < requests.length; index++) {
      const {path, body:sent} = requests[index];
      const [request, prepared, fetched, response] = events.slice(index * 4, index * 4 + 4);
      const provider = fetched.body.__probeProvider;
      assert.deepEqual(request.body, sent);
      assert.equal(request.ctx.protocol, 'responses');
      assert.equal(request.ctx.origin, 'local');
      assert.equal(request.ctx.path, path);
      assert.equal(request.ctx.provider, undefined);
      assert.equal(request.ctx.headers, undefined);
      assert.deepEqual(request.ctx.state, {});
      assert.deepEqual(provider.body, prepared.body);
      assert.equal(provider.ctx.protocol, 'responses');
      assert.equal(provider.ctx.origin, undefined);
      assert.equal(provider.ctx.headers, undefined);
      assert.equal(provider.ctx.provider.id, 'chatgpt-web');
      assert.equal(provider.ctx.provider.model, route);
      assert.deepEqual(provider.ctx.state, {}); // Not the Node hook's state.
      assert.deepEqual(response.ctx.state, prepared.ctx.state);
      assert.equal(response.ctx.success, true);
      assert.equal(fetched.url, `${endpoint}/responses`);
      assert.equal(fetched.headers.authorization, 'Bearer fixture-local');
      assert.match(fetched.headers['user-agent'], /^magpie\//);
      assert.equal(fetched.headers['x-magpie-session'], threadId);
      for (const name of ['originator', 'x-codex-turn-metadata', 'session_id']) assert.equal(fetched.headers[name], undefined);
      for (const item of fetched.body.input) {
        assert.equal(item.internal_chat_message_metadata_passthrough, undefined);
        assert.equal(item.encrypted_function_args, undefined);
        if (item.type !== 'reasoning') assert.equal(item.encrypted_content, undefined);
      }
      assert.equal(fetched.body.input[5].encrypted_content, 'sealed-reasoning-fixture');
      assert.equal(fetched.body.input[0].phase, 'commentary');
      assert.deepEqual(fetched.body.input[0].fixture_extension, {value:7});
      const expected = structuredClone(sent);
      expected.model = route;
      if (index === 2) {
        assert.equal(provider.body.input[0].internal_chat_message_metadata_passthrough.hook_mutation, true);
        assert.equal(fetched.body.__probeMiddlewareMutation, true);
        expected.input[0].internal_chat_message_metadata_passthrough.hook_mutation = true;
      }
      assert.deepEqual(calls[index].body, expected);
      t.diagnostic(JSON.stringify({path, mutationProbe:index === 2, url:fetched.url, headers:fetched.headers,
        hookContextKeys:Object.keys(request.ctx), providerContext:provider.ctx,
        stages:['onRequest', 'onProvider', 'loader.fetch', 'onResponse'],
        strippedItemFields:['internal_chat_message_metadata_passthrough', 'encrypted_function_args', 'encrypted_content (except reasoning/compaction)'],
        exactRestoredBody:true}));
    }
    t.diagnostic(`External background requests rejected by local proxy: ${[...new Set(blocked)].join(', ')}`);
    const customRequest = structuredClone(original);
    customRequest.client_metadata.extra = 'custom-probe';
    customRequest.tools = [...original.tools, {type:'custom', name:'apply_patch', description:'Patch files', format:{type:'text'}},
      {type:'namespace', name:'mcp__fixture', description:'Fixture MCP', tools:[{type:'function', name:'echo', description:'Echo', parameters:{type:'object', properties:{x:{type:'number'}}}}]}];
    const customResponse = await fetch(`http://127.0.0.1:${gatewayPort}${paths[0]}`, {method:'POST',
      headers:{'content-type':'application/json', authorization:'Bearer fixture', 'user-agent':'codex_cli_rs/0.162.1',
        originator:'codex_cli_rs', 'x-codex-turn-metadata':JSON.stringify(turn), session_id:threadId},
      body:JSON.stringify(customRequest), signal:AbortSignal.timeout(30000)});
    const customOutput = await customResponse.text();
    assert.equal(customResponse.status, 200, `${customOutput}\n${gatewayLog}`);
    const doneItems = customOutput.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => JSON.parse(line.slice(5))).filter(event => event.type === 'response.output_item.done').map(event => event.item);
    const patch = doneItems.find(item => item.call_id === 'call_custom');
    assert.equal(patch?.type, 'custom_tool_call', customOutput);
    assert.equal(patch.name, 'apply_patch');
    assert.equal(patch.input, '*** Begin Patch\n*** End Patch');
    const echo = doneItems.find(item => item.call_id === 'call_spaced');
    assert.equal(echo?.type, 'function_call', customOutput);
    assert.equal(echo.namespace, 'mcp__fixture');
    assert.equal(echo.name, 'echo');
    assert.equal(echo.arguments, '{"x":1}');
  } finally {
    if (gateway && gateway.exitCode === null) {
      const exited = new Promise(resolve => gateway.once('exit', resolve));
      gateway.kill();
      await exited;
    }
    await close(upstream);
    // Only this test's newly-created temporary tree is removed.
    assert.equal(dirname(temporary), resolve(tmpdir()));
    await rm(temporary, {recursive:true, force:true, maxRetries:10, retryDelay:100});
  }
});
