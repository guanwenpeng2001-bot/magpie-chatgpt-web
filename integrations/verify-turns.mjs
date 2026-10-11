import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { prepare, translate } from '../src/protocol.mjs';
import { createTurnFixture } from './turn-fixture.mjs';

export async function verifyTurns(dependency) {
  const { chromium } = await import(pathToFileURL(dependency).href);
  const fixture = await createTurnFixture({ interval: 450, stall: 900 });
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-web-turn-fixture-'));
  const driver = new TurnDriver({
    profileRoot: root, origin: fixture.origin, timeout: 8000,
    launch: async profile => {
      const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block', args: ['--disable-background-networking'] });
      await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
      return context;
    },
  });
  const guard = new AccountGuard();
  const history = [{ role: 'user', content: 'Describe a fictional garden.' }];
  const command = (key, messages = history) => ({ ...prepare({ model: 'auto', messages, conversation_id: key }), auth: { profile: 'fixture' } });
  const collect = async (request, targetGuard = guard, controller = new AbortController()) => {
    const frames = [];
    const times = [];
    const started = Date.now();
    await driver.complete(request, targetGuard, 'fixture-account', controller.signal, async frame => { frames.push(frame); if (['dom', 'answer'].includes(frame.event)) times.push(Date.now() - started); });
    const output = [];
    for await (const chunk of translate(frames, request)) output.push(chunk);
    return { frames, times, output: output.join('') };
  };
  try {
    const first = await collect(command('continued'));
    assert.equal(first.frames.filter(frame => ['dom', 'answer'].includes(frame.event)).length, 3);
    assert.ok(first.times[1] - first.times[0] >= 250);
    assert.ok(first.times[2] - first.times[1] >= 250);
    assert.equal(first.output.includes('metadata must not appear'), false);
    console.log(JSON.stringify({ fixture: 'incremental', deltas: 3, sizes: fixture.batches.map(text => text.length), arrivalMilliseconds: first.times }));
    await collect(command('continued', [...history, { role: 'assistant', content: fixture.batches.join('') }, { role: 'user', content: 'Continue.' }]));
    assert.equal(fixture.requests[0].conversation, fixture.requests[1].conversation);
    console.log('fixture continuation reused the same web conversation');
    await driver.bindings.discard('continued');
    await collect(command('continued', [...history, { role: 'assistant', content: fixture.batches.join('') }, { role: 'user', content: 'Rebuild.' }]));
    assert.notEqual(fixture.requests[1].conversation, fixture.requests[2].conversation);
    assert.match(fixture.requests[2].prompt, /Describe a fictional garden/);
    console.log('fixture eviction rebuilt from full history');
    for (const [mode, expected] of [['empty', 'empty'], ['hidden', 'hidden'], ['truncated', 'truncated'], ['changed', 'protocol'], ['rate', 'cooldown'], ['challenge', 'verification']]) {
      fixture.setMode(mode);
      const accountGuard = new AccountGuard();
      await assert.rejects(collect(command(mode), accountGuard), error => error.code === expected);
      if (mode === 'rate') await assert.rejects(accountGuard.begin(), error => error.status === 429);
      else (await accountGuard.begin())();
      console.log(`fixture ${mode}: typed ${expected}, slot released`);
    }
    for (const mode of ['clone-failure', 'disabled']) {
      fixture.setMode(mode);
      driver.network = mode !== 'disabled';
      const result = await collect(command(mode));
      assert.equal(result.frames.filter(frame => ['dom', 'answer'].includes(frame.event)).at(-1).data.text, fixture.batches.join(''));
      assert.ok(result.times.length > 1);
      console.log(`fixture ${mode}: DOM fallback delivered ${result.times.length} updates`);
    }
    driver.network = true;
    fixture.setMode('normal');
    const controller = new AbortController();
    await assert.rejects(driver.complete(command('abort'), guard, 'fixture-account', controller.signal, async frame => { if (['dom', 'answer'].includes(frame.event)) controller.abort(); }));
    assert.equal(driver.bindings.entries.has('abort'), false);
    const afterAbort = await collect(command('abort'));
    assert.match(afterAbort.output, /message_stop/);
    console.log('fixture abort closed page, dropped binding, released guard; next turn reused session');
  } finally { await driver.close(); await fixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
