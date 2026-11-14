import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
const [entry, root] = process.argv.slice(2);
const n = await import(pathToFileURL(entry).href);
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
class Page extends EventEmitter {
  closed = false;
  closes = 0;
  delayed;
  isClosed() { return this.closed; }
  url() { return 'https://chatgpt.com/c/owned-source'; }
  mainFrame() { return this; }
  async close() { this.closes++; await this.delayed?.promise; this.closed = true; this.emit('close'); }
}
const provider = { adapter: 'chatgpt-web', baseUrl: 'browser://managed-retention-offline', chatgptWeb: {
  browserHost: 'managed-chrome', browserInteractionMode: 'automatic', brokerSocketPath: n.brokerEndpoint(root),
  storageStatePath: root + '/unused-state.json', appName: 'Retained test', localToolsEnabled: true,
  solAvailable: true, proAvailable: true, extraHighAvailable: false, turnTimeoutMs: 5000,
} };
const sourceRequest = { modelId: 'gpt-5.6-sol', stream: true, options: { reasoning: 'max' }, _chatgptModelFamily: '6',
  context: { messages: [{ role: 'user', content: 'Original task', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Source work completed' }], timestamp: 2 },
    { role: 'user', content: 'Continue with the next step', timestamp: 3 }] },
  _rawBody: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue with the next step' }],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn_source' } }],
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread_retained_test', turn_id: 'turn_source' }) } },
};
const ns = n.namespace(provider), key = n.conversationKey(sourceRequest, ns);
const worker = n.Worker.forProvider(provider), broker = n.Broker.forSocket(provider.chatgptWeb.brokerSocketPath);
const page = new Page();
let creations = 0, handoffs = 0, releases = 0, sourcePrepared = 0, ordinaryToolClaims = 0;
const acceptedReceipt = deferred();
worker.pageForNewTurn = async () => { creations++; return page; };
worker.runBrowserTurn = async (turn, surface, pageOrGet, reused) => {
  assert.equal(surface, undefined, 'managed host never fabricates a Launcher surface');
  const prepared = await (reused ? turn.prepareResume : turn.prepare)();
  try {
    const actualPage = typeof pageOrGet === 'function' ? await pageOrGet(turn.abortSignal) : await worker.pageForNewTurn();
    assert.equal(actualPage, page);
    if (!turn.compaction) { sourcePrepared++; if (!pageOrGet) await page.close(); return 'source complete'; }
    handoffs++;
    assert.equal(reused, true);
    assert.equal(turn.requireRetainedConversation, true);
    assert.equal(turn.nativeConnector, true);
    assert.equal(turn.capabilities.localToolsEnabled, false);
    assert.equal(prepared.text.split('When the user requests later recall').length, 2);
    const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9]+)/)?.[1];
    const handoffId = prepared.text.match(/handoff_id (handoff_[A-Za-z0-9]+)/)?.[1];
    assert.ok(token && handoffId);
    await assert.rejects(n.callBroker(broker.socketPath, { method: 'claim', token }), /turn token is invalid/);
    ordinaryToolClaims++;
    await assert.rejects(n.callBroker(broker.socketPath, { method: 'submit_compaction_handoff', token, handoffId: 'handoff_wrong', summary: 'wrong' }), /does not match/);
    page.delayed = deferred();
    // Prepare the listener before submitting; receipt acceptance may abort the
    // owned response immediately, before the wire reply reaches this fixture.
    const abort = turn.abortSignal.aborted ? Promise.resolve() : new Promise(r => turn.abortSignal.addEventListener('abort', r, { once: true }));
    await n.callBroker(broker.socketPath, { method: 'submit_compaction_handoff', token, handoffId, summary: 'Exact retained checkpoint: key = value' });
    await assert.rejects(n.callBroker(broker.socketPath, { method: 'submit_compaction_handoff', token, handoffId, summary: 'again' }), /already submitted|invalid, expired, or consumed/);
    acceptedReceipt.resolve();
    await abort;
    throw turn.abortSignal.reason;
  } catch (error) {
    if (!turn.abortSignal?.aborted) { acceptedReceipt.reject(error); page.delayed?.resolve(); }
    throw error;
  } finally { prepared.release(); }
};
const sourceBrowser = worker.run({ traceId: 'source_ordinary', modelId: sourceRequest.modelId, modelFamily: '6', reasoning: 'max',
  capabilities: { localToolsEnabled: true }, conversationKey: key, retainConversation: true,
  prepare: async () => ({ text: 'ordinary source', images: [], release() {} }), onTextDelta() {},
});
const sourceKey = ns + ':' + n.executionKey(sourceRequest);
const source = n.sessions.getOrCreate(sourceKey, () => ({ mode: 'read-only', browser: sourceBrowser,
  physicalSettlement: sourceBrowser.then(() => {}), conversationKey: key, usageInput: sourceRequest,
  trace: { observeProgress: () => () => {} }, text: {}, cancel() {},
  releaseRetainedConversation: async () => { releases++; await worker.releaseNativeRetainedConversation(key); },
}));
try {
  await source.browserOutcome; await source.physicalSettlement;
  assert.equal(sourcePrepared, 1);
  assert.equal(page.closed, false, 'source page must survive actual worker settlement');
  const compact = structuredClone(sourceRequest); compact._compactionRequest = true;
  compact._rawBody.client_metadata['x-codex-turn-metadata'] = JSON.stringify({ thread_id: 'thread_retained_test', turn_id: 'turn_compact' });
  const adapter = n.adapter(provider), events = [], firstAbort = new AbortController();
  const firstEvents = [];
  const first = adapter.runTurn(compact, { headers: new Headers(), abortSignal: firstAbort.signal }, event => firstEvents.push(event));
  void first.then(() => { if (!handoffs) acceptedReceipt.reject(new Error('Handoff did not run: ' + JSON.stringify(firstEvents))); }, error => { if (!handoffs) acceptedReceipt.reject(error); });
  await acceptedReceipt.promise;
  firstAbort.abort();
  await assert.rejects(first, { name: 'AbortError' });
  let finished = false;
  const second = adapter.runTurn(compact, { headers: new Headers() }, e => events.push(e)).then(() => { finished = true; });
  await tick(); await tick();
  assert.equal(finished, false, 'receipt alone cannot release physical ownership');
  assert.equal(handoffs, 1, 'observer reconnect must share the single handoff');
  await assert.rejects(worker.run({ traceId: 'competing_owner', conversationKey: key, prepareResume: async () => ({}),
    prepare: async () => ({}), capabilities: { localToolsEnabled: true } }));
  page.delayed.resolve();
  await second;
  assert.equal(events.some(e => e.type === 'error'), false);
  assert.match(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), /Exact retained checkpoint/);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(handoffs, 1); assert.equal(creations, 1); assert.equal(page.closes, 1);
  assert.equal(releases, 1); assert.equal(ordinaryToolClaims, 1);
  assert.equal(n.sessions.findConversationHead(key), undefined);
  await adapter.runTurn(compact, { headers: new Headers() }, () => {});
  assert.equal(handoffs, 1, 'completed compaction replay must not re-send');
  const before = creations;
  await assert.rejects(worker.run({ traceId: 'missing_retained_source', conversationKey: key, requireRetainedConversation: true,
    capabilities: { localToolsEnabled: false }, prepareResume: async () => ({}), prepare: async () => ({}) }), e => e.code === 'compaction_source_unavailable');
  assert.equal(creations, before, 'required missing source fails before a new page');
  // An answer claiming submission cannot replace the reserved broker receipt.
  const proseWorker = new n.Worker(worker.config), prosePage = new Page(), proseKey = 'b'.repeat(64);
  let proseCreations = 0;
  proseWorker.pageForNewTurn = async () => { proseCreations++; return prosePage; };
  proseWorker.runBrowserTurn = async (turn, surface, getPage, reused) => {
    const prepared = await (reused ? turn.prepareResume : turn.prepare)();
    try { assert.equal(await getPage(turn.abortSignal), prosePage); return 'submitted=true. Complete checkpoint.'; }
    finally { prepared.release(); }
  };
  const proseTurn = { traceId: 'prose_source', conversationKey: proseKey, retainConversation: true,
    modelId: sourceRequest.modelId, capabilities: { localToolsEnabled: true },
    prepare: async () => ({ text: 'source', images: [], release() {} }), onTextDelta() {} };
  try {
    await proseWorker.run(proseTurn);
    await assert.rejects(n.retainedHandoff(proseWorker, sourceRequest, { conversationKey: () => proseKey }, broker,
      provider.chatgptWeb, 'prose_handoff', undefined, 1000), e => e.code === 'compaction_handoff_missing');
    assert.equal(prosePage.closed, true); assert.equal(proseCreations, 1);
    await proseWorker.close();
    await assert.rejects(proseWorker.run({ ...proseTurn, traceId: 'after_generation_end',
      requireRetainedConversation: true, prepareResume: proseTurn.prepare }), e => e.code === 'compaction_source_unavailable');
    assert.equal(proseCreations, 1, 'worker restart never adopts an old page');
  } finally { await proseWorker.close(); }
  // Exercise the actual patched runBrowserTurn, stopping at its first browser
  // boundary. Preparation/limits precede lazy allocation, and ownership cleanup
  // still runs when that boundary fails before the local Page assignment.
  const boundaryWorker = new n.Worker(worker.config), boundaryPage = new Page();
  let boundaryCreations = 0, preparedFirst = false, preparedReleases = 0;
  boundaryWorker.pageForNewTurn = async () => { assert.equal(preparedFirst, true); boundaryCreations++; return boundaryPage; };
  const boundaryError = new Error('OFFLINE_BROWSER_BOUNDARY');
  boundaryWorker.runStage = async (trace, stage, timeout, action) => {
    assert.equal(stage, 'browser_page');
    assert.equal(await action(new AbortController().signal), boundaryPage);
    throw boundaryError;
  };
  try {
    await assert.rejects(boundaryWorker.run({ traceId: 'original_browser_boundary', conversationKey: 'c'.repeat(64),
      retainConversation: true, modelId: sourceRequest.modelId, modelFamily: '6', reasoning: 'max',
      capabilities: { solAvailable: true, proAvailable: true, localToolsEnabled: false },
      prepare: async () => { preparedFirst = true; return { text: 'Short source', images: [], release() { preparedReleases++; } }; },
      onTextDelta() {},
    }), error => error === boundaryError);
    assert.equal(boundaryCreations, 1); assert.equal(preparedReleases, 1); assert.equal(boundaryPage.closes, 1);
  } finally { await boundaryWorker.close(); }
  const cleanupWorker = new n.Worker(worker.config), cleanupPage = new Page(), cleanupFailure = new Error('PAGE_CLOSE_FAILED');
  let browserDisconnects = 0, refuseClose = true;
  cleanupPage.close = async () => { cleanupPage.closes++; if (refuseClose) throw cleanupFailure; cleanupPage.closed = true; };
  cleanupWorker.pageForNewTurn = async () => cleanupPage;
  cleanupWorker.runBrowserTurn = async (turn, surface, getPage) => { await getPage(turn.abortSignal); return 'complete'; };
  await cleanupWorker.run({ traceId: 'cleanup_source', conversationKey: 'd'.repeat(64), retainConversation: true,
    capabilities: { localToolsEnabled: true }, prepare: async () => ({}) });
  cleanupWorker.browser = { close: async () => { browserDisconnects++; } };
  await assert.rejects(cleanupWorker.close(), error => error === cleanupFailure);
  assert.equal(browserDisconnects, 1, 'page cleanup failure must still disconnect the original browser');
  assert.equal(cleanupWorker.browser, undefined);
  await assert.rejects(cleanupWorker.run({ traceId: 'cleanup_competitor', conversationKey: 'd'.repeat(64) }), /closing/);
  refuseClose = false; await cleanupWorker.close();
  assert.equal(cleanupPage.closed, true);

  const navWorker = new n.Worker(worker.config), navPage = new Page(), navKey = 'e'.repeat(64);
  navWorker.pageForNewTurn = async () => navPage;
  navWorker.runBrowserTurn = async (turn, surface, getPage) => { await getPage(turn.abortSignal); return 'complete'; };
  const navTurn = { traceId: 'nav_source', conversationKey: navKey, retainConversation: true,
    capabilities: { localToolsEnabled: true }, prepare: async () => ({}) };
  await navWorker.run(navTurn);
  navWorker.runBrowserTurn = async (turn, surface, getPage, reused) => {
    assert.equal(reused, true);
    await getPage(turn.abortSignal);
    navPage.emit('framenavigated', navPage.mainFrame());
    assert.equal(turn.abortSignal.aborted, true, 'navigation must cancel even after page delivery');
    throw turn.abortSignal.reason;
  };
  try {
    await assert.rejects(navWorker.run({ ...navTurn, traceId: 'nav_handoff', requireRetainedConversation: true,
      prepareResume: navTurn.prepare }), error => error.code === 'compaction_source_unavailable');
    assert.equal(navPage.closed, true);
  } finally { await navWorker.close(); }
  console.log('Managed retained source integration passed');
} finally {
  page.delayed?.resolve();
  n.sessions.clear();
  await worker.close(); await broker.close();
}
