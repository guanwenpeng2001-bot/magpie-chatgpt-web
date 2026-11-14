import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeRetainedPages } from '../src/native/retained-pages.mjs';

const key = 'a'.repeat(64);
const otherKey = 'b'.repeat(64);
const thirdKey = 'c'.repeat(64);
const identity = { appName: 'Retained fixture' };
const retained = { completed: true, retain: true, connectorBound: true };
const unavailable = { code: 'compaction_source_unavailable' };
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe(promise) {
  const state = { settled: false };
  promise.then(value => Object.assign(state, { settled: true, value }),
    error => Object.assign(state, { settled: true, error }));
  return state;
}
class FakePage extends EventEmitter {
  closed = false;
  address = 'https://fixture.invalid/conversation';
  frame = {};
  closeCalls = 0;
  closeAction;
  isClosed() { return this.closed; }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  navigate(address = this.address, frame = this.frame) {
    if (frame === this.frame) this.address = address;
    this.emit('framenavigated', frame);
  }
  async close() {
    this.closeCalls++;
    await this.closeAction?.();
    this.closed = true;
  }
}
const acquire = (registry, options = {}) => registry.acquire({ key, identity, ...options });
async function seed(registry, page = new FakePage(), options = {}) {
  const lease = await acquire(registry, options);
  assert.equal(await lease.page(() => page), page);
  await lease.finish(retained);
  return { lease, page };
}
const neverCreate = () => { assert.fail('Must not discover or create a replacement page'); };

test('lazy exact handle ownership, one factory, explicit resume and appName snapshot', async () => {
  const registry = new NativeRetainedPages();
  const mutableIdentity = { ...identity };
  const lease = await acquire(registry, { identity: mutableIdentity });
  mutableIdentity.appName = 'mutated';
  assert.equal(lease.reused, false);
  let calls = 0;
  const page = new FakePage();
  const create = () => { calls++; return page; };
  assert.deepEqual(await Promise.all([lease.page(create), lease.page(create)]), [page, page]);
  assert.equal(calls, 1);
  await lease.finish(retained);
  const next = await acquire(registry, { canResume: true, requireRetained: true });
  assert.equal(next.reused, true);
  assert.equal(await next.page(neverCreate), page);
  await next.finish(retained);
  await registry.close();
  assert.equal(page.closeCalls, 1);
  assert.equal(page.listenerCount('framenavigated'), 0);
});

test('invalid keys and identities fail before reserving or creating', async () => {
  const registry = new NativeRetainedPages();
  for (const invalid of [undefined, null, 1, '', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 'A'.repeat(64), ` ${key}`]) {
    await assert.rejects(acquire(registry, { key: invalid }), unavailable);
  }
  for (const invalid of [undefined, null, {}, { appName: '' }, { appName: '  ' }, { appName: 12 }]) {
    await assert.rejects(acquire(registry, { identity: invalid }), unavailable);
  }
  const lease = await acquire(registry);
  await lease.finish();
  await registry.close();
});

test('constructor rejects invalid bounds and honors the unavailable error factory', async () => {
  for (const options of [{ maxPages: 0 }, { maxPages: 1.5 }, { maxPages: Infinity }, { idleMs: -1 },
    { idleMs: NaN }, { now: 1 }, { unavailable: null }]) {
    assert.throws(() => new NativeRetainedPages(options), TypeError);
  }
  const error = new Error('custom unavailable');
  const registry = new NativeRetainedPages({ unavailable: () => error });
  await assert.rejects(acquire(registry, { requireRetained: true }), value => value === error);
  await registry.close();
});

test('required missing source rejects before page creation and never adopts from another registry', async () => {
  const first = new NativeRetainedPages();
  const second = new NativeRetainedPages();
  const { page } = await seed(first);
  await assert.rejects(acquire(second, { requireRetained: true, canResume: true }), unavailable);
  await second.close();
  assert.equal(page.closed, false);
  const again = await acquire(first, { requireRetained: true, canResume: true });
  assert.equal(await again.page(neverCreate), page);
  await again.finish();
  await first.close();
});

test('duplicate lazy reservations reject immediately, including before creation', async () => {
  const registry = new NativeRetainedPages();
  const pending = acquire(registry);
  await assert.rejects(acquire(registry), unavailable);
  const lease = await pending;
  await assert.rejects(acquire(registry, { requireRetained: true, canResume: true }), unavailable);
  await lease.finish();
  await registry.close();
});

