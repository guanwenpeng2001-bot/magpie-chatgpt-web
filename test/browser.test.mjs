import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
