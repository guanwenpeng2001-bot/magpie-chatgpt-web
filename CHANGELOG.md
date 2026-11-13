# Changelog

## 0.5.6 — 2026-11-13

- Read Magpie's transparent `magpie1:` compaction envelope after canonical request restoration, so completed-work summaries reach Native models and survive daemon restart. Require canonical base64 and valid UTF-8; keep exact checkpoint scope/summary authentication and existing `ocx1:` support.
- Ignore JSON object key order in process-local Native execution, round and instruction identities. Automatic compaction can now match a pending source tool when Magpie re-encodes identical content in a different field order. Preserve string/array ordering, exact capabilities, ownership checks and the existing encrypted checkpoint format.
- Add durable account-scoped physical-Send accounting for Native and text Chat: rolling 24-hour/7-day counts, model/effort breakdowns, deduplication, multipart/compaction attribution, recording start and observation gaps. Show recorded counts only, without estimated remaining allowance, historical budgets or forecasts. Unreported account allowance is labeled 未提供. Refreshing the card does not add usage or change routing availability.
- Classify visible terminal service alerts before initial assistant selection or after an established assistant binding disappears, only when the original submitted user message is proven and no competing turn exists. Support virtualized multipart history using local formatter provenance; preserve ordinary rebinding, bounded observation recovery and error identities. Alerts behind surviving stale bindings remain outside this fallback.
- Port four applicable fixes from the newer reference source into the checksum-pinned runtime: atomically replace restored drafts for plain/staged prompts, ignore Mermaid preview-only remounts without losing source code, recognize strict UUID subagent inventories in calendar updates, and activate capability menus through the existing click/pointer fallback. Preserve connector-pill insertion and continuation authorization.
- Capture bounded Native broker registration/claim fingerprints and completion counters for diagnosing failed tool calls. Exclude raw credentials, prompts and arguments; bound stream drain and optional writes during shutdown, and isolate files by daemon generation so delayed writes cannot replace the new run's evidence.
- Record near-threshold Pro compaction and restart evidence, including the GPT-5.6 failed automatic compaction followed by successful explicit retry. Record the failed Bigger Sol stress and no-tool control separately; these results do not establish full-window retention or 1M support. Model windows and the guarded Pro limit remain conservative.

## 0.5.5 — 2026-11-13

- Shorten quota-card status to Chinese, including `剩余额度` and `未知：接口未返回额度`. Keep distinct failure reasons, text-only rendering, account state and token accounting behavior.
- Document the installed per-model windows, Codex's separate 95% effective display and 90% compaction trigger, variable summary length, and checkpoint restart behavior. Do not advertise universal 1M Web support or successful full-window retention.
- Clarify that reference v6.1.18 Limits uses local send receipts and static policies, not a verified upstream remaining/reset interface.

## 0.5.4 — 2026-11-13

### Native routing and responses

- Publish explicit GPT-5.6 Pro and GPT-6 Pro Native selectors for Pro accounts even when Bigger Context is off. Default Plus/Pro catalogues contain 36/38 entries; Bigger Context contains 38/40. Core aliases retain their conservative limits.
- Stop advertising the experimental triple Pro window after live ~276K trials recovered only 4/12 distributed markers. Keep the ordinary Pro catalogue budget and reject compiled Pro input at or above 112,193 tokens before browser work, including clients with stale model catalogues. No input is silently dropped.
- Preserve Pro's fixed maximum effort during text fallback and honor `parallel_tool_calls: false`. Auxiliary requests without any provenance markers use strict text conversion; partial, invalid and cross-account proofs still fail closed, including when Native mode is disabled.
- Repair multiline Markdown table cells in the checksum-pinned reference converter without changing code blocks. Recognize visible terminal service alerts in the bound response, including observed Chinese errors, without treating user text or generated Markdown as site failures.

Live checks: both Pro models read files, reproduced two test failures, edited the implementation and passed all three tests. After installing 0.5.4, a short session compacted, survived a daemon restart and read files/passed tests again; only one tunnel alias remained. Large-context trials transmitted all six parts and used real tools, but failed 12-marker retention (4/12 recovered); no-tools and all-Pro-staging controls also failed. The latter experiment was reverted. An earlier Codex-truncated trial is excluded from capacity evidence.

