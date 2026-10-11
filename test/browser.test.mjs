import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BackendError } from '../backend/guard.mjs';
const module = await import('../backend/browser.mjs').catch(() => ({}));
test('supervisor lazily launches, closes idle contexts and relaunches after a crash', async () => {
  assert.equal(typeof module.BrowserSupervisor, 'function');
  const contexts = [];
  const browser = new module.BrowserSupervisor({
    profileRoot: '.', idleMilliseconds: 10,
    launch: async () => {
      const context = new EventEmitter();
      context.close = async () => context.emit('close');
      context.pages = () => [{ url: () => 'about:blank' }];
      contexts.push(context);
      return context;
    },
  });
  assert.equal(contexts.length, 0);
  await browser.run('fixture', async context => assert.equal(context, contexts[0]));
  const closed = new Promise(resolve => contexts[0].once('close', resolve));
  await closed;
  await browser.run('fixture', async context => assert.equal(context, contexts[1]));
  await assert.rejects(browser.run('fixture', async context => {
    context.emit('close');
    await new Promise(() => {});
  }), error => error.status === 503);
  await browser.run('fixture', async context => assert.equal(context, contexts[2]));
  await browser.close();
});

for (const [label, options, account, expected] of [
  ['configuration', {}, 'fixture', 'browserConfiguration'],
  ['account', { profileRoot: '.' }, '../invalid', 'browserConfiguration'],
  ['dependency', { profileRoot: '.', launch: async () => { throw new BackendError('browserDependency'); } }, 'fixture', 'browserDependency'],
  ['launch', { profileRoot: '.', launch: async () => { throw new Error('synthetic foreign diagnostic'); } }, 'fixture', 'backendDown'],
  ['profile', { profileRoot: '.', launch: async () => {
    const context = new EventEmitter();
    context.pages = () => [{ url: () => 'about:blank#restored' }];
    context.close = async () => context.emit('close');
    return context;
  } }, 'fixture', 'browserProfile'],
]) test(`browser distinguishes ${label} failure`, async () => {
  const browser = new module.BrowserSupervisor(options);
  try {
    await assert.rejects(browser.run(account, () => assert.fail('operation must not start')), error => {
      assert.equal(error.code, expected);
      assert.deepEqual(error.toJSON(), new BackendError(expected).toJSON());
      return true;
    });
  } finally { await browser.close(); }
});

test('an explicit profile directory is launched in place instead of composed from the account', async () => {
  const launched = [];
  const browser = new module.BrowserSupervisor({
    profile: 'C:/signed-in-profile',
    launch: async dir => {
      launched.push(dir);
      const context = new EventEmitter();
      context.close = async () => context.emit('close');
      context.pages = () => [{ url: () => 'about:blank' }];
      return context;
    },
  });
  await browser.run('fixture', async () => {});
  assert.deepEqual(launched, ['C:/signed-in-profile']);
  await browser.close();
});

test('TurnDriver forwards an explicit profile directory to its supervisor without changing the launch shape', async () => {
  const launched = [];
  const driver = new (await import('../backend/turn.mjs')).TurnDriver({
    profile: 'C:/signed-in-profile',
    launch: async dir => {
      launched.push(dir);
      const context = new EventEmitter();
      context.close = async () => context.emit('close');
      context.pages = () => [{ url: () => 'about:blank' }];
      return context;
    },
  });
  await driver.browser.run('fixture', async () => {});
  assert.deepEqual(launched, ['C:/signed-in-profile']);
  await driver.close();
});

test('closed supervisor reports lifecycle failure', async () => {
  const browser = new module.BrowserSupervisor({ profileRoot: '.' });
  await browser.close();
  await assert.rejects(browser.run('fixture', () => {}), error => error.code === 'browserClosed');
});
