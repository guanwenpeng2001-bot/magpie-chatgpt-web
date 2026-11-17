import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountKeyFromSession, usageProfile, recordSubmission, readUsage, DAY_MS } from '../src/usage/store.mjs';
import { localUsageWindows } from '../src/usage/display.mjs';
import { readQuota } from '../backend/quota.mjs';
import { usageHook } from '../src/hooks/usage.mjs';

const now = Date.UTC(2026, 10, 13, 12);
function local(byModel, extras = {}) {
  return { version: 1, status: 'tracking', asOf: now, since: now - DAY_MS,
    sources: [{ source: 'native', since: now - DAY_MS }], gaps: { day: 0, week: 0 },
    day: byModel.reduce((n, x) => n + x.day, 0), week: byModel.reduce((n, x) => n + x.week, 0), byModel, ...extras };
}
const sample = () => local([
  { model: 'gpt-6-pro', effort: 'max', day: 3, week: 7 },
  { model: 'gpt-5.6-sol', effort: 'max', day: 2, week: 5 },
  { model: 'pro-unknown', effort: 'unknown', day: 1, week: 2 },
  { model: 'gpt-6-sol', effort: 'high', day: 8, week: 20 },
]);
const noMeasuredQuota = windows => {
  for (const row of windows) {
    assert.equal(row.aside, true);
    for (const name of ['used', 'remaining', 'amount', 'limit', 'balance', 'resetsAt', 'resetSecs', 'runsOutAt']) assert.equal(Object.hasOwn(row, name), false, name);
    assert.doesNotMatch(row.display, /\d+%/);
  }
};

test('all plans show recorded counts without budgets, forecasts or remaining percentages', () => {
  for (const planType of ['prolite', 'pro', 'plus', 'business', undefined]) {
    const windows = localUsageWindows(sample(), { planType, personal: true });
    const text = JSON.stringify(windows);
    assert.match(text, /14 次已记录/);
    assert.match(text, /34 次已记录/);
    assert.match(text, /此前及外部发送/);
    assert.doesNotMatch(text, /估算|预测|预算|Pro100|Pro200|余\d+|\d+\/50/);
    noMeasuredQuota(windows);
  }
});

test('new/partial coverage, gaps and unknown family never become full-account certainty', () => {
  const notStarted = { ...local([]), status: 'not-started', since: null, sources: [] };
  const windows = localUsageWindows(notStarted, { planType: 'prolite', personal: true });
  assert.match(JSON.stringify(windows), /尚未开始/);
  assert.doesNotMatch(JSON.stringify(windows), /余50|0 次/);
  const gaps = localUsageWindows({ ...sample(), gaps: { day: 1, week: 2 } }, { planType: 'prolite', personal: true });
  assert.match(JSON.stringify(gaps), /2 次记录缺口/);
  const unknown = local([{ model: 'unknown', effort: 'unknown', day: 1, week: 1 }]);
  assert.match(JSON.stringify(localUsageWindows(unknown, { planType: 'prolite', personal: true })), /型号未识别/);
  assert.match(JSON.stringify(localUsageWindows({ status: 'unavailable' })), /未归零/);
  noMeasuredQuota(gaps);
});

test('malformed projections fail closed without exposing arbitrary labels or invalid totals', () => {
  for (const invalid of [null, {}, { ...sample(), day: -1 }, { ...sample(), day: 999 },
    { ...sample(), byModel: [{ model: 'private-text', effort: 'max', day: 14, week: 34 }] },
    { ...sample(), since: NaN }, { ...sample(), asOf: Infinity }, { ...sample(), sources: [] }]) {
    assert.equal(localUsageWindows(invalid), null);
  }
});

test('backend/session to visible card reads the same persisted account, with no model request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'usage-card-')); t.after(() => rm(root, { recursive: true, force: true }));
  const profile = usageProfile('fixture', root);
  const session = { user: { id: 'private-user' }, account: { id: 'private-account', planType: 'prolite', structure: 'personal' },
    accessToken: 'private-token', expires: '2099-01-01T00:00:00Z' };
  const scope = { profile, accountKey: accountKeyFromSession(session) };
  await recordSubmission({ ...scope, id: 'private-send-id', at: now, source: 'native', model: 'gpt-6-pro', effort: 'max' }, { now });
  let sessionReads = 0;
  const client = { session: async (_signal, options) => { sessionReads++; assert.deepEqual(options, { interactive: false }); return session; } };
  const quota = await readQuota(client, undefined, { profile, now });
  assert.equal(quota.state, 'unknown', 'actual account remaining is still unknown');
  assert.equal(quota.local.week, 1);
  assert.doesNotMatch(JSON.stringify(quota), /private-|accountKey|"profile"/);
  const hook = usageHook({ bridge: { call: async () => quota } });
  const result = await hook(async () => ({ type: 'oauth', refresh: 'fixture-only' }));
  assert.equal(result.signIn, 'kept');
  assert.doesNotMatch(JSON.stringify(result), /估算|预测|预算|余49/);
  assert.equal(result.windows.at(-1).display, '未提供');
  assert.match(JSON.stringify(result), /1 次已记录/);
  noMeasuredQuota(result.windows);
  assert.equal(sessionReads, 1);
  const other = await readQuota({ session: async () => ({ ...session, user: { id: 'other' } }) }, undefined, { profile, now });
  assert.equal(other.local.status, 'not-started');
  const missingIdentity = await readQuota({ session: async () => ({ ...session, user: {} }) }, undefined, { profile, now });
  assert.equal(missingIdentity.local.status, 'identity-unavailable');
});

test('text hyphen-version aliases and native dotted models share recorded counts; High remains separate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'usage-alias-')); t.after(() => rm(root, { recursive: true, force: true }));
  const scope = { profile: usageProfile('fixture', root), accountKey: 'a'.repeat(64) };
  for (const [id, model, effort, source] of [
    ['native', 'gpt-5.6-pro', 'max', 'native'], ['text', 'gpt-5-6-pro', 'max', 'text'],
    ['high', 'gpt-5-6-high', 'high', 'text'],
  ]) await recordSubmission({ ...scope, id, model, effort, source, at: now }, { now });
  const result = await readUsage(scope, { now });
  assert.equal(result.byModel.find(x => x.model === 'gpt-5.6-pro').week, 2);
  assert.equal(result.byModel.find(x => x.model === 'gpt-5.6-high').week, 1);
  assert.equal(result.week, 3);
  assert.doesNotMatch(JSON.stringify(localUsageWindows(result)), /估算|预测|预算/);
});
