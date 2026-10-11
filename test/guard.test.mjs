import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountGuard, BackendError, publicError } from '../backend/guard.mjs';

const forge = () => {
  let now = 0;
  const sleeps = [];
  return {
    sleeps,
    now: () => now,
    advance: milliseconds => { now += milliseconds; },
    sleep: async (milliseconds, signal) => {
      if (signal?.aborted) throw new BackendError('upstream');
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  };
};

test('an account serializes concurrent callers and paces after release', async () => {
  const clock = forge();
  const guard = new AccountGuard(clock);
  const release = await guard.begin();
  let entered = false;
  const second = guard.begin().then(releaseSecond => { entered = true; return releaseSecond; });
  await Promise.resolve();
  assert.equal(entered, false, 'second caller must wait for the first to release');
  release();
  (await second)();
  assert.deepEqual(clock.sleeps, [1000]);
});

test('a 429 sets a cooldown honouring Retry-After', async () => {
  const clock = forge();
  const guard = new AccountGuard(clock);
  const reported = guard.observe(429, '30');
  assert.equal(reported, '30');
  await assert.rejects(guard.begin(), error => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, '30');
    return true;
  });
  clock.advance(30_000);
  const release = await guard.begin();
  release();
});

test('a Retry-After HTTP date and the 7-day clamp are honoured', async () => {
  const clock = forge();
  const guard = new AccountGuard(clock);
  guard.observe(429, new Date(clock.now() + 90_000).toUTCString());
  clock.advance(90_000);
  await guard.begin().then(release => release());
  guard.observe(429, '999999999');
  await assert.rejects(guard.begin(), error => {
    assert.equal(error.retryAfter, '604800');
    assert.equal(error.status, 429);
    return true;
  });
});

test('a 401 blocks the account for the guard lifetime', async () => {
  const guard = new AccountGuard(forge());
  guard.observe(401);
  await assert.rejects(guard.begin(), error => {
    assert.equal(error.status, 401);
    assert.equal(error.signIn, 'expired');
    return true;
  });
});

test('every error envelope is credential-free', () => {
  for (const code of ['expired', 'cooldown', 'upstream', 'empty', 'protocol', 'verification', 'backendDown', 'capacity', 'browserDependency', 'browserProfile', 'browserConfiguration', 'browserClosed']) {
    const envelope = publicError(new BackendError(code));
    assert.ok(!('cookie' in envelope));
    assert.ok(!('token' in envelope));
    assert.deepEqual(Object.keys(envelope), ['status', 'message', ...(code === 'cooldown' ? ['retryAfter'] : []), ...(code === 'expired' ? ['signIn'] : [])]);
  }
  const marker = globalThis.crypto.randomUUID();
  const foreign = new Error(marker);
  const envelope = publicError(foreign);
  assert.equal(envelope.message, new BackendError('upstream').message);
  assert.ok(!JSON.stringify(envelope).includes(marker));
});

test('error headers and pipe envelopes retain their distinct safe meanings', () => {
  assert.deepEqual(new BackendError('expired').headers, { 'x-magpie-sign-in': 'expired' });
  assert.deepEqual(new BackendError('cooldown', { retryAfter: 12 }).headers, { 'retry-after': '12' });
  for (const code of ['capacity', 'browserDependency', 'browserProfile', 'browserConfiguration', 'browserClosed', 'backendDown']) {
    const error = new BackendError(code);
    assert.deepEqual(error.headers, {});
    assert.equal(BackendError.fromEnvelope(error.toJSON()).code, code);
  }
});

test('mutated error fields cannot leak through HTTP headers', () => {
  const marker = globalThis.crypto.randomUUID();
  for (const code of ['expired', 'cooldown', 'upstream', 'backendDown']) {
    const error = new BackendError(code);
    error.message = marker;
    error.signIn = marker;
    error.retryAfter = marker;
    assert.equal(JSON.stringify(error.toJSON()).includes(marker), false);
    assert.equal(JSON.stringify(error.headers).includes(marker), false);
    assert.equal([...new Headers(error.headers).values()].some(value => value.includes(marker)), false);
  }
});

test('restriction reads do not alter pacing, cooldown or permanent blocking', async () => {
  for (const status of [200, 401, 429]) {
    const clock = forge();
    const guard = new AccountGuard(clock);
    guard.observe(status, '60');
    for (let index = 0; index < 500; index++) {
      if (status === 200) assert.doesNotThrow(() => guard.restriction());
      else assert.throws(() => guard.restriction(), error => error.status === status);
    }
    assert.deepEqual(clock.sleeps, []);
    clock.advance(60001);
    if (status === 401) await assert.rejects(guard.begin(), error => error.status === 401);
    else (await guard.begin())();
  }
});
