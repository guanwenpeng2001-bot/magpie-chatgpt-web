import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_SUBMIT_PATTERN, LiveLedger } from '../integrations/verify-live.mjs';

test('conversation submit paths are classified exactly, preparation paths are not', () => {
  assert.equal(CONVERSATION_SUBMIT_PATTERN.test('/backend-api/conversation'), true);
  assert.equal(CONVERSATION_SUBMIT_PATTERN.test('/backend-api/f/conversation'), true);
  assert.equal(CONVERSATION_SUBMIT_PATTERN.test('/backend-api/f/conversation/prepare'), false);
  assert.equal(CONVERSATION_SUBMIT_PATTERN.test('/backend-api/conversation/init'), false);
  assert.equal(CONVERSATION_SUBMIT_PATTERN.test('/backend-api/sentinel/chat-requirements/prepare'), false);
  const ledger = new LiveLedger();
  assert.equal(ledger.classifyBrowserRequest('POST', '/backend-api/conversation'), 'submit');
  assert.equal(ledger.classifyBrowserRequest('POST', '/backend-api/f/conversation'), 'submit');
  assert.equal(ledger.classifyBrowserRequest('GET', '/backend-api/conversation'), 'record');
  assert.equal(ledger.classifyBrowserRequest('POST', '/backend-api/f/conversation/prepare'), 'record');
});

test('a conversation submit is counted as a deliberate request, unlike the INC-7 ledger shape', () => {
  const inc7Deliberate = [
    { route: 'node', path: '/backend-api/models' },
    { route: 'browser-read-attempt', path: '/backend-api/models' },
  ];
  const ledger = new LiveLedger({ deliberateCap: 4 });
  ledger.deliberate.push(...inc7Deliberate);
  assert.equal(ledger.deliberate.length, 2);
  assert.equal(ledger.reserveSubmit('/backend-api/conversation'), true);
  assert.equal(ledger.conversationSubmits, 1);
  assert.equal(ledger.deliberate.length, 3);
  assert.deepEqual(ledger.deliberate.at(-1), { route: 'browser', path: '/backend-api/conversation' });
});

test('submit reservations stop at the deliberate cap and the submit cap', () => {
  const capped = new LiveLedger({ deliberateCap: 3 });
  capped.reserve('node', '/backend-api/models');
  capped.reserve('browser-read-attempt', '/backend-api/models');
  assert.equal(capped.reserveSubmit('/backend-api/conversation'), true);
  assert.equal(capped.reserveSubmit('/backend-api/f/conversation'), false);
  assert.equal(capped.conversationSubmits, 1);
  assert.equal(capped.deliberate.length, 3);

  const limited = new LiveLedger({ deliberateCap: 8, submitCap: 1 });
  assert.equal(limited.reserveSubmit('/backend-api/conversation'), true);
  assert.equal(limited.reserveSubmit('/backend-api/conversation'), false);
  assert.equal(limited.conversationSubmits, 1);
  assert.equal(limited.deliberate.length, 1);
});

test('the ledger serializes to the archived accounting shape without private fields', () => {
  const ledger = new LiveLedger({ deliberateCap: 4 });
  ledger.reserve('node', '/backend-api/models');
  ledger.reserveSubmit('/backend-api/conversation');
  ledger.statuses.push({ route: 'node', path: '/backend-api/models', status: 403, mitigated: true });
  const saved = JSON.parse(JSON.stringify(ledger));
  assert.deepEqual(Object.keys(saved).sort(), ['blockedOffOrigin', 'browserByKind', 'browserRequests', 'conversationSubmits', 'deliberate', 'posts', 'statuses'].sort());
  assert.equal(saved.conversationSubmits, 1);
  assert.equal(saved.deliberate.length, 2);
});