test('active conflict never waits and adopts after the owner finishes', async () => {
  const registry = new NativeRetainedPages();
  const { page } = await seed(registry);
  const owner = await acquire(registry, { canResume: true });
  const rejected = acquire(registry, { canResume: true });
  const check = assert.rejects(rejected, unavailable);
  await owner.finish(retained);
  await check;
  assert.equal(page.closeCalls, 0);
  const next = await acquire(registry, { canResume: true, requireRetained: true });
  assert.equal(await next.page(neverCreate), page);
  await next.finish();
  await registry.close();
});

test('identity mismatch and non-boolean resume permissions cannot reuse a source', async t => {
  for (const options of [{ identity: { appName: 'other' }, canResume: true }, { canResume: false },
    { canResume: 'true' }, { canResume: 1 }, { canResume: {} }]) {
    await t.test(JSON.stringify(options), async () => {
      const registry = new NativeRetainedPages();
      const { page } = await seed(registry);
      await assert.rejects(acquire(registry, { ...options, requireRetained: true }), unavailable);
      assert.equal(page.closed, true);
      await registry.close();
    });
  }
});

test('ordinary stale source closes physically before replacement reservation completes', async () => {
  const registry = new NativeRetainedPages();
  const { page } = await seed(registry);
  const closing = deferred();
  page.closeAction = () => closing.promise;
  const pending = acquire(registry); // canResume defaults to false.
  const state = observe(pending);
  await turn();
  assert.equal(page.closeCalls, 1);
  assert.equal(state.settled, false);
  await assert.rejects(acquire(registry), unavailable);
  closing.resolve();
  const fresh = await pending;
  assert.equal(fresh.reused, false);
  const replacement = new FakePage();
  assert.equal(await fresh.page(() => { assert.equal(page.closed, true); return replacement; }), replacement);
  await fresh.finish();
  await registry.close();
});

test('release cancels a pending stale replacement admission', async () => {
  const registry = new NativeRetainedPages();
  const { page } = await seed(registry);
  const closing = deferred();
  page.closeAction = () => closing.promise;
  const admission = acquire(registry);
  const rejected = assert.rejects(admission, unavailable);
  const release = registry.release(key);
  const state = observe(release);
  await turn();
  assert.equal(state.settled, false);
  closing.resolve();
  await Promise.all([release, rejected]);
  assert.equal(page.closeCalls, 1);
  const lease = await acquire(registry);
  await lease.finish();
  await registry.close();
});

test('retention requires completed, retain, connectorBound, and a delivered live page', async t => {
  for (const flags of [{}, { ...retained, completed: false }, { ...retained, retain: false },
    { ...retained, connectorBound: false }, { ...retained, connectorBound: 'true' }]) {
    await t.test(JSON.stringify(flags), async () => {
      const registry = new NativeRetainedPages();
      const lease = await acquire(registry);
      const page = await lease.page(() => new FakePage());
      await lease.finish(flags);
      assert.equal(page.closed, true);
      await assert.rejects(acquire(registry, { canResume: true, requireRetained: true }), unavailable);
      await registry.close();
    });
  }
});

test('idle top-level navigation invalidates even the same URL and an away/back round trip', async t => {
  for (const navigate of [page => page.navigate(), page => {
    const before = page.url(); page.navigate('https://fixture.invalid/away'); page.navigate(before);
  }, page => { page.address = 'https://fixture.invalid/silent-change'; }]) {
    await t.test(navigate.toString(), async () => {
      const registry = new NativeRetainedPages();
      const { page } = await seed(registry);
      navigate(page);
      await assert.rejects(acquire(registry, { requireRetained: true, canResume: true }), unavailable);
      assert.equal(page.closed, true);
      await registry.close();
    });
  }
});

test('fresh active navigation is allowed, finish snapshots URL, and subframe navigation is allowed', async () => {
  const registry = new NativeRetainedPages();
  const lease = await acquire(registry);
  const page = await lease.page(() => new FakePage());
  page.navigate('https://fixture.invalid/new-conversation');
  page.navigate();
  assert.equal(lease.signal.aborted, false);
  await lease.finish(retained);
  page.navigate('https://fixture.invalid/child', {});
  const next = await acquire(registry, { requireRetained: true, canResume: true });
  assert.equal(await next.page(neverCreate), page);
  page.navigate('https://fixture.invalid/active-child', {});
  assert.equal(next.signal.aborted, false);
  await next.finish(retained);
  const last = await acquire(registry, { requireRetained: true, canResume: true });
  assert.equal(last.reused, true);
  await last.finish();
  await registry.close();
});

