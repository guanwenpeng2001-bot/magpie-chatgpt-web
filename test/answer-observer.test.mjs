import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { prepare } from '../src/protocol.mjs';
import { createTurnFixture } from '../integrations/turn-fixture.mjs';
import { observeAnswer } from '../integrations/observe-answer.mjs';

test('answer observer captures exact fixture text, terminal and timed deltas; rejects truncation', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts, then node --test test/answer-observer.test.mjs (requires Chrome).');
    return;
  }
  const { chromium } = await import('playwright-core');
  const fixture = await createTurnFixture({ interval: 450 });
  const root = await mkdtemp(join(tmpdir(), 'answer-observer-'));
  const driver = new TurnDriver({ profileRoot: root, origin: fixture.origin, timeout: 8000, launch: async profile => {
    const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    return context;
  } });
  const command = () => ({ ...prepare({ model: 'auto', messages: [{ role: 'user', content: 'Describe a fictional garden.' }] }), auth: { profile: 'fixture' } });
  try {
    fixture.setMode('truncated');
    const bad = await observeAnswer(driver, command(), new AccountGuard(), 'fixture', new AbortController().signal);
    assert.equal(bad.verified, false);
    fixture.setMode('normal');
    const result = await observeAnswer(driver, command(), new AccountGuard(), 'fixture', new AbortController().signal);
    assert.equal(result.verified, true);
    assert.equal(result.text, fixture.batches.join(''));
    assert.equal(result.deltas.length, 3);
    assert.ok(result.deltas[1].milliseconds - result.deltas[0].milliseconds >= 250);
    assert.ok(result.deltas[2].milliseconds - result.deltas[1].milliseconds >= 250);
    console.log(JSON.stringify({ observer: 'offline exact answer verified', ...result }));
  } finally { await driver.close(); await fixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
