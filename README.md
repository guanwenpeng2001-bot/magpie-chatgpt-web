# ChatGPT Web for magpie

Development snapshot: provider registration, browser sign-in, browserless renewal, model discovery and text turns. Replies stream in append batches as the site writes them; this is not token-level streaming. Prompt-based tools await INC-5 verification.

Requires Node.js 20 or later on PATH and installed Google Chrome. Install the local repository with:

```sh
magpie plugin add /absolute/path/to/magpie-chatgpt-web
magpie plugin login chatgpt-web
```

Adding a plugin restarts magpie's plugin host. Select **ChatGPT account (browser sign-in)**. A normal Chrome window opens on chatgpt.com using a separate plugin-owned profile. Sign in normally; no cookie copying or token pasting is needed. The window closes after the session is verified. Chrome is spawned without automation, headless or no-sandbox flags and attached over CDP.

Magpie stores the session cookie and derived access token in its own credential store. Renewal uses the stored cookie without opening Chrome, starting 24 hours before token expiry. An expired cookie triggers magpie's sign-in-again affordance. Each sign-in uses a fresh profile slot under `~/.config/magpie/chatgpt-web-profile/`; restored pages are reset to a blank page before use without deleting cookies. A failed reset produces an error; signing in again allocates another slot. Old profile cleanup is not yet automated.

Browser state is a sensitive login artifact; never share the profile; use a trusted workstation. Web-session automation is unofficial, can break when the site changes, and may risk account restrictions. Use only an account you are authorized to access. Challenges and rate limits are not bypassed or retried automatically.

The model catalogue is fetched per account and cached in memory for 60 seconds. Catalogue inclusion does not prove a model is selectable or can generate; INC-6 reconciles it against the picker and generation evidence. Duplicate mini-model titles include their slug. Advertised limits (200,000 context; 34,834 output) are planning values, not verified subscription or generation guarantees.

No attachment or image input, reasoning controls or traces, native tool API, web search/canvas/image tools, or quota display is provided. Tools are rejected explicitly until INC-5 supplies and verifies emulation. The host delivers its session id through `chat.headers`; a caller-supplied `conversation_id` takes priority, otherwise its SHA-256 identifies the local binding. Bindings expire after 30 idle minutes; lost pages rebuild from the full supplied history.

Turns currently open ordinary visible Chrome, the launch shape supported by the live spike; working headless generation remains unproven. New pages request `?temporary-chat=true`; a redirect that loses that flag fails before submission. Cancelling closes the active page and drops its binding, while retaining the browser session for the next send. Local discard never deletes a remote conversation.

Network collection preserves answer text and Markdown. If cloning is unavailable before any answer is forwarded, DOM prefix snapshots provide incremental plain text with reduced formatting fidelity. A reader failure after collection starts, incomplete stream, hidden reply, empty reply or changed vocabulary produces an explicit error, never a fabricated completed answer. Rate limits keep the account cooldown even if their dialog is dismissed. Interactive verification requires manual action in the sign-in browser; no challenge is solved or retried automatically. Before the first answer batch, the request remains pending; no invented progress text is inserted. Usage counts are character-based estimates.

This README is a skeleton. Final packaging, lockfile, license, dependency/install-script gates, model pruning, cleanup instructions and delivery rehearsal belong to INC-6.
