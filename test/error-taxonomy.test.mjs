import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountGuard, BackendError, errorTable, publicError } from '../backend/guard.mjs';

// The pinned taxonomy from the implementation plan §3.1. The kept codes must
// preserve their 0.1.0 message strings; the new codes are pinned templates
// whose {slots} are interpolated from construction values.
const taxonomy = {
  expired: [401, 'Sign in again to refresh the ChatGPT session.'],
  cooldown: [429, 'The account is cooling down after a rate limit.'],
  upstream: [502, 'The upstream request failed.'],
  requestBudget: [504, 'This request exceeded its local time budget and was stopped before any confirmed result.'],
  empty: [502, 'ChatGPT returned an empty reply.'],
  hidden: [502, 'ChatGPT hid the reply from the conversation.'],
  truncated: [502, 'ChatGPT stopped before confirming the reply was complete.'],
  unsupported: [400, 'This provider accepts text and client tool blocks; attachments and other content blocks are unavailable.'],
  invalidRequest: [400, 'The request is invalid.'],
  toolDefinition: [400, 'The tool definitions are invalid or use unsupported schema keywords.'],
  toolChoice: [400, 'The tool choice is invalid or names an undefined tool.'],
  toolUnknown: [502, 'ChatGPT requested an undefined tool.'],
  toolJSON: [502, 'ChatGPT returned malformed tool-call JSON.'],
  toolSchema: [502, 'ChatGPT tool arguments do not match the input schema.'],
  toolChoiceViolation: [502, 'ChatGPT did not follow the requested tool choice.'],
  toolParallel: [502, 'ChatGPT emitted multiple tool calls when parallel calls were disabled.'],
  toolIncomplete: [502, 'ChatGPT ended the reply inside an incomplete tool call.'],
  toolRequired: [502, 'ChatGPT did not produce the required tool call.'],
  toolDelimiter: [502, 'ChatGPT returned a malformed tool-call delimiter.'],
  toolLimit: [502, 'The tool call or schema validation exceeded its complexity limit.'],
  binding: [409, 'The conversation belongs to another account or its history was replayed or changed.'],
  temporary: [502, 'Temporary chat could not be confirmed; no message was sent.'],
  harvest: [502, 'The answer reader failed; no completed reply can be confirmed.'],
  protocol: [502, 'The backend or upstream protocol is invalid.'],
  verification: [502, 'ChatGPT asked to verify you are human. Complete verification in the open browser, then retry the chat.'],
  capacity: [503, 'Local backend capacity is exhausted; active work and cooldowns may clear, but sign-in blocks persist until the backend restarts.'],
  browserDependency: [503, 'The playwright-core dependency is unavailable; install the packaged dependency.'],
  browserProfile: [502, 'The browser profile restored a page other than about:blank.'],
  browserConfiguration: [502, 'Browser account or profile root configuration is invalid.'],
  browserClosed: [503, 'The browser context closed or its supervisor stopped.'],
  backendDown: [503, 'Backend unavailable; install Node 20 or newer and Chrome.'],
  signinTimeout: [504, 'Sign-in did not finish within {windowMinutes} minutes. Start sign-in again; the previous attempt was cancelled cleanly.'],
  missingComponent: [503, '{component} was not found. {remedy}'],
  pickerMissing: [502, 'The ChatGPT page changed: {component} was not found (selector {selector}, adapter {adapterVersion}). Update the plugin; if it is already latest, report this adapter version.'],
  pickerAmbiguous: [502, "The model picker shows {count} entries for {slug}; the plugin cannot choose safely. Retry, or select the model once by hand in a visible browser (enable 'visible-turns')."],
  modelNotOffered: [400, '{slug} is not offered to this ChatGPT account. Pick one of the listed models; refresh the model list if the account changed.'],
  attachmentUnsupported: [400, 'This message contains {kind}, which chatgpt-web cannot send. Remove it and retry. Images are supported up to {maxCount} files / {maxBytes} each.'],
  imageRejected: [502, 'ChatGPT refused the image upload ({detail}). Retry; if it persists, send the message without the image.'],
};

const slotValues = {
  signinTimeout: { windowMinutes: 5 },
  missingComponent: { component: 'Google Chrome', remedy: 'Install Google Chrome and try again.' },
  pickerMissing: { component: 'composer', selector: '[id="prompt-textarea"]', adapterVersion: '2026-10-15.1' },
  pickerAmbiguous: { count: 3, slug: 'gpt-5.2' },
  modelNotOffered: { slug: 'gpt-6' },
  attachmentUnsupported: { kind: 'a PDF file', maxCount: 4, maxBytes: '10 MiB' },
  imageRejected: { detail: 'unsupported media type' },
};

test('every §3.1 code exists with its pinned status and message template', () => {
  for (const [code, [status, template]] of Object.entries(taxonomy)) {
    assert.ok(Object.hasOwn(errorTable, code), `the code ${code} is missing from the error table`);
    assert.deepEqual(errorTable[code], [status, template], `status or template drift for ${code}`);
  }
});

