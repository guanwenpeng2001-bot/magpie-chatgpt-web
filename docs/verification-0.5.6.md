# Context and continuation follow-up — 2026-11-13

Environment: Windows, Magpie 0.1.3930, Codex CLI 0.167.2, pinned reference v6.1.18. The initial live trials below ran the published 0.5.5 plugin (`c0befa55b280c468e2bd7a7df30f3abedf3a968b`). They use isolated Codex app-server processes and scratch projects, not a replacement of the user's desktop app-server. The user explicitly accepted CLI validation.

## Pro context, real editing and restart continuation

Each Pro model received 87 small additional-context fragments containing twelve random hexadecimal values distributed across four groups and three positions. The fixture and answer files were outside the model's permitted test working directory. Expected values were never added to the continuation prompt. The GPT-6 rollout was checked against all 87 original fragments, with no truncated fragment. Per-request input below is the adapter's local estimate, not an upstream token count or a sum across requests.

| Model and phase | Result | Maximum reported input |
| --- | --- | ---: |
| GPT-6 Pro, initial turn | 12/12 recall; real read, failing test, `apply_patch`, passing test; automatic compaction completed | 92,211 |
| GPT-6 Pro, same session after daemon restart | 12/12 recall; real read and 3/3 passing tests; no further edit | 20,295 |
| GPT-5.6 Pro, initial turn | Real read and failing test; tool search; automatic compaction failed with a response-DOM error, test stopped | 91,658 |
| GPT-5.6 Pro, explicit compaction retry | Compaction completed and checkpoint persisted | Not a new full-window recall test |
| GPT-5.6 Pro, same session after daemon restart | 12/12 recall; resumed unfinished edit and passed 3/3 tests | See local event evidence |

Both projects began with one passing and two failing tests because quantities were ignored in invoice totals. Only the implementation was edited. The test file SHA-256 before and after both workflows was `691f374b72c351cdd9e2a57b53826335b3664d831cab0181fd92b4574d4d91dc`.

The GPT-6 checkpoint file grew from 3,471 to 4,484 bytes; the successful GPT-5.6 retry grew it to 5,136 bytes. Both restarts changed the daemon port and retained the same Codex thread. After the first restart, the tunnel inventory contained one account-owned alias, matching the current daemon. File size alone is not proof of checkpoint correctness; resumed real tool calls and exact recall are the relevant verification.

This is a successful near-compaction-range continuation check for GPT-6 and a successful recovery after a failed automatic compaction for GPT-5.6. It is **not** an uninterrupted GPT-5.6 pass, a test of every token below the hard boundary, or proof of 1M support. The earlier ~276K Pro trials still recovered only 4/12 values; their failed retention result has not been superseded.

Local evidence: `native-live/near-window/{first,resume,first56,retry-compact56,resume56}.json.events.json`, `verified-6-pro.json`, `verified-56-pro-resume.json`, fixture hashes and Codex rollouts. Raw account profiles, credentials and prompt captures are not included in the package.

## Bigger Sol stress and control

The GPT-6 Sol fixture contained 214 fragments and twelve random markers. Its offline compiled estimate was 220,458 tokens; no final live usage event was returned, so this is not a measured upstream input count. Passive network inspection matched all 214 fragments and all twelve markers across six submitted requests in one conversation. Later request parent IDs appeared among the preceding response's assistant nodes, which supports continuity but does not prove complete server ancestry.

The final webpage displayed `消息流中的错误` with Retry. No local tools or final answer surfaced before the bounded 600-second test interrupted the turn. Reading the existing terminal detector against that exact grouped root correctly produced `upstream_server_error`; the normal waiting path did not surface it. This isolates a classification/control-flow gap, not the cause of the service error.

A separate no-tool control used the same fragments and requested only the twelve values. It reached a visible `出了点问题。请重试` alert on the first stage and was interrupted at its 360-second budget. It did not finish staging, so it establishes neither full-context retention nor a tool-specific failure. A GPT-5.6 Sol fixture estimated at 289,210 tokens was prepared but has not been submitted. None of these Sol trials is a successful full-window result.

Local evidence: `native-live/sol-window/{first,no-tools}.json.events.json`, passive lineage projections, and the bounded terminal-alert shape snapshot. Raw request bodies and authentication are not part of published evidence.

## Submitted-error classification investigation

The first GPT-5.6 automatic compaction's diagnostic at 13:20:07 UTC contained two older completed assistant groups and a final group with a user bubble and a visible seven-character service alert, but no assistant body. The snapshot intentionally omitted alert text; length does not prove its wording. `surfaceBound: false` measures the launcher surface marker, not response identity, so it cannot establish a rekey or lost assistant binding.

Source investigation identified a separate concrete classification gap: when a grouped response identity is unavailable and only its user-plus-alert group remains, ordinary reconciliation searches assistant identities. The existing scoped terminal detector can then miss the service error and DOM health eventually reports disappearance. Any fallback must authenticate the original submitted user message and exclude previous or competing turns; a page-global error search would be unsafe. This finding does not explain or repair the upstream service failure itself.