### Account quota

- Add Magpie's `auth.usage` hook so signed-in ChatGPT Web accounts can supply an allowance card instead of being omitted and falling back to the CLI's generic Balance URL placeholder.
- Read recognized plan labels and payment-attention status from `/api/auth/session` without model requests or browser fallback. Missing account fields, unsupported plans and read failures produce explicit unknown reasons; remaining allowance and reset times are not fabricated or inferred from plans, local token totals or Codex quotas. Installed 0.5.4 live quota returned a subscription with plan `ChatGPT Pro (prolite)` and an Unknown text window (`diagnosis-054-quota-live.json`); other plan tiers and the payment-attention outcome were not live-verified.
- Keep existing per-request input/output token accounting unchanged. Quota refresh emits no additional `input.magpie.usage` event. Add offline coverage for the installed host contract, unknown values, cancellation, account isolation and duplicate-event prevention.
- Clarify that Go-normalized JSON fields `used: 0` and `remaining: 100` are numeric placeholders when `text: true`, not a measured 100% remaining. Verify the installed UI renders the Unknown message without a percentage meter in Used/Left modes, and focused upstream Go tests exclude text-only windows from measured routing allowance. This rendering check uses an isolated fixture, not a new live UI session.

## 0.5.3 — 2026-11-13

- Generate Native turn capabilities from 160 CSPRNG bits using 32 lowercase Crockford characters. Live saved-chat inspection reproduced a model changing the final token character's case. Exact schema, broker lookup and revocation remain enforced; no guessed or case-normalized tool credential is accepted.

- Persist native continuation checkpoints across daemon restarts using atomic AES-256-GCM storage bound to each account directory, with a separate key and LRU eviction by both 256-entry and 32 MiB serialized plaintext budgets. Restore source-hash Sets and preserve task provenance, scope, summary and metadata checks. Compaction completion requires a successful durable commit; storage failures do not authorize the unsaved summary.
- Reject damaged or replaced snapshots, missing committed state, invalid task-message schemas and unsafe checkpoint files. Checkpoints already lost by older versions cannot be recovered retroactively; recover trusted complete history or start a new turn with the original task.
- Expose `native-bigger-context` (default false): the usual 18-text-model catalogue still has 36 entries by default; enabling Bigger Context adds two dedicated entries for Plus or four for Pro. Original aliases retain conservative Instant-safe windows.
- Expose `native-temporary-chats` (default true); disabling it saves ordinary native chats. Restart Magpie after changing either native option for the new settings to take effect. Ordinary text Chat still requires Temporary Chat.
- Keep the reference differences explicit: no Zero Risk manual-send mode or Compatibility V1 selector, and pinned native installation remains Windows x64 only.

Live verification: Native read/edit/test passed; the same session compacted twice, survived daemon/plugin restarts, and read files and passed tests in both ordinary and temporary chat modes with Bigger Context enabled. The local Pro catalogue reports 40 entries and 240K Sol / approximately 316.7K Pro windows. Full-window saturation was not tested. Regression: 1,073 passed out of 1,078, five gated/platform skips; separate pinned-runtime, real Chrome launch and package checks passed.

## 0.5.2 — 2026-11-13

- Serialize Unicode turn metadata as JSON-safe ASCII HTTP headers, preserving Chinese workspace paths and emoji for native turns and compaction.
- Refuse text fallback for native compaction and checkpoint history when the native runtime is unavailable, instead of reporting a successful but incompatible summary or dropping continuation state.
- Hold an operating-system account ownership lock while the native daemon runs, preventing a second process from removing a live owner's tunnel alias. Surface stale-alias cleanup failures before connecting a new alias.
- Propagate request cancellation through native runtime startup and prevent cancelled requests from falling through to text submission.
- Observe Platform login navigation and response waiting together, preventing an unhandled delayed rejection from terminating the backend after a failed login.
- Clarify reference feature coverage, mode-specific history and model contracts, and the downloaded runtime's third-party notices.

