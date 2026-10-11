import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serve } from '../backend/main.mjs';
import { LoginStates } from '../backend/browser.mjs';

function harness(options) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  const waiters = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  const work = serve(input, output, options);
  return { input, frames, work,
    send: command => input.write(JSON.stringify(command) + '\n'),
    async until(predicate) {
      while (!predicate(frames)) await new Promise(resolve => waiters.push(resolve));
    },
  };
}

test('backend streams head/data/done and cancels a live handler on abort', async () => {
  const server = harness({ handlers: {
    complete: async (command, signal, emit) => {
      await emit({ text: 'fixture' });
      if (command.wait) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  } });
  server.send({ id: 'finished', method: 'complete' });
  await server.until(frames => frames.some(frame => frame.id === 'finished' && frame.event === 'done'));
  assert.deepEqual(server.frames.filter(frame => frame.id === 'finished').map(frame => frame.event), ['head', 'data', 'done']);
  server.send({ id: 'cancelled', method: 'complete', wait: true });
  await server.until(frames => frames.some(frame => frame.id === 'cancelled' && frame.event === 'data'));
  server.send({ id: 'cancelled', method: 'abort' });
  await server.until(frames => frames.some(frame => frame.id === 'cancelled' && frame.event === 'error'));
  assert.equal(server.frames.some(frame => frame.id === 'cancelled' && frame.event === 'done'), false);
  server.input.end();
  await server.work;
});

test('stdin EOF aborts work and disposes owned resources', async () => {
  let aborted = false;
  let disposed = false;
  const server = harness({
    close: async () => { disposed = true; },
    handlers: { complete: async (command, signal, emit) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await emit({ text: 'waiting' });
      await new Promise(() => {});
    } },
  });
  server.send({ id: 'active', method: 'complete' });
  await server.until(frames => frames.some(frame => frame.event === 'data'));
  server.input.end();
  await server.work;
  assert.equal(aborted, true);
  assert.equal(disposed, true);
});

test('request timeout emits a sanitized error without success', async () => {
  const server = harness({ timeout: 10, handlers: { complete: () => new Promise(() => {}) } });
  server.send({ id: 'timeout', method: 'complete' });
  await server.until(frames => frames.some(frame => frame.event === 'error'));
  server.input.end();
  await server.work;
  assert.equal(server.frames.some(frame => frame.event === 'done'), false);
  assert.equal(server.frames.at(-1).error.status, 502);
});

test('backend bounds active executions to sixteen and drains on EOF', async () => {
  let active = 0;
  const server = harness({ handlers: { complete: async (command, signal, emit) => {
    active++;
    const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await emit({ active });
    await aborted;
    active--;
  } } });
  for (let index = 0; index < 20; index++) server.send({ id: `request-${index}`, method: 'complete' });
  await server.until(frames => frames.filter(frame => frame.event === 'data').length === 16);
  assert.equal(active, 16);
  server.input.end();
  await server.work;
  assert.equal(active, 0);
});

test('login commands keep polling status pending and resolve through the flow', async () => {
  let resolveFlow;
  const server = harness({ loginFlow: () => new Promise(resolve => { resolveFlow = resolve; }) });
  server.send({ id: 'login-start', method: 'login', account: 'fixture' });
  await server.until(frames => frames.some(frame => frame.id === 'login-start' && frame.event === 'data'));
  assert.deepEqual(server.frames.find(frame => frame.id === 'login-start' && frame.event === 'data').data, { state: 'pending' });
  server.send({ id: 'login-poll', method: 'loginStatus', account: 'fixture' });
  await server.until(frames => frames.some(frame => frame.id === 'login-poll' && frame.event === 'data'));
  assert.deepEqual(server.frames.find(frame => frame.id === 'login-poll' && frame.event === 'data').data, { state: 'pending' });
  resolveFlow({ state: 'signed-in', credential: { profile: 'fixture' } });
  server.send({ id: 'login-final', method: 'loginStatus', account: 'fixture' });
  await server.until(frames => frames.some(frame => frame.id === 'login-final' && frame.event === 'data'));
  assert.deepEqual(server.frames.find(frame => frame.id === 'login-final' && frame.event === 'data').data, { state: 'signed-in', credential: { profile: 'fixture' } });
  server.input.end();
  await server.work;
});

test('login state polling represents all four states without arbitrary error text', () => {
  const states = new LoginStates();
  assert.deepEqual(states.start('fixture'), { state: 'pending' });
  assert.deepEqual(states.finish('fixture', 'signed-in', { profile: 'fixture' }), { state: 'signed-in', credential: { profile: 'fixture' } });
  assert.equal(states.finish('fixture', 'failed').state, 'failed');
  assert.equal(states.finish('fixture', 'cancelled').state, 'cancelled');
});
