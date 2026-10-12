import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installHarvest } from '../backend/harvest.mjs';
import { TurnDriver } from '../backend/turn.mjs';
import { AccountGuard } from '../backend/guard.mjs';

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
for (const signal of ['card', 'script']) test(`pageError detects app-shell ${signal} independently`, async () => {
  const document = { title: 'Garden conversation', querySelector: () => null, querySelectorAll(selector) {
    if (selector === 'script[src]') return signal === 'script' ? [{ src: 'http://127.0.0.1/cdn-cgi/challenge-platform/scripts/jsd/api.js' }] : [];
    if (selector.includes('data-message-author-role')) return signal === 'card' ? [{ innerText: 'cloudflare_challenge\nRetry' }] : [];
    return [];
  } };
  const page = { evaluate: callback => runInNewContext(`(${callback.toString()})()`, { document, URL }) };
  await assert.rejects(TurnDriver.prototype.pageError(page, new AccountGuard()), { code: 'verification' });
});
