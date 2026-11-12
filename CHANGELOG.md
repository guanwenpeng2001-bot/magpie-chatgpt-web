# Changelog

## 0.5.0 — Unreleased

- Add opt-in/out `native-tools` setup (enabled by default), account-scoped Responses models, and the pinned v6.1.18 Full-mode daemon with tunnel-client v0.0.16 and cloudflared.
- Verify release and installed-file checksums; isolate browser state, runtime keys, named pipes, ports, and Codex/tunnel state per account. Supervise startup, shutdown and crash retries with bounded backoff.
- Restore native item metadata through Magpie request hooks and provider middleware, preserving top-level client metadata and checking account/route provenance.
- Keep the text engine available, translate fallback results to Responses, and route compaction to tool-free plain summaries. Never replay a submitted native tool turn through the fallback engine.
- Add offline installer, daemon, provisioning-interface, catalog, provenance and routing tests. Live native MCP/tunnel operation remains unverified. Package version remains 0.4.8 pending release.
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
