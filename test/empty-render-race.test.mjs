import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTurn } from '../backend/observe.mjs';
import { AccountGuard } from '../backend/guard.mjs';

test('terminal state before the text child does not become a premature empty failure', async () => {
  let reads = 0;
  const page = { isClosed: () => false, evaluate: async () => ({ text: reads++ ? 'MODEL_AUDIT_OK' : '', nodes: 1 }) };
  const adapter = { probePageError: async () => null, completionState: async () => ({ complete: true, layout: 'current' }) };
  const result = await observeTurn(page, { run: { queue: [] }, adapter, guard: new AccountGuard(), budget: 2000, emit: async () => {} });
  assert.equal(result.text, 'MODEL_AUDIT_OK');
});
