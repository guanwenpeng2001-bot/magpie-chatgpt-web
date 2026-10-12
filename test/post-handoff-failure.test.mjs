import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { installHarvest } from '../backend/harvest.mjs';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { prepare } from '../src/protocol.mjs';
import { createTurnFixture } from '../integrations/turn-fixture.mjs';

const expected = 'ORCA_DOM_ALPHA\nORCA_DOM_BETA\nORCA_DOM_GAMMA';
const readerCrash = 'fixture post-handoff reader crash';

async function runFixtureTurn({ mode, answerDelayMs = 0, timeout = 20000 } = {}) {
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
      if (mode.startsWith('present-') && !answerScheduled && state.nodes === 0) {
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
  try {
    await driver.complete({ ...prepared, auth: { profile: 'fixture' } }, new AccountGuard(), 'fixture', new AbortController().signal, frame => frames.push(frame));
  } catch (error) { failure = error; }
  return {
    frames, failure, harvestEvents,
    async close() { await driver.close(); await fixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
  };
}

test('a post-handoff reader failure does not abort a turn the DOM route completes', async () => {
  const turn = await runFixtureTurn({ mode: 'present-handoff-failure' });
  try {
    assert.equal(turn.failure?.code ?? null, null, `turn must complete, got ${turn.failure?.code}: ${turn.failure?.message}`);
    assert.deepEqual(turn.frames.filter(frame => frame.event === 'dom').map(frame => frame.data.text), ['ORCA_DOM_ALPHA', expected]);
    assert.equal(turn.frames.at(-1).data.type, 'message_stream_complete');
    const failure = turn.harvestEvents.find(item => item.kind === 'failure');
    assert.equal(failure?.code, 'harvest', 'the reader must have reported its own failure');
    assert.match(failure?.cause ?? '', new RegExp(readerCrash), 'the failure must carry its cause');
    assert.equal(turn.harvestEvents.some(item => item.kind === 'eof'), false, 'eof never arrives after a post-handoff reader crash');
  } finally { await turn.close(); }
});

test('a post-handoff reader failure survives a DOM answer that arrives only after a substantial gap', async () => {
  const turn = await runFixtureTurn({ mode: 'present-handoff-failure', answerDelayMs: 2500 });
  try {
    assert.equal(turn.failure?.code ?? null, null, `turn must complete, got ${turn.failure?.code}: ${turn.failure?.message}`);
    assert.deepEqual(turn.frames.filter(frame => frame.event === 'dom').map(frame => frame.data.text), ['ORCA_DOM_ALPHA', expected]);
    assert.equal(turn.frames.at(-1).data.type, 'message_stream_complete');
    const failure = turn.harvestEvents.find(item => item.kind === 'failure');
    assert.equal(failure?.code, 'harvest');
  } finally { await turn.close(); }
});

test('an upstream request failure still fails the turn', async () => {
  const turn = await runFixtureTurn({ mode: 'upstream-reject' });
  try {
    assert.equal(turn.failure?.code, 'upstream');
    assert.deepEqual(turn.frames, []);
  } finally { await turn.close(); }
});

test('a non-200 response status still fails the turn', async () => {
  const turn = await runFixtureTurn({ mode: 'post-expired' });
  try {
    assert.equal(turn.failure?.code, 'expired');
    assert.deepEqual(turn.frames, []);
  } finally { await turn.close(); }
});

test('the harvest send path records the binding failure cause on the page', async t => {
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
    await page.waitForFunction(() => window.fixtureStages?.some(item => item.phase === 'user-only'));
    const state = await page.evaluate(() => window.__chatgptHarvest.snapshot());
    assert.equal(state.failed, 'Error: fixture binding rejection');
  } finally {
    await browser.close();
    await fixture.close();
  }
});
