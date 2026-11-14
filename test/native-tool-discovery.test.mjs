import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const entry = resolve(process.env.NATIVE_REFERENCE_CLI
  ?? fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/app/cli.js', import.meta.url)));
const bun = resolve(process.env.NATIVE_REFERENCE_BUN
  ?? fileURLToPath(new URL('../../native-runtime-spike/runtime-6.1.18/runtime/bun.exe', import.meta.url)));
const patchModule = new URL('../src/native/tool-discovery.mjs', import.meta.url).href;
const pinnedHash = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const pinned = { skip: process.env.NATIVE_TOOL_DISCOVERY_SMOKE !== '1', timeout: 90_000 };
const baseline = process.env.NATIVE_TOOL_DISCOVERY_BASELINE === '1';
// Retained RED evidence (unmodified whole CLI at pinnedHash, before the fix):
// NATIVE_TOOL_DISCOVERY_SMOKE=1 NATIVE_TOOL_DISCOVERY_BASELINE=1
// NATIVE_TOOL_DISCOVERY_REAL_SCHEMAS=<saved native-subagent-rollout-schemas.json>
// node --test --test-name-pattern="discovery contracts" test/native-tool-discovery.test.mjs
// Observed exit 1: actual brokerResult.structuredContent was undefined; content:
// "Tool search loaded these tools — they are now in your available tools. Call
// one by its EXACT name: spawn_agent, wait_agent, close_agent, spawn_agent, wait_agent."
// The saved schemas are copied into scratch, not embedded or required by CI.
// Without BASELINE, the identical assertion passes with the fix; the distinct
// audit_registry.inspect_record contract also guards against agent-key aliases.
let fixture;
function readPinnedFixture() {
  return fixture ??= (async () => {
    const bytes = await readFile(entry);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pinnedHash);
    return { bytes, source: bytes.toString('utf8') };
  })();
}

