// Executed only by the opt-in runtime test with the pinned Bun executable. All
// protocol, ownership, checkpoint and prompt code comes from the downloaded CLI.
// Substitute only browser generation; export aliases are injected by the test.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, phase] = process.argv.slice(2);
process.argv = [process.execPath, entry, '--version'];
const native = await import(pathToFileURL(entry).href);
const home = process.env.CODEX_CHATGPT_WEB_HOME;
const replayPath = join(home, 'replays.json');
const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const config = { mode: 'full', subagentProtocol: 'native', contextWindow: 256000,
  appName: 'Codex Compaction Fixture', browserHost: 'managed-chrome', browserInteractionMode: 'automatic',
  storageStatePath: join(home, 'storage.json'), brokerSocketPath: `\\\\.\\pipe\\compaction-bundle-${process.pid}`,
  headed: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const parse = body => { const parsed = native.parseRequest(body); native.route(parsed, config); return parsed; };
const restore = body => {
  const parsed = parse(body);
  return native.restore(parsed, native.identity(parsed), native.revisions(parsed));
};
const request = body => new Request('http://127.0.0.1/v1/responses', { method: 'POST', body: JSON.stringify(body) });
const checkpoint = summary => ({ type: 'compaction', encrypted_content: `ocx1:${Buffer.from(summary).toString('base64')}` });

if (phase === 'model-announcements') {
  const html = await readFile(new URL('./native-model-picker-fixture.html', import.meta.url), 'utf8');
  const browser = await native.chromium.launch({
    executablePath: process.env.CHATGPT_DOM_TEST_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  });
  try {
    const page = await browser.newPage();
    const menu = { menu: page.locator('#picker'), slider: page.locator('#picker [role="slider"]') };
    const set = async (options = {}) => {
      await page.setContent(html);
      await page.evaluate(({ rows, header, status, value, max, extra }) => {
        if (rows) {
          const container = document.querySelector('#model-rows');
          container.replaceChildren(...rows.map(([name, checked = true, attributes = {}]) => {
            const row = document.createElement('div');
            row.setAttribute('role', 'menuitemradio'); row.setAttribute('aria-checked', String(checked));
            row.textContent = name;
            for (const [key, value] of Object.entries(attributes)) row.setAttribute(key, value);
            return row;
          }));
        }
        if (header !== undefined) document.querySelector('#header-effort').textContent = header;
        if (status !== undefined) document.querySelector('#status').textContent = status;
        if (value !== undefined) document.querySelector('[role="slider"]').setAttribute('aria-valuenow', value);
        if (max !== undefined) document.querySelector('[role="slider"]').setAttribute('aria-valuemax', max);
        if (extra) document.body.insertAdjacentHTML('beforeend', extra);
      }, options);
    };
    await set();
    const original = ['High，第 3 项，共 5 项。', '使用左右方向键调整强度', 'High'];
    assert.deepEqual(await native.rawModelAnnouncements(menu.slider), original);
    assert.equal(native.familyMatches(original, '6', 'high'), false, 'unmodified compiled reader reproduces the live failure');
    assert.equal(await native.selectModelFamily(menu, '6', async () => menu, 'high'), menu);
    assert.deepEqual(await native.readAnnouncements(menu.slider), [...original, 'GPT-6 High']);
    await native.assertModelFamily(menu, '6', 'high', 2);
    for (const [label, header, family, effort, index, max = 4] of [
      ['6', 'High', '6', 'high', 2], ['GPT-6', 'Pro', '6', 'max', 4],
      ['GPT-5.6 Sol', 'High', '5.6', 'high', 2], ['GPT-6 Sol', 'Extra High', '6', 'xhigh', 3],
      ['GPT-6 Astra', 'Max', '6', 'max', 4, 5], ['GPT-6', '高', '6', 'high', 2],
      ['GPT-6', '中', '6', 'medium', 1], ['GPT-6', '即时', '6', 'low', 0],
    ]) {
      await set({ rows: [[label]], header, status: `${header}，第 ${index + 1} 项，共 ${max + 1} 项。`, value: index, max });
      await native.assertModelFamily(menu, family, effort, index);
    }
    const negatives = [
      { rows: [['GPT-6', false], ['GPT-5.6 Sol', false]] },
      { rows: [['GPT-6'], ['GPT-5.6 Sol']] }, { rows: [['GPT-6'], ['GPT-6']] },
      { rows: [['GPT-6'], ['GPT-6', false]] }, { rows: [['GPT-6'], ['Unknown selected model']] },
      { rows: [['GPT-5.6 Sol']] }, { rows: [['GPT-6.1 Sol']] }, { rows: [['Latest']] },
      { rows: [['Default']] }, { rows: [['GPT-6 GPT-5.6 Sol']] },
      { rows: [['GPT-6 Astra']] },
      { rows: [['GPT-6 Sol'], ['GPT-6 Astra', false]], header: 'Pro', status: 'Pro，第 5 项，共 5 项。', value: 4, effort: 'max', index: 4 },
      { header: 'Medium', status: 'Medium，第 3 项，共 5 项。' }, { value: 1 },
      { header: 'High performance' }, { header: 'High (recommended)' },
      { status: 'Medium，第 2 项，共 5 项。' },
      { status: '5.6 Sol High，第 3 项，共 5 项。' },
      { status: '6 Astra High，第 3 项，共 5 项。' },
      { status: '6 Medium，第 3 项，共 5 项。' },
      { header: '5.6 Sol High' },
      { rows: [['GPT-6', true, { 'aria-label': 'GPT-5.6 Sol' }]] },
      { rows: [['GPT-6', true, { 'aria-labelledby': 'outside-label' }]], extra: '<span id="outside-label">GPT-6</span>' },
    ];
    for (const options of negatives) {
      await set(options);
      if (/^(?:5\.6|6) /.test(options.status ?? '') || options.header === '5.6 Sol High') {
        assert.deepEqual(await native.readAnnouncements(menu.slider), await native.rawModelAnnouncements(menu.slider),
          'contradictory version/name/mode evidence must be returned intact');
      }
      await assert.rejects(native.assertModelFamily(menu, '6', options.effort ?? 'high', options.index ?? 2),
        error => error.code === 'model_version_unavailable', JSON.stringify(options));
    }
    // Other menus and hidden headers must not create or override own-menu proof.
    await set({ extra: '<div role="menu"><div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div><div data-model-picker-view-toggle="true">5.6 Sol High</div></div>' });
    await page.locator('#picker').evaluate(node => node.insertAdjacentHTML('beforeend',
      '<div role="menu"><div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div></div><div data-model-picker-view-toggle="true" hidden>5.6 High</div>'));
    await native.assertModelFamily(menu, '6', 'high', 2);
    await page.locator('#model-rows [aria-checked="true"]').evaluate(row => row.setAttribute('aria-checked', 'false'));
    await assert.rejects(native.assertModelFamily(menu, '6', 'high', 2), error => error.code === 'model_version_unavailable');
    await set({ header: '6 High', status: '6 High，第 3 项，共 5 项。' });
    assert.deepEqual(await native.readAnnouncements(menu.slider), await native.rawModelAnnouncements(menu.slider));
    await native.assertModelFamily(menu, '6', 'high', 2);
    await set();
    await page.locator('#picker').evaluate(node => node.insertAdjacentHTML('beforeend', '<div data-model-picker-view-toggle="true">High</div>'));
    await assert.rejects(native.assertModelFamily(menu, '6', 'high', 2), /multiple active model headers/);
    assert.equal(await page.locator('#prompt-textarea').textContent(), 'Unsent fixture draft');
  } finally { await browser.close(); }
} else if (phase === 'cdp-ownership') {
  await writeFile(config.storageStatePath, JSON.stringify({ cookies: [], origins: [] }));
  await writeFile(`${config.storageStatePath}.verified.json`, JSON.stringify({ authenticated: true }));
  const workerConfig = { ...config, chromeExecutablePath: process.execPath };
  let launches = 0, connections = 0, disconnects = 0, contextsCreated = 0;
  const page = { isClosed: () => false };
  const borrowed = { newPage: async () => page, close() { assert.fail('backend owns the borrowed context'); } };
  const chromium = native.chromium;
  chromium.launch = async options => {
    assert.deepEqual(options, { executablePath: process.execPath, headless: true });
    launches++;
    return { async newContext(options) {
      assert.deepEqual(options, { storageState: config.storageStatePath });
      contextsCreated++;
      return { newPage: async () => page };
    }, close: async () => {} };
  };
  chromium.connectOverCDP = async endpoint => {
    assert.equal(endpoint, 'http://127.0.0.1:9222');
    connections++;
    const browser = { contexts: () => [borrowed],
      newContext() { assert.fail('CDP attachment must not create an incognito context'); },
      async close() { assert.equal(this, browser); disconnects++; } };
    return browser;
  };
  const worker = () => Object.assign(Object.create(native.Worker.prototype), {
    config: workerConfig, activeRuns: new Map(), maintenanceTail: Promise.resolve(),
  });
  for (const method of ['ensurePage', 'ensureManagedBrowser']) {
    delete process.env.MAGPIE_NATIVE_BROWSER_CDP;
    const owned = worker();
    await owned[method]();
    assert.notEqual(owned.context, borrowed);
    await owned.close();
    process.env.MAGPIE_NATIVE_BROWSER_CDP = 'http://127.0.0.1:9222';
    const attached = worker();
    await attached[method]();
    assert.equal(attached.context, borrowed);
    const connection = attached.browser;
    // A worker reuses its own connection; its close path leaves the borrowed
    // browser/context available for the backend and the next worker attachment.
    await attached[method]();
    assert.equal(attached.browser, connection);
    await attached.close();
    assert.equal(attached.context, undefined);
    assert.equal(await borrowed.newPage(), page);
    process.env.MAGPIE_NATIVE_BROWSER_CDP = 'http://remote.invalid:9222';
    await assert.rejects(worker()[method](), /Invalid MAGPIE_NATIVE_BROWSER_CDP/);
  }
  assert.equal(launches, 2);
  assert.equal(contextsCreated, 2);
  assert.equal(connections, 2);
  assert.equal(disconnects, 2);
} else if (phase === 'persistence-failure') {
  const state = join(home, 'checkpoints.bin'), backup = join(home, 'checkpoints.fixture-backup');
  await rename(state, backup); await mkdir(state);
  native.Worker.forProvider = () => ({ appName: 'Fixture', async run(options) {
    const text = 'Uncommitted summary'; options.onTextDelta?.(text); return text;
  } });
  try {
    for (const kind of ['v1', 'v2', 'v2-stream', 'memento-stream']) {
      const turn = `failed-write-${kind}`;
      const task = { type: 'message', role: 'user', id: 'failed-write-task', content: 'Must not gain durable authority',
        internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ['goal.internal_context'] } };
      const body = { model: 'chatgpt-web/high', stream: kind.endsWith('stream'), input: [task],
        client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: turn, turn_id: turn,
          ...(kind.startsWith('memento') ? { request_kind: 'compaction', compaction: { implementation: 'responses', strategy: 'memento' } } : {}) }) } };
      if (kind.startsWith('v2')) body.input.push({ type: 'compaction_trigger' });
      try {
        const response = await (kind === 'v1' ? native.compactRequest : native.responseRequest)(request(body), config);
        const text = await response.text();
        if (body.stream) assert.doesNotMatch(text, /"type":"response.completed"/);
        else assert.notEqual(response.status, 200);
      } catch (error) { assert.match(error.message, /Native checkpoint/); }
      assert.equal(restore({ ...body, input: [checkpoint('Uncommitted summary')] }).some(message => message.content === task.content), false);
    }
  } finally { await rm(state, { recursive: true }); await rename(backup, state); }
} else if (phase === 'durable-recompact') {
  const replays = JSON.parse(await readFile(replayPath, 'utf8'));
  for (const replay of replays) {
    native.Worker.forProvider = () => ({ appName: 'Restarted compaction fixture', async run(options) {
      const prompt = await options.prepare();
      assert.ok(prompt.text.includes('Implement the next checked milestone.'), 'recompaction after restart retains the authorized task');
      const summary = `Restarted checkpoint ${JSON.parse(replay.body.client_metadata['x-codex-turn-metadata']).thread_id}`;
      options.onTextDelta?.(summary);
      return summary;
    } });
    const response = await native.responseRequest(request({ ...replay.body, input: [...replay.body.input, { type: 'compaction_trigger' }] }), config);
    const result = await response.json();
    assert.equal(result.status, 'completed', JSON.stringify(result));
    replay.body = { ...replay.body, input: [replay.body.input[0], ...result.output,
      { type: 'function_call', call_id: 'latest', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'latest', output: 'LATEST_TOOL_RESULT' }] };
    assert.equal(restore(replay.body).filter(message => message.content === replay.taskText).length, 1);
  }
  await writeFile(replayPath, JSON.stringify(replays));
} else if (phase === 'durable-fresh') {
  for (const { body, taskText } of JSON.parse(await readFile(replayPath, 'utf8'))) {
    const before = JSON.stringify(body);
    assert.equal(restore(body).filter(message => message.content === taskText).length, 1);
    const response = await native.responseRequest(request(body), config, () => ({
      name: 'restarted-continuation-observer', async runTurn(parsed, _incoming, emit) {
        const prompt = native.compilePrompt(parsed, capabilities, 'turn_12345678901234567890123456789012');
        const match = prompt.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/);
        assert.ok(match);
        const messages = JSON.parse(match[1]).messages;
        const taskIndex = messages.findIndex(message => message.content === taskText);
        assert.ok(taskIndex >= 0);
        assert.ok(taskIndex < messages.findIndex(message => message.content === 'LATEST_TOOL_RESULT'));
        emit({ type: 'text_delta', text: 'Restarted task accepted.', phase: 'final_answer' });
        emit({ type: 'done', stopReason: 'stop', endTurn: true });
      },
    }), { rememberState: false });
    assert.equal((await response.json()).status, 'completed');
    assert.equal(JSON.stringify(body), before);
    const identity = JSON.parse(body.client_metadata['x-codex-turn-metadata']);
    for (const field of ['thread_id', 'turn_id']) {
      const changed = { ...body, client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ ...identity, [field]: 'foreign' }) } };
      assert.equal(restore(changed).some(message => message.content === taskText), false);
    }
    for (const field of ['model', 'effort']) {
      const parsed = parse(body);
      if (field === 'model') parsed.modelId = 'foreign-model'; else parsed.options.reasoning = 'low';
      assert.equal(native.restore(parsed, native.identity(parsed), native.revisions(parsed)).some(message => message.content === taskText), false);
    }
    const unknown = { ...body, input: [...body.input, checkpoint('Unissued checkpoint after restart')] };
    assert.equal(restore(unknown).some(message => message.content === taskText), false);
    const steering = { ...body, input: [...body.input, { type: 'message', role: 'user', id: 'steering', content: 'Stop implementation.',
      internal_chat_message_metadata_passthrough: { turn_id: identity.turn_id } }] };
    assert.equal(restore(steering).some(message => message.content === taskText), false);
  }
} else if (phase === 'fresh-process') {
  for (const { body, taskText } of JSON.parse(await readFile(replayPath, 'utf8'))) {
    const parsed = parse(body);
    assert.equal(native.restore(parsed, native.identity(parsed), []), parsed.context.messages);
    assert.equal(restore(body).some(message => message.content === taskText), false);
  }
} else {
  let summary = '', browserCalls = 0, failBrowser = false;
  native.Worker.forProvider = () => ({ appName: 'Codex Compaction Fixture', async run(options) {
    browserCalls++;
    assert.equal(options.compaction, true);
    assert.equal(options.capabilities.localToolsEnabled, false);
    const prompt = await options.prepare();
    assert.ok(prompt.text.includes('CONTEXT CHECKPOINT COMPACTION'));
    assert.equal(prompt.text.includes('codex_compaction_control'), false);
    if (failBrowser) throw new Error('Fixture generation failed');
    options.onTextDelta?.(summary);
    return summary;
  } });
  const replays = [];
  for (const kind of ['v1', 'v2', 'memento', 'v2-stream', 'memento-stream']) for (const taskKind of ['goal', 'delegation']) {
    const protocol = kind.replace('-stream', '');
    const turn = `turn-${kind}-${taskKind}`;
    const identity = { thread_id: `thread-${kind}-${taskKind}`, turn_id: turn };
    const human = { type: 'message', role: 'user', id: 'human', content: [{ type: 'input_text', text: 'Report status only.' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'earlier' } };
    const taskText = taskKind === 'goal'
      ? '<codex_internal_context source="goal">Implement the next checked milestone.</codex_internal_context>'
      : '<codex_delegation><source_thread_id>coordinator</source_thread_id><input>Implement the next checked milestone.</input></codex_delegation>';
    const task = taskKind === 'goal'
      ? { type: 'message', role: 'user', id: 'task', content: taskText,
        internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ['goal.internal_context'] } }
      : { type: 'function_call_output', id: 'task', name: 'send_message_to_thread', namespace: 'codex_app',
        output: taskText, internal_chat_message_metadata_passthrough: { turn_id: turn } };
    const base = { model: 'chatgpt-web/high', stream: kind.endsWith('-stream'), input: [human, task],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify(identity) } };
    summary = `Exact completed checkpoint ${kind} ${taskKind}.`;
    const compact = async body => {
      const payload = protocol === 'memento' ? { ...body, client_metadata: { 'x-codex-turn-metadata': JSON.stringify({
        ...identity, request_kind: 'compaction', compaction: { implementation: 'responses', strategy: 'memento' },
      }) } } : protocol === 'v2' ? { ...body, input: [...body.input, { type: 'compaction_trigger' }] } : body;
      const response = await (protocol === 'v1' ? native.compactRequest : native.responseRequest)(request(payload), config);
      const result = base.stream
        ? (await response.text()).split('\n').filter(line => line.startsWith('data: {'))
          .map(line => JSON.parse(line.slice(6))).find(event => event.type === 'response.completed')?.response
        : await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.ok(result, 'stream must complete before continuation can be accepted');
      assert.ok(result.output.length, JSON.stringify(result));
      if (protocol !== 'v1') assert.equal(result.status, 'completed', JSON.stringify(result));
      if (protocol === 'memento') {
        assert.equal(result.output[0].type, 'message');
        assert.equal(result.output[0].content[0].text, summary);
        // Native memento installs the returned assistant text as a readable user
        // summary, with its exact content and current-turn attribution.
        return [human, { type: 'message', role: 'user', content: [{ type: 'input_text',
          text: `${native.summaryPrefix}\n${result.output[0].content[0].text}` }],
          internal_chat_message_metadata_passthrough: { turn_id: turn } }];
      }
      return protocol === 'v1' ? result.output : [human, ...result.output];
    };
    const count = browserCalls;
    let input = (await compact(base)).filter(item => item.id !== task.id);
    assert.equal(browserCalls, count + 1);
    const initial = { ...base, input };
    assert.equal(restore(initial).filter(message => message.content === taskText).length, 1);

    // Recompaction must recover the omitted producer-defined task, not replace it
    // with the older retained human instruction or arbitrary summary wording.
    summary = `Second completed checkpoint ${kind} ${taskKind}.`;
    input = (await compact(initial)).filter(item => item.id !== task.id);
    const latestResult = { type: 'function_call_output', call_id: 'latest', output: 'LATEST_TOOL_RESULT' };
    assert.equal(restore(initial).some(message => message.content === taskText), false, 'older checkpoint is superseded');
    const body = { ...base, stream: false, input: [...input, { type: 'function_call', call_id: 'latest', name: 'exec_command', arguments: '{}' }, latestResult] };
    assert.equal(restore(body).filter(message => message.content === taskText).length, 1, `${kind} ${taskKind} recompaction restores the task`);

    // The next full-mode Responses request compiles the restored task into the
    // actual model-facing context, before the new tool result, without raw edits.
    const response = await native.responseRequest(request(body), config, provider => {
      assert.equal(provider.chatgptWeb.localToolsEnabled, true);
      return { name: 'continuation-observer', async runTurn(parsed, _incoming, emit) {
        const before = JSON.stringify(parsed);
        const prompt = native.compilePrompt(parsed, capabilities, 'turn_12345678901234567890123456789012');
        const match = prompt.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/);
        assert.ok(match);
        const messages = JSON.parse(match[1]).messages;
        const taskIndex = messages.findIndex(message => message.content === taskText);
        assert.ok(taskIndex >= 0);
        assert.equal(messages[taskIndex].role, taskKind === 'goal' ? 'user' : 'agent_message');
        assert.ok(taskIndex < messages.findIndex(message => message.content === 'LATEST_TOOL_RESULT'));
        assert.equal(JSON.stringify(parsed), before);
        emit({ type: 'text_delta', text: 'Restored task.', phase: 'final_answer' });
        emit({ type: 'done', stopReason: 'stop', endTurn: true });
      } };
    }, { rememberState: false });
    assert.equal((await response.json()).status, 'completed');

    for (const change of [{ thread_id: 'other-account-thread' }, { turn_id: 'other-turn' }]) {
      assert.equal(restore({ ...body, client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ ...identity, ...change }) } })
        .some(message => message.content === taskText), false);
    }
    for (const field of ['model', 'effort']) {
      const parsed = parse(body);
      if (field === 'model') parsed.modelId = 'other-model';
      else parsed.options.reasoning = 'low';
      assert.equal(native.restore(parsed, native.identity(parsed), native.revisions(parsed)).some(message => message.content === taskText), false);
    }
    const changedSummary = { ...base, input: [human, checkpoint('Unissued summary')] };
    assert.equal(restore(changedSummary).some(message => message.content === taskText), false);
    const foreignOwner = { ...base, input: [human, { ...checkpoint(summary), internal_chat_message_metadata_passthrough: { turn_id: 'other-turn' } }] };
    assert.equal(restore(foreignOwner).some(message => message.content === taskText), false);
    const steering = { ...body, input: [...body.input, { type: 'message', role: 'user', id: 'steering', content: 'Stop implementation.',
      internal_chat_message_metadata_passthrough: { turn_id: turn } }] };
    assert.equal(restore(steering).some(message => message.content === taskText), false);
    replays.push({ body, taskText });
  }

  // Launcher and unconfigured hosts retain the reference control requirement.
  for (const browserHost of ['launcher', undefined]) {
    const guarded = { model: 'chatgpt-web/high', stream: false, input: [{ type: 'message', role: 'user', id: 'guarded',
      content: [{ type: 'input_text', text: 'Guarded task' }], internal_chat_message_metadata_passthrough: { turn_id: 'guarded' } }],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: `guarded-${browserHost}`, turn_id: 'guarded' }) } };
    const count = browserCalls;
    const response = await native.compactRequest(request(guarded), { ...config, browserHost });
    const rejected = await response.json();
    assert.equal(response.status, 400, JSON.stringify(rejected));
    assert.equal(rejected.error.code, 'compaction_control_unavailable');
    assert.equal(browserCalls, count);
  }

  // Failed generation must not mint a checkpoint. Exact scope/summary matching
  // is still enforced by the native registry, not by the magpie HTTP endpoint.
  failBrowser = true;
  const failedTask = { type: 'message', role: 'user', id: 'failed-task', content: 'Failed task provenance',
    internal_chat_message_metadata_passthrough: { turn_id: 'failed-turn', content_item_kinds: ['goal.internal_context'] } };
  const failed = { model: 'chatgpt-web/high', stream: false, input: [failedTask],
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'failed-thread', turn_id: 'failed-turn' }) } };
  const failure = await native.compactRequest(request(failed), config);
  assert.notEqual(failure.status, 200);
  assert.equal(restore({ ...failed, input: [checkpoint(summary)] }).some(message => message.content === failedTask.content), false);
  await writeFile(replayPath, JSON.stringify(replays));
}
await native.close();
console.log(`${phase}: passed`);
