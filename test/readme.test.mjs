import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const prose = readme.replace(/\s+/g, ' ');
const publicCodes = `expired cooldown upstream requestBudget empty hidden truncated unsupported
invalidRequest toolDefinition toolChoice toolUnknown toolJSON toolSchema toolChoiceViolation
 toolParallel toolIncomplete toolRequired toolDelimiter toolLimit binding temporary harvest protocol
 verification capacity browserDependency browserProfile browserConfiguration browserClosed backendDown
 signinTimeout missingComponent pickerMissing pickerAmbiguous modelNotOffered attachmentUnsupported
 imageRejected`.split(/\s+/);

test('README failure table covers every pinned public code with condition and recovery', () => {
  const section = readme.split('## Failure messages\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'failure section exists');
  const rows = [...section.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)];
  assert.deepEqual(rows.map(row => row[1]).sort(), [...publicCodes].sort());
  for (const [, code, condition, recovery] of rows) {
    assert.ok(condition.trim().length > 15, `${code} needs a condition`);
    assert.match(recovery, /\b(Repeat|Wait|Check|Retry|Review|Remove|Correct|Choose|Simplify|Reduce|Start|Update|Enable|Reinstall|Close|Install|Pick)\b/, `${code} needs an actionable recovery`);
  }
});

test('README states the plugin release and host version verified against', () => {
  assert.match(prose, /Plugin version: `0\.2\.0`\. Host verified against: magpie `0\.1\.1247`/);
});

test('README records the exact verified host identity with its evidence citation', () => {
  const section = readme.split('### Running host identity and bundle SHA-256\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'host identity section exists');
  for (const value of [
    'magpie `0.1.1247`', '`host-79c61aeda399.js`', '91 864 bytes',
    '`79c61aeda399c1baa3edbe0b41af0403013ec95224724e5a92126e9f69ba2646`',
    'verification/verify-live-acceptance.md:148-156',
    '`…/home/.cache/magpie/plugin-host/host-79c61aeda399.js`',
    'verification/verify-live-acceptance-r3.md:283-286',
  ]) assert.ok(section.includes(value), `host identity needs ${value}`);
});

test('README distinguishes live sign-in verification from unmeasured turns', () => {
  const opening = readme.split('\n')[2];
  assert.match(opening, /Sign-in lifecycle is live-verified/);
  assert.match(opening, /turn path remains blocked by a durable verification challenge/);
  assert.match(opening, /handled by design.*\[failure table\]\(#failure-messages\)/);
  assert.match(opening, /Turn budget and delivery cadence remain unmeasured/);
});

test('README explains blocked measurements without inventing live delivery results', () => {
  for (const heading of ['Turn-budget measurement', 'Delivery-cadence measurement']) {
    const section = readme.split(`### ${heading}\n`)[1]?.split('\n### ')[0];
    assert.ok(section, `${heading} section exists`);
    assert.match(section, /Unmeasured: live turn measurement was blocked by the durable verification challenge/);
    assert.match(section, /verification\/verify-live-acceptance-r3\.md/);
    assert.match(section, /`verification` row in the \[failure table\]\(#failure-messages\)/);
  }
  const cadence = readme.split('### Delivery-cadence measurement\n')[1]?.split('\n### ')[0];
  assert.match(cadence, /whole-block.*one content delta.*by construction/);
  assert.match(cadence, /500 ms DOM poll is an implementation setting, not measured delivery cadence/);
  assert.match(cadence, /verification\/verify-live-acceptance\.md:183-201/);
});

test('README ships verification status without open release-gate scaffolding', () => {
  assert.match(readme, /## Release verification status/);
  assert.doesNotMatch(prose, /TBD|<!--\s*VERIFY|intentionally unfilled|release verification is incomplete|must be replaced.*before release/i);
});

test('README makes no unmeasured progressive delivery claim', () => {
  const claims = prose.match(/[^.!?]*(?:stream(?:s|ing)? incrementally|progressive|token-level|characters per batch|twice per second)[^.!?]*[.!?]/gi) ?? [];
  assert.ok(claims.length > 0, 'delivery limitation must be explicit');
  for (const claim of claims) {
    assert.match(claim, /(?:not verified|not measured|evidence(?:-path)?\s*:\s*\S+)/i, claim);
  }
});

test('README distinguishes visible sign-in from default headless turns', () => {
  assert.match(prose, /Sign-in always opens (?:a )?visible Chrome/);
  assert.match(prose, /headless by default/);
  assert.match(prose, /Show browser during chats.*visible-turns/);
  assert.match(prose, /Idle turn browser contexts close after \*\*5 minutes\*\*/);
});

test('README discloses privacy boundaries and emulated capabilities', () => {
  assert.match(prose, /never deletes remote conversations/);
  assert.match(prose, /Neither operation erases the plugin-owned Chrome profile/);
  assert.match(prose, /Anthropic-wire emulation/);
  assert.match(prose, /toolcall: false/);
  assert.match(prose, /dormant emulation layer/i);
  assert.match(prose, /4 images \/ 10 MiB each/);
});

test('README documents both published upgrades and the local stale-pin workaround', () => {
  assert.match(prose, /git\+file:\/\/.*stale-pin/);
  assert.match(prose, /magpie plugin rm magpie-chatgpt-web/);
  assert.match(prose, /magpie plugin add github:guanwenpeng2001-bot\/magpie-chatgpt-web/);
});

test('README names where magpie comes from and the bare-name PATH requirement', () => {
  assert.match(readme, /https:\/\/usemagpie\.ai/);
  assert.match(readme, /https:\/\/github\.com\/yetone\/magpie/);
  assert.match(readme, /magpie-windows-amd64\.exe/);
  assert.match(readme, /magpie --version/);
  assert.match(readme, /CommandNotFoundException/);
});

test('README rehearsal states the network requirement without a package-cache alternative', () => {
  assert.match(readme, /a registry connection is required/);
  assert.doesNotMatch(readme, /compatible package cache/);
});

test('README harness description does not claim non-default model selection', () => {
  assert.doesNotMatch(readme, /selects a model through the stock host/);
});
