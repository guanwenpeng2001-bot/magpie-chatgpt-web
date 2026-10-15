import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installHarvest } from '../backend/harvest.mjs';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { prepare } from '../src/wire/prepare.mjs';
import { createTurnFixture } from '../integrations/turn-fixture.mjs';

const expected = 'ORCA_DOM_ALPHA\nORCA_DOM_BETA\nORCA_DOM_GAMMA';
const readerCrash = 'fixture post-handoff reader crash';

let chromium;

async function runFixtureTurn({ mode, answerDelayMs = 0, timeout = 20000, renderAnswer = true } = {}) {
  const fixture = await createTurnFixture();
  fixture.setMode(mode);
  const root = await mkdtemp(join(tmpdir(), 'post-handoff-'));
  let context;
  const harvestEvents = [];
  let answerScheduled = false;
  const driver = new TurnDriver({ origin: fixture.origin, profileRoot: root, timeout, launch: async profile => {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block', args: ['--disable-background-networking'] });
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    await context.exposeBinding('fixtureHarvestEvents', ({ page }, payload) => { harvestEvents.push(payload); });
    await context.exposeBinding('fixtureSnapshotObserved', async ({ page }, state) => {
      if (mode.startsWith('present-') && renderAnswer && !answerScheduled && state.nodes === 0) {
        answerScheduled = true;
        if (answerDelayMs > 0) await delay(answerDelayMs);
        await page.evaluate(() => window.advancePresentTurn('answer'));
      }
      if (state.text === 'ORCA_DOM_ALPHA') await page.evaluate(() => window.advancePresentTurn('grow'));
      else if (state.text === expected) await page.evaluate(() => window.advancePresentTurn('complete'));
    });
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        if (!window.__chatgptHarvestEvent) return;
        const original = window.__chatgptHarvestEvent;
        window.__chatgptHarvestEvent = payload => { void window.fixtureHarvestEvents({ ...payload }); return original(payload); };
      });
    });
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const original = window.__chatgptHarvest.snapshot;
        window.__chatgptHarvest.snapshot = () => {
          const state = original();
          if (window.advancePresentTurn) void window.fixtureSnapshotObserved(state);
          return state;
        };
      });
    });
    return context;
  } });
  const prepared = prepare({ model: 'auto', messages: [{ role: 'user', content: 'Answer from the page.' }] });
  const frames = [];
  let failure;
  const startedAt = Date.now();
  try {
    await driver.complete({ ...prepared, auth: { profile: 'fixture' } }, new AccountGuard(), 'fixture', new AbortController().signal, frame => frames.push(frame));
  } catch (error) { failure = error; }
  return {
    frames, failure, harvestEvents, elapsedMs: Date.now() - startedAt,
    async close() { await driver.close(); await fixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
  };
}

test('a post-handoff reader failure does not abort a turn the DOM route completes', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  ({ chromium } = await import('playwright-core'));
  const turn = await runFixtureTurn({ mode: 'present-handoff-failure' });
  try {
    assert.equal(turn.failure?.code ?? null, null, `turn must complete, got ${turn.failure?.code}: ${turn.failure?.message}`);
    assert.deepEqual(turn.frames.filter(frame => frame.type === 'delta').map(frame => frame.text), [expected]);
    assert.equal(turn.frames.at(-1).type, 'finish');
    const failure = turn.harvestEvents.find(item => item.kind === 'failure');
    assert.equal(failure?.code, 'harvest', 'the reader must have reported its own failure');
    assert.match(failure?.cause ?? '', new RegExp(readerCrash), 'the failure must carry its cause');
    assert.equal(turn.harvestEvents.some(item => item.kind === 'eof'), false, 'eof never arrives after a post-handoff reader crash');
  } finally { await turn.close(); }
});

