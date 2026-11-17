# 0.5.8 candidate verification

This is a development verification record, not a release acceptance claim. The
installed baseline is 0.5.7 until an exact candidate/release commit is installed
and checked. The final release, tag and installation must identify the same code.

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
  The latest 380K probe stopped before the fifth send because Pro was unavailable
  in the model controls; it did not complete the six-part request. These results
  do not establish production 400K acceptance.

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