test('reused navigation before page delivery aborts immediately and holds ownership until finish', async t => {
  for (const sameUrl of [false, true]) {
    await t.test(sameUrl ? 'same URL reload' : 'different conversation', async () => {
      const registry = new NativeRetainedPages();
      const { lease: old, page } = await seed(registry);
      const lease = await acquire(registry, { canResume: true, requireRetained: true });
      assert.notEqual(lease.signal, old.signal);
      const combined = AbortSignal.any([new AbortController().signal, lease.signal]);
      page.navigate(sameUrl ? page.url() : 'https://fixture.invalid/wrong-conversation');
      assert.equal(combined.aborted, true);
      assert.equal(combined.reason.code, unavailable.code);
      assert.equal(old.signal.aborted, false);
      await assert.rejects(lease.page(neverCreate), error => error === combined.reason);
      const release = registry.release(key);
      const releaseState = observe(release);
      await turn();
      assert.equal(page.closeCalls, 0);
      assert.equal(releaseState.settled, false);
      await assert.rejects(acquire(registry), unavailable);
      const closing = deferred();
      page.closeAction = () => closing.promise;
      const finish = lease.finish(retained);
      assert.equal(lease.finish(), finish);
      await turn();
      assert.equal(page.closeCalls, 1);
      assert.equal(releaseState.settled, false);
      await assert.rejects(acquire(registry), unavailable);
      closing.resolve();
      await Promise.all([finish, release]);
      await registry.close();
    });
  }
});

test('reused navigation after page delivery cancels submission or generation, including same URL reload', async t => {
  for (const sameUrl of [false, true]) {
    await t.test(sameUrl ? 'same URL reload' : 'different conversation', async () => {
      const registry = new NativeRetainedPages();
      const { page } = await seed(registry);
      const lease = await acquire(registry, { canResume: true, requireRetained: true });
      assert.equal(await lease.page(neverCreate), page);
      const combined = AbortSignal.any([new AbortController().signal, lease.signal]);
      let cancelled = 0;
      combined.addEventListener('abort', () => { cancelled++; }, { once: true });
      const before = page.url();
      page.navigate(sameUrl ? before : 'https://fixture.invalid/wrong-conversation');
      assert.equal(cancelled, 1, 'the in-flight consumer is notified synchronously');
      assert.equal(combined.reason.code, unavailable.code);
      page.navigate(before);
      assert.equal(cancelled, 1);
      await assert.rejects(lease.page(neverCreate), unavailable);
      assert.equal(page.closeCalls, 0, 'cancellation must not close a worker-owned page early');
      await assert.rejects(acquire(registry, { canResume: true }), unavailable);
      await lease.finish(retained);
      assert.equal(page.closed, true);
      await assert.rejects(acquire(registry, { canResume: true, requireRetained: true }), unavailable);
      await registry.close();
    });
  }
});

test('reused page delivery rechecks the original URL even without a navigation event', async () => {
  const registry = new NativeRetainedPages();
  const { page } = await seed(registry);
  const lease = await acquire(registry, { canResume: true, requireRetained: true });
  page.address = 'https://fixture.invalid/silent-change';
  await assert.rejects(lease.page(neverCreate), unavailable);
  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.signal.reason.code, unavailable.code);
  assert.equal(page.closeCalls, 0);
  await lease.finish(retained);
  assert.equal(page.closed, true);
  await registry.close();
});

test('navigation cancellation still propagates close failure and keeps a retryable tombstone', async () => {
  const registry = new NativeRetainedPages();
  const { page } = await seed(registry);
  const lease = await acquire(registry, { canResume: true });
  await lease.page(neverCreate);
  const failure = new Error('navigation cleanup failed');
  page.closeAction = () => { throw failure; };
  page.navigate();
  const release = registry.release(key);
  const rejectedRelease = assert.rejects(release, error => error === failure);
  await assert.rejects(lease.finish(retained), error => error === failure);
  await rejectedRelease;
  await assert.rejects(acquire(registry), unavailable);
  page.closeAction = undefined;
  await registry.release(key);
  assert.equal(page.closeCalls, 2);
  await registry.close();
});

