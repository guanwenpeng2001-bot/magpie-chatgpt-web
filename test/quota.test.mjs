import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { _internal } from '../src/index.mjs';
import { usageHook } from '../src/hooks/usage.mjs';
import { readQuota } from '../backend/quota.mjs';
import { serve } from '../backend/main.mjs';
import { ReadClient } from '../backend/http.mjs';
import { AccountGuard, BackendError } from '../backend/guard.mjs';

const auth = { type: 'oauth', refresh: 'fixture-cookie', access: 'fixture-token', profile: 'fixture' };
const session = { accessToken: 'private-access', refresh: 'private-cookie', user: { email: 'private-email' },
  account: { id: 'private-account', planType: 'pro', structure: 'personal', isDelinquent: false },
  expires: '2099-01-01T00:00:00Z' };
const noShare = result => {
  assert.equal(result.windows.length, 1);
  assert.match(result.windows[0].display, /^Unknown — .+/);
  assert.equal(result.windows[0].aside, true);
  for (const field of ['used', 'amount', 'limit', 'balance', 'resetsAt', 'resetSecs']) {
    assert.equal(Object.hasOwn(result.windows[0], field), false, `${field} must not be fabricated`);
  }
  assert.equal(Object.hasOwn(result, 'until'), false, 'session expiry is not subscription expiry');
};

test('index exposes auth.usage, reads current account and passes cancellation through', async () => {
  const calls = [];
  const hooks = _internal.createHooks({ profileRoot: '/fixture', bridge: { async call(command, signal) {
    calls.push({ command, signal });
    return { state: 'unknown', reason: 'not-reported', planType: 'pro' };
  } } });
  assert.equal(typeof hooks.auth.usage, 'function');
  const signal = new AbortController().signal;
  for (const current of [auth, { ...auth, refresh: 'rotated', profile: 'other' }]) {
    const result = await hooks.auth.usage(async () => current, { id: 'chatgpt-web' }, { signal });
    assert.deepEqual(calls.at(-1), { command: { method: 'quota', auth: current, profileRoot: '/fixture' }, signal });
    assert.equal(result.plan, 'ChatGPT Pro');
    assert.equal(result.signIn, 'kept');
    noShare(result);
  }
});

test('quota refresh never emits request-token usage or sends a model request', async () => {
  let usageEvents = 0, modelRequests = 0, quotaReads = 0;
  const hooks = _internal.createHooks({
    input: { magpie: { usage() { usageEvents++; } } },
    bridge: {
      async call(command) {
        assert.equal(command.method, 'quota');
        quotaReads++;
        if (quotaReads === 2) throw new BackendError('verification');
        return { state: 'unknown', reason: 'not-reported', planType: 'pro' };
      },
      open() { modelRequests++; throw Error('quota must not submit a chat'); },
    },
  });
  // Success, transient failure and another refresh must all remain quota-only.
  for (let i = 0; i < 3; i++) noShare(await hooks.auth.usage(async () => auth));
  assert.equal(quotaReads, 3);
  assert.equal(usageEvents, 0, 'token usage is already recorded by the request path');
  assert.equal(modelRequests, 0);
});

test('account projection allowlists plan/payment fields and discards credentials and Codex counters', async () => {
  const result = await readQuota({ session: async (signal, options) => {
    assert.equal(signal, undefined);
    assert.deepEqual(options, { interactive: false });
    return { ...session, plan_type: 'plus', rate_limit: { primary_window: { used_percent: 34, reset_at: 99999 } },
      remaining_messages: 42, usage: { input_tokens: 300, output_tokens: 200 }, credits: { balance: '999' } };
  } });
  assert.deepEqual(result, { state: 'unknown', reason: 'not-reported', planType: 'pro' });
  assert.doesNotMatch(JSON.stringify(result), /private-|999|42|34/);
});

test('missing/unsupported plans and payment problems remain explicit unknowns', async () => {
  for (const [account, reason, planType] of [
    [undefined, 'plan-not-reported'], [{}, 'plan-not-reported'],
    [{ planType: 'unverified-tier' }, 'plan-not-reported'],
    [{ planType: 'pro', isDelinquent: true }, 'payment-attention', 'pro'],
    [{ planType: 'prolite' }, 'not-reported', 'prolite'],
    [{ planType: 'free' }, 'not-reported', 'free'],
    [{ planType: '__proto__' }, 'plan-not-reported'],
  ]) {
    const snapshot = await readQuota({ session: async () => ({ ...session, account }) });
    assert.deepEqual(snapshot, { state: 'unknown', reason, ...(planType ? { planType } : {}) });
    const result = await usageHook({ bridge: { call: async () => snapshot } })(async () => auth);
    noShare(result);
    if (reason === 'payment-attention') assert.match(result.windows[0].display, /payment issue/);
  }
});

