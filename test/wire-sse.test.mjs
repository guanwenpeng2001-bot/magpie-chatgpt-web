import test from 'node:test';
import assert from 'node:assert/strict';

const wire = await import('../src/wire/sse.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

test('SSE parsing preserves multiline data and handles every CRLF chunk boundary', () => {
  assert.equal(typeof wire.parseSSE, 'function', 'incremental SSE parser is available');
  const input = ': comment\r\nevent: delta\r\ndata:first\r\ndata: second\r\n\r\ndata: [DONE]\r\n\r\n';
  for (let offset = 0; offset <= input.length; offset++) {
    const first = wire.parseSSE(input.slice(0, offset));
    const second = wire.parseSSE(input.slice(offset), first.rest);
    assert.deepEqual([...first.events, ...second.events], [{ event: 'delta', data: 'first\nsecond' }, { event: '', data: '[DONE]' }]);
    assert.equal(second.rest, '');
  }
});

test('unterminated event bytes remain buffered for EOF truncation checks', () => {
  assert.equal(typeof wire.parseSSE, 'function');
  assert.deepEqual(wire.parseSSE('data: partial\n'), { events: [], rest: 'data: partial\n' });
});

test('SSE encoding round trips multiline data and ignores comment-only events', () => {
  assert.equal(typeof wire.encodeSSE, 'function');
  const event = { event: 'delta', data: 'one\ntwo' };
  assert.deepEqual(wire.parseSSE(wire.encodeSSE(event)).events, [event]);
  assert.deepEqual(wire.parseSSE(': heartbeat\n\n').events, []);
});