test('user cancellation forwards its reason through lease.signal but awaits delivered owner finish', async () => {
  const registry = new NativeRetainedPages();
  const controller = new AbortController();
  const lease = await acquire(registry, { signal: controller.signal });
  const page = await lease.page(() => new FakePage());
  const reason = new Error('user cancelled');
  controller.abort(reason);
  assert.equal(lease.signal.reason, reason);
  await assert.rejects(lease.page(neverCreate), error => error === reason);
  assert.equal(page.closeCalls, 0);
  await assert.rejects(acquire(registry), unavailable);
  await lease.finish(retained);
  assert.equal(page.closed, true);
  await registry.close();
});

test('externally closed pages cannot be reused; ordinary acquisition may replace them', async () => {
  const registry = new NativeRetainedPages();
  const { page } = await seed(registry);
  page.closed = true;
  const lease = await acquire(registry, { canResume: true });
  assert.equal(lease.reused, false);
  assert.equal(page.closeCalls, 0);
  await lease.finish();
  await registry.close();
});

test('a required closed source fails and a page closed after acquisition cannot be delivered', async () => {
  const registry = new NativeRetainedPages();
  const { page } = await seed(registry);
  page.closed = true;
  await assert.rejects(acquire(registry, { requireRetained: true, canResume: true }), unavailable);
  const { page: second } = await seed(registry);
  const lease = await acquire(registry, { requireRetained: true, canResume: true });
  second.closed = true;
  await assert.rejects(lease.page(neverCreate), unavailable);
  await lease.finish();
  await registry.close();
});

test('finish is exactly once and waits for close; stale leases cannot touch a later owner', async () => {
  const registry = new NativeRetainedPages();
  const lease = await acquire(registry);
  const page = await lease.page(() => new FakePage());
  const closing = deferred();
  page.closeAction = () => closing.promise;
  const finish = lease.finish();
  assert.equal(lease.finish(retained), finish);
  const state = observe(finish);
  await turn();
  assert.equal(state.settled, false);
  await assert.rejects(acquire(registry), unavailable);
  await assert.rejects(lease.page(neverCreate), unavailable);
  closing.resolve();
  await finish;
  const next = await acquire(registry);
  const replacement = await next.page(() => new FakePage());
  assert.equal(lease.finish(), finish);
  await assert.rejects(lease.page(neverCreate), unavailable);
  assert.equal(replacement.closed, false);
  await next.finish();
  await registry.close();
});

test('a retained stale handle cannot retire or close a newer lease for the same exact page', async () => {
  const registry = new NativeRetainedPages();
  const { lease: old, page } = await seed(registry);
  const next = await acquire(registry, { canResume: true });
  const aborted = AbortSignal.abort(new Error('stale abort'));
  await assert.rejects(old.page(neverCreate, aborted), unavailable);
  await old.finish();
  assert.equal(await next.page(neverCreate), page);
  assert.equal(page.closed, false);
  await next.finish();
  await registry.close();
});

test('release waits for active finish and its physical close, without closing the active page early', async () => {
  const registry = new NativeRetainedPages();
  const lease = await acquire(registry);
  const page = await lease.page(() => new FakePage());
  const closing = deferred();
  page.closeAction = () => closing.promise;
  const release = registry.release(key);
  const state = observe(release);
  await turn();
  assert.equal(state.settled, false);
  assert.equal(page.closeCalls, 0);
  await assert.rejects(acquire(registry, { canResume: true }), unavailable);
  const finish = lease.finish(retained);
  await turn();
  assert.equal(page.closeCalls, 1);
  assert.equal(state.settled, false);
  closing.resolve();
  await Promise.all([release, finish]);
  assert.equal(page.closed, true);
  await registry.close();
});

test('release waits for a lazy reservation to finish without ever invoking a factory', async () => {
  const registry = new NativeRetainedPages();
  const lease = await acquire(registry);
  const release = registry.release(key);
  const state = observe(release);
  await turn();
  assert.equal(state.settled, false);
  await lease.finish(retained);
  await release;
  await assert.rejects(lease.page(neverCreate), unavailable);
  await registry.close();
});