test('kept codes keep their 0.1.0 message as the constructed message', () => {
  for (const code of ['expired', 'cooldown', 'truncated', 'binding', 'verification', 'capacity', 'backendDown']) {
    assert.equal(new BackendError(code).message, taxonomy[code][1]);
    assert.equal(new BackendError(code).status, taxonomy[code][0]);
  }
});

test('new codes interpolate their pinned message templates', () => {
  assert.equal(
    new BackendError('signinTimeout', { values: slotValues.signinTimeout }).message,
    'Sign-in did not finish within 5 minutes. Start sign-in again; the previous attempt was cancelled cleanly.',
  );
  assert.equal(
    new BackendError('missingComponent', { values: slotValues.missingComponent }).message,
    'Google Chrome was not found. Install Google Chrome and try again.',
  );
  assert.equal(
    new BackendError('pickerMissing', { values: slotValues.pickerMissing }).message,
    'The ChatGPT page changed: composer was not found (selector [id="prompt-textarea"], adapter 2026-10-15.1). Update the plugin; if it is already latest, report this adapter version.',
  );
  assert.equal(
    new BackendError('pickerAmbiguous', { values: slotValues.pickerAmbiguous }).message,
    "The model picker shows 3 entries for gpt-5.2; the plugin cannot choose safely. Retry, or select the model once by hand in a visible browser (enable 'visible-turns').",
  );
  assert.equal(
    new BackendError('modelNotOffered', { values: slotValues.modelNotOffered }).message,
    'gpt-6 is not offered to this ChatGPT account. Pick one of the listed models; refresh the model list if the account changed.',
  );
  assert.equal(
    new BackendError('attachmentUnsupported', { values: slotValues.attachmentUnsupported }).message,
    'This message contains a PDF file, which chatgpt-web cannot send. Remove it and retry. Images are supported up to 4 files / 10 MiB each.',
  );
  assert.equal(
    new BackendError('imageRejected', { values: slotValues.imageRejected }).message,
    'ChatGPT refused the image upload (unsupported media type). Retry; if it persists, send the message without the image.',
  );
});

test('new codes carry their §3.1 statuses and plain headers', () => {
  for (const [code, values] of Object.entries(slotValues)) {
    const error = new BackendError(code, { values });
    assert.equal(error.status, taxonomy[code][0], code);
    assert.deepEqual(error.headers, {}, code);
  }
});

test('a slotted code cannot be constructed with a missing or null value', () => {
  assert.throws(() => new BackendError('missingComponent'), TypeError);
  assert.throws(() => new BackendError('modelNotOffered', { values: {} }), TypeError);
  assert.throws(() => new BackendError('modelNotOffered', { values: { slug: null } }), TypeError);
  assert.throws(() => new BackendError('imageRejected', { values: { detail: undefined } }), TypeError);
});

test('a parameterized message survives the envelope round trip', () => {
  for (const [code, values] of Object.entries(slotValues)) {
    const error = new BackendError(code, { values });
    const restored = BackendError.fromEnvelope(error.toJSON());
    assert.equal(restored.code, code);
    assert.equal(restored.message, error.message);
    assert.equal(restored.status, error.status);
  }
});

test('new error envelopes are credential-free', () => {
  for (const [code, values] of Object.entries(slotValues)) {
    const envelope = publicError(new BackendError(code, { values }));
    assert.ok(!('cookie' in envelope), code);
    assert.ok(!('token' in envelope), code);
    assert.equal(envelope.status, taxonomy[code][0], code);
    assert.equal(typeof envelope.message, 'string', code);
  }
});

test('mutated error fields cannot leak through slotted envelopes', () => {
  const marker = globalThis.crypto.randomUUID();
  const error = new BackendError('modelNotOffered', { values: { slug: 'gpt-6' } });
  error.message = marker;
  error.retryAfter = marker;
  assert.equal(JSON.stringify(error.toJSON()).includes(marker), false);
  assert.equal(JSON.stringify(error.headers).includes(marker), false);
});

test('an envelope without recoverable slots still resolves to a safe known error', () => {
  const restored = BackendError.fromEnvelope({ status: 502, message: 'site said something unexpected' });
  assert.equal(restored.code, 'protocol');
  assert.equal(restored.message, taxonomy.protocol[1]);
  const named = BackendError.fromEnvelope({ status: 502, message: 'drift', code: 'pickerMissing' });
  assert.equal(named.code, 'protocol');
});

test('a 403 blocks the account for the guard lifetime', async () => {
  const forge = () => {
    let now = 0;
    return {
      now: () => now,
      sleep: async milliseconds => { now += milliseconds; },
    };
  };
  const guard = new AccountGuard(forge());
  guard.observe(403);
  await assert.rejects(guard.begin(), error => {
    assert.equal(error.status, 401);
    assert.equal(error.signIn, 'expired');
    return true;
  });
});
