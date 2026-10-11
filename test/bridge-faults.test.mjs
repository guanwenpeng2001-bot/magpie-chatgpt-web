import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { Bridge } from '../src/bridge.mjs';

function childFixture(onCommand, handshake = true) {
  let child;
  const commands = [];
  return {
    commands,
    spawnProcess(executable, args, options) {
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, encoding, callback) {
          const command = JSON.parse(chunk.toString());
          commands.push(command);
          onCommand?.(command, child);
          callback();
        },
        final(callback) { callback(); queueMicrotask(() => child.emit('exit', 0)); },
      });
      child.kill = () => queueMicrotask(() => child.emit('exit', 1));
      if (handshake) queueMicrotask(() => child.stdout.write('{"event":"ready","protocol":2}\n'));
      return child;
    },
  };
}

test('a frame split across chunks is decoded including multibyte text', async t => {
  const fixture = childFixture((command, child) => {
    const bytes = Buffer.from(JSON.stringify({ id: command.id, event: 'data', data: '字符' }) + '\n');
    child.stdout.write(JSON.stringify({ id: command.id, event: 'head', status: 200 }) + '\n');
    const split = bytes.indexOf(Buffer.from('字')) + 1;
    child.stdout.write(bytes.subarray(0, split));
    child.stdout.write(bytes.subarray(split));
    child.stdout.write(JSON.stringify({ id: command.id, event: 'done' }) + '\n');
  });
  const bridge = new Bridge(fixture);
  t.after(() => bridge.dispose());
  assert.equal(await bridge.call({ method: 'models' }), '字符');
});

test('a child dying mid-request rejects its consumer', async t => {
  const fixture = childFixture((command, child) => child.kill());
  const bridge = new Bridge(fixture);
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.call({ method: 'models' }), error => error.status === 503);
});

test('a malformed frame fails closed', async t => {
  const fixture = childFixture((command, child) => child.stdout.write('invalid\n'));
  const bridge = new Bridge(fixture);
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.call({ method: 'models' }), error => error.status === 502);
});

test('a child never becoming ready times out', async () => {
  const bridge = new Bridge({ ...childFixture(null, false), startupMilliseconds: 10 });
  await assert.rejects(bridge.start(), error => error.status === 503);
  await bridge.dispose();
});

test('abort propagates the request id without an arbitrary reason', async t => {
  const fixture = childFixture();
  const bridge = new Bridge(fixture);
  t.after(() => bridge.dispose());
  const controller = new AbortController();
  const stream = await bridge.open({ method: 'complete' }, controller.signal);
  controller.abort();
  await assert.rejects(stream.next(), error => error.status === 502);
  assert.deepEqual(fixture.commands.map(command => command.method), ['complete', 'abort']);
  assert.equal(fixture.commands[0].id, fixture.commands[1].id);
});

test('a slow consumer is aborted when its bounded queue fills', async t => {
  const fixture = childFixture((command, child) => {
    if (command.method === 'abort') return;
    child.stdout.write(JSON.stringify({ id: command.id, event: 'head', status: 200 }) + '\n');
    child.stdout.write(JSON.stringify({ id: command.id, event: 'data', data: 'x'.repeat(300) }) + '\n');
  });
  const bridge = new Bridge({ ...fixture, queueBytes: 100 });
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.call({ method: 'complete' }), error => error.status === 502);
  assert.equal(fixture.commands.at(-1).method, 'abort');
});
