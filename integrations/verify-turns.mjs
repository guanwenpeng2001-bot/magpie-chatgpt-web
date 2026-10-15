import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { prepare } from '../src/wire/prepare.mjs';
import { translate } from '../src/wire/translate.mjs';
import { createTurnFixture } from './turn-fixture.mjs';

export async function verifyTurns(dependency) {
  const { chromium } = await import(pathToFileURL(dependency).href);
  const fixture = await createTurnFixture({ interval: 100 });
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-web-turn-fixture-'));
  const driver = new TurnDriver({
    profileRoot: root, origin: fixture.origin, timeout: 15000,
    launch: async profile => {
      const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block', args: ['--disable-background-networking'] });
      await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
      return context;
    },
  });
  const guard = new AccountGuard();
  const history = [{ role: 'user', content: 'Describe a fictional garden.' }];
  const command = (key, messages = history) => ({ ...prepare({ model: 'auto', messages, conversation_id: key }), auth: { profile: 'fixture' } });
  const collect = async (request, targetGuard = guard, signal = new AbortController().signal) => {
    const frames = [];
    const result = await driver.complete(request, targetGuard, 'fixture-account', signal, async frame => { frames.push(frame); });
    const output = [];
    for await (const chunk of translate(frames, request)) output.push(chunk);
    return { frames, result, output: output.join('') };
  };
  try {
    const first = await collect(command('continued'));
    assert.deepEqual(first.frames.map(frame => frame.type), ['delta', 'finish']);
    assert.equal(first.frames[0].text, fixture.batches.join(''));
    assert.equal(first.output.includes('metadata must not appear'), false);
    let continued = history;
    for (const prompt of ['Continue.', 'Recall the first garden.']) {
      continued = [...continued, { role: 'assistant', content: fixture.batches.join('') }, { role: 'user', content: prompt }];
      assert.match((await collect(command('continued', continued))).output, /message_stop/);
    }
    assert.equal(new Set(fixture.requests.slice(0, 3).map(request => request.conversation)).size, 1);
    assert.doesNotMatch(fixture.requests[1].prompt, /Describe a fictional garden/);
    await driver.bindings.discard('continued');
    await collect(command('continued', continued));
    assert.notEqual(fixture.requests[2].conversation, fixture.requests[3].conversation);
    assert.match(fixture.requests[3].prompt, /Describe a fictional garden/);
    for (const [mode, expected] of [['empty', 'empty'], ['hidden', 'hidden'], ['truncated', 'truncated'], ['rate', 'cooldown'], ['challenge', 'verification'], ['post-challenge', 'verification'], ['post-expired', 'expired'], ['post-forbidden', 'expired']]) {
      fixture.setMode(mode);
      console.log('checking failure ' + mode);
      await assert.rejects(collect(command(mode), new AccountGuard()), error => error.code === expected);
    }
    for (const mode of ['clone-failure', 'disabled', 'user-add']) {
      fixture.setMode(mode);
      driver.network = mode !== 'disabled';
      const result = await collect(command(mode));
      assert.equal(result.frames[0].text, fixture.batches.join(''));
      assert.match(result.output, /message_stop/);
    }
    driver.network = true;
    fixture.setMode('normal');
    const controller = new AbortController();
    const count = fixture.requests.length;
    const aborted = collect(command('abort'), guard, controller.signal);
    const rejected = assert.rejects(aborted, error => error.code === 'upstream');
    const submittedBy = Date.now() + 15000;
    while (fixture.requests.length === count) {
      assert.ok(Date.now() < submittedBy, 'Abort probe must reach submission');
      await delay(10);
    }
    controller.abort();
    await rejected;
    assert.equal(driver.bindings.entries.has('abort'), false);
    assert.match((await collect(command('abort'))).output, /message_stop/);
    console.log('fixture: three-turn supplied conversation_id reuse, discard rebuild, typed failures, whole-block delivery and abort/reuse passed');
    return { bindingReuse: true, discardWithoutAccount: true, abortReuse: true, delivery: 'whole-block' };
  } finally { await driver.close(); await fixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyTurns(process.argv[2] ?? fileURLToPath(new URL('../node_modules/playwright-core/index.mjs', import.meta.url)));
}
