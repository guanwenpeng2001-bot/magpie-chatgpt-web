# Changelog

## 0.3.2 — 2026-11-12

- Map all eight ordinary GPT-5.6/GPT-6 default, Instant, Thinking and Pro IDs to explicit family and effort selections. Base/Thinking use Medium; no previous Pro/Instant choice is inherited.
- Audit all 23 current catalogue IDs. Mark the 15 Work-mode, mini, research and experimental entries without implemented selectors as not yet supported; return `modelUnsupported` rather than claiming missing account access.
- Record only structural preflight diagnostics for incompatible client requests, without prompts, tool names, schemas or credentials. Claude Desktop's reported 400 remains under diagnosis pending a fresh request; this release does not claim general client-tool compatibility.
- Live UI selection succeeded for all eight mapped IDs; GPT-6 Pro completed a live backend turn.

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
