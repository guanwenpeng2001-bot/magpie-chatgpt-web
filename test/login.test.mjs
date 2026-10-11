import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as browserModule from '../backend/browser.mjs';

test('ordinary Chrome sign-in launch uses only the four prescribed arguments', () => {
  assert.equal(typeof browserModule.chromeArguments, 'function');
  const args = browserModule.chromeArguments('C:/fixture/profile', 12345);
  assert.deepEqual(args, ['--user-data-dir=C:/fixture/profile', '--remote-debugging-port=12345', '--no-first-run', '--no-default-browser-check']);
  assert.equal(args.some(arg => /no-sandbox|enable-automation|headless/.test(arg)), false);
});

test('a restored non-blank page recovers without discarding its session', async () => {
  let location = 'about:blank#restored';
  const context = new EventEmitter();
  context.pages = () => [{ url: () => location, goto: async url => { location = url; } }];
  context.close = async () => context.emit('close');
  const supervisor = new browserModule.BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  try {
    const value = await supervisor.run('fixture', async restored => {
      assert.equal(restored, context);
      assert.equal(location, 'about:blank');
      return 'account usable';
    });
    assert.equal(value, 'account usable');
  } finally { await supervisor.close(); }
});

test('cancellation during browser attachment closes it before navigating', async () => {
  const controller = new AbortController();
  const context = new EventEmitter();
  let closed = false;
  context.pages = () => [];
  context.newPage = async () => { throw new Error('must not navigate'); };
  const flow = browserModule.createLoginFlow({ launch: async () => {
    controller.abort();
    return { context, close: async () => { closed = true; context.emit('close'); } };
  } });
  assert.equal((await flow('fixture', controller.signal, '.')).state, 'cancelled');
  assert.equal(closed, true);
});

test('session conversion yields the exact synthetic credential record', () => {
  assert.equal(typeof browserModule.sessionCredential, 'function');
  const refresh = `fixture=${randomUUID()}`;
  const access = randomUUID();
  const expires = Date.now() + 10 * 86400000;
  assert.deepEqual(browserModule.sessionCredential({ accessToken: access, expires: new Date(expires).toISOString(), user: { email: 'fixture@example.invalid' } }, refresh, 'fixture'), {
    type: 'oauth', refresh, access, expires, accountId: 'fixture@example.invalid', profile: 'fixture', persona: 'chatgpt-paid',
  });
});
