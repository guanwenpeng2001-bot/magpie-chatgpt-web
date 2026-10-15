import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnDriver } from '../backend/turn.mjs';
import { BrowserSupervisor } from '../backend/browser.mjs';
import { AccountGuard } from '../backend/guard.mjs';
import { ReadClient } from '../backend/http.mjs';
import { serve } from '../backend/main.mjs';
import { PassThrough } from 'node:stream';
import { prepare } from '../src/wire/prepare.mjs';

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const skip = !chromium && 'playwright-core is not installed';

for (const challenge of [true, 'url-token', false]) test(`served late-title page: challenge=${challenge}`, { skip }, async () => {
  let navigations = 0;
  const server = createServer((request, response) => {
    if (request.url.startsWith('/cdn-cgi/')) { response.end(''); return; }
    if (challenge === 'url-token' && !request.url.includes('__cf_chl_')) {
      response.writeHead(302, { location: '/?__cf_chl_rt_tk=fixture' }); response.end(); return;
    }
    navigations++;
    response.setHeader('Content-Type', 'text/html');
    if (challenge === 'url-token') {
      response.end('<html><body><script src="/cdn-cgi/challenge-platform/test.js"></script><script>setTimeout(()=>document.title="Just a moment",450);</script></body></html>');
      return;
    }
    response.end(challenge
      ? '<html><head></head><body><script src="/cdn-cgi/challenge-platform/test.js"></script><script>window._cf_chl_opt={cRay:"fixture",cUPMDTk:"/?__cf_chl_rt_tk=fixture"};setTimeout(()=>document.title="Just a moment",450);</script></body></html>'
      : '<html><body><p>Temporary chat unavailable</p></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'late-title-'));
  const driver = new TurnDriver({ profileRoot: root, origin, timeout: 15000, launch: async profile => {
    const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    return context;
  } });
  const command = { ...prepare({ model: 'auto', messages: [{ role: 'user', content: 'Fixture' }] }), auth: { profile: 'fixture', refresh: 'next-auth.session-token=fixture' } };
  try {
    await assert.rejects(driver.complete(command, new AccountGuard(), 'fixture', new AbortController().signal, () => assert.fail('no output expected')), { code: challenge ? 'verification' : 'temporary' });
    assert.equal(navigations, challenge ? 1 : 2);
  } finally {
    await driver.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('node header challenge recovers through the production browserRoute chain', { skip }, async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, browser: request.headers.accept !== 'application/json', ua: request.headers['user-agent'] });
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Fixture</title>'); return; }
    if (request.headers.accept === 'application/json') { response.writeHead(403, { 'cf-mitigated': 'challenge' }); response.end(''); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ models: [{ slug: 'auto', title: 'Auto' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'fallback-presentation-'));
  const driver = new TurnDriver({ profileRoot: root });
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  let received;
  output.on('data', data => { frames.push(...data.toString().trim().split('\n').map(line => JSON.parse(line))); received?.(); });
  const work = serve(input, output, { turnDriver: driver, readClient: options => new ReadClient(options) });
  try {
    await driver.browser.run('fixture', async context => {
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    });
    input.write(JSON.stringify({ id: 'models', method: 'models', origin, profileRoot: root, auth: { profile: 'fixture', refresh: 'next-auth.session-token=fixture' } }) + '\n');
    while (!frames.some(frame => ['done', 'error'].includes(frame.event))) await new Promise(resolve => { received = resolve; });
    assert.equal(frames.some(frame => frame.event === 'error'), false, JSON.stringify(frames));
    assert.equal(frames.some(frame => frame.event === 'done'), true);
    const requests = seen.filter(request => request.url === '/backend-api/models');
    assert.deepEqual(requests.map(request => request.browser), [false, true]);
    assert.doesNotMatch(requests[1].ua, /HeadlessChrome/);
  } finally {
    input.end(); await work; await driver.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

for (const kind of ['supervisor', 'turn']) test(`production ${kind} launch presents matching Chrome identity`, { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'launch-presentation-'));
  const owner = kind === 'supervisor' ? new BrowserSupervisor({ profileRoot: root }) : new TurnDriver({ profileRoot: root });
  const browser = kind === 'supervisor' ? owner : owner.browser;
  try {
    await browser.run('fixture', async context => {
      const page = await context.newPage();
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture</title>' }));
      await context.setOffline(false);
      await page.goto('http://127.0.0.1/');
      const identity = await page.evaluate(async () => ({ ua: navigator.userAgent, hints: await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']) }));
      assert.doesNotMatch(identity.ua, /HeadlessChrome/);
      const major = identity.ua.match(/Chrome\/(\d+)/)?.[1];
      assert.ok(major);
      assert.ok(identity.hints);
      for (const brand of identity.hints.brands.filter(brand => /Chrom/i.test(brand.brand))) assert.equal(brand.version, major);
      assert.ok(identity.hints.brands.some(brand => /Chrom/i.test(brand.brand)));
      const cdp = await context.newCDPSession(page);
      const version = await cdp.send('Browser.getVersion');
      assert.equal(major, version.product.match(/\/(\d+)/)[1]);
      await cdp.detach();
    });
  } finally { await owner.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
