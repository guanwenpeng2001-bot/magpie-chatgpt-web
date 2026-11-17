import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSubmissionReceipt, nativeUsageModel, readSubmissionAccount } from '../src/usage/submission.mjs';

const key = 'a'.repeat(64);
const setup = extra => {
  const events = [];
  return { events, options: { profile: 'fixture', source: 'native', model: 'gpt-6-pro', effort: 'max', id: 'send-one',
    readAccount: async () => ({ accountKey: key }), now: () => 42,
    begin: async () => events.push('start'), record: async x => events.push(x), gap: async () => events.push('gap'), ...extra } };
};

test('accepted sends count once across repeated observation and separate physical sends count separately', async () => {
  const { events, options } = setup();
  const first = await prepareSubmissionReceipt(options);
  await first.flush(); assert.deepEqual(events, ['start'], 'preparing/clicking is not acceptance');
  first.confirm(); first.confirm(); first.uncertain(); await first.flush();
  const second = await prepareSubmissionReceipt({ ...options, id: 'send-two', stage: 'multipart' });
  second.confirm(); await second.flush();
  assert.deepEqual(events.filter(x => typeof x === 'object').map(x => [x.id, x.stage, x.at]),
    [['send-one', 'message', 42], ['send-two', 'multipart', 42]]);
});

test('ambiguous submitted failures are gaps, while preparation alone is not', async () => {
  const { events, options } = setup();
  const receipt = await prepareSubmissionReceipt(options);
  receipt.uncertain(); receipt.uncertain(); await receipt.flush();
  assert.deepEqual(events, ['start', 'gap']);
});

test('unknown account never charges a cached identity; optional failures do not escape', async () => {
  for (const readAccount of [async () => undefined, async () => ({ accountKey: 'bad' }), async () => { throw Error('identity failed'); }]) {
    const { events, options } = setup({ readAccount });
    const receipt = await prepareSubmissionReceipt(options); receipt.confirm(); receipt.uncertain(); await receipt.flush();
    assert.deepEqual(events, []);
  }
  const { options } = setup({ begin: async () => { throw Error('disk'); }, record: async () => { throw Error('disk'); } });
  const receipt = await prepareSubmissionReceipt(options); receipt.confirm(); await receipt.flush();
});

test('stalled optional observers and writes have a bounded wait', async () => {
  const stalled = () => new Promise(() => {});
  const { options } = setup({ readAccount: stalled, identityTimeoutMs: 5 });
  const receipt = await prepareSubmissionReceipt(options); receipt.confirm(); await receipt.flush();
  const writable = await prepareSubmissionReceipt({ ...options, readAccount: async () => ({ accountKey: key }), begin: stalled, flushTimeoutMs: 5 });
  writable.confirm(); await writable.flush();
});

test('native receipt model follows proven selected family and effort', () => {
  assert.equal(nativeUsageModel({ modelFamily: '6', effort: 'max' }), 'gpt-6-pro');
  assert.equal(nativeUsageModel({ modelFamily: '5.6', effort: 'max' }), 'gpt-5.6-pro');
  assert.equal(nativeUsageModel({ modelFamily: '6', effort: 'low' }), 'gpt-6');
  assert.equal(nativeUsageModel({ effort: 'max' }), 'pro-unknown');
  assert.equal(nativeUsageModel({ modelFamily: 'unverified', effort: 'high' }), 'other');
});

test('non-ChatGPT pages cannot supply accounting identity', async () => {
  assert.equal(await readSubmissionAccount({ url: () => 'https://example.com', evaluate() { assert.fail('no cross-origin read'); } }), undefined);
});
