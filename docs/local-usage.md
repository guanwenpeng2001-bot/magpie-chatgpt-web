# Local Send accounting

The usage card shows Sends recorded by this plugin in rolling 24-hour and 7-day windows, grouped by selected model and effort. It also shows when recording started, which producers have started recording, and known observation gaps. These are recorded physical Sends, not token totals, native tool calls, response stream attachments, or automatically counted retry attempts. Every actually submitted multipart stage is a separate Send. A failed answer after an accepted Send does not erase that Send.

Actual account-wide Chat used/remaining allowance is still unknown. Local records exclude activity outside this profile's plugin instrumentation and before recording began. A seven-day-old recording start is not proof that there were no gaps. Missing/corrupt storage does not become zero usage. No previous account's records are used when the current identity is unavailable.

## Display contract

The card contains only recorded Sends, model/effort breakdowns, recording start, coverage and known gaps. It does not calculate or display historical budgets, estimated remaining allowance, percentages, depletion dates or forecasts. Unreported account allowance is labeled **账号额度 / 未提供**. Local records do not establish account-wide usage, and records are not backfilled from request-token totals or guessed activity.

All card rows are text-only (`aside: true`). The hook supplies no numeric `used`, `amount`, `limit`, `remaining`, `balance`, reset, or depletion fields, so Magpie cannot treat recorded Send counts as a percentage or use them to route accounts. Native/text version aliases normalize to the same model count; different effort levels remain separate. Unknown model identity is shown explicitly rather than assigned a model or budget.

## Checking a missing card

Use `magpie quota refresh chatgpt-web --json` to request this provider's card explicitly. In Magpie 0.1.3930, ordinary `magpie quota chatgpt-web --json` collects all providers before filtering the output. Its 15-second caller deadline can expire before the aggregate subscription refresh completes; the CLI then inserts a generic empty balance card saying no balance endpoint is configured. That message alone does not prove the ChatGPT Web hook is absent or failing. Do not invent a Balance URL or replace unavailable allowance with a percentage.

The targeted refresh is a supported host command, scoped to the requested card, with its own existing deadline and a persisted 30-second refresh floor. It does not send a model message. The running gateway's `/v1/magpie/quotas` also exposes the cards available to its process; its cache may differ from a newly started CLI process. When diagnosing, compare provider, window contents, errors and read timestamps, not only HTTP success.

Actual installed checks returned 15 text rows through the direct plugin hook (902 ms), running gateway (81 ms), and targeted refresh (8,136 ms). The first earlier global CLI read returned the misleading placeholder; a later read returned the full card without code/configuration changes. Pinned host-source analysis identifies a matching omission path, but the historical blocking provider and exact timing were not recorded. [Verification details](verification-0.5.6.md) distinguish deterministic host behavior from that historical inference.

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
2. Text: use a stable physical-Send ID across challenge/observation recovery; conservative confirmation can require the first nonempty generated output or completed nonempty response. An accepted-but-unconfirmed outcome is a gap. A new actual Send gets a new ID. Work/image routes are excluded from Chat Send counts.
3. Backend quota dispatch: `readQuota(client, signal, { profile: usageProfile(command.auth.profile) })`. The reader derives the current account hash from the same noninteractive session read, adds sanitized `local` statistics, and leaves actual allowance state `unknown`.

## Persistence and validation

Records live under `<accountHome>/usage-v1/<accountHash>/`. Receipt filenames use SHA-256 of the physical-Send ID. A fully written and synced temporary file is published using an exclusive atomic hard link; competing processes cannot overwrite receipts or lose unrelated Sends. Duplicate IDs preserve the first accepted timestamp. Conflicting model/source/stage metadata rejects rather than silently changing history. Coverage markers are separate per producer; out-of-order callbacks are counted at their original Send times.

Only the last seven days affect projections. Capacity checking, expiry pruning and publication share one kernel-owned admission lock per canonical account-store path. Windows uses a named pipe and Linux an abstract socket; other platforms use a bounded loopback-port mapping. Process death releases the lock automatically, with no persistent lock file or stale-owner deletion. Contention is bounded to five seconds and fails optional accounting as busy, never retries a model Send. Duplicate receipts are checked before capacity, so replay at the limit still succeeds as a no-op. At the 20,000-entry bound, expired immutable records can be pruned; recent history is not silently evicted. Oversized/corrupt records and clock rollback fail closed. Reads support cancellation and do not create coverage or Send receipts. Store identity additionally includes the account-home location, so separate plugin profiles are not silently combined, even if signed in to the same upstream account.

Tests cover durable reopening, concurrent independent writers, two processes racing for the last of 20,000 slots, a writer killed after durable staging, replay deduplication at capacity, resolved gaps, account/profile isolation, window boundaries, clock errors, corruption, model/effort/stage attribution, absence of budgets and forecasts for every plan, unknown model labels, secret exclusion, backend-to-card projection, and both Used/Left modes of the installed host's actual renderer. No live model prompts are needed for these checks.