## 0.5.1 — 2026-11-13

- Stop and remove earlier tunnel aliases of the account's profile when the native daemon starts, and remove the current alias on shutdown, so restarts no longer accumulate local runtime metadata. The remote tunnel and aliases of other profiles or tunnels are kept.
- Make Codex compact native conversations at the reference's measured limits (Plus: 32K Instant, 80K Medium/High; Pro: 95K). Magpie offers no per-model threshold for plugins and Codex compacts at 90% of the published window, so each Native entry publishes the window whose 90% is that limit, never above the real window. Previously Pro compacted near 100K and Plus Medium/High near 81K only on Sol-only entries, while aliases used the Instant window.

## 0.5.0 — 2026-11-13

- Add opt-in/out `native-tools` setup (enabled by default), account-scoped Responses models, and the pinned v6.1.18 Full-mode daemon with tunnel-client v0.0.16 and cloudflared.
- Verify release and installed-file checksums; isolate browser state, runtime keys, named pipes, ports, and Codex/tunnel state per account. Supervise startup, shutdown and crash retries with bounded backoff.
- Restore the canonical local Codex request through Magpie protocol conversion, Lite lifting and masking, using bounded in-memory snapshots bound to account/route proof. Disclose original-history and local-path forwarding in the Native option.
- Keep 18 matching Native-namespace entries alongside 18 text entries. Label unsupported native routes as exact-model text fallback/unavailable instead of silently substituting Sol or Pro for Work/mini models; derive native limits and variants from account capabilities.
- Run compaction and subsequent tool turns in the same Full daemon, retaining native continuation checkpoints and v1/memento/v2 envelopes. A checksum-pinned compatibility preload selects the existing read-only compaction path without modifying downloaded runtime bytes.
- Serialize inferred reasoning efforts and gracefully drain/cancel/shut down the Windows daemon before tunnel teardown.
- Add installer, daemon, provisioning, catalog, provenance and routing tests, including installed-Magpie and pinned-runtime checks.
- Return native custom, namespaced and tool-search calls as the flat functions Magpie offered when it translated the request, so Codex executes them. Verified live: native read, apply_patch, test run, two compactions and post-compaction tool turns.
- Recheck a challenge card painted between the DOM probe and a queued HTTP 403 before expiring the account; cover this timing race in the fallback observer tests.

## 0.4.8 — 2026-11-13

- Repair an unfinished text-form tool call wherever it appears: prose before the action marker is kept, only the unfinished envelope is replaced by the bounded JSON-only correction, and the corrected call is validated against its schema. Previously only a reply consisting of the bare marker was repaired, so live `gpt-6` `max` turns failed with `toolIncomplete`.
- Reconcile SSE and rendered DOM text into one canonical reply, keep non-prefix revisions instead of silently dropping them, and stop accepting DOM completion while a healthy SSE stream is still open.
- Validate and repair tool calls before emitting the final `finish` frame.
- Report model output-format failures (`toolIncomplete`, `toolJSON`, …) with their explicit code as Magpie's "tool call, written as text, was cut short" contract (502, `x-magpie-sign-in: kept`), so the gateway retries without resting the account.
- Bind conversations to the stable account/profile identity, so a rotated session cookie no longer breaks an open conversation with `binding` 409.
- Await the first backend frame before answering a streamed request, so an immediate logout returns the sign-in-expired status instead of `200` + `kept`; streamed expiry is typed `authentication_error`.
- Keep `$defs`/`definitions` whenever a compacted tool schema still contains `$ref`.
- Honor `stop_sequences` and `max_tokens` with matching stop reasons.
- Upload only the new suffix's images when continuing an existing conversation.

## 0.4.7 — 2026-11-13

