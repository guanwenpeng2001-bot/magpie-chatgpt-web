# 0.5.8 candidate verification

This is a development verification record, not a release acceptance claim. The
installed recovery candidate is 0.5.8-rc.2 at commit
`5ee4710bc9c7e3e91c51594c6165a48fa5de506e`. The final release, tag and
installation must identify the same code.

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

## Still required before final acceptance

Installed ordinary Native command execution; actual logged-browser binding;
complete maximum-window transmission and recall; automatic compaction and
continuation; eligible-account quota failover including compacted history; and
plugin/runtime restart checks. A physical Windows reboot has not been performed
by this verification. Never replace these checks with a directory number change.

Official product source: [ChatGPT pricing](https://chatgpt.com/pricing/) lists a
400K Pro reasoning total window. Input shares that total with other context and
generation overhead. [Cloudflare clearance](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/)
is visitor/device specific and can be invalidated; changing browser profiles is
not equivalent to continuing the same verified session.
