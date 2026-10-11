# ChatGPT Web for magpie

Development snapshot: provider registration, browser sign-in, browserless renewal and model discovery. Chat turns are not implemented yet (INC-4); prompt-based tools await INC-5 verification.

Requires Node.js 20 or later on PATH and installed Google Chrome. Install the local repository with:

```sh
magpie plugin add /absolute/path/to/magpie-chatgpt-web
magpie plugin login chatgpt-web
```

Adding a plugin restarts magpie's plugin host. Select **ChatGPT account (browser sign-in)**. A normal Chrome window opens on chatgpt.com using a separate plugin-owned profile. Sign in normally; no cookie copying or token pasting is needed. The window closes after the session is verified. Chrome is spawned without automation, headless or no-sandbox flags and attached over CDP.

Magpie stores the session cookie and derived access token in its own credential store. Renewal uses the stored cookie without opening Chrome, starting 24 hours before token expiry. An expired cookie triggers magpie's sign-in-again affordance. Each sign-in uses a fresh profile slot under `~/.config/magpie/chatgpt-web-profile/`; restored pages are reset to a blank page before use without deleting cookies. A failed reset produces an error; signing in again allocates another slot. Old profile cleanup is not yet automated.

Browser state is a sensitive login artifact; never share the profile; use a trusted workstation. Web-session automation is unofficial, can break when the site changes, and may risk account restrictions. Use only an account you are authorized to access. Challenges and rate limits are not bypassed or retried automatically.

The model catalogue is fetched per account and cached in memory for 60 seconds. Catalogue inclusion does not prove a model is selectable or can generate; INC-6 reconciles it against the picker and generation evidence. Duplicate mini-model titles include their slug. Advertised limits (200,000 context; 34,834 output) are planning values, not verified subscription or generation guarantees.

No attachment or image input, reasoning controls or traces, native tool API, web search/canvas/image tools, or quota display is provided. The planned toolcall capability describes prompt-level emulation, whose reliability remains unverified. The per-request `chat.headers` hook is implemented, but gateway reachability for plugin providers is unverified. No successful chat behavior should be inferred from discovery or authentication tests.

This README is a skeleton. Final packaging, lockfile, license, dependency/install-script gates, model pruning, cleanup instructions and delivery rehearsal belong to INC-6.
