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
  { ...failed, response: { ...failed.response, retryable: true } },
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
