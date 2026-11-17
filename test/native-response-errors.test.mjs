import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveNativeVerification } from '../src/native/response-errors.mjs';

const created = { type: 'response.created', response: { output: [] } };
const failed = { type: 'response.failed', response: { output: [], retryable: false,
  error: { type: 'permission_error', code: 'chatgpt_security_check', message: '浏览器需要验证。' } } };
const frame = event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
function stream(parts) {
  let cancelled = false;
  const encoder = new TextEncoder();
  return { get cancelled() { return cancelled; }, response: new Response(new ReadableStream({
    start(controller) { for (const part of parts) controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) };
}

test('empty native prelude and fragmented UTF-8 verification become one HTTP 403', async () => {
  const bytes = new TextEncoder().encode(': keepalive\r\n\r\n' + frame(created) + frame(failed));
  const upstream = stream([...bytes].map(byte => Uint8Array.of(byte)));
  const response = await preserveNativeVerification(upstream.response);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-magpie-sign-in'), 'kept');
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.deepEqual(await response.json(), { error: { ...failed.response.error, status: 403, retryable: false } });
  assert.equal(upstream.cancelled, true);
});

for (const event of [
  { type: 'response.output_item.added', item: { type: 'function_call' } },
  { type: 'response.output_text.delta', delta: 'text' },
  { type: 'response.created', response: { output: [{ type: 'message' }] } },
  { ...failed, response: { ...failed.response, error: { ...failed.response.error, code: 'upstream_server_error' } } },
]) test(`never relabel or replay after ${event.type} ${event.response?.error?.code ?? ''}`, async () => {
  const text = frame(created) + frame(event) + frame(failed);
  const response = await preserveNativeVerification(new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), text);
});

test('prelude memory bound streams the original bytes without waiting for completion', async () => {
  const prefix = ': ' + 'x'.repeat(65536) + '\n\n';
  const upstream = stream([prefix]);
  const response = await preserveNativeVerification(upstream.response);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), prefix);
  await reader.cancel();
  assert.equal(upstream.cancelled, true);
});

test('cancellation while only the prelude is available cancels the upstream', async () => {
  const upstream = stream([frame(created)]);
  const controller = new AbortController();
  const work = preserveNativeVerification(upstream.response, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(upstream.cancelled, true);
});

test('HTTP refusals and non-SSE responses stay unchanged', async () => {
  for (const response of [Response.json({ error: 'refusal' }, { status: 403 }), Response.json({ output: [] })]) {
    assert.equal(await preserveNativeVerification(response), response);
  }
});

test('typed verification remains non-retryable when the native encoder omits or changes retryable', async () => {
  for (const retryable of [undefined, true, false]) {
    const error = { ...failed.response, retryable };
    for (const upstream of [Response.json({ ...error, status: 'failed' }),
      new Response(frame(created) + frame({ type: 'response.failed', response: error }), { headers: { 'content-type': 'text/event-stream' } })]) {
      const response = await preserveNativeVerification(upstream);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('x-should-retry'), 'false');
      assert.equal((await response.json()).error.retryable, false);
    }
  }
});

test('explicit account-model unavailability allows another account before output, without inferring quota', async () => {
  const failure = { type: 'response.failed', response: { status: 'failed', output: [],
    error: { type: 'server_error', code: 'account_model_unavailable', message: 'Model unavailable for this account.' } } };
  for (const upstream of [Response.json(failure.response),
    new Response(frame(created) + frame(failure), { headers: { 'content-type': 'text/event-stream' } })]) {
    const response = await preserveNativeVerification(upstream);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-magpie-sign-in'), 'kept');
    assert.equal(response.headers.has('retry-after'), false);
    assert.equal(response.headers.has('x-should-retry'), false);
    assert.equal((await response.json()).error.code, 'account_model_unavailable');
  }
  const text = frame(created) + frame({ type: 'response.output_text.delta', delta: 'output' }) + frame(failure);
  const preserved = await preserveNativeVerification(new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(preserved.status, 200); assert.equal(await preserved.text(), text);
});

for (const [type, code] of [['rate_limit_error', 'rate_limit_exceeded'], ['insufficient_quota', 'insufficient_quota']]) {
  test(`empty Native ${code} allows host account rotation while retaining sign-in`, async () => {
    const event = { type: 'response.failed', response: { output: [], retryable: false, error: { type, code, message: 'fixture limit', retry_after: 120 } } };
    const upstream = stream([frame(created), frame(event)]);
    const response = await preserveNativeVerification(upstream.response);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('x-magpie-sign-in'), 'kept');
    assert.equal(response.headers.get('retry-after'), '120');
    assert.equal(response.headers.has('x-should-retry'), false);
    assert.equal((await response.json()).error.code, code);
    assert.equal(upstream.cancelled, true);
    for (const output of [{ type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.output_item.added', item: { type: 'function_call' } }]) {
      const bytes = frame(created) + frame(output) + frame(event);
      const retained = await preserveNativeVerification(new Response(bytes, { headers: { 'content-type': 'text/event-stream' } }));
      assert.equal(retained.status, 200);
      assert.equal(await retained.text(), bytes);
    }
  });
}
