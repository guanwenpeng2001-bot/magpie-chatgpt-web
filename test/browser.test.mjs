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
  await browser.run('fixture', async context => assert.equal(context, contexts[3]));
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

test('idle contexts close at five minutes, with active time excluded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closes = 0;
  const context = new EventEmitter();
  context.pages = () => [];
  context.close = async () => { closes++; context.emit('close'); };
  const browser = new module.BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  assert.equal(browser.idleMilliseconds, 300_000);
  await browser.run('fixture', async () => { t.mock.timers.tick(300_000); assert.equal(closes, 0); });
  t.mock.timers.tick(299_999);
  assert.equal(closes, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closes, 1);
  await browser.close();
});

test('one crash retries the operation and a second crash exhausts that turn only', async () => {
  let launches = 0;
  const browser = new module.BrowserSupervisor({ profileRoot: '.', launch: async () => {
    launches++;
    const context = new EventEmitter();
    context.pages = () => [];
    context.close = async () => context.emit('close');
    return context;
  } });
  try {
    let attempts = 0;
    assert.equal(await browser.run('fixture', async context => {
      if (++attempts === 1) { context.emit('close'); await new Promise(() => {}); }
      return 'recovered';
    }), 'recovered');
    assert.equal(attempts, 2);
    await assert.rejects(browser.run('fixture', async context => {
      context.emit('close'); await new Promise(() => {});
    }), error => error.code === 'browserClosed');
    assert.equal(launches, 3);
    assert.equal(await browser.run('fixture', async () => 'next turn'), 'next turn');
  } finally { await browser.close(); }
});

test('visible turns replace an idle headless context and return to headless afterwards', async () => {
  const modes = [];
  let closes = 0;
  const browser = new module.BrowserSupervisor({ profileRoot: '.', launch: async (profile, options) => {
    modes.push(options.headless);
    const context = new EventEmitter();
    context.pages = () => [];
    context.close = async () => { closes++; context.emit('close'); };
    return context;
  } });
  try {
    await browser.run('fixture', async () => {});
    await browser.run('fixture', async () => {}, undefined, { visibleTurns: true });
    await browser.run('fixture', async () => {}, undefined, { visibleTurns: false });
    assert.deepEqual(modes, [true, false, true]);
    assert.equal(closes, 2);
  } finally { await browser.close(); }
});

for (const visibleTurns of [true, false]) test(`active operation rejects a switch to visibleTurns=${visibleTurns} with a local mode conflict`, async () => {
  const modes = [];
  const context = new EventEmitter();
  context.pages = () => [];
  context.close = async () => context.emit('close');
  const browser = new module.BrowserSupervisor({ profileRoot: '.', launch: async (profile, options) => {
    modes.push(options.headless);
    return context;
  } });
  try {
    await browser.run('fixture', async () => {
      await assert.rejects(browser.run('fixture', () => assert.fail('conflicting operation must not start'), undefined, { visibleTurns }), error => {
        assert.equal(error.constructor, Error);
        assert.equal(error.code, undefined);
        assert.match(error.message, /active operation.*other mode.*wait/i);
        return true;
      });
      assert.deepEqual(modes, [visibleTurns]);
    }, undefined, { visibleTurns: !visibleTurns });
  } finally { await browser.close(); }
});

test('intentional account close never restarts an active operation', async () => {
  let launches = 0;
  const browser = new module.BrowserSupervisor({ profileRoot: '.', launch: async () => {
    launches++;
    const context = new EventEmitter();
    context.pages = () => [];
    context.close = async () => context.emit('close');
    return context;
  } });
  await assert.rejects(browser.run('fixture', async () => {
    await browser.closeAccount('fixture');
    await new Promise(() => {});
  }), error => error.code === 'browserClosed');
  assert.equal(launches, 1);
  await browser.close();
});

function cookieContext(initial) {
  const context = new EventEmitter();
  let cookies = structuredClone(initial);
  context.writes = [];
  context.pages = () => [];
  context.close = async () => context.emit('close');
  context.cookies = async () => structuredClone(cookies);
  context.clearCookies = async filter => { cookies = cookies.filter(cookie => !(cookie.name === filter.name && cookie.domain === filter.domain && cookie.path === filter.path)); };
  context.addCookies = async additions => {
    context.writes.push(additions);
    for (const cookie of additions) {
      cookies = cookies.filter(existing => existing.name !== cookie.name);
      cookies.push(cookie);
    }
  };
  return context;
}

for (const [label, initial, refresh] of [
  ['rotation', [{ name: '__Secure-next-auth.session-token', value: 'prior' }], '__Secure-next-auth.session-token=current'],
  ['chunk contraction', [{ name: '__Secure-next-auth.session-token.0', value: 'prior' }, { name: '__Secure-next-auth.session-token.1', value: 'tail' }], '__Secure-next-auth.session-token=current'],
  ['chunk expansion', [{ name: '__Secure-next-auth.session-token', value: 'prior' }], '__Secure-next-auth.session-token.0=current; __Secure-next-auth.session-token.1=tail'],
]) test(`credential reconciliation ${label} sends current session and preserves other cookies`, async () => {
  const other = { name: 'preference', value: 'dark', domain: 'chatgpt.com', path: '/' };
  const context = cookieContext([...initial.map(cookie => ({ ...cookie, domain: '.chatgpt.com', path: '/' })), other]);
  const browser = new module.BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  try {
    await browser.run('fixture', async context => {
      const actual = await context.cookies();
      assert.deepEqual(actual.filter(cookie => cookie.name !== 'preference').map(cookie => `${cookie.name}=${cookie.value}`).sort(), refresh.split('; ').sort());
      assert.deepEqual(actual.find(cookie => cookie.name === 'preference'), other);
    }, undefined, { auth: { refresh }, origin: 'https://chatgpt.com' });
  } finally { await browser.close(); }
});

