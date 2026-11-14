import test from 'node:test';
import assert from 'node:assert/strict';
import { ownershipSnapshot, parseOwnershipSnapshot } from '../src/native/ownership-diagnostics.mjs';
import { parseBrokerDiagnostic } from '../src/native/broker-diagnostics.mjs';

const sample = () => ({ executionKey: 'private-execution', ownerKey: 'private-owner', model: 'private-model',
  instruction: { current: 'private-instruction', predecessors: new Set(['private-prior']) },
  reasoning: { effort: 'high', summary: 'private-summary' }, identity: { turnId: 'private-turn', threadId: 'private-thread' },
  revision: { itemId: 'private-item', content: [{ text: 'private-prompt' }] } });

test('ownership evidence distinguishes changed settings from changed canonical instructions without content', () => {
  const source = ownershipSnapshot(sample());
  const compact = ownershipSnapshot({ ...sample(), compaction: true, executionKey: 'private-compact',
    sourceKey: 'private-execution', reasoning: { effort: 'medium' } });
  assert.equal(compact.sourceHash, source.executionHash);
  for (const key of ['ownerHash', 'instructionHash', 'itemHash', 'contentHash', 'turnHash']) assert.equal(compact[key], source[key]);
  assert.notEqual(compact.executionHash, source.executionHash);
  assert.equal(compact.effort, 'medium');
  assert.doesNotMatch(JSON.stringify({ source, compact }), /private-|prompt|token|summary/);
  assert.deepEqual(parseBrokerDiagnostic('[chatgpt-web] ownership ' + JSON.stringify(compact)), { type: 'ownership', ...compact });
});

test('ownership parser retains only bounded allowlisted hashes and safely ignores unsupported data', () => {
  assert.equal(ownershipSnapshot({ ...sample(), reasoning: 'high' }).effort, 'high');
  assert.equal(ownershipSnapshot({ ...sample(), reasoning: 'private-value' }).effort, 'unknown');
  const snapshot = ownershipSnapshot(sample());
  assert.doesNotMatch(JSON.stringify(parseOwnershipSnapshot({ ...snapshot, token: 'private-token' })), /private|token/);
  for (const value of [null, { ...snapshot, effort: 'private-value' }, { ...snapshot, itemHash: 'private-id' },
    { ...snapshot, predecessorHashes: Array(9).fill('a'.repeat(16)) }, { ...snapshot, ownerHash: undefined }]) {
    assert.equal(parseOwnershipSnapshot(value), undefined);
  }
  assert.equal(ownershipSnapshot({ instruction: { predecessors: 1 } }), null);
  assert.equal(parseBrokerDiagnostic('[chatgpt-web] ownership invalid'), undefined);
});
