import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSupervisor } from '../backend/browser.mjs';

test('restored session cookies share the site domain so server rotations replace rather than duplicate them', async () => {
  const { chromium } = await import('playwright-core');
  const chrome = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await chrome.newContext({ offline: true });
  const browser = new BrowserSupervisor({ profileRoot: '.', launch: async () => context });
  try {
    await context.addCookies([{ name: '__Secure-next-auth.session-token', value: 'stored', url: 'https://chatgpt.com', secure: true }]);
    await browser.run('fixture', async () => {}, undefined, { auth: { refresh: '__Secure-next-auth.session-token=stored' } });
    await context.addCookies([{ name: '__Secure-next-auth.session-token', value: 'rotated', domain: '.chatgpt.com', path: '/', secure: true }]);
    const cookies = (await context.cookies('https://chatgpt.com')).filter(c => c.name.includes('session-token'));
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].value, 'rotated');
  } finally { await browser.close(); await chrome.close(); }
});
