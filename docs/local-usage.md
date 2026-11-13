# Local Send accounting and reference-budget estimates

The usage card shows Sends recorded by this plugin in rolling 24-hour and 7-day windows, grouped by selected model and effort. It also shows when recording started, which producers have started recording, and known observation gaps. These are recorded physical Sends, not token totals, native tool calls, response stream attachments, or automatically counted retry attempts. Every actually submitted multipart stage is a separate Send. A failed answer after an accepted Send does not erase that Send.

Actual account-wide Chat used/remaining allowance is still unknown. Local records exclude activity outside this profile's plugin instrumentation and before recording began. A seven-day-old recording start is not proof that there were no gaps. Missing/corrupt storage does not become zero usage. No previous account's records are used when the current identity is unavailable.

## Historical reference scenario

At the user's request, personal accounts with a recognized plan additionally show **参考预算 · 非官方实时**, using the pinned reference v6.1.18 `launcher/electron/limits-policy.json`, checked **2026-09-19**:

| Recognized plan code | Historical assumption | Rolling comparison | Reference budget |
| --- | --- | --- | --- |
| `prolite` | Pro 100 | Both Pro families, 7 days | 50 Sends |
| `pro` | Pro 200 | GPT-6 Pro, 7 days | 200 Sends |
| `pro` | Pro 200 | GPT-5.6 Sol Pro, 24 hours | 170 Sends |
| `pro` | Pro 200 | Both Pro families, 24 hours | 200 Sends |

The display subtracts recorded applicable Sends from that reference budget, clamping the difference at zero while retaining the real recorded count above the budget. Example: 14 recorded Pro Sends yield **余36/50 · 已记14次** under the Pro 100 scenario. It also displays **未扣此前/外部用量；非账号余额**. The result is a scenario under a historical rule, not a measured remaining allowance, a guaranteed upper bound on remaining official allowance, or a current official cap. Rolling comparisons do not establish official reset boundaries. Plan changes inside a window are not reconstructed.

Unidentified Pro-family Sends count once in the shared bucket and conservatively in each potentially applicable family bucket; that uncertainty is visible. Non-Pro effort and unsupported model families do not get invented caps. Unclassified Sends remain in local totals and are identified as a potential budgeting gap. Plans other than recognized personal `pro`/`prolite` get local counts only. No scenario claiming a full unused budget is shown before tracking begins.

Checked **2026-11-13**: current official documentation confirms the Pro bucket relationships, but the two pages reviewed do not supply these numeric caps. The [Chat model limits page](https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt) distinguishes Chat from Work/Codex; [About ChatGPT Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers) describes more recent plan changes. Therefore the September numbers are deliberately labeled historical assumptions, not reverified current caps. Provenance is in `src/usage/policy.mjs`.

All card rows are text-only (`aside: true`). The hook supplies no numeric `used`, `amount`, `limit`, `remaining`, `balance`, reset, or depletion fields, so Magpie cannot promote the scenario to a measured percentage or use it to route accounts. The ordinary unknown-account-allowance row is retained below the useful local statistics.

## Producer and reader contract

Import from `src/usage/store.mjs`. Node and Bun use the same async filesystem implementation, with no extra dependencies.

```js
// profile is the ABSOLUTE native account-home directory, not a profile ID and
// not the Chrome user-data directory. Native: CODEX_CHATGPT_WEB_HOME.
// Text/quota: usageProfile(command.auth.profile, optionalNativeRoot).
const scope = { profile, accountKey };
await beginTracking({ ...scope, source: 'native' });

// Acquire one stable ID and authenticated account identity before each physical
// Send. Reuse that ID when recovering observation of the SAME Send.
await recordSubmission({
  ...scope, id, at: Date.now(), model, effort,
  source: 'native',             // 'native' | 'text'
  stage: 'message',             // 'message' | 'compaction' | 'multipart'
});

// Only with a verified account scope. Same ID can later be confirmed, resolving
// the gap in projections without double-counting either observation.
await recordTrackingGap({ ...scope, id, at: Date.now(), source: 'text' });

const local = await readUsage(scope, { signal });
```

`recordSubmission`, `recordTrackingGap`, and `beginTracking` return `Promise<boolean>`: true for a newly published record, false for an existing record; receipts outside the retained seven-day window also return false. Invalid input or failed persistence rejects with an error. Producers must isolate accounting failures from model execution, drain bounded optional writes, and never retry a model Send because accounting failed. If a write itself is unavailable, a gap may also be impossible to persist; the UI says **已记录**, not a promise of complete plugin usage.

`accountKeyFromSession(session)` computes SHA-256 of `session.user.id + NUL + session.account.id`, matching the reference's `readChatGptUsageAccount`. Missing/bad identity returns undefined. `usageProfile(profileId, root?)` resolves `<nativeRoot>/accounts/<profileId>`; the default root is `~/.config/magpie/chatgpt-web-native`. Native code that already has the exact account home must pass that directly. Raw identities, credentials, prompt text and original receipt IDs are never stored or returned in the quota projection.

Parent integration points (outside this feature's file ownership):

1. Native: prepare the receipt at the existing pinned `usageSubmission` closure, using its stable physical-Send UUID and authenticated account hash. Confirm only on the proven `onSubmitted` callback, including each real multipart Send. Pass selected family/effort, not the requested alias or token usage.
2. Text: use a stable physical-Send ID across challenge/observation recovery; conservative confirmation can require the first nonempty generated output or completed nonempty response. An accepted-but-unconfirmed outcome is a gap. A new actual Send gets a new ID. Work/image routes are excluded from Chat estimates.
3. Backend quota dispatch: `readQuota(client, signal, { profile: usageProfile(command.auth.profile) })`. The reader derives the current account hash from the same noninteractive session read, adds sanitized `local` statistics and `accountScope`, and leaves actual allowance state `unknown`.

## Persistence and validation

Records live under `<accountHome>/usage-v1/<accountHash>/`. Receipt filenames use SHA-256 of the physical-Send ID. A fully written and synced temporary file is published using an exclusive atomic hard link; competing processes cannot overwrite receipts or lose unrelated Sends. Duplicate IDs preserve the first accepted timestamp. Conflicting model/source/stage metadata rejects rather than silently changing history. Coverage markers are separate per producer; out-of-order callbacks are counted at their original Send times.

Only the last seven days affect projections. Capacity checking, expiry pruning and publication share one kernel-owned admission lock per canonical account-store path. Windows uses a named pipe and Linux an abstract socket; other platforms use a bounded loopback-port mapping. Process death releases the lock automatically, with no persistent lock file or stale-owner deletion. Contention is bounded to five seconds and fails optional accounting as busy, never retries a model Send. Duplicate receipts are checked before capacity, so replay at the limit still succeeds as a no-op. At the 20,000-entry bound, expired immutable records can be pruned; recent history is not silently evicted. Oversized/corrupt records and clock rollback fail closed. Reads support cancellation and do not create coverage or Send receipts. Store identity additionally includes the account-home location, so separate plugin profiles are not silently combined, even if signed in to the same upstream account.

Tests cover durable reopening, concurrent independent writers, two processes racing for the last of 20,000 slots, a writer killed after durable staging, replay deduplication at capacity, resolved gaps, account/profile isolation, window boundaries, clock errors, corruption, model/effort/stage attribution, historical-budget assumptions, uncertain Pro families, unknown plans, over-budget clamping, secret exclusion, backend-to-card projection, and both Used/Left modes of the installed host's actual renderer. No live model prompts are needed for these checks.