test('TurnDriver reconciles the command credential before creating a turn page', async () => {
  const { TurnDriver } = await import('../backend/turn.mjs');
  const { AccountGuard } = await import('../backend/guard.mjs');
  const context = cookieContext([{ name: '__Secure-next-auth.session-token', value: 'prior', domain: 'chatgpt.com', path: '/' }]);
  context.exposeBinding = async () => {};
  context.addInitScript = async () => {};
  let sent;
  context.newPage = async () => {
    sent = (await context.cookies()).map(cookie => cookie.value);
    throw new BackendError('expired');
  };
  const driver = new TurnDriver({ profileRoot: '.', launch: async () => context });
  try {
    await assert.rejects(driver.complete({ auth: { profile: 'fixture', refresh: '__Secure-next-auth.session-token=current' }, model: 'auto', history: [{ role: 'user', content: 'hello' }] }, new AccountGuard(), 'fixture', new AbortController().signal, () => {}), error => error.code === 'expired');
    assert.deepEqual(sent, ['current']);
    const { PassThrough } = await import('node:stream');
    const { serve } = await import('../backend/main.mjs');
    const input = new PassThrough();
    const output = new PassThrough();
    let credential = '__Secure-next-auth.session-token=current';
    const frames = [];
    let receive;
    output.on('data', chunk => { frames.push(JSON.parse(chunk.toString())); receive?.(); });
    const work = serve(input, output, {
      turnDriver: driver,
      readClient: ({ guard }) => ({
        guard, get credential() { return credential; },
        session: async () => {
          credential = '__Secure-next-auth.session-token=rotated';
          return { accessToken: 'access', expires: '2099-01-01T00:00:00Z' };
        },
      }),
    });
    try {
      for (const method of ['session', 'complete']) {
        input.write(JSON.stringify({ id: method, method, auth: { profile: 'fixture', refresh: '__Secure-next-auth.session-token=current' }, model: 'auto', history: [{ role: 'user', content: 'hello' }] }) + '\n');
        while (!frames.some(frame => frame.id === method && ['done', 'error'].includes(frame.event))) await new Promise(resolve => { receive = resolve; });
      }
      assert.deepEqual(sent, ['rotated']);
      assert.equal(BackendError.fromEnvelope(frames.find(frame => frame.id === 'complete' && frame.event === 'error').error).code, 'expired');
    } finally { input.end(); await work; }
  } finally { await driver.close(); }
});

test('cookie write failures suppress credential-bearing browser diagnostics', async () => {
  const context = cookieContext([]);
  context.addCookies = async () => { throw new Error('private-session-marker'); };
  const browser = new module.BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  try {
    await assert.rejects(browser.run('fixture', () => assert.fail('must not use failed reconciliation'), undefined, { auth: { refresh: '__Secure-next-auth.session-token=private-session-marker' } }), error => {
      assert.equal(error.code, 'upstream');
      assert.equal(JSON.stringify(error.toJSON()).includes('private-session-marker'), false);
      assert.equal(error.stack.includes('private-session-marker'), false);
      return true;
    });
  } finally { await browser.close(); }
});

test('unchanged credential reconciliation performs zero cookie writes', async () => {
  const context = cookieContext([{ name: '__Secure-next-auth.session-token', value: 'current', domain: '.chatgpt.com', path: '/' }]);
  context.clearCookies = async () => assert.fail('unchanged cookies must not be cleared');
  const browser = new module.BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  try {
    await browser.run('fixture', async () => {}, undefined, { auth: { refresh: '__Secure-next-auth.session-token=current' }, origin: 'https://chatgpt.com' });
    assert.equal(context.writes.length, 0);
  } finally { await browser.close(); }
});

for (const refresh of [undefined, '', 'preference=dark', '__Secure-next-auth.session-token=']) test(`absent session credential (${String(refresh)}) cannot reuse a live profile`, async () => {
  const context = cookieContext([{ name: '__Secure-next-auth.session-token', value: 'live', domain: '.chatgpt.com', path: '/' }]);
  const browser = new module.BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  let used = false;
  try {
    await assert.rejects(browser.run('fixture', async () => { used = true; }, undefined, { auth: { refresh }, origin: 'https://chatgpt.com' }), error => error instanceof BackendError && error.code === 'expired');
    assert.equal(used, false);
    assert.equal(context.writes.length, 0);
  } finally { await browser.close(); }
});

test('closed supervisor reports lifecycle failure', async () => {
  const browser = new module.BrowserSupervisor({ profileRoot: '.' });
  await browser.close();
  await assert.rejects(browser.run('fixture', () => {}), error => error.code === 'browserClosed');
});