- Present the account catalogue through Magpie's native model-variant contract: two Chat base families with five verified efforts and eight Work base families with six verified efforts, instead of duplicate effort model cards.
- Advance the site-adapter diagnostic version to `2026-11-13.1` with the Chat and Work picker changes.
- Map `x-magpie-effort` to the exact ChatGPT Chat and Work picker positions, including High, Extra High, Max and Ultra, and verify the selected family before sending.
- Reopen and verify the Work picker after selecting a family so the six-position slider is applied in the real page lifecycle.
- Bind conversation reuse to the selected effort as well as the base model, preventing a page selected for one effort from being silently reused for another.
- Make context preflight use the selected effort, so Instant requests are checked against the 41K browser boundary instead of inheriting the larger base-family value.
- Respect the host's `tool_choice` and keep tool schemas available on automatic turns. The plugin no longer guesses whether arbitrary prose needs a tool from a keyword whitelist.
- Track explicitly named tool requests across tool-result rounds and force the next unfinished action, so multi-command and patch-then-read tasks cannot stop early with an invented completion.
- Leave semantic tool selection to the Web model for indirect, mixed-language and otherwise unclassified requests, and pause an explicit action queue when any parallel tool result fails.
- When ChatGPT Web stops immediately after an opening action marker, issue a bounded JSON-only correction in the same temporary Chat before returning a tool call; a second correction attempt covers an empty first repair.
- Accept the site's double JSON-encoded SSE delta payloads and use a complete SSE envelope only when it exactly extends a truncated rendered DOM prefix.
- Preserve every tool name, required property and final result-validation schema when a large Agent catalogue is compacted; if the compacted catalogue still exceeds the browser boundary, return `contextLength` before dispatch instead of silently hiding tools.
- Keep full model, history and tool context dynamic; no fixed message-count trimming or silent history slicing is introduced.

## 0.4.6 — 2026-11-13

- Recognize explicit project inspection, checking, editing, testing and execution requests as Agent actions, so prompts such as “看一下这个项目” call the client tools instead of returning a text-only clarification.
- Keep ordinary conceptual questions such as “What does run mean?” text-eligible and preserve the exact-named tool and host `tool_choice` rules.

## 0.4.5 — 2026-11-13

- Return ownership of the Codex Desktop route, `model_provider`, `model_catalog_json`, context override lookup and reconnect state to Magpie. The plugin no longer edits or repairs Magpie's main `config.toml`.
- Keep `codex-profile` as an explicit CLI-only helper that writes `chatgpt-web-http.config.toml`, resolves catalogue metadata for that isolated profile, and leaves the Magpie Desktop configuration read-only.
- Prevent the configuration ownership conflict introduced by 0.4.4 with Magpie 0.1.3930.

## 0.4.4 — 2026-11-13

- Add checked CLI profile and journalled Codex Desktop routes for Chatgpt Web models. Both are model-agnostic, preserve Magpie's existing auth and headers, disable Responses WebSockets, follow Magpie's current gateway address, and fail closed on unowned or conflicting settings.
- Resolve the Codex model catalogue to an absolute path so Codex can load the ChatGPT Web context and tool metadata instead of silently using fallback metadata. Desktop activation and mutation repair preserve rollback and refuse later catalogue edits.
- Keep tool rounds in the same ChatGPT task conversation and translate browser output incrementally into Codex SSE. Codex environment metadata no longer forces unrelated text-only turns to call a tool, and a complete tool action remains usable when ChatGPT omits the redundant closing marker.
- Accept current Codex catalogues with more than 300 tools. For an oversized catalogue, select direct Agent controls plus tools relevant to the current turn and dynamically compact verbose schemas while retaining the complete definitions for local validation.
- Continue past hidden intermediate reasoning units and wait for a visible answer or tool action, so Pro models no longer fail merely because they emit hidden reasoning first. Background turns also wait for the hydrated model picker before selecting a model.
- Match the current ordinary model picker and select effort by slider position so localized labels do not cause a valid family selection to fail.
- Promote GPT-6 Thinking mini to a request-only exact-model route after a live completion check. Keep GPT-6 mini and Research explicitly unsupported after exact overrides returned no usable rendered answer.
- Recognize the current text-row shape of the Create image tool and honor its disabled state.
- Run ordinary chats in headed Chrome positioned off-screen by default while keeping sign-in visibly interactive. Window position changes reuse the same context and normal browser fingerprint instead of closing and relaunching a profile.
- Reveal the same background window when ChatGPT requests human verification, wait for the check to clear, resume observation without resubmitting the prompt, and return the window off-screen. If the turn deadline expires first, preserve the visible page and conversation binding for retry.
- Preserve the credential watermark across window-position changes so server-rotated session cookies survive mode changes and only a genuinely new host credential replaces them.
- Keep normalized tool IDs and structured tool results stable across rounds so the next request can reuse the same browser page; changed history, tools, tool choice or image bytes force a safe rebuild.
- Protect pending verification turns with a complete request fingerprint and avoid retaining keyless pages that cannot be resumed.
- Reject conservatively estimated over-context prompts before browser submission with a typed `contextLength` error, and populate Magpie's existing proxied-request usage accounting with local input/output/cache estimates in the Anthropic stream without a duplicate out-of-band usage event.

