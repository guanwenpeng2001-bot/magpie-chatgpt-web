// Full original checksum-pinned handler with its actual catch/encoder. Only
// runTurn's boundary is injectable; no browser, listener, RPC or tool executes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchNativeCompactionErrors } from '../../src/native/compaction-errors.mjs';

const [entryArg, mode] = process.argv.slice(2);
assert.ok(['baseline', 'patched'].includes(mode));
const entry = resolve(entryArg);
const original = readFileSync(entry);
const pin = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
assert.equal(createHash('sha256').update(original).digest('hex'), pin);
const startup = 'Rk().catch((e)=>{process.stderr.write(`codex-chatgpt-web: ${e instanceof Error?e.message:String(e)}\n`),process.exitCode=1});';
globalThis.fetch = () => { throw new Error('Offline compaction fixture forbids network'); };
Bun.plugin({ name: 'pinned-compaction-error-contract', setup(build) {
  build.onLoad({ filter: /[\\/]cli\.js$/ }, ({ path }) => {
    assert.equal(resolve(path), entry);
    assert.deepEqual(readFileSync(path), original);
    let source = original.toString('utf8');
    assert.equal(source.split(startup).length, 2);
    if (mode === 'patched') source = patchNativeCompactionErrors(source);
    return { loader: 'js', contents: source.replace(startup, '')
      + '\nexport { Ls as responses, cd as compact, q as AdapterError, $n as decodeSummary };' };
  });
} });

const native = await import(pathToFileURL(entry).href);
const config = { mode: 'full', subagentProtocol: 'native', contextWindow: 256000,
  appName: 'Offline compaction errors', browserHost: 'managed-chrome', browserInteractionMode: 'automatic',
  storageStatePath: join(process.cwd(), 'unused-storage.json'), brokerSocketPath: 'unused-offline',
  solAvailable: true, extraHighAvailable: true, proAvailable: true };
const request = (path, stream) => {
  const turn = randomUUID();
  const body = { model: 'chatgpt-web/gpt-5.6-sol', stream, reasoning: { effort: 'high' },
    client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: randomUUID(), turn_id: turn,
      request_kind: 'compaction', compaction: { implementation: 'responses', strategy: 'memento' } }) },
    input: [{ type: 'message', id: 'original', role: 'user', content: [{ type: 'input_text', text: 'Original fixture history.' }],
      internal_chat_message_metadata_passthrough: { turn_id: turn } }],
  };
  return new Request('http://127.0.0.1/v1/' + path, { method: 'POST', body: JSON.stringify(body) });
};