test('failed finish and waiting release both propagate cleanup error; tombstone requires explicit retry', async () => {
  const registry = new NativeRetainedPages();
  const lease = await acquire(registry);
  const page = await lease.page(() => new FakePage());
  const failure = new Error('physical close failed');
  page.closeAction = () => { throw failure; };
  const release = registry.release(key);
  const rejectedRelease = assert.rejects(release, error => error === failure);
  const finish = lease.finish();
  await assert.rejects(finish, error => error === failure);
  await rejectedRelease;
  assert.equal(lease.finish(retained), finish);
  await assert.rejects(acquire(registry), unavailable);
  assert.equal(page.closeCalls, 1);
  const closing = deferred();
  page.closeAction = () => closing.promise;
  const retry = registry.release(key);
  await turn();
  await assert.rejects(acquire(registry), unavailable);
  closing.resolve();
  await retry;
  assert.equal(page.closeCalls, 2);
  const next = await acquire(registry);
  await next.finish();
  await registry.close();
});

test('stale cleanup failure prevents replacement and keeps its capacity slot', async () => {
  const registry = new NativeRetainedPages({ maxPages: 1 });
  const { page } = await seed(registry);
  const failure = new Error('close failure');
  page.closeAction = () => { throw failure; };
  await assert.rejects(acquire(registry), error => error === failure);
  await assert.rejects(acquire(registry), unavailable);
  await assert.rejects(acquire(registry, { key: otherKey }), unavailable);
  assert.equal(page.closeCalls, 1);
  page.closeAction = undefined;
  await registry.release(key);
  const next = await acquire(registry);
  await next.finish();
  await registry.close();
});

test('a resolved close that leaves the page open cannot clear the ownership tombstone', async () => {
  const registry = new NativeRetainedPages();
  const { page } = await seed(registry);
  const close = page.close;
  page.close = async () => { page.closeCalls++; };
  await assert.rejects(registry.release(key), unavailable);
  await assert.rejects(acquire(registry), unavailable);
  page.close = close;
  await registry.release(key);
  assert.equal(page.closed, true);
  assert.equal(page.closeCalls, 2);
  await registry.close();
});

test('pre-aborted acquisition never reserves; aborted page call never creates', async () => {
  const registry = new NativeRetainedPages();
  const reason = new Error('abort before creation');
  const signal = AbortSignal.abort(reason);
  await assert.rejects(acquire(registry, { signal }), error => error === reason);
  const lease = await acquire(registry);
  await assert.rejects(lease.page(neverCreate, signal), error => error === reason);
  await lease.finish();
  await registry.close();
});

test('abort during creation owns the late page and holds the reservation through physical cleanup', async t => {
  for (const signalOn of ['acquire', 'page']) {
    await t.test(signalOn, async () => {
      const registry = new NativeRetainedPages();
      const controller = new AbortController();
      const reason = new Error('cancelled creation');
      const lease = await acquire(registry, signalOn === 'acquire' ? { signal: controller.signal } : {});
      const creation = deferred(), closing = deferred();
      const late = new FakePage();
      late.closeAction = () => closing.promise;
      let called = 0;
      const pending = lease.page(() => { called++; return creation.promise; },
        signalOn === 'page' ? controller.signal : undefined);
      const state = observe(pending);
      await turn();
      assert.equal(called, 1);
      controller.abort(reason);
      const release = registry.release(key);
      const releaseState = observe(release);
      await assert.rejects(acquire(registry), unavailable);
      creation.resolve(late);
      await turn();
      assert.equal(late.closeCalls, 1);
      assert.equal(state.settled, false);
      assert.equal(releaseState.settled, false);
      await assert.rejects(acquire(registry), unavailable);
      closing.resolve();
      await assert.rejects(pending, error => error === reason);
      await release;
      assert.equal(late.closed, true);
      const next = await acquire(registry);
      await next.finish();
      await registry.close();
    });
  }
});