## 0.4.3 — 2026-11-12

- Stream translated frames as the browser turn produces them. The previous loader buffered every backend frame before returning an SSE response, which left Codex with only gateway keepalives and caused 300-second cancellations before the first model or tool event.

## 0.4.2 — 2026-11-12

- Hand the completed sign-in Chrome context directly to the chat driver instead of closing it and starting a second process. The next visible turn reuses the same browser instance and account profile.

## 0.4.1 — 2026-11-12

- Ignore Magpie's injected `HTTPS_PROXY` and `MAGPIE_HTTPS_PROXY` values when launching the ordinary ChatGPT Web Chrome profile. Those values made Chrome use an explicit `--proxy-server` path that differed from the user's normal system-proxy session and produced a fresh verification challenge.
- Provide the plugin-specific `MAGPIE_CHATGPT_WEB_PROXY` override for users who intentionally need a forced browser proxy; an empty value requests a direct connection.

## 0.4.0 — 2026-11-12

- Map all eight ordinary GPT-5.6/GPT-6 default, Instant, Thinking and Pro IDs to explicit family and effort selections. Base/Thinking use Medium; no previous Pro/Instant choice is inherited.
- Adapt all eight Work models through the separate saved-task surface, including cancellation and explicit non-Temporary-Chat behavior.
- Adapt four verified request-only catalogue IDs: GPT-5.6 Luna mini, GPT-5.6 Luna Thinking mini, and both experimental multisys IDs. Replace only the conversation request's model field and keep the selected family as the visible UI bridge.
- Add a catalogue-conditional ChatGPT Images entry that uses the ordinary Create image workflow and saves generated image blobs as local files.
- Accept Claude-shaped requests with trailing system messages, up to 256 tools, `$schema`/`format` annotations, and bounded ECMA-262 `pattern` validation. Record only structural preflight diagnostics without prompts or tool payloads.
- Pass the host environment into the backend while leaving ordinary Chrome on its system proxy by default.
- Keep the account's Chrome context resident for the backend lifetime so sequential turns do not reset state or trigger a fresh site check after five idle minutes.
- Keep GPT-6 mini, GPT-6 Thinking mini and research explicitly unsupported because this account's current web submission returned empty/hidden results or no research canvas.

Live checks: GPT-5.6/GPT-6 Pro chat, all eight Work picker selections, GPT-6 Luna Work completion, four request-only catalogue IDs, image generation/file output, and a 36-tool request through the real Magpie gateway.

## 0.3.1 — 2026-11-12

- Default chats to ordinary visible Chrome using the plugin-owned account profile. Reuse visible contexts for background reads.
- Wait for the visible composer and enabled model picker before sending; allow initial site checks to finish within the existing turn budget.
- Restore session cookies on the correct domain and preserve server rotations across operations, preventing duplicate tokens and stale-cookie rewrites.
- Support the current inline picker and verify the GPT-5.6 Pro family and Pro setting before sending.
- Read visible turns from the rendered answer, avoiding premature failures on hidden intermediate stream messages.

Site verification can still occur. Chrome must be installed; no browser download or Electron bundle is included.

## 0.3.0 — 2026-11-12

- Add Bearer authorization to model catalogue requests to prevent valid sessions being marked expired immediately after sign-in.
- Include the macOS sign-in lock fix contributed by oldwinter in PR #1.