// Whole checksum-pinned CLI, its shipped dependencies, and real parser/result/
// prompt functions. No startup, browser, socket, host dispatch, or live account.
async function runPinned(t, suite, patch = !baseline) {
  const { bytes } = await readPinnedFixture();
  const scratch = await mkdtemp(join(tmpdir(), 'native-tool-discovery-'));
  const childPath = relative(resolve(tmpdir()), resolve(scratch));
  assert.ok(childPath && !isAbsolute(childPath) && !childPath.startsWith('..'));
  t.after(async () => {
    await rm(scratch, { recursive: true, force: true });
    assert.deepEqual(await readFile(entry), bytes, 'pinned CLI unchanged');
  });
  // Optional real saved search contracts are copied to disposable scratch only.
  // Ordinary tests use their own differently named synthetic contracts below.
  const reference = process.env.NATIVE_TOOL_DISCOVERY_REAL_SCHEMAS;
  if (reference) await writeFile(join(scratch, 'reference-schemas.json'), await readFile(resolve(reference)));
  const script = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const entry=${JSON.stringify(entry)}, scratch=${JSON.stringify(scratch)};
const patch=${patch ? `(await import(${JSON.stringify(patchModule)})).patchToolDiscovery` : 'source => source'};
Bun.plugin({name:'isolated-tool-discovery',setup(build){
  build.onLoad({filter:/[\\\\/]cli\\.js$/},({path})=>{
    assert.equal(resolve(path),entry);
    const bytes=readFileSync(path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),${JSON.stringify(pinnedHash)});
    const source=patch(bytes.toString('utf8'));
    const startup='Rk().catch((e)=>{process.stderr.write(\x60codex-chatgpt-web: \x24{e instanceof Error?e.message:String(e)}\\n\x60),process.exitCode=1});';
    assert.equal(source.split(startup).length,2,'unique CLI startup disabled');
    return {contents:source.replace(startup,'')+'\\nexport { Fn as parseRequest, Ph as buildTools, Hm as describeTool, Wm as toolParameters, mt as wireName, ag as brokerResult, Xt as compilePrompt, dn as Broker };',loader:'js'};
  });
}});
const native=await import(pathToFileURL(entry).href);
const reference=${reference ? "JSON.parse(readFileSync(join(scratch,'reference-schemas.json'),'utf8')).schemas" : '[]'};
await (${suite.toString()})(native,reference);
console.log('tool discovery fixture passed');
`;
  const child = spawn(bun, ['run', '-'], {
    cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: join(scratch, 'app'),
      MAGPIE_NATIVE_BROWSER_CDP: '', CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS: '0' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const timeout = setTimeout(() => child.kill(), 75_000);
  child.stdin.end(script);
  try {
    const result = await exit;
    assert.equal(result.code, 0, `Bun fixture failed (${result.signal}):\n${stdout}\n${stderr}`);
    assert.match(stdout, /tool discovery fixture passed/);
    t.diagnostic('tool discovery fixture passed');
  } finally { clearTimeout(timeout); }
}

test('discovery contracts reach the real broker result and inline/multipart replay', pinned, async t => {
  await runPinned(t, async (native, reference) => {
    const synthetic = [{ type: 'namespace', name: 'audit_registry', tools: [{
      type: 'function', name: 'inspect_record', description: 'Inspect a distinct synthetic record.',
      parameters: { type: 'object', properties: { record_key: { type: 'string', minLength: 2 } },
        required: ['record_key'], additionalProperties: false },
    }] }];
    const cases = [synthetic];
    if (reference.length) cases.unshift(reference.map(tool => ({ type: 'function', ...tool })));
    for (const specs of cases) {
      const parsed = native.parseRequest({ model: 'gpt-5.6-sol', reasoning: { effort: 'high' }, input: [
        { role: 'user', content: 'Use the discovered contract.' },
        { type: 'tool_search_output', call_id: 'search_probe', status: 'completed', tools: specs },
      ] });
      const message = parsed.context.messages.find(message => message.role === 'toolResult');
      const result = native.brokerResult(message);
      assert.ok(result.structuredContent?.tools, 'search result must carry contracts, not only names: ' + message.content);
      const data = result.structuredContent;
      assert.deepEqual(JSON.parse(result.content[0].text), data);
      assert.equal(data.schemas_included, true);
      const expected = native.buildTools(specs).map(tool => ({
        wire_name: native.wireName(tool), name: tool.name, namespace: tool.namespace ?? null,
        description: native.describeTool(tool),
        kind: tool.freeform ? 'freeform' : tool.toolSearch ? 'tool_search' : 'function',
        parameters: native.toolParameters(tool),
      }));
      assert.deepEqual(data.tools, expected);
      // Complete an actual shipped broker invocation without starting its socket.
      const broker = new native.Broker('unused-offline-tool-discovery');
      broker.start = async () => {};
      try {
        const environment = { cwd: process.cwd(), roots: [process.cwd()], writableRoots: [],
          sandboxPolicy: { type: 'readOnly' }, tools: [] };
        const token = await broker.register(environment, undefined, 'discovery-fixture');
        const binding = await broker.dispatch({ method: 'claim', token, activityId: 'activity_0123456789abcdef', contract: 'native' });
        const waiting = broker.dispatch({ method: 'invoke', bindingId: binding.bindingId, wireName: 'tool_search', arguments: { query: 'fixture' } });
        const [call] = await broker.nextToolBatch(token);
        broker.updateEnvironment(token, { ...environment, tools: parsed.context.tools });
        broker.completeTool(token, call.callId, result);
        assert.deepEqual(await waiting, result);
        assert.deepEqual((await broker.dispatch({ method: 'resolve', bindingId: binding.bindingId })).environment.tools, parsed.context.tools);
        await broker.dispatch({ method: 'activity_complete', token, activityId: 'activity_0123456789abcdef' });
        assert.equal(broker.channels.get(token).activities.size, 0);
      } finally { await broker.close(); }
      const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
      for (const parts of [undefined, 2, 6]) {
        const compiled = native.compilePrompt(parsed, capabilities, 'turn_' + 'a'.repeat(32), { experimentalMultipartParts: parts });
        const messages = compiled.multipart
          ? compiled.multipart.parts.flatMap(part => JSON.parse(part).records).filter(r => r.kind === 'message').map(r => r.message)
          : JSON.parse(compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)[1]).messages;
        assert.deepEqual(JSON.parse(messages.find(m => m.role === 'tool_result').content), data);
      }
    }
  });
});

test('discovery transform rejects invalid source without optional fixtures', async () => {
  const { patchToolDiscovery } = await import(patchModule);
  for (const value of [null, {}, Buffer.from('source')]) assert.throws(() => patchToolDiscovery(value), TypeError);
  assert.throws(() => patchToolDiscovery(''), /anchor mismatch/);
});

test('all discovery anchors reject drift and duplicates; serialized preload transform is independent', pinned, async () => {
  const { source } = await readPinnedFixture();
  const { patchToolDiscovery } = await import(patchModule);
  const sites = [
    ['toolName:"tool_search",content:y&&R.length===0?', 'timestamp:o});continue}'],
    ['if(M==="tool_search_output"){', 'l.push(..._);let R=[];'],
    ['function Ph(e){', 'function cx('],
    ['function mt(e){', 'function to('],
    ['function Hm(e){', 'function Wm('],
    ['function Wm(e){', 'function Hv('],
    ['if(!Tl(e))return e.parameters;', 'r=n.timeout_ms'],
  ];
  for (const [start, end] of sites) {
    const at = source.indexOf(start), through = source.indexOf(end, at);
    assert.ok(at >= 0 && through > at);
    const anchor = source.slice(at, through + end.length);
    assert.throws(() => patchToolDiscovery(source.replace(start, () => '?' + start.slice(1))), /anchor mismatch/, start);
    assert.throws(() => patchToolDiscovery(source.replace(anchor, () => anchor + anchor)), /anchor mismatch/, start);
  }
  assert.throws(() => patchToolDiscovery(patchToolDiscovery(source)), /anchor mismatch/);
  assert.throws(() => patchToolDiscovery(source + '\n// magpieDiscoveredToolContracts'), /helper collision/);
  assert.equal(runInNewContext(`(${patchToolDiscovery.toString()})(source)`, { source }), patchToolDiscovery(source));
  const unrelated = '\n// unrelated preload patch $& $` $\'';
  assert.ok(patchToolDiscovery(source + unrelated).includes(unrelated));
});

