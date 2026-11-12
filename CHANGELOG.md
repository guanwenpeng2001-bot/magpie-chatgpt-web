# Changelog

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
