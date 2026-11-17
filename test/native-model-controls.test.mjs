import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { nativeProLockEvidence, nativeProQuotaReason, patchNativeModelControls } from '../src/native/model-controls.mjs';
import { modelControlsMenu } from './fixtures/native-model-controls-dom.mjs';

test('hidden disabled Pro: reveal its menu, hover its row, preserve the entire real reset text', async () => {
  const reason = '已达限额。\n请在明天 14:54 后重试。';
  const f = modelControlsMenu({ hidden: true, reason });
  const evidence = await nativeProLockEvidence(f.menu, { revealModelList: f.revealModelList });
  assert.deepEqual(evidence, { reason, quotaConfirmed: true });
  assert.equal(f.events.reveals, 1); assert.equal(f.events.hovers, 1);
  assert.equal(f.events.modelChanges, 0); assert.equal(f.events.submissions, 0);
  assert.equal(f.events.disposed, 3); assert.ok(!('retryAfter' in evidence));
});

test('only positive quota-language evidence is recognized; no inferred dates or generic length limits', () => {
  for (const reason of ['已达限额。请明天再试。', 'Usage limit reached. Try again tomorrow at 14:54.',
    "You've hit your usage limit for Pro. Try later.", 'You have reached the Pro usage limit.']) assert.equal(nativeProQuotaReason(reason), true, reason);
  for (const reason of [null, '', 'Upgrade required', "You've reached your input length limit.", 'No usage limit reached.',
    'Usage limit is 100', 'Usage limit not reached', 'Please check your usage limit', 'x'.repeat(2049)]) assert.equal(nativeProQuotaReason(reason), false, reason);
});

test('enabled, absent, ambiguous, nested, aliased and changing rows cannot authorize quota', async () => {
  for (const options of [{ rowAttrs: { 'aria-disabled': 'false' } }, { duplicate: true }, { nested: true },
    { rowText: 'Pro Max' }, { rootRole: 'dialog' }, { rowAttrs: { 'aria-label': 'Other' } },
    { rowAttrs: { 'aria-labelledby': 'other' } }, { onHover: ({ row }) => { row.attrs['aria-disabled'] = 'false'; } },
    { onHover: ({ root }) => { root.isConnected = false; } },
    { onHover: ({ row, root, Element }) => { row.isConnected = false; new Element({ role: 'menuitemradio', 'aria-disabled': 'true' }, 'Pro', root); } }]) {
    const f = modelControlsMenu(options);
    assert.equal(await nativeProLockEvidence(f.menu, { revealModelList: f.revealModelList }), null);
  }
});

test('a supplied reason or unrelated/ambiguous/stale tooltip cannot replace the row-bound evidence', async () => {
  for (const options of [{ reason: 'Upgrade required', unrelatedQuota: true }, { duplicateId: true }, { secondTooltip: true },
    { reason: '已达限额。' + 'x'.repeat(2048) }, { hoverError: true }, { hidden: true, revealError: true }]) {
    const f = modelControlsMenu(options);
    const result = await nativeProLockEvidence(f.menu, { revealModelList: f.revealModelList, reason: '已达限额。' });
    assert.equal(result.quotaConfirmed, false);
    assert.equal(f.events.modelChanges, 0);
  }
});

test('hidden or unreferenced tooltips remain explicitly unavailable, never 429', async () => {
  for (const options of [{ tooltipVisible: false }, { describedBy: 'not-this-tooltip' }]) {
    const f = modelControlsMenu(options);
    assert.deepEqual(await nativeProLockEvidence(f.menu, { revealModelList: f.revealModelList }), { reason: null, quotaConfirmed: false });
  }
});

test('actual pinned selection range branch uses 429 for quota and 503 for an unavailable account model', async t => {
  const path = process.env.NATIVE_REFERENCE_CLI ?? 'C:/Users/Administrator/.config/magpie/chatgpt-web-native/runtime-6.1.18/payload/app/cli.js';
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT' && !process.env.NATIVE_REFERENCE_CLI) { t.skip('Pinned CLI not installed; never downloads'); return; } throw error; }
  assert.equal(createHash('sha256').update(raw).digest('hex'), 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1');
  const patched = patchNativeModelControls(raw);
  assert.throws(() => patchNativeModelControls(patched), /collision/);
  assert.throws(() => patchNativeModelControls(raw.replace('if(u>L.max-L.min)', 'if(false)')), /anchor/);
  assert.throws(() => patchNativeModelControls(raw + raw), /anchor/);
  // Execute the actual, uniquely located native range/availability guard in a
  // VM. DOM and tooltip work use the production callbacks, with no account,
  // browser, CLI startup, network or model execution. No copied guard logic.
  const start = patched.indexOf('let C=e.url(),f=async(y,P)=>');
  const end = patched.indexOf(',v=await f(g,h.menu)', start);
  assert.ok(start > 0 && end > start);
  const guard = patched.slice(start, end) + ';return f;';
  const helpersStart = patched.indexOf('\nfunction nativeDisabledProRow');
  assert.ok(helpersStart > 0);
  const helpers = patched.slice(helpersStart);
  for (const [options, expected] of [[{ hidden: true }, 429], [{ reason: 'Upgrade required' }, 503],
    [{ hoverError: true }, 503], [{ duplicateId: true }, 503]]) {
    const f = modelControlsMenu(options);
    class AdapterError extends Error { constructor(message, fields) { super(message); Object.assign(this, fields); } }
    const context = { q: AdapterError, e: { url: () => 'fixture:' }, u: 4,
      pa: async () => ({ min: 0, max: 3, value: 1, available: [true, true, true, true] }),
      l_: async () => undefined, qd: f.revealModelList, Kn: text => Error(text),
      setTimeout, clearTimeout, Date };
    const nativeGuard = runInNewContext(helpers + '\n(async()=>{' + guard + '})()', context);
    const check = await nativeGuard;
    await assert.rejects(check({}, f.menu), error => {
      assert.equal(error.status, expected);
      assert.equal(error.code, expected === 429 ? 'rate_limit_exceeded' : 'account_model_unavailable');
      assert.equal(error.errorType, expected === 429 ? 'rate_limit_error' : 'server_error');
      assert.equal(error.retryable, false);
      if (expected === 429) assert.ok(error.message.endsWith('已达限额。请在明天 14:54 后重试。'));
      assert.ok(!('retryAfter' in error) && !('retry_after' in error)); return true;
    });
    assert.equal(f.events.modelChanges, 0); assert.equal(f.events.submissions, 0);
  }
  for (const anchor of ['if(u>L.max-L.min)', 'if(!L.available[u])', 'if(a)await mu(_,a,s.effort,u,1000)',
    'if(s&&c&&c.value===c.min+r&&r_(l,t,n))return;']) assert.ok(patched.includes(anchor));
});