test('aborted late-page close failure propagates and remains retryable', async () => {
  const registry = new NativeRetainedPages();
  const controller = new AbortController();
  const lease = await acquire(registry, { signal: controller.signal });
  const creation = deferred();
  const pending = lease.page(() => creation.promise);
  const failure = new Error('late cleanup failure');
  const check = assert.rejects(pending, error => error === failure);
  const late = new FakePage();
  late.closeAction = () => { throw failure; };
  await turn();
  controller.abort();
  creation.resolve(late);
  await check;
  await assert.rejects(lease.finish(), error => error === failure);
  await assert.rejects(acquire(registry), unavailable);
  late.closeAction = undefined;
  await registry.release(key);
  assert.equal(late.closeCalls, 2);
  await registry.close();
});

test('abort after successful finish cannot retire a later owner', async () => {
  const registry = new NativeRetainedPages();
  const controller = new AbortController();
  const { page } = await seed(registry, new FakePage(), { signal: controller.signal });
  const next = await acquire(registry, { canResume: true });
  controller.abort();
  assert.equal(await next.page(neverCreate), page);
  await next.finish(retained);
  const last = await acquire(registry, { canResume: true, requireRetained: true });
  await last.finish();
  await registry.close();
});

test('finish during deferred creation waits and closes the late handle', async () => {
  const registry = new NativeRetainedPages();
  const lease = await acquire(registry);
  const creation = deferred(), closing = deferred();
  const pending = lease.page(() => creation.promise);
  const rejected = assert.rejects(pending, unavailable);
  await turn();
  const finish = lease.finish(retained);
  const state = observe(finish);
  const late = new FakePage();
  late.closeAction = () => closing.promise;
  creation.resolve(late);
  await turn();
  assert.equal(state.settled, false);
  assert.equal(late.closeCalls, 1);
  closing.resolve();
  await Promise.all([finish, rejected]);
  await registry.close();
});

test('factory failures release the reservation and finish remains idempotent', async () => {
  const registry = new NativeRetainedPages();
  const failure = new Error('create failed');
  const lease = await acquire(registry);
  await assert.rejects(lease.page(() => { throw failure; }), error => error === failure);
  const finish = lease.finish();
  assert.equal(finish, lease.finish(retained));
  await finish;
  const next = await acquire(registry);
  await next.finish();
  await registry.close();
});

test('capacity evicts oldest idle only, never active reservations', async () => {
  let now = 0;
  const registry = new NativeRetainedPages({ maxPages: 2, now: () => now });
  const { page: oldest } = await seed(registry);
  now = 1;
  const { page: newer } = await seed(registry, new FakePage(), { key: otherKey });
  const third = await acquire(registry, { key: thirdKey });
  assert.equal(oldest.closed, true);
  assert.equal(newer.closed, false);
  const active = await acquire(registry, { key: otherKey, canResume: true });
  await assert.rejects(acquire(registry), unavailable);
  assert.equal(newer.closed, false);
  await Promise.all([active.finish(), third.finish()]);
  await registry.close();
});

test('concurrent capacity admissions cannot exceed the cap or adopt a retiring victim', async () => {
  const registry = new NativeRetainedPages({ maxPages: 1 });
  const { page } = await seed(registry);
  const closing = deferred();
  page.closeAction = () => closing.promise;
  const admission = acquire(registry, { key: otherKey });
  const state = observe(admission);
  await turn();
  await assert.rejects(acquire(registry, { key: thirdKey }), unavailable);
  await assert.rejects(acquire(registry, { key: otherKey }), unavailable);
  await assert.rejects(acquire(registry, { canResume: true }), unavailable);
  assert.equal(state.settled, false);
  closing.resolve();
  const lease = await admission;
  await lease.finish();
  await registry.close();
});

test('lazy TTL expires at the boundary, resets on successful finish, and never evicts active leases', async () => {
  let now = 0;
  const registry = new NativeRetainedPages({ idleMs: 10, now: () => now, maxPages: 2 });
  const { page } = await seed(registry);
  now = 9;
  const active = await acquire(registry, { canResume: true, requireRetained: true });
  assert.equal(await active.page(neverCreate), page);
  now = 100;
  const other = await acquire(registry, { key: otherKey });
  assert.equal(page.closed, false);
  await other.finish();
  await active.finish(retained);
  now = 109;
  const fresh = await acquire(registry, { key: otherKey });
  assert.equal(page.closed, false);
  await fresh.finish();
  now = 110;
  const prune = await acquire(registry, { key: thirdKey });
  assert.equal(page.closed, true);
  await assert.rejects(acquire(registry, { canResume: true, requireRetained: true }), unavailable);
  await prune.finish();
  await registry.close();
});

