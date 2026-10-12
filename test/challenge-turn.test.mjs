import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { prepare } from '../src/protocol.mjs';
import { createTurnFixture } from '../integrations/turn-fixture.mjs';

const verification = 'ChatGPT asked to verify you are human. Complete verification in the open browser, then retry the chat.';

test('offline challenge turn routing', async t => {
  try { import.meta.resolve('playwright-core'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  const { chromium } = await import('playwright-core');
  const fixture = await createTurnFixture({ interval: 20 });
  const root = await mkdtemp(join(tmpdir(), 'challenge-turn-'));
  let context;
  const driver = new TurnDriver({ profileRoot: root, origin: fixture.origin, timeout: 1500, launch: async profile => {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block', args: ['--disable-background-networking'] });
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    if (process.env.CHALLENGE_TRACE) await context.tracing.start({ screenshots: true, snapshots: true });
    return context;
  } });
  const command = () => ({ ...prepare({ model: 'auto', messages: [{ role: 'user', content: 'Describe a fictional garden.' }] }), auth: { profile: 'fixture' } });
  try {
    for (const [mode, expected] of [
      ['app-shell-challenge', 'verification'], ['app-shell-card', 'verification'], ['app-shell-script', 'verification'],
      ['xhr-challenge', 'verification'], ['xhr-interstitial', 'verification'], ['xhr-forbidden', 'expired'],
      ['xhr-expired', 'expired'], ['xhr-rate', 'cooldown'], ['challenge', 'verification'],
      ['post-challenge', 'verification'], ['page-shape', 'pageShape'],
    ]) await t.test(mode, async () => {
      fixture.setMode(mode);
      const guard = new AccountGuard({ sleep: async () => {} });
      const frames = [];
      const before = fixture.requests.length;
      let failure;
      try { await driver.complete(command(), guard, 'fixture', new AbortController().signal, frame => frames.push(frame)); }
      catch (error) { failure = error; }
      console.log(JSON.stringify({ mode, code: failure?.code, error: failure?.toJSON() }));
      assert.equal(failure?.code, expected);
      assert.deepEqual(frames, []);
      assert.equal(fixture.requests.length - before, ['challenge', 'page-shape'].includes(mode) ? 0 : 1);
      if (expected === 'verification') {
        assert.deepEqual(failure.toJSON(), { status: 502, message: verification });
        (await guard.begin())();
        if (mode.startsWith('app-shell-')) {
          const page = context.pages().find(page => new URL(page.url()).pathname.startsWith('/c/'));
          assert.ok(page, 'challenge page remains open for manual verification');
          assert.equal(await page.title(), 'Local chat fixture');
          assert.equal(await page.getByRole('textbox').count(), 1);
          assert.equal(await page.locator('iframe').getAttribute('title'), 'DIL execution sandbox');
          assert.equal(await page.getByRole('dialog').count(), 0);
          await page.close();
        }
      } else if (expected === 'expired') await assert.rejects(guard.begin(), { code: 'expired' });
      else if (expected === 'cooldown') assert.equal(failure.retryAfter, '120');
    });
    await t.test('healthy fixture still completes', async () => {
      fixture.setMode('normal');
      const frames = [];
      await driver.complete(command(), new AccountGuard(), 'fixture', new AbortController().signal, frame => frames.push(frame));
      assert.equal(frames.filter(frame => frame.event === 'answer').map(frame => frame.data.text).join(''), fixture.batches.join(''));
      assert.equal(frames.at(-1).data.type, 'message_stream_complete');
    });
  } finally {
    if (process.env.CHALLENGE_TRACE && context) await context.tracing.stop({ path: process.env.CHALLENGE_TRACE });
    await driver.close(); await fixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
