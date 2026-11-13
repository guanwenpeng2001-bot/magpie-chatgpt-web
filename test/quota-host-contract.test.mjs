import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { inflateRawSync } from 'node:zlib';
import { _internal } from '../src/index.mjs';
import { BackendError } from '../backend/guard.mjs';

async function installedHost(t) {
  const path = process.env.MAGPIE_USAGE_HOST_EXE
    ?? (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/magpie/magpie.exe'));
  if (!path) { t.skip('set MAGPIE_USAGE_HOST_EXE to an existing Magpie executable'); return; }
  let binary;
  try { binary = await readFile(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.MAGPIE_USAGE_HOST_EXE) throw error;
    t.skip('installed Magpie absent; no download or host startup'); return;
  }
  return binary;
}

test('installed Magpie usage contract preserves unknown quota and cancellation (no host startup)', async t => {
  const binary = await installedHost(t);
  if (!binary) return;
  // Read only embedded program code, not a running host or any configuration,
  // sign-in store or browser profile. Execute this one function with fixtures.
  const start = binary.indexOf('async function usageOf(provider, account, signal) {');
  const end = binary.indexOf('// ---- check-in ', start);
  assert.ok(start >= 0 && end > start && end - start < 10000, 'installed usageOf boundaries');
  assert.ok(binary.includes(Buffer.from('usage: typeof a.auth.usage === "function"')), 'host discovers auth.usage');
  let snapshot = { state: 'unknown', reason: 'not-reported', planType: 'pro' };
  const auth = { type: 'oauth', refresh: 'fixture-only', profile: 'fixture' };
  const controller = new AbortController();
  let calls = 0;
  const hooks = _internal.createHooks({ profileRoot: '/fixture', bridge: { async call(command, signal) {
    assert.equal(command.method, 'quota');
    assert.deepEqual(command.auth, auth);
    assert.equal(signal, controller.signal);
    calls++;
    if (snapshot instanceof Error) throw snapshot;
    return snapshot;
  } } });
  const usageOf = runInNewContext(binary.subarray(start, end).toString('utf8') + '\nusageOf', {
    auths: () => new Map([['chatgpt-web', { auth: hooks.auth }]]),
    accountKey: (provider, account) => { assert.equal(provider, 'chatgpt-web'); return account; },
    readAuth: () => ({ fixture: auth }),
    fresh: async () => {}, // never invoke real host refresh/models hooks
    infoOf: async () => ({ id: 'chatgpt-web', models: {} }),
    authCopy: () => structuredClone(auth),
    inScope: (_provider, _key, callback) => callback(),
  });
  for (const value of [snapshot, { state: 'unknown', reason: 'plan-not-reported' },
    new BackendError('verification'), new BackendError('expired')]) {
    snapshot = value;
    const result = await usageOf('chatgpt-web', 'fixture', controller.signal);
    assert.equal(result.windows.length, 1, 'unknown must still have a visible text window');
    assert.equal(result.windows[0].used, null, 'JS boundary preserves absence; Go JSON may later add numeric placeholders');
    assert.equal(result.windows[0].balance, null);
    assert.equal(result.windows[0].aside, true);
    assert.equal(result.error, '', 'show the fixed reason as a text window, not a hidden tooltip');
    assert.match(result.windows[0].display, /^未知：.+/);
    assert.equal(result.signIn, value?.code === 'expired' ? 'expired' : 'kept');
    assert.equal(result.until, '');
    assert.equal(result.windows[0].resetsAt, '');
    assert.doesNotMatch(JSON.stringify(result), /fixture-only/);
  }
  assert.equal(calls, 4);
  controller.abort();
  await assert.rejects(usageOf('chatgpt-web', 'fixture', controller.signal), { name: 'AbortError' });
  assert.equal(calls, 4, 'cancelled host reads never reach the backend');
});

function installedUI(binary) {
  // Release builds embed assets.zip (internal/gui/assets_packed.go). Read just
  // app.js into memory; do not extract files or start the app/browser. ZIP uses
  // a data descriptor, so inflate stops at the deflate stream's end.
  const name = Buffer.from('assets/app.js');
  const headers = [];
  for (let at = binary.indexOf(name); at >= 0; at = binary.indexOf(name, at + 1)) {
    const header = at - 30;
    if (header >= 0 && binary.readUInt32LE(header) === 0x04034b50
      && binary.readUInt16LE(header + 26) === name.length) headers.push(header);
  }
  assert.equal(headers.length, 1, 'one installed app.js ZIP entry');
  const header = headers[0];
  assert.equal(binary.readUInt16LE(header + 6) & 1, 0, 'entry is not encrypted');
  assert.equal(binary.readUInt16LE(header + 8), 8, 'entry uses deflate');
  const offset = header + 30 + name.length + binary.readUInt16LE(header + 28);
  return inflateRawSync(binary.subarray(offset), { maxOutputLength: 8 << 20 }).toString('utf8');
}

function uiFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `installed UI function ${name}`);
  const firstLineEnd = source.indexOf('\n', start);
  const end = source.slice(start, firstLineEnd).endsWith('}') ? firstLineEnd : source.indexOf('\n}', start) + 2;
  assert.ok(end > start, `complete installed UI function ${name}`);
  return source.slice(start, end);
}