test('discovery reuses shipped namespace, freeform, schema and transport projections without mutation', pinned, async t => {
  await runPinned(t, async native => {
    const rich = { type: 'object', $defs: { value: { type: 'string', enum: ['x', 'y'] } },
      properties: { arbitrary_key: { $ref: '#/$defs/value' } }, required: ['arbitrary_key'],
      additionalProperties: false, allOf: [{ not: { required: ['forbidden'] } }] };
    const specs = [
      { type: 'namespace', name: 'functions', tools: [
        { type: 'function', name: 'inspect_unique', description: 'Literal $& `name` 中文', parameters: rich },
        { type: 'custom', name: 'exec', description: 'Native freeform execution', format: { type: 'grammar', syntax: 'lark', definition: 'start: "x"' } },
      ] },
      { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'wait_agent', description: 'Wait fixture',
        parameters: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' } }, timeout_ms: { type: 'number', default: 900_000 } }, required: ['targets'] } }] },
      { type: 'function', name: 'write_stdin', description: 'Poll fixture', parameters: {
        type: 'object', properties: { session_id: { type: 'number' }, yield_time_ms: { type: 'number', default: 900_000 } }, required: ['session_id'] } },
      { type: 'namespace', name: 'audit_custom', tools: [{ type: 'function', name: 'inspect_other', parameters: rich }] },
      { type: 'custom', name: 'raw_unique', description: 'Raw input', format: { type: 'grammar', syntax: 'lark', definition: 'start: "ok"' } },
      { type: 'tool_search', description: 'Nested discovery' },
    ];
    const original = JSON.stringify(specs);
    const parsed = native.parseRequest({ model: 'gpt-5.6-sol', input: [{ type: 'tool_search_output', call_id: 'projection', tools: specs }] });
    const content = JSON.parse(parsed.context.messages[0].content);
    assert.equal(content.schemas_included, true);
    assert.deepEqual(content.tools, native.buildTools(specs).map(tool => ({ wire_name: native.wireName(tool), name: tool.name,
      namespace: tool.namespace ?? null, description: native.describeTool(tool),
      kind: tool.freeform ? 'freeform' : tool.toolSearch ? 'tool_search' : 'function', parameters: native.toolParameters(tool) })));
    const byName = name => content.tools.find(tool => tool.wire_name === name);
    assert.deepEqual(byName('inspect_unique').parameters, rich);
    assert.equal(byName('audit_custom__inspect_other').namespace, 'audit_custom');
    assert.equal(byName('multi_agent_v1__wait_agent').parameters.properties.timeout_ms.const, 30_000);
    assert.equal(byName('multi_agent_v1__wait_agent').parameters.properties.timeout_ms.default, undefined);
    assert.ok(byName('multi_agent_v1__wait_agent').parameters.required.includes('targets'));
    assert.ok(byName('multi_agent_v1__wait_agent').parameters.required.includes('timeout_ms'));
    assert.equal(byName('write_stdin').parameters.properties.yield_time_ms.maximum, 60_000);
    assert.equal(byName('write_stdin').parameters.properties.yield_time_ms.default, undefined);
    assert.equal(byName('raw_unique').kind, 'freeform');
    assert.deepEqual(byName('raw_unique').parameters.required, ['input']);
    assert.equal(byName('exec').kind, 'freeform');
    assert.match(byName('exec').description, /transport rule/);
    assert.equal(byName('tool_search').kind, 'tool_search');
    assert.equal(JSON.stringify(specs), original);
    assert.equal(parsed.context.tools.find(tool => tool.name === 'wait_agent').parameters.properties.timeout_ms.default, 900_000);
  });
});

test('oversized discovery uses bounded whole-result fallback, with exact UTF-8 boundary', pinned, async t => {
  await runPinned(t, async native => {
    const tool = { type: 'function', name: 'bounded_record', description: '', parameters: { type: 'object', properties: { key: { type: 'string' } } } };
    const result = specs => native.parseRequest({ model: 'gpt-5.6-sol', input: [{ type: 'tool_search_output', call_id: 'budget', tools: specs }] }).context.messages[0].content;
    const size = Buffer.byteLength(result([tool]));
    const exact = result([{ ...tool, description: 'a'.repeat(65_536 - size) }]);
    assert.equal(Buffer.byteLength(exact), 65_536);
    assert.equal(JSON.parse(exact).schemas_included, true);
    const cases = [
      [{ ...tool, description: 'a'.repeat(65_537 - size) }],
      [{ ...tool, description: '界'.repeat(30_000) }],
      [{ ...tool, parameters: { type: 'object', description: 'schema-must-not-be-truncated'.repeat(5_000) } }],
      Array.from({ length: 51 }, (_, i) => ({ ...tool, name: 'record_' + i })),
    ];
    for (const specs of cases) {
      const text = result(specs), data = JSON.parse(text);
      assert.ok(Buffer.byteLength(text) < 1_024);
      assert.equal(data.reason, 'tool_discovery_result_too_large');
      assert.equal(data.schemas_included, false);
      assert.equal(data.total, specs.length);
      assert.deepEqual(data.tools, []);
      assert.deepEqual(data.inventory, { tool: 'codex_tool_inventory', arguments: { include_schema: true, offset: 0, limit: 1 } });
      assert.ok(!text.includes('schema-must-not-be-truncated'));
    }
    assert.equal(JSON.parse(result(Array.from({ length: 50 }, (_, i) => ({ ...tool, name: 'record_' + i })))).schemas_included, true);
  });
});

test('unsupported or malformed discovery never advertises a complete partial registry', pinned, async t => {
  await runPinned(t, async native => {
    const valid = { type: 'function', name: 'valid_record', parameters: { type: 'object' } };
    const cases = [
      { type: 'namespace', name: 'foreign_custom', tools: [{ type: 'custom', name: 'not_callable', format: { type: 'grammar' } }] },
      { type: 'web_search', name: 'hosted_only' },
      { type: 'function', name: 'no_schema' },
      { type: 'function', name: 'bad_schema', parameters: 'object' },
      { type: 'function', name: 'bad_array', parameters: [] },
      { type: 'function', name: 'bad_description', description: 1, parameters: {} },
      { type: 'function', name: 'write_stdin', parameters: { properties: { yield_time_ms: 'invalid' } } },
      { type: 'function', parameters: {} },
    ];
    for (const unsupported of cases) {
      const parsed = native.parseRequest({ model: 'gpt-5.6-sol', input: [{ type: 'tool_search_output', call_id: 'unavailable', tools: [valid, unsupported] }] });
      const data = JSON.parse(parsed.context.messages[0].content);
      assert.equal(data.schemas_included, false);
      assert.equal(data.reason, 'tool_discovery_contract_unavailable');
      assert.deepEqual(data.tools, []);
      assert.ok(parsed.context.tools.some(tool => tool.name === 'valid_record'), 'builder still owns tool registration');
    }
    const onlyUnsupported = native.parseRequest({ model: 'gpt-5.6-sol', input: [{ type: 'tool_search_output', call_id: 'unavailable', tools: [cases[0]] }] });
    const absent = JSON.parse(onlyUnsupported.context.messages[0].content);
    assert.equal(absent.schemas_included, false);
    assert.equal(absent.total, 0);
  });
});

test('failure, empty and partial-error discovery outcomes retain original content and status', pinned, async t => {
  await runPinned(t, async native => {
    const tools = [{ type: 'function', name: 'partial_record', parameters: { type: 'object' } }];
    for (const status of [undefined, 'completed', 'success', 'failed', 'cancelled', 'in_progress']) {
      for (const specs of [[], tools]) {
        const failed = status !== undefined && !['completed', 'success'].includes(status);
        if (!failed && specs.length) continue;
        const parsed = native.parseRequest({ model: 'gpt-5.6-sol', input: [{ type: 'tool_search_output', call_id: 'preserve', status, tools: specs }] });
        const message = parsed.context.messages[0];
        const expected = specs.length
          ? 'Tool search loaded these tools — they are now in your available tools. Call one by its EXACT name: partial_record.'
          : failed ? `Tool search failed (status: ${status}).` : 'Tool search returned no tools.';
        assert.equal(message.content, expected);
        assert.equal(message.isError, failed && specs.length === 0);
        assert.equal(message.toolCallId, 'preserve');
        assert.equal(native.brokerResult(message).structuredContent, undefined);
      }
    }
    for (const tools of [undefined, null, {}]) {
      const parsed = native.parseRequest({ model: 'gpt-5.6-sol', input: [{ type: 'tool_search_output', call_id: 'empty', tools }] });
      assert.equal(parsed.context.messages[0].content, 'Tool search returned no tools.');
      assert.equal(parsed.context.messages[0].isError, false);
    }
  });
});
