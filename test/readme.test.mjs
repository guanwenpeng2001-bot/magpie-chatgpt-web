import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const prose = readme.replace(/\s+/g, ' ');
const publicCodes = `expired cooldown upstream requestBudget empty hidden truncated unsupported
invalidRequest toolDefinition toolChoice toolUnknown toolJSON toolSchema toolChoiceViolation
 toolParallel toolIncomplete toolRequired toolDelimiter toolLimit binding temporary harvest protocol
 verification capacity browserDependency browserProfile browserConfiguration browserClosed backendDown
 signinTimeout missingComponent pickerMissing pickerAmbiguous modelUnsupported modelNotOffered attachmentUnsupported
 contextLength imageRejected imageOutput`.split(/\s+/);

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
  assert.match(prose, /Plugin version: `0\.5\.6`\. Historical host verification used: magpie `0\.1\.3930`/);
});

test('README separates supported plan fields from unknown account allowance and live evidence', () => {
  const section = readme.split('## Account quota and token accounting\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'account quota section exists');
  assert.match(section, /`auth\.usage`.*Usage > Overview > Quota/);
  assert.match(section, /`account\.planType`.*when the response contains a recognized code/);
  assert.match(section, /`account\.isDelinquent === true`/);
  assert.match(section, /Remaining allowance and reset times.*\*\*Unknown\*\*.*with a reason/);
  assert.match(section, /omits `used` at the JavaScript hook boundary rather than reporting a fabricated 0% used or 100% remaining/);
  assert.match(section, /Installed \*\*0\.5\.4\*\* was live-verified/);
  assert.match(section, /`kind: "subscription"`, plan `ChatGPT Pro \(prolite\)` and an Unknown text window/);
  assert.match(section, /diagnosis-054-quota-live\.json/);
  assert.match(section, /does not verify every plan tier or the payment-attention outcome/);
  assert.match(section, /valid session can lack `account` or a recognized plan code/);
  assert.match(section, /Session expiry is not a quota reset or subscription renewal date/);
  assert.match(section, /Historical budget scenarios are separate from measured allowance/);
  assert.match(section, /local token totals and Codex `\/wham\/usage` counters do not measure ChatGPT Chat allowance/);
  assert.match(section, /not verified current caps/);
  assert.match(section, /excludes earlier and outside activity/);
  assert.match(section, /Neither the live quota result nor these tests establishes a measured remaining allowance/);
  assert.doesNotMatch(prose, /no dedicated[^.]*quota-display workflow/i);
});

test('README explains Go numeric placeholders and the authoritative text-only flag', () => {
  const section = readme.split('## Account quota and token accounting\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'account quota section exists');
  assert.match(section, /`used: 0`, `remaining: 100` and `text: true`/);
  assert.match(section, /Go-normalized placeholders, not measured usage or remaining allowance/);
  assert.match(section, /JSON consumers must honor `text: true`/);
  assert.match(section, /Unknown without a percentage meter in both Used and Left modes/);
  assert.match(section, /Go routing excludes text-only windows from measured allowance/);
  assert.match(section, /not a new live UI session/);
});

test('README keeps quota reads non-interactive and separate from request token accounting', () => {
  const section = readme.split('## Account quota and token accounting\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'account quota section exists');
  assert.match(section, /non-interactive `GET \/api\/auth\/session`.*10-second budget and cancellation/);
  assert.match(section, /does not submit a model request or open a browser/);
  assert.match(section, /session credentials and raw upstream errors are not returned/);
  assert.match(section, /Request token accounting remains separate/);
  assert.match(section, /per-turn input\/output records in `magpie usage --csv`/);
  assert.match(section, /Text-route counts remain the local estimates/);
  assert.match(section, /quota card emits no additional `input\.magpie\.usage` event/);
});

test('CHANGELOG 0.5.4 records quota support without claiming measured remaining allowance', async () => {
  const changelog = (await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const section = changelog.split('## 0.5.4 — 2026-11-13\n')[1]?.split('\n## ')[0];
  assert.ok(section, '0.5.4 release section exists');
  assert.match(section, /auth\.usage/);
  assert.match(section, /recognized plan labels and payment-attention status/);
  assert.match(section, /remaining allowance and reset times are not fabricated or inferred/);
  assert.match(section, /Installed 0\.5\.4 live quota returned a subscription with plan `ChatGPT Pro \(prolite\)`/);
  assert.match(section, /other plan tiers and the payment-attention outcome were not live-verified/);
  assert.match(section, /`used: 0` and `remaining: 100` are numeric placeholders when `text: true`/);
  assert.match(section, /not a new live UI session/);
  assert.match(section, /Quota refresh emits no additional `input\.magpie\.usage` event/);
});

test('README records the exact verified host identity with its evidence citation', () => {
  const section = readme.split('### Running host identity and bundle SHA-256\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'host identity section exists');
  for (const value of [
    'magpie `0.1.3930`', '`host-e6801c6cb0f6.js`', '166 257 bytes',
    '`e6801c6cb0f61553ca747c2b02209bfe87720183b37bb8840d08bcfb5352c5f3`',
    'Codex CLI `0.167.2`',
  ]) assert.ok(section.includes(value), `host identity needs ${value}`);
});

test('README distinguishes live sign-in verification from unmeasured turns', () => {
  const opening = readme.split('\n')[2];
  assert.match(opening, /Sign-in lifecycle is live-verified/);
  assert.match(opening, /two consecutive live turns completed/);
  assert.match(opening, /Site verification can still occur/);
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

test('README documents background-by-default turns and explicit visible override', () => {
  assert.match(prose, /Sign-in always opens (?:a )?visible Chrome/);
  assert.match(prose, /background by default/);
  assert.match(prose, /explicitly enable/);
  assert.match(prose, /Show browser during chats.*visible-turns/);
  assert.match(prose, /same persistent account profile/);
  assert.match(prose, /verification automatically reveals the same window, page and browser context/);
  assert.match(prose, /deadline expires first.*page stays visible.*conversation binding intact/);
});

test('README discloses privacy boundaries and emulated capabilities', () => {
  assert.match(prose, /never deletes remote conversations/);
  assert.match(prose, /Neither operation erases the plugin-owned Chrome profile/);
  assert.match(prose, /Anthropic-wire emulation/);
  assert.match(prose, /toolcall: false/);
  assert.match(prose, /prompt-level client tool emulation/i);
  assert.match(prose, /outer Agent then executes it/i);
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
