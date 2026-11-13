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

if (phase === 'compaction-retirement') {
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const bounded = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture stalled: ${label}`)), 2000);
      })]);
    } finally { clearTimeout(timer); }
  };
  // This is an observation interval, not a replacement for the broker's 90s timeout.
  const observe = () => new Promise(resolve => setTimeout(resolve, 60));
  for (const scenario of ['reordered-content', 'changed-content', 'matching', 'omitted-reasoning', 'changed-reasoning', 'different-turn-unattributed', 'missing-item-id', 'different-namespace']) {
    const sourcePrepared = deferred(), sourceAborted = deferred(), physicalRelease = deferred();
    const compactEntered = deferred(), compactStarted = deferred();
    let sourceOptions, compactOptions, sourceParsed, compactParsed, sourceProvider, compactProvider;
    let sourceSession, token, binding, invokeOutcome, pendingCompact, cancellationAt, compactFinished = false;
    const sourceEvents = [], compactEvents = [];
    const fixtureConfig = { ...config, brokerSocketPath: `${config.brokerSocketPath}-${scenario}` };
    const broker = native.TurnBroker.forSocket(fixtureConfig.brokerSocketPath);
    const sourceTurn = `source-${scenario}`, thread = `thread-${scenario}`;
    const environment = `<environment_context><cwd>${home}</cwd><filesystem><workspace_roots><root>${home}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
    const body = {
      model: 'chatgpt-web/gpt-5.6-sol', stream: false, reasoning: { effort: 'high' },
      tools: [{ type: 'function', name: 'exec_command', description: 'Offline inert command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: thread, turn_id: sourceTurn }) },
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: environment }],
          internal_chat_message_metadata_passthrough: { turn_id: sourceTurn } },
        { type: 'message', id: 'fixture-instruction', role: 'user', content: [{ type: 'input_text', text: 'Inspect the offline fixture and report the result.' }],
          internal_chat_message_metadata_passthrough: { turn_id: sourceTurn } },
      ],
    };
    const factory = kind => provider => {
      // Observe the real HTTP route/provider and delegate unchanged to the pinned adapter.
      const adapter = native.createAdapter(provider);
      return { ...adapter, runTurn(parsed, incoming, emit) {
        if (kind === 'source') { sourceParsed = parsed; sourceProvider = provider; }
        else { compactParsed = parsed; compactProvider = provider; compactEntered.resolve(); }
        return adapter.runTurn(parsed, incoming, event => {
          (kind === 'source' ? sourceEvents : compactEvents).push(event);
          emit(event);
        });
      } };
    };
    native.Worker.forProvider = () => ({
      appName: config.appName,
      async run(options) {
        const prepared = await options.prepare();
        if (!options.compaction) {
          sourceOptions = options;
          assert.equal(options.capabilities.localToolsEnabled, true);
          const aborted = () => { cancellationAt = performance.now(); sourceAborted.resolve(); };
          options.abortSignal.addEventListener('abort', aborted, { once: true });
          if (options.abortSignal.aborted) aborted();
          sourcePrepared.resolve();
          // Model the browser's captured text boundary, using the real progress
          // reader acknowledgement; this is not delivery of the tool result.
          const batch = await options.externalProgress.waitForChange(0, options.abortSignal);
          await options.externalProgress.acknowledgeToolBatch(batch.lastToolBatchRevision);
          // Real adapter cancellation must abort us. Physical browser teardown is a
          // separate boundary, deliberately held after abort to expose ownership waits.
          await sourceAborted.promise;
          await physicalRelease.promise;
          prepared.release?.();
          throw options.abortSignal.reason ?? new DOMException('Fixture browser cancelled', 'AbortError');
        }
        compactOptions = options;
        assert.equal(options.capabilities.localToolsEnabled, false);
        assert.equal(options.completionFence, undefined);
        assert.match(prepared.text, /INERT_COMPACT_RESULT/);
        assert.ok(!prepared.text.includes(token), 'compact prompt must not inherit the source capability');
        compactStarted.resolve();
        const summary = 'Offline checkpoint: inert tool output recorded; continue the original task.';
        options.onTextDelta?.(summary);
        prepared.release?.();
        return summary;
      },
    });
    try {
      const sourceResponse = native.responseRequest(request(body), fixtureConfig, factory('source'));
      await bounded(sourcePrepared.promise, 'source browser prepared');
      const sourceKey = `${native.namespace(sourceProvider)}:${native.executionKey(sourceParsed)}`;
      if (scenario === 'reordered-content') {
        const reorder = value => Array.isArray(value) ? value.map(reorder)
          : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
        const reordered = parse(reorder(body));
        assert.equal(native.executionKey(sourceParsed), native.executionKey(reordered));
        assert.equal(native.roundKey(sourceParsed), native.roundKey(reordered));
        assert.deepEqual(native.instructionLineage(sourceParsed), native.instructionLineage(reordered));
        for (const change of [
          p => { p.modelId += '-different'; },
          p => { p.options.reasoning = 'medium'; },
          p => { p._rawBody.input[1].id += '-different'; },
          p => { p._rawBody.input[1].content[0].text += ' '; },
          p => { p._rawBody.input[1].content[0].extra = true; },
        ]) {
          const changed = parse(structuredClone(body)); change(changed);
          assert.notEqual(native.executionKey(sourceParsed), native.executionKey(changed));
        }
        const orderedBody = structuredClone(body);
        orderedBody.input[1].content.push({ type: 'input_text', text: 'Second ordered instruction.' });
        const ordered = parse(orderedBody);
        const swappedBody = structuredClone(orderedBody); swappedBody.input[1].content.reverse();
        const swapped = parse(swappedBody);
        assert.notEqual(native.executionKey(ordered), native.executionKey(swapped));
        assert.notEqual(native.instructionLineage(ordered).current, native.instructionLineage(swapped).current);
      }
      sourceSession = native.sessions.find(sourceKey);
      assert.ok(sourceSession, 'real adapter registered the source runtime');
      assert.equal(sourceSession.runtime.mode, 'tools');
      assert.equal(sourceSession.conversationKey(), undefined, 'managed Chrome has no launcher retained-conversation head');
      token = await sourceSession.runtime.token;
      binding = await native.callBroker(fixtureConfig.brokerSocketPath, { method: 'claim', token });
      invokeOutcome = native.callBroker(fixtureConfig.brokerSocketPath, {
        method: 'invoke', bindingId: binding.bindingId, wireName: 'exec_command', freeform: false,
        arguments: { cmd: 'inert-offline-fixture-only' },
      }, 90_000).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
      const response = await bounded(sourceResponse, 'native source tool call');
      assert.equal(response.status, 200);
      const call = sourceEvents.find(event => event.type === 'tool_call_start');
      assert.ok(call, 'real broker invocation was emitted to the native caller');
      assert.equal(sourceSession.outstanding().length, 1);
      assert.equal(sourceSession.outstanding()[0].callId, call.id);
      const compactBody = structuredClone(body);
      compactBody.client_metadata['x-codex-turn-metadata'] = JSON.stringify({
        thread_id: thread, turn_id: scenario === 'different-turn-unattributed' ? `compact-${scenario}` : sourceTurn, request_kind: 'compaction',
        compaction: { trigger: 'auto', phase: 'mid_turn', implementation: 'responses', strategy: 'memento' },
      });
      if (scenario === 'missing-item-id') delete compactBody.input[1].id;
      if (scenario === 'reordered-content') {
        compactBody.input[1].content = compactBody.input[1].content.map(({ type, text }) => ({ text, type }));
        assert.notEqual(JSON.stringify(compactBody.input[1].content), JSON.stringify(body.input[1].content));
      }
      if (scenario === 'changed-content') compactBody.input[1].content[0].text += ' Changed instruction.';
      if (scenario === 'omitted-reasoning') delete compactBody.reasoning;
      if (scenario === 'changed-reasoning') compactBody.reasoning.effort = 'medium';
      if (scenario === 'different-turn-unattributed') {
        for (const item of compactBody.input) delete item.internal_chat_message_metadata_passthrough;
      }
      compactBody.input.push({ type: 'function_call', call_id: call.id, name: 'exec_command', arguments: JSON.stringify({ cmd: 'inert-offline-fixture-only' }) },
        { type: 'function_call_output', call_id: call.id, output: 'INERT_COMPACT_RESULT: completed offline',
          internal_chat_message_metadata_passthrough: { turn_id: sourceTurn } });
      const compactConfig = scenario === 'different-namespace'
        ? { ...fixtureConfig, automaticAppName: 'Changed offline provider namespace' } : fixtureConfig;
      const startedAt = performance.now();
      pendingCompact = native.compactRequest(request(compactBody), compactConfig, factory('compact'))
        .then(async result => { compactFinished = true; return { status: result.status, body: await result.json() }; });
      await bounded(compactEntered.promise, 'compact adapter entry');
      const lookupKey = `${native.namespace(compactProvider)}:${native.sourceKey(compactParsed)}`;
      const sameNamespace = native.namespace(sourceProvider) === native.namespace(compactProvider);
      const sameOwner = sameNamespace && native.ownerKey(sourceParsed) === native.ownerKey(compactParsed);
      const sourceLineage = native.instructionLineage(sourceParsed);
      const compactLineage = native.instructionLineage(compactParsed);
      const sameInstruction = sourceLineage.current === compactLineage.current;
      const sourceIsPredecessor = compactLineage.predecessors.has(sourceLineage.current);
      const reasoning = { source: sourceParsed.options.reasoning, compact: compactParsed.options.reasoning };
      const matched = ['matching', 'reordered-content'].includes(scenario) || (scenario === 'omitted-reasoning' && reasoning.source === reasoning.compact);
      assert.equal(lookupKey === sourceKey, matched);
      assert.equal(sameOwner, scenario !== 'different-namespace');
      assert.equal(sameInstruction, !['missing-item-id', 'changed-content'].includes(scenario));
      if (['missing-item-id', 'changed-content'].includes(scenario)) {
        const failed = await bounded(pendingCompact, 'conflicting instruction rejection');
        assert.match(failed.body.error?.message ?? '', /newer Codex instruction superseded/);
        assert.equal(failed.status, 502);
        assert.equal(sourceOptions.abortSignal.aborted, false);
        assert.equal(native.sessions.find(sourceKey), sourceSession);
        assert.equal(compactOptions, undefined);
        assert.equal(sourceIsPredecessor, false, 'conflicting source is neither current nor a canonical predecessor');
        console.log(`retirement-evidence: ${JSON.stringify({ scenario, sourceLookupMatched: false,
          sameNamespace, sameOwner, sameInstruction, sourceIsPredecessor, reasoning,
          cancelledBeforeSettlement: false, compactError: failed.body.error.code,
          sourceToolOutputDelivered: false, timeoutReleaseInjected: false })}`);
        continue;
      }
      let cancelledBeforeSettlement;
      if (matched) {
        await bounded(sourceAborted.promise, 'matched retirement abort');
        assert.throws(() => broker.updateEnvironment(token, {}), /invalid or expired/);
        assert.equal((await bounded(invokeOutcome, 'revoked invocation')).ok, false,
          'compact output was not delivered as a tool completion');
        assert.equal(native.sessions.find(sourceKey), undefined);
        await observe();
        assert.equal(compactOptions, undefined, 'fresh browser waits for physical teardown');
        assert.equal(compactFinished, false);
        cancelledBeforeSettlement = true;
      } else {
        if (scenario === 'different-namespace') await bounded(compactStarted.promise, 'independent compact browser');
        else await observe();
        assert.equal(sourceOptions.abortSignal.aborted, false, 'lookup miss did not cancel the source');
        assert.equal(native.sessions.find(sourceKey), sourceSession);
        assert.doesNotThrow(() => broker.updateEnvironment(token, {
          cwd: home, roots: [home], writableRoots: [home], sandboxPolicy: { type: 'dangerFullAccess' }, tools: sourceParsed.context.tools,
        }));
        if (sameOwner) {
          assert.equal(compactOptions, undefined, 'same owner waits after empty source retirement');
          assert.equal(compactFinished, false);
        }
        cancelledBeforeSettlement = false;
        // Inject the real MCP timeout-release protocol only after proving the miss.
        // No 90s clock is simulated: this tests the failure transition, not elapsed time.
        await native.callBroker(fixtureConfig.brokerSocketPath, { method: 'release', bindingId: binding.bindingId,
          failure: { code: 'codex_tool_timeout', tool: 'exec_command', timeoutMs: 90_000 } });
        await bounded(sourceAborted.promise, 'timeout release abort');
        assert.equal(sourceOptions.abortSignal.reason.code, 'codex_tool_timeout');
        assert.equal((await bounded(invokeOutcome, 'timeout invocation')).ok, false);
      }
      const beforePhysicalReleaseMs = Math.round(performance.now() - startedAt);
      assert.equal(sourceSession.isPhysicallySettled(), false, 'abort is separate from browser cleanup settlement');
      physicalRelease.resolve();
      const compactResponse = await bounded(pendingCompact, 'compact after physical settlement');
      assert.equal(compactResponse.status, 200, JSON.stringify(compactResponse.body));
      assert.equal(compactResponse.body.error, undefined);
      assert.equal(compactEvents.some(event => event.type === 'tool_call_start'), false);
      assert.ok(compactOptions);
      const compactSession = native.sessions.find(`${native.namespace(compactProvider)}:${native.executionKey(compactParsed)}`);
      assert.equal(compactSession.runtime.mode, 'read-only');
      assert.equal(compactSession.runtime.token, undefined);
      assert.equal(sourceSession.outstanding().length, 1, 'incoming compact output never completed the source call');
      console.log(`retirement-evidence: ${JSON.stringify({ scenario, sourceLookupMatched: lookupKey === sourceKey,
        sameNamespace, sameOwner, sameInstruction, sourceIsPredecessor, reasoning, cancelledBeforeSettlement, beforePhysicalReleaseMs,
        ...(matched ? { cancellationMs: Math.round(cancellationAt - startedAt) } : {}),
        compactReadOnly: true, sourceToolOutputDelivered: false, timeoutReleaseInjected: !matched })}`);
    } finally {
      sourceSession?.cancel(new Error('Offline fixture cleanup'));
      physicalRelease.resolve();
      native.sessions.clear();
      await broker.close();
      await invokeOutcome;
      if (pendingCompact) await bounded(pendingCompact, 'cleanup');
    }
  }
} else if (phase === 'turn-tokens') {
  const broker = new native.TurnBroker(config.brokerSocketPath);
  try {
    const token = await broker.register({});
    assert.match(token, /^turn_[0123456789abcdefghjkmnpqrstvwxyz]{32}$/);
    broker.updateEnvironment(token, {});
    const wrong = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    assert.throws(() => broker.updateEnvironment(wrong, {}), /invalid or expired/);
    assert.throws(() => broker.updateEnvironment(token.toUpperCase(), {}), /invalid or expired/);
    broker.revoke(token);
    assert.throws(() => broker.updateEnvironment(token, {}), /invalid or expired/);
    assert.match(native.opaqueId('binding'), /^binding_[A-Za-z0-9_-]{32}$/);
  } finally { await broker.close(); }
} else if (phase === 'model-announcements') {
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