test('a post-handoff reader failure survives a DOM answer that arrives only after a substantial gap', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  ({ chromium } = await import('playwright-core'));
  const turn = await runFixtureTurn({ mode: 'present-handoff-failure', answerDelayMs: 2500 });
  try {
    assert.equal(turn.failure?.code ?? null, null, `turn must complete, got ${turn.failure?.code}: ${turn.failure?.message}`);
    assert.deepEqual(turn.frames.filter(frame => frame.type === 'delta').map(frame => frame.text), [expected]);
    assert.equal(turn.frames.at(-1).type, 'finish');
    const failure = turn.harvestEvents.find(item => item.kind === 'failure');
    assert.equal(failure?.code, 'harvest');
  } finally { await turn.close(); }
});

test('a stream completion frame after the handoff does not end the turn before the DOM answer', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  ({ chromium } = await import('playwright-core'));
  const turn = await runFixtureTurn({ mode: 'present-handoff-done', answerDelayMs: 1000 });
  try {
    assert.equal(turn.failure?.code ?? null, null, `turn must complete, got ${turn.failure?.code}: ${turn.failure?.message}`);
    assert.deepEqual(turn.frames.filter(frame => frame.type === 'delta').map(frame => frame.text), [expected]);
    assert.equal(turn.frames.at(-1).type, 'finish');
  } finally { await turn.close(); }
});

test('an upstream request failure still fails the turn', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  ({ chromium } = await import('playwright-core'));
  const turn = await runFixtureTurn({ mode: 'upstream-reject' });
  try {
    assert.equal(turn.failure?.code, 'upstream');
    assert.deepEqual(turn.frames, []);
  } finally { await turn.close(); }
});

test('a non-200 response status still fails the turn', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  ({ chromium } = await import('playwright-core'));
  const turn = await runFixtureTurn({ mode: 'post-expired' });
  try {
    assert.equal(turn.failure?.code, 'expired');
    assert.deepEqual(turn.frames, []);
  } finally { await turn.close(); }
});

// Pins a deliberate trade: once the stream has handed off, its completion
// frame is not evidence that the reply is empty - the live body completed
// carrying no text long before the DOM answer rendered. So a post-handoff
// reply whose DOM answer never renders holds the turn to its budget and
// reports 'truncated' (we never confirmed what the reply was) instead of
// exiting 'empty' on the untrusted stream-side completion, as the base did.
test('a post-handoff stream completion whose DOM answer never renders holds the turn to its budget and reports truncated', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  ({ chromium } = await import('playwright-core'));
  const turn = await runFixtureTurn({ mode: 'present-handoff-done', renderAnswer: false, timeout: 3000 });
  try {
    assert.equal(turn.failure?.code, 'truncated', `got ${turn.failure?.code}: ${turn.failure?.message}`);
    assert.ok(turn.elapsedMs >= 3000, `the turn must hold to its budget, elapsed ${turn.elapsedMs} ms`);
    assert.deepEqual(turn.frames, [], 'no answer may be emitted for a reply the driver could not confirm');
  } finally { await turn.close(); }
});

test('the harvest send path records the binding failure cause on the page', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  ({ chromium } = await import('playwright-core'));
  const fixture = await createTurnFixture();
  fixture.setMode('present-dom');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-networking'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await context.addInitScript(installHarvest);
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      window.__chatgptHarvestEvent = () => { throw new Error('fixture binding rejection'); };
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(fixture.origin);
    await page.evaluate(() => window.__chatgptHarvest.start('fixture', false));
    await page.getByRole('textbox').fill('Turn the send failure into a reported cause');
    await page.getByRole('textbox').press('Enter');
    // Wait on the condition under test: the send catch must have recorded
    // run.failed. The fixture reaches 'user-only' inside its keydown handler
    // before `await fetch(...)` runs, so that stage proves nothing.
    await page.waitForFunction(() => window.__chatgptHarvest.snapshot().failed !== false);
    const state = await page.evaluate(() => window.__chatgptHarvest.snapshot());
    assert.equal(state.failed, 'Error: fixture binding rejection');
  } finally {
    await browser.close();
    await fixture.close();
  }
});