const cases = [
  { name: 'history-proof', message: 'History compaction capture requires current canonical Codex rollout proof.', status: 403, errorType: 'permission_error', code: 'history_scope_unverified', retryable: false },
  { name: 'verification', message: 'Complete browser verification.', status: 403, errorType: 'permission_error', code: 'chatgpt_security_check', retryable: false },
  { name: 'quota', message: 'Quota exhausted for this account.', status: 429, errorType: 'rate_limit_error', code: 'rate_limit_exceeded', retryable: false, retry_after: 120 },
  { name: 'quota-no-hint', message: 'Account quota exhausted.', status: 429, errorType: 'insufficient_quota', code: 'insufficient_quota', retryable: false },
  { name: 'quota-camel-hint', message: 'Rate limit.', status: 429, errorType: 'rate_limit_error', code: 'rate_limit_exceeded', retryable: false, retryAfter: '90' },
  { name: 'context', message: 'Context window exceeded.', status: 400, errorType: 'invalid_request_error', code: 'context_length_exceeded', retryable: false },
  { name: 'archive', message: 'Archive unavailable.', status: 409, errorType: 'invalid_request_error', code: 'history_archive_unavailable', retryable: false },
  { name: 'capacity', message: 'Archive full.', status: 413, errorType: 'invalid_request_error', code: 'history_capacity_exceeded', retryable: false },
  { name: 'expired', message: 'Sign in again.', status: 401, errorType: 'authentication_error', code: 'chatgpt_session_expired', retryable: false },
  { name: 'server-retryable', message: 'Temporarily unavailable.', status: 503, errorType: 'server_error', code: 'server_is_overloaded', retryable: true },
  { name: 'typed-server-500', message: 'Explicit internal failure.', status: 500, errorType: 'server_error', code: 'upstream_server_error', retryable: true },
];
let checks = 0;
const results = [];
try {
  for (const path of ['responses/compact', 'responses']) {
    const handler = path.endsWith('/compact') ? native.compact : native.responses;
    for (const value of cases) for (const delivery of ['throw', 'emit']) {
      let calls = 0;
      const observed = [];
      const error = Object.assign(new native.AdapterError(value.message, value),
        Object.fromEntries(['retry_after', 'retryAfter'].filter(key => value[key] !== undefined).map(key => [key, value[key]])));
      const response = await handler(request(path, false), config, () => ({ async runTurn(parsed, _incoming, emit) {
        calls++;
        assert.equal(parsed._compactionRequest, true);
        if (delivery === 'throw') throw error;
        emit({ type: 'error', message: error.message, status: error.status, errorType: error.errorType,
          code: error.code, retryable: error.retryable, ...value.retry_after === undefined ? {} : { retry_after: value.retry_after },
          ...value.retryAfter === undefined ? {} : { retryAfter: value.retryAfter } });
      } }), { onAdapterEvent: event => observed.push(event) });
      const body = await response.json();
      assert.equal(calls, 1, 'the handler must not replay any refusal');
      assert.equal(body.error.message, value.message);
      if (mode === 'patched') {
        assert.equal(response.status, value.status, path + '/' + delivery + '/' + value.name);
        assert.equal(body.error.type, value.errorType);
        assert.equal(body.error.errorType, value.errorType);
        assert.equal(body.error.code, value.code);
        assert.equal(body.error.status, value.status);
        assert.equal(body.error.retryable, value.retryable);
        assert.equal(body.retryable, value.retryable);
        assert.equal(response.headers.get('x-should-retry'), !value.retryable && value.status !== 429 ? 'false' : null);
        assert.equal(response.headers.get('x-magpie-sign-in'), value.status === 401 ? 'expired' : 'kept');
        assert.equal(response.headers.get('retry-after'), value.retry_after ? String(value.retry_after) : value.retryAfter ?? null);
        assert.equal(observed.at(-1).status, value.status);
        assert.equal(observed.at(-1).retryable, value.retryable);
      } else if (delivery === 'throw' && value.name === 'history-proof') {
        assert.equal(response.status, path.endsWith('/compact') ? 502 : 200);
        assert.notEqual(body.error.code, value.code);
        assert.equal(body.retryable, undefined);
        assert.equal(observed.at(-1).status, undefined);
      }
      checks++;
      if (delivery === 'throw') results.push({ path, name: value.name, status: response.status,
        code: body.error.code, shouldRetry: response.headers.get('x-should-retry'), signIn: response.headers.get('x-magpie-sign-in'), calls });
    }

    for (const kind of ['generic', 'lookalike', 'invalid-typed-status', 'invalid-typed-retryable']) {
      let calls = 0;
      const message = 'Synthetic unclassified adapter failure';
      let error = new Error(message);
      if (kind === 'lookalike') Object.assign(error, cases[0], { message });
      if (kind.startsWith('invalid-typed')) {
        error = new native.AdapterError(message, { ...cases[0],
          ...kind.endsWith('status') ? { status: '403' } : { retryable: 'false' } });
      }
      const response = await handler(request(path, false), config, () => ({ async runTurn() { calls++; throw error; } }));
      const body = await response.json();
      assert.equal(calls, 1);
      assert.equal(response.status, path.endsWith('/compact') ? 502 : 200);
      assert.equal(body.error.message, message);
      assert.notEqual(body.error.code, 'history_scope_unverified');
      assert.equal(response.headers.get('x-should-retry'), null);
      assert.equal(response.headers.get('x-magpie-sign-in'), null);
      checks++;
    }

    let calls = 0;
    const summary = 'Fixture complete summary: keep exact original facts.\nNo real tools executed.';
    const success = await handler(request(path, false), config, () => ({ async runTurn(_parsed, _incoming, emit) {
      calls++;
      emit({ type: 'text_delta', text: summary, phase: 'final_answer' });
      emit({ type: 'done', stopReason: 'stop', endTurn: true, usage: { inputTokens: 1, outputTokens: 1 } });
    } }));
    const body = await success.json();
    assert.equal(calls, 1);
    assert.equal(success.status, 200);
    assert.equal(success.headers.get('x-should-retry'), null);
    assert.equal(body.error, undefined);
    if (path.endsWith('/compact')) {
      assert.deepEqual(Object.keys(body), ['output']);
      assert.ok(JSON.stringify(body.output).includes(summary.split('\n')[0]));
    } else {
      assert.equal(body.status, 'completed');
      assert.equal(body.output.length, 1);
      assert.equal(body.output[0].type, 'message');
      assert.equal(body.output[0].role, 'assistant');
      assert.equal(body.output[0].content[0].text, summary);
    }
    checks++;
  }

  // Throwing a real AdapterError into the original Ls catch also preserves the
  // SSE event fields. HTTP headers cannot change once a stream has started.
  let calls = 0;
  const stream = await native.responses(request('responses', true), config, () => ({ async runTurn() {
    calls++; throw new native.AdapterError(cases[0].message, cases[0]);
  } }));
  const frames = (await stream.text()).split(/\r?\n/).filter(line => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map(line => JSON.parse(line.slice(5)));
  assert.equal(calls, 1);
  assert.equal(stream.status, 200);
  const failure = frames.find(event => event.type === 'response.failed').response;
  assert.equal(failure.error.code, mode === 'patched' ? 'history_scope_unverified' : 'upstream_server_error');
  assert.equal(failure.retryable, mode === 'patched' ? false : undefined);
  checks++;
  console.log('compaction-errors-evidence: ' + JSON.stringify({ mode, checks, results }));
  console.log('PINNED_COMPACTION_ERRORS_OK ' + mode);
} finally {
  assert.deepEqual(readFileSync(entry), original, 'original bundle remains unchanged');
}
