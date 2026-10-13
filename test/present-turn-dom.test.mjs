import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHarvest } from '../backend/harvest.mjs';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { prepare, translate } from '../src/protocol.mjs';
import { createTurnFixture } from '../integrations/turn-fixture.mjs';

const expected = 'ORCA_DOM_ALPHA\nORCA_DOM_BETA\nORCA_DOM_GAMMA';
const assistantSelector = '[data-content-search-unit-key$=":assistant"]';
const answerSelector = `${assistantSelector} > [data-conversation-role="assistant"] + div`;

let chromium;

test('present DOM answer, stop and completion evidence', async t => {
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
  await context.exposeBinding('__chatgptHarvestEvent', () => {});
  await context.addInitScript(installHarvest);
  if (process.env.PRESENT_TRACE) await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const snapshot = () => page.evaluate(() => window.__chatgptHarvest.snapshot());
  const advance = phase => page.evaluate(phase => window.advancePresentTurn(phase), phase);
  try {
    await page.goto(fixture.origin);
    await page.evaluate(() => window.__chatgptHarvest.start('fixture', false));
    await page.getByRole('textbox').fill('User instruction must not become answer text');
    await page.getByRole('textbox').press('Enter');
    await page.waitForFunction(() => window.fixtureStages?.length);
    await t.test('user-only complete state cannot finish an answer', async () => {
      assert.equal(await page.locator('[data-talvt-turn-state]').getAttribute('data-talvt-turn-state'), 'complete');
      assert.equal(await page.locator(assistantSelector).count(), 0);
      assert.equal(await page.locator('main button[aria-label="停止"]').count(), 1);
      const state = await snapshot();
      assert.equal(state.finished, false);
      assert.equal(state.text, '');
    });
    await t.test('observed stop label is detected', async () => { assert.equal((await snapshot()).stop, true); });
    await advance('answer');
    await advance('grow');
    await t.test('measured vocabulary returns answer alone with old selectors absent', async () => {
      assert.equal(await page.locator('[data-dil-message-id], [data-message-author-role="assistant"], [aria-label="Assistant response"]').count(), 0);
      assert.equal(await page.locator(assistantSelector).count(), 1);
      assert.equal(await page.locator('[data-content-search-unit-key$=":user"]').count(), 1);
      assert.equal(await page.locator(answerSelector).count(), 1);
      assert.equal(await page.locator(answerSelector).innerText(), expected);
      assert.equal((await snapshot()).text, expected);
    });
    await t.test('complete state still waits for stop removal', async () => {
      await advance('complete-with-stop');
      assert.equal((await snapshot()).finished, false);
    });
    await t.test('in-progress answer without stop cannot finish', async () => {
      await page.locator('[data-talvt-turn-state]').evaluate(node => node.setAttribute('data-talvt-turn-state', 'in_progress'));
      await advance('in-progress-no-stop');
      assert.equal((await snapshot()).finished, false);
    });
    await t.test('assistant plus complete state without stop finishes', async () => {
      await advance('complete');
      assert.equal((await snapshot()).finished, true);
    });
    await t.test('baseline excludes an existing assistant unit and role suffix ignores index', async () => {
      await page.evaluate(() => window.__chatgptHarvest.start('next', false));
      assert.equal((await snapshot()).text, '');
      assert.equal((await snapshot()).nodes, 0);
      await page.locator(assistantSelector).evaluate(node => {
        const next = node.cloneNode(true);
        next.setAttribute('data-content-search-unit-key', 'fallback-turn-1:17:assistant');
        next.querySelector('[data-conversation-role="assistant"] + div').textContent = 'Next answer';
        node.parentElement.append(next);
      });
      assert.equal((await snapshot()).text, 'Next answer');
      assert.equal((await snapshot()).nodes, 1);
    });
    await t.test('present assistant challenge card remains a verification error', async () => {
      await page.locator(answerSelector).last().evaluate(node => { node.textContent = 'cloudflare_challenge'; });
      await assert.rejects(new TurnDriver().pageError(page, new AccountGuard()), { code: 'verification' });
    });
  } finally {
    if (process.env.PRESENT_TRACE) await context.tracing.stop({ path: process.env.PRESENT_TRACE });
    await browser.close();
    await fixture.close();
  }
});

for (const network of [false, true]) test(`present DOM ${network ? 'handoff' : 'fallback'} completes through TurnDriver with incremental answer-only frames`, async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  ({ chromium } = await import('playwright-core'));
  const fixture = await createTurnFixture();
  fixture.setMode(network ? 'present-handoff' : 'present-dom');
  const root = await mkdtemp(join(tmpdir(), 'present-turn-'));
  let context;
  const driver = new TurnDriver({ origin: fixture.origin, profileRoot: root, network, timeout: 2500, launch: async profile => {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block', args: ['--disable-background-networking'] });
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    await context.exposeBinding('fixtureSnapshotObserved', async ({ page }, state) => {
      if (state.nodes === 0) await page.evaluate(() => window.advancePresentTurn?.('answer'));
      else if (state.text === 'ORCA_DOM_ALPHA') await page.evaluate(() => window.advancePresentTurn('grow'));
      else if (state.text === expected) await page.evaluate(() => window.advancePresentTurn('complete'));
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
  const prepared = prepare({ model: 'auto', messages: [{ role: 'user', content: 'User instruction must not escape' }] });
  const frames = [];
  try {
    await assert.doesNotReject(driver.complete({ ...prepared, auth: { profile: 'fixture' } }, new AccountGuard(), 'fixture', new AbortController().signal, frame => frames.push(frame)));
    assert.deepEqual(frames.filter(frame => frame.event === 'dom').map(frame => frame.data.text), ['ORCA_DOM_ALPHA', expected]);
    assert.equal(frames.at(-1).data.type, 'message_stream_complete');
    const chunks = [];
    for await (const chunk of translate(frames, prepared)) chunks.push(chunk);
    assert.equal(chunks.at(-1).includes('event: message_stop'), true);
  } finally {
    await driver.close(); await fixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
