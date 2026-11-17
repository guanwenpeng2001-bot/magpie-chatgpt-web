# 0.5.8 verification

The final runtime code was tested at commit
`0647762608aa7a458e8096aa66468b0ed5826dbd` (0.5.8-rc.8). Formal 0.5.8
promotion changes version metadata and verification documentation. The final
release, tag and local installation identify the same release tree.

## Required behavior

1. Advertise the target Web Pro model's official 400,000-token total window and
   fit complete requests within separate input, output and physical-message
   budgets. Do not advertise native 1M capacity.
2. Expose the same automatic model ID on eligible accounts so Magpie can switch
   after a quota refusal. Preserve the canonical task and do not replay output or
   executed commands. Compacted continuation must also survive the switch.
3. Keep the signed-in persistent browser bound to the saved account and stable
   native route. Normal restarts must reuse that binding. Upstream session
   revocation or a new interactive challenge is not a plugin-controlled event.
4. Run ordinary commands, compact automatically and continue the task. Retain at
   least 1M tokens of observed historical text for scoped retrieval after
   compaction and process restart.

## Evidence currently recorded

- [Live automatic compaction and continuation](evidence/live-continuity-0.5.8.json)
  passed in the original test chat after repairing the failure: nine sequential
  sample reads, three passing command tests, and 12/12 original associations in
  both the saved 3,997-character summary and the final answer. The test used a
  70K compaction trigger; the production target is 230.4K. The model also reported
  successful history retrieval; an independent withheld-record check after the
  formal-version restart is recorded separately.
- The final full suite ran **1,872 tests: 1,843 passed, 29 skipped, zero failures**.
  The skips are optional/platform integration checks. Focused real backend and
  pinned compaction tests passed after the live-discovered fixes. Package checks
  and credential scans passed; installed-host tests used Magpie 0.1.4400.

- The installed recovery candidate reused the user's completed browser login
  through the normal Magpie sign-in callback, preserving the existing route and
  persisting its browser-profile alias. A live check identified normal NextAuth
  rotation on every session read; the corrected identity check accepted the
  verified same account without overwriting cookies.
- A real Codex run using `chatgpt-web/native/auto/gpt-6-pro` executed
  `node --test verification.test.mjs`, passed three tests and completed its answer.
  Both saved accounts completed Native setup through the normal plugin flow.
- An actual isolated Magpie gateway test verified A-to-B quota failover with and
  without Retry-After, exact canonical payload preservation and no replay after
  output. An original pinned broker/adapter/Responses fixture proved a local
  tool is delivered before client execution; quota before delivery executes zero
  client commands. These do not consume real account quota.

- Browser reauthentication reuses a saved profile; adding the same account binds
  the newly authenticated browser without replacing the native route. Identity,
  binding-change and cancellation regressions cover rejected account replacement
  and late page cleanup. Browser identities are verified against the actual
  session and cached briefly only while its cookie fingerprint is unchanged.
- The earlier broad run passed 1,750 tests and skipped 30; one Windows temporary
  directory cleanup failed with `EBUSY`. Its isolated rerun passed, including both
  actual Magpie Responses paths. Later changes require their own final regression.
- [1M archive probe](evidence/native-history-capacity-0.5.8.json): 1,001,368 original
  tokenizer-measured tokens. Two independent processes each read all 513 pages,
  found 49 synthetic markers and verified thread isolation. This is offline
  pinned-runtime evidence, not a live million-token model request.
- [Live window probes](evidence/web-window-live-0.5.8.json): 128K and 256K samples
  each returned 12/12 random associations. Transport evidence remains incomplete.
  A subsequent production-default 380K run completed but recalled only 8/12
  associations, losing the four in its first two parts. The production-default
  256K control recalled all twelve. The release therefore retains 400K total
  metadata but allocates less than 256K compiled input, a joint 128K
  reasoning/output reserve and 16K additional headroom. The allocation is local;
  it is not an official maximum-input or maximum-generation claim. Pro's
  automatic-compaction target is 230.4K; Codex's effective input is about 243.2K.
- The integrated broad regression passed 1,818 tests with 29 skips before a
  cancelled-lookup regression was fixed (its three tests subsequently passed).
  The revised input allocation passed 323 focused tests without skips; account
  failover, tool-emission, model controls, policy and package checks passed 45
  additional focused tests without skips. Final installed checks follow below.

## Limits and post-install checks

1M is an encrypted searchable archive, not a native million-token context.
Only authenticated Native request text is recorded; unverified host-generated
summary requests and text truncated before reaching the plugin are excluded.
The 256K recall result is a finite sample, while the 380K input sample failed.
Formal-version checkpoint/history reopening is checked after installation.
A physical Windows reboot has not been performed. Magpie login autostart is on;
normal restart persistence cannot prevent upstream session revocation or a new
browser challenge. Those events remain visible rather than being treated as
proof that the account was lost.

Official product source: [ChatGPT pricing](https://chatgpt.com/pricing/) lists a
400K Pro reasoning total window. Input shares that total with other context and
generation overhead. [Cloudflare clearance](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/)
is visitor/device specific and can be invalidated; changing browser profiles is
not equivalent to continuing the same verified session.