The explicit retry was passively instrumented through CDP response streams. All six requests used one resolved conversation. Requests two through six named parent IDs present among the previous response's assistant nodes. The first five selected GPT-5.6 Instant staging and the final request selected GPT-5.6 Pro. This supports client continuity for that retry. Response messages did not expose complete parent edges, so it is not proof of the entire server ancestry graph or full server-side ingestion. It does not retrospectively prove lineage for the earlier 276K trials.

The standalone instrumentation exports only hashed IDs, allowlisted metadata and counts. Its fourteen offline tests cover chunked UTF-8, root and patched message shapes, missing/conflicting identities, bounded buffers and exclusion of arbitrary content and credentials. Instrumentation is not itself a retention test.

## Fix scope and remaining gaps

The submitted-alert fallback runs after an established assistant binding disappears. It requires a unique new grouped user, original prepared-token or complete-text proof, a visible scoped service alert, no competing turn, and an unchanged DOM observation through proof and detection. Local multipart formatter provenance permits older staged messages to be virtualized. Text that merely resembles a multipart envelope grants no authority. It never installs a replacement assistant binding, changes tool authorization, retries a submission or weakens the reference's existing identity gate.

Alerts before any assistant binding is established and still-present stale bindings/snapshots are not covered. Plain full-text proof without a prepared nonce requires baseline history to remain present. Copied recovery baselines do not inherit multipart provenance, and intervening DOM mutations cause abstention. These conservative limitations mean this patch does not claim to fix every live timeout above.

Four ports from reference commit `f08d16509e6a5447a0d0f2943abb172c69705160` address restored drafts, Mermaid preview remounts, strict UUID calendar inventories, and capability-menu activation. The original bundle bytes and hash remain pinned. Tests exercise the actual transformed bundle and isolated Chrome; synthetic fixtures do not establish live-account success.

Release regression: `node --test --test-concurrency=1` with `NATIVE_REFERENCE_FIXES_SMOKE=1`, `NATIVE_COMPACTION_SMOKE=1` and an explicit installed Chrome path completed 1,435 tests: 1,433 passed, zero failed, two skipped. The clean npm package gate passed, scanning 56 files for credentials and validating manifest, dependency and lockfile contracts. Independent code review approved the bounded fixes with the limitations above.

Candidate `297e16e` was installed locally as 0.5.6. Installed source hashes matched, and the running daemon's preload contained both fixes. The separate headed/headless Chrome launch gate passed. An attempted short GPT-6 Pro continuation of the previously compacted thread failed before tool execution with a visible service error, later reported as response-DOM disappearance. Diagnostic checkpoints include an initial hidden assistant subtree followed by a user-plus-alert group; they do not establish rekeying or prove that initial binding was absent. This is an unresolved live failure, and PR #18 remains a draft. The diagnostic driver stops after an observed provider error; Codex may already have retried internally before emitting that event.

A fresh GPT-5.6 Pro session on the same installed candidate successfully answered a short Chinese greeting, with 18,530 estimated input tokens and a 100,278 effective context window. This is a chat sanity check, not a tool, compaction or retention pass. A fresh GPT-6 Pro read/test request completed as a response but executed no local command: the model reported `turn token is invalid, expired, or revoked`. That report has not yet been corroborated with broker claim/registration fingerprints, and is not proof that the token expired, was mistranscribed, or reached the wrong broker. It is a failed tool-workflow check. Current daemon stdout/stderr are discarded, so retrospective broker fingerprint evidence is unavailable.

A subsequent code-only fix adds the same proven-user alert classification before initial assistant selection, with no synthetic binding or tool acknowledgement. Focused isolated tests passed 157/157. It addresses a separately reproduced initial-wait gap; the failed live continuation above reached `response-visible`, so that case is not established as fixed. The previously reported full regression count applies to candidate `297e16e`, before this additional change. The release remains draft pending renewed validation.

The additional initial-wait patch's independent review found a recovery regression: its new proof call was outside the original observation-timeout recovery catch. That review blocker must be fixed and revalidated before inclusion. Following the failed candidate live workflows, the local plugin was restored to the published 0.5.5 pin (`c0befa55b280c468e2bd7a7df30f3abedf3a968b`) after confirming the Native daemon was idle; the draft is not the installed stable release.

## Account quota still unavailable

A fresh local `magpie quota refresh chatgpt-web --json` on 2026-11-13 returned the recognized Pro (prolite) plan and a text-only unknown window. A read of the current model catalogue returned 23 models but no actual used, remaining, quota or reset fields. The current quota reader only recognizes session/plan information and does not implement a verified real-allowance endpoint. Displaying the card and shortening its wording did not complete real remaining-quota support. This release does not claim otherwise or substitute local request counts for account allowance.

The reference's Limits path records local Send receipts (`id`, `accountKey`, `model`, `at`) through its own `/v1/turn/usage` receiver. Its windows combine those receipts with static policies (`limit`, `used`, `uncertainUsed`); this is not an upstream ChatGPT allowance interface. A new-page passive inspection did not reach a ready composer or capture eligible backend responses, so it supplies no further quota conclusion. These observations establish the implementation gap and this account's observed responses, not that all upstream interfaces universally lack quota information.