test('expired sessions do not pass as current account information', async () => {
  for (const invalid of [{ expires: '2000-01-01T00:00:00Z' }, { expires: 'invalid' }, { error: 'private-upstream-error' }]) {
    await assert.rejects(readQuota({ session: async () => ({ ...session, ...invalid }) }), { code: 'expired' });
  }
});

test('read failures show fixed reasons, never vendor error text or an invented percentage', async () => {
  for (const code of ['expired', 'verification', 'cooldown', 'requestBudget', 'backendDown', 'protocol', 'upstream']) {
    const failure = new BackendError(code);
    failure.message = 'private-error-body';
    const result = await usageHook({ bridge: { call: async () => { throw failure; } } })(async () => auth);
    noShare(result);
    assert.equal(result.signIn, code === 'expired' ? 'expired' : 'kept');
    assert.doesNotMatch(JSON.stringify(result), /private-/);
    if (code === 'cooldown') assert.match(result.windows[0].display, /does not establish/);
  }
  const result = await usageHook({ bridge: { call: async () => { throw Error('private-cookie'); } } })(async () => auth);
  noShare(result);
  assert.equal(result.signIn, 'kept');
  assert.doesNotMatch(JSON.stringify(result), /private-cookie/);
});

test('malformed backend replies never become quota readings', async () => {
  for (const response of [null, {}, { state: 'known', used: 10 }, { state: 'unknown', reason: 'secret' }]) {
    const result = await usageHook({ bridge: { call: async () => response } })(async () => auth);
    noShare(result);
    assert.match(result.windows[0].display, /supported format/);
  }
});

test('missing auth and cancellation never start an account read', async () => {
  const hook = usageHook({ bridge: { call() { assert.fail('must not read'); } } });
  assert.equal((await hook(async () => null)).signIn, 'expired');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(hook(() => assert.fail('must not get auth'), {}, { signal: controller.signal }), { name: 'AbortError' });
  const inFlight = new AbortController();
  const running = usageHook({ bridge: { async call(_command, signal) {
    assert.equal(signal, inFlight.signal);
    inFlight.abort();
    throw new BackendError('upstream');
  } } });
  await assert.rejects(running(async () => auth, {}, { signal: inFlight.signal }), { name: 'AbortError' });
});

async function httpFixture(t, handler) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push([request.method, request.url]);
    handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new ReadClient({ origin: `http://127.0.0.1:${server.address().port}`, cookie: 'fixture-cookie',
    guard: new AccountGuard({ sleep: async () => {} }),
    browserRoute() { assert.fail('quota must never enter a browser route'); } });
  return { client, seen };
}

test('quota uses only GET auth/session, never models, conversations or Codex usage', async t => {
  const { client, seen } = await httpFixture(t, (_request, response) => response.end(JSON.stringify(session)));
  assert.deepEqual(await readQuota(client), { state: 'unknown', reason: 'not-reported', planType: 'pro' });
  assert.deepEqual(seen, [['GET', '/api/auth/session']]);
});

for (const [status, headers, body, code] of [
  [403, { 'cf-mitigated': 'challenge' }, '', 'verification'],
  [403, { 'content-type': 'text/html' }, 'Just a moment /cdn-cgi/challenge-platform Enable JavaScript and cookies to continue', 'verification'],
  [401, {}, 'private-upstream', 'expired'],
  [429, { 'retry-after': '5' }, 'private-upstream', 'cooldown'],
  [200, {}, 'not JSON', 'protocol'],
]) {
  test(`quota HTTP ${status}/${code} never opens a browser or submits a model request`, async t => {
    const { client, seen } = await httpFixture(t, (_request, response) => { response.writeHead(status, headers); response.end(body); });
    await assert.rejects(readQuota(client), error => error.code === code && !error.message.includes('private-upstream'));
    assert.deepEqual(seen, [['GET', '/api/auth/session']]);
  });
}

test('backend quota dispatch projects data before it crosses the wire and isolates accounts', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const frames = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const accounts = [];
  const work = serve(input, output, { readClient(options) {
    accounts.push(options.cookie);
    return { guard: options.guard, session: async (_signal, policy) => {
      assert.deepEqual(policy, { interactive: false });
      return { ...session, account: { planType: options.cookie === 'account-a' ? 'pro' : 'plus' } };
    } };
  } });
  try {
    for (const cookie of ['account-a', 'account-b']) {
      input.write(JSON.stringify({ id: cookie, method: 'quota', auth: { ...auth, profile: cookie, refresh: cookie } }) + '\n');
      while (!frames.some(frame => frame.id === cookie && ['done', 'error'].includes(frame.event))) await once(output, 'data');
    }
    assert.deepEqual(accounts, ['account-a', 'account-b']);
    assert.deepEqual(frames.filter(frame => frame.event === 'data').map(frame => frame.data.planType), ['pro', 'plus']);
    assert.equal(frames.some(frame => frame.event === 'error'), false);
    assert.doesNotMatch(JSON.stringify(frames), /private-|accessToken|refresh|email/);
  } finally { input.end(); await work; }
});
