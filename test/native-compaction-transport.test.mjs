import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseNativeCompactionTransport } from '../src/native/compaction-transport.mjs';

class AdapterError extends Error {
  constructor(options = {}) {
    super('fixture');
    Object.assign(this, { status: 400, errorType: 'invalid_request_error', code: 'context_length_exceeded', retryable: false }, options);
  }
}

function fixture(fail) {
  const calls = [];
  const parsed = Object.freeze({ modelId: 'gpt-5.6-sol', _chatgptModelFamily: '6', _compactionRequest: true });
  const caps = Object.freeze({ proAvailable: true, localToolsEnabled: false });
  const options = Object.freeze({ appName: 'fixture', experimentalSkillAttachments: true });
  let parts;
  const reference = {
    AdapterError,
    compile(p, c, token, o) {
      assert.equal(p, parsed); assert.equal(c, caps); assert.equal(token, undefined);
      assert.deepEqual(o, { ...options, experimentalMultipartParts: o.experimentalMultipartParts });
      parts = o.experimentalMultipartParts; calls.push(parts);
      fail?.('compile', parts);
      return { multipart: { parts: Array(parts).fill('record') }, images: [], text: 'compact' };
    },
    messages: c => c.multipart.parts,
    inputTokens: () => 50, messageTokens: () => 10, textTokens: () => 10,
    skillTokens: () => 2, imageTokens: () => 3,
    stagingMode(model, c) { assert.equal(model, parsed.modelId); assert.equal(c, caps); fail?.('stage', parts); return { effort: 'low' }; },
    assertMultipart(input, message, model, effort, c, chars, count, transport, family) {
      assert.equal(effort, 'max'); assert.equal(family, '6'); assert.equal(c, caps);
      assert.equal(count, parts); assert.equal(input, 50);
      assert.equal(transport.finalMessageTokens, 12); assert.equal(transport.finalImageTokens, 3);
      assert.equal(transport.stagingEffort, 'low'); fail?.('preflight', parts);
    },
  };
  return { calls, reference, run: () => chooseNativeCompactionTransport(parsed, caps, undefined, options, 'max', reference) };
}

test('chooser stops at the first validated candidate and preserves reference arguments', () => {
  const f = fixture(); assert.equal(f.run().multipart.parts.length, 2); assert.deepEqual(f.calls, [2]);
});

for (const phase of ['compile', 'stage', 'preflight']) {
  test(`only typed fit failure from ${phase} advances to six`, () => {
    const f = fixture((at, parts) => { if (at === phase && parts === 2) throw new AdapterError(); });
    assert.equal(f.run().multipart.parts.length, 6); assert.deepEqual(f.calls, [2, 6]);
  });
  for (const error of [new Error('unrelated'), new AdapterError({ code: 'capability_unavailable' }),
    new AdapterError({ retryable: true }), new AdapterError({ status: 500 }), new AdapterError({ errorType: 'server_error' })]) {
    test(`${phase} propagates unrelated ${error.constructor.name}/${error.code}/${error.status}/${error.retryable}/${error.errorType}`, () => {
      const f = fixture(at => { if (at === phase) throw error; });
      assert.throws(f.run, e => e === error); assert.deepEqual(f.calls, [2]);
    });
  }
}

test('both allocations failing returns the last fit failure', () => {
  const errors = [new AdapterError(), new AdapterError()];
  const f = fixture((at, parts) => { if (at === 'preflight') throw errors[parts === 2 ? 0 : 1]; });
  assert.throws(f.run, e => e === errors[1]); assert.deepEqual(f.calls, [2, 6]);
});

test('missing trustworthy preflight and incomplete candidate are never accepted', () => {
  const missing = fixture(); delete missing.reference.assertMultipart;
  assert.throws(missing.run, TypeError); assert.deepEqual(missing.calls, [2]);
  const incomplete = fixture(); const compile = incomplete.reference.compile;
  incomplete.reference.compile = (...args) => ({ ...compile(...args), trimmedCompactionMessages: 1 });
  assert.throws(incomplete.run, /did not preserve complete/); assert.deepEqual(incomplete.calls, [2]);
});
