import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installHarvest } from '../backend/harvest.mjs';
import { probePageError } from '../backend/site-adapter/index.mjs';
import { siteAdapterHtml } from '../integrations/turn-fixture.mjs';

function harvest({ status = 403, headers = {}, body = '', responseType = '' } = {}) {
  const events = [];
  class XMLHttpRequest {
    listeners = {};
    status = status;
    responseType = responseType;
    get responseText() { if (this.responseType && this.responseType !== 'text') throw new Error('InvalidStateError'); return body; }
    getResponseHeader(name) { return headers[name] ?? null; }
    addEventListener(name, callback) { (this.listeners[name] ??= []).push(callback); }
    open() {}
    send() {}
    fire(name) { for (const callback of this.listeners[name] ?? []) callback(); }
  }
  const window = { fetch() {}, __chatgptHarvestEvent: event => events.push(event) };
  runInNewContext(`(${installHarvest.toString()})()`, { window, XMLHttpRequest, URL, location: { href: 'http://127.0.0.1/' }, document: { querySelectorAll: () => [] } });
  window.__chatgptHarvest.start('first');
  const xhr = new XMLHttpRequest(); xhr.open('POST', '/backend-api/f/conversation'); xhr.send();
  return { events, xhr, window, async flush() { await new Promise(resolve => setImmediate(resolve)); } };
}

for (const responseType of ['', 'json']) test(`XHR retains cf-mitigated with ${responseType || 'text'} response`, async () => {
  const fixture = harvest({ headers: { 'cf-mitigated': 'challenge' }, responseType });
  fixture.xhr.fire('load'); await fixture.flush();
  assert.equal(fixture.events.find(event => event.kind === 'status')?.mitigated, true);
});
test('XHR sniffs bounded HTML challenge body', async () => {
  const fixture = harvest({ headers: { 'content-type': 'text/html' }, body: '<title>Just a moment</title>/cdn-cgi/challenge-platform/' });
  fixture.xhr.fire('load'); await fixture.flush();
  assert.equal(fixture.events.find(event => event.kind === 'status')?.interstitial, true);
});
test('XHR ignores responses from a previous turn', async () => {
  const fixture = harvest({ headers: { 'cf-mitigated': 'challenge' } });
  await fixture.flush(); fixture.events.length = 0;
  fixture.window.__chatgptHarvest.stop(); fixture.window.__chatgptHarvest.start('second');
  fixture.xhr.fire('load'); fixture.xhr.fire('error'); await fixture.flush();
  assert.deepEqual(fixture.events, []);
});
test('page probes prioritize challenge and ignore passive scripts', async t => {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('playwright-core is not installed; run npm ci --ignore-scripts (requires Chrome).');
    return;
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const challenge of ['iframe', 'title']) await t.test(challenge, async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(siteAdapterHtml({ challenge, rate: 'Usage limit', signIn: true }));
        assert.equal((await probePageError(page)).kind, 'challenge');
      } finally { await page.close(); }
    });
    const page = await browser.newPage();
    await page.setContent('<textarea></textarea><script src="data:text/javascript,//cdn-cgi/challenge-platform/"></script>');
    assert.equal(await probePageError(page), null);
    await page.evaluate(() => { const card = document.createElement('div'); card.setAttribute('role', 'alert'); card.style.whiteSpace = 'pre-wrap'; card.textContent = 'cloudflare_challenge\nRetry'; document.body.append(card); });
    assert.equal((await probePageError(page)).evidence, 'challenge-card');
  } finally { await browser.close(); }
});
