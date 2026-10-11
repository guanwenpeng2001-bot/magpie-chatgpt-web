import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { BrowserSupervisor } from '../backend/browser.mjs';

if (!process.env.NODE_TEST_CONTEXT) {
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ? pathToFileURL(resolve(process.env.PLAYWRIGHT_CORE_PATH)).href : 'playwright-core');
const matrix = [];
for (const headless of [true, false]) {
  const profileRoot = await mkdtemp(resolve('.launch-profile-'));
  let launches = 0;
  const supervisor = new BrowserSupervisor({
    profileRoot, headless, idleMilliseconds: 30,
    launch: async (profile, options) => {
      launches++;
      return chromium.launchPersistentContext(profile, {
        ...options, offline: true, serviceWorkers: 'block', timeout: 20_000,
        args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
      });
    },
  });
  const row = { channel: 'chrome', headless, lazy: launches === 0, launch: false, idleClose: false, crashRelaunch: false };
  try {
    let closed;
    await supervisor.run('fixture', async context => {
      closed = new Promise(resolve => context.once('close', resolve));
      assert.equal(await context.pages()[0].evaluate(() => location.href), 'about:blank');
      row.launch = true;
    });
    await closed;
    row.idleClose = true;
    await supervisor.run('fixture', async context => {
      assert.equal(context.pages()[0].url(), 'about:blank');
    });
    await assert.rejects(supervisor.run('fixture', async context => {
      const session = await context.newCDPSession(context.pages()[0]);
      await session.send('Browser.crash').catch(() => {});
      await new Promise(() => {});
    }));
    await supervisor.run('fixture', async context => {
      assert.equal(await context.pages()[0].evaluate(() => location.href), 'about:blank');
    });
    row.crashRelaunch = launches === 3;
  } catch { row.failure = 'Launch or lifecycle assertion failed'; }
  finally {
    await supervisor.close();
    await rm(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  matrix.push(row);
  console.log(JSON.stringify(row));
}
if (matrix.some(row => !row.launch || !row.idleClose || !row.crashRelaunch || !row.lazy)) process.exitCode = 1;
}