// Minimal DOM fixture: assertions inspect only appended nodes, since the real
// renderer may construct a percentage track and deliberately leave it detached.
function element(tag, className = '', text = '') {
  return { tag, className, children: text ? [text] : [], style: { setProperty() {} }, dataset: {},
    classList: { add() {} }, append(...children) { this.children.push(...children); } };
}
function visibleText(node) {
  return typeof node === 'string' ? node : node.children.map(visibleText).join(' ');
}
function tracks(node) {
  return typeof node === 'string' ? 0 : Number(node.className === 'quota-track') + node.children.reduce((n, child) => n + tracks(child), 0);
}

test('installed UI treats Go-normalized text windows as unknown, not 100% left', async t => {
  const binary = await installedHost(t);
  if (!binary) return;
  const source = installedUI(binary);
  const functions = ['to100', 'quotaNoShare', 'quotaFill', 'quotaText', 'quotaCount', 'quotaPace', 'quotaWindows', 'panelQuotaCard']
    .map(name => uiFunction(source, name)).join('\n');
  const ui = runInNewContext(`let quotaLeft = false;\n${functions}\n({ quotaNoShare, quotaText, quotaPace, quotaWindows, panelQuotaCard,
    mode(left) { quotaLeft = left; } })`, {
    t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_slot, key) => String(values[key])),
    el: element, countFormat: new Intl.NumberFormat('en-US'), quotaFit: { observe() {} },
    window: { hideAccounts: false }, trayCardID: () => 'fixture', planName: plan => plan,
    familyWindows: windows => windows, pqLine: text => element('div', 'pq-line', text),
    runsOutText: () => '',
  });
  // Sanitized window shape from diagnosis-054-quota-live.json. No account id,
  // email, credentials or live reads belong in this regression fixture.
  const window = { name: '剩余额度', used: 0, remaining: 100,
    display: '未知：接口未返回额度', text: true };
  const card = { provider: 'chatgpt-web', name: 'ChatGPT Web', kind: 'subscription',
    plan: 'ChatGPT Pro (prolite)', windows: [window] };
  for (const left of [false, true]) {
    ui.mode(left);
    assert.equal(ui.quotaNoShare(window), true);
    assert.equal(ui.quotaText(window), window.display);
    assert.equal(ui.quotaPace({ ...window, startsAt: '2026-01-01', resetsAt: '2026-02-01' }, Date.parse('2026-01-15')), null);
    const rendered = ui.quotaWindows(card);
    assert.equal(tracks(rendered), 0, 'text-only window must not attach a percentage meter');
    assert.match(visibleText(rendered), /未知/);
    assert.doesNotMatch(visibleText(rendered), /\d+(?:\.\d+)?%/);
    const panel = ui.panelQuotaCard(card);
    assert.match(visibleText(panel), /未知/);
    assert.doesNotMatch(visibleText(panel), /\d+(?:\.\d+)?%|Not used yet/);

    // Positive control: an explicitly measured zero must still show its meter
    // and the selected Used/Left percentage, rather than hiding all readings.
    const measured = { name: 'Measured allowance', used: 0, remaining: 100 };
    assert.equal(ui.quotaNoShare(measured), false);
    assert.equal(ui.quotaText(measured), left ? '100% left' : '0% used');
    assert.equal(tracks(ui.quotaWindows({ ...card, windows: [measured] })), 1);
  }
});
