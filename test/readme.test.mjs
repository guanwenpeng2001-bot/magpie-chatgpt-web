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

test('README reserves exactly three release measurement markers with TBD values', () => {
  const markers = [...readme.matchAll(/<!-- VERIFY:([^>]+) -->\r?\n([^\r\n]+)/g)];
  assert.deepEqual(markers.map(match => [match[1], match[2]]), [
    ['turn-budget', 'TBD'], ['delivery-cadence', 'TBD'], ['host-identity', 'TBD'],
  ]);
  assert.equal((readme.match(/<!-- VERIFY:/g) ?? []).length, 3);
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