test('required retained source cannot resume an expired page', async () => {
  let now = 0;
  const registry = new NativeRetainedPages({ idleMs: 5, now: () => now });
  const { page } = await seed(registry);
  now = 5;
  await assert.rejects(acquire(registry, { requireRetained: true, canResume: true }), unavailable);
  assert.equal(page.closed, true);
  await registry.close();
});

test('default capacity includes lazy reservations and default TTL is five minutes', async () => {
  let now = 0;
  const registry = new NativeRetainedPages({ now: () => now });
  const leases = [];
  for (let i = 0; i < 8; i++) leases.push(await acquire(registry, { key: i.toString(16).padStart(64, '0') }));
  await assert.rejects(acquire(registry), unavailable);
  await Promise.all(leases.map(lease => lease.finish()));
  const { page } = await seed(registry);
  now = 299_999;
  const next = await acquire(registry, { canResume: true, requireRetained: true });
  assert.equal(await next.page(neverCreate), page);
  await next.finish(retained);
  now += 300_000;
  await assert.rejects(acquire(registry, { canResume: true, requireRetained: true }), unavailable);
  assert.equal(page.closed, true);
  await registry.close();
});

test('TTL pruning waits all expired physical closes and preserves failed tombstones', async () => {
  let now = 0;
  const registry = new NativeRetainedPages({ idleMs: 1, now: () => now });
  const { page: broken } = await seed(registry);
  const { page: slow } = await seed(registry, new FakePage(), { key: otherKey });
  const failure = new Error('expired page close failed');
  const closing = deferred();
  broken.closeAction = () => { throw failure; };
  slow.closeAction = () => closing.promise;
  now = 1;
  const pending = acquire(registry, { key: thirdKey });
  const state = observe(pending);
  await turn();
  assert.equal(state.settled, false);
  await assert.rejects(acquire(registry, { key: thirdKey }), unavailable);
  closing.resolve();
  await assert.rejects(pending, error => error === failure);
  assert.equal(slow.closed, true);
  await assert.rejects(acquire(registry), unavailable);
  broken.closeAction = undefined;
  await registry.release(key);
  await registry.close();
});

test('close stops admissions, waits active leases and late creation, and only closes owned pages', async () => {
  const registry = new NativeRetainedPages();
  const { page: idle } = await seed(registry);
  const active = await acquire(registry, { key: otherKey });
  const creation = deferred(), closing = deferred();
  const pending = active.page(() => creation.promise);
  const rejected = assert.rejects(pending, unavailable);
  const running = await acquire(registry, { key: thirdKey });
  const runningPage = await running.page(() => new FakePage());
  await turn();
  const close = registry.close();
  assert.equal(registry.close(), close);
  const state = observe(close);
  await assert.rejects(acquire(registry, { key: thirdKey }), unavailable);
  await turn();
  assert.equal(idle.closed, true);
  assert.equal(runningPage.closed, false);
  assert.equal(state.settled, false);
  const late = new FakePage();
  late.browser = neverCreate;
  late.context = neverCreate;
  late.closeAction = () => closing.promise;
  creation.resolve(late);
  await turn();
  assert.equal(late.closeCalls, 1);
  assert.equal(state.settled, false);
  closing.resolve();
  await rejected;
  await turn();
  assert.equal(state.settled, false, 'close still awaits the already delivered active page');
  await running.finish(retained);
  await Promise.all([close, rejected]);
  assert.equal(runningPage.closed, true);
  await assert.rejects(acquire(registry), unavailable);
  await registry.close();
});

test('close waits every physical cleanup even when one fails, then can retry tombstones', async () => {
  const registry = new NativeRetainedPages();
  const { page: broken } = await seed(registry);
  const { page: slow } = await seed(registry, new FakePage(), { key: otherKey });
  const failure = new Error('close failed');
  const closing = deferred();
  broken.closeAction = () => { throw failure; };
  slow.closeAction = () => closing.promise;
  const close = registry.close();
  const state = observe(close);
  await turn();
  assert.equal(state.settled, false);
  closing.resolve();
  await assert.rejects(close, error => error === failure);
  assert.equal(slow.closed, true);
  broken.closeAction = undefined;
  await registry.close();
  assert.equal(broken.closeCalls, 2);
  assert.equal(slow.closeCalls, 1);
});
