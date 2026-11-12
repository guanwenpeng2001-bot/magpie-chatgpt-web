# ChatGPT Web for magpie

Use your ChatGPT web session as a magpie provider. Sign-in always opens visible Chrome; chat turns run in the background by default. Sign-in lifecycle is live-verified; two consecutive live turns completed on Windows using the same ordinary Chrome session. Site verification can still occur. Turn budget and delivery cadence remain unmeasured. Whole-block replies are acceptable: progressive or token-level streaming is not verified.

Plugin version: `0.4.6`. Host verified against: magpie `0.1.3930` (see [release verification status](#release-verification-status) for scope and evidence).

## Requirements and installation

Install magpie, Node.js 20 or later, Google Chrome and Git. No browser or runtime is bundled, and Edge fallback is not implemented. The backend runs under Node.js and drives Chrome through `playwright-core`, its sole dependency.

Get magpie from https://usemagpie.ai or the [magpie releases](https://github.com/yetone/magpie-releases/releases); its sources are at https://github.com/yetone/magpie. On Windows, rename the downloaded `magpie-windows-amd64.exe` to `magpie.exe` and put its folder on PATH. Open a new terminal and run `magpie --version`. If PowerShell reports CommandNotFoundException, fix PATH before continuing. `magpie update` updates magpie itself.

Install the plugin and start sign-in in PowerShell:

```powershell
magpie plugin add github:guanwenpeng2001-bot/magpie-chatgpt-web
magpie plugin login chatgpt-web
```

For a local, committed checkout, run from that checkout:

```powershell
$pluginSpec = node -e "console.log('git+' + require('node:url').pathToFileURL(process.cwd()).href)"
magpie plugin add $pluginSpec
magpie plugin login chatgpt-web
```

Git installs consume committed source. The installer resolves `playwright-core ~1.62.0`; the lockfile pins 1.62.1. No install lifecycle scripts are needed. This repository is not published to a package registry. Finish active turns before installing or upgrading: installation restarts the plugin host.

## Upgrading

Finish active turns, then rerun the published installation command:

```powershell
magpie plugin add github:guanwenpeng2001-bot/magpie-chatgpt-web
```

Local `git+file://` installs have a verified upstream magpie **stale-pin** defect (D-167): reinstalling can report success while reusing an older cached checkout because `~/.config/magpie/plugins/bun.lock` still pins the old commit. This is an upstream installer defect, not a plugin runtime bug.

For that local-install case, commit the desired source and run `git rev-parse HEAD` in its checkout to obtain the intended SHA. Back up `~/.config/magpie/plugins/bun.lock`, then edit only this plugin's git dependency entry to replace its pinned commit SHA with that intended SHA. Rerun `magpie plugin add $pluginSpec` from the local installation steps. Confirm the intended version or changed behavior is actually serving; a successful installer exit alone does not prove the upgrade. Do not alter other plugins' lock entries or erase browser profiles as an upgrade workaround.

## Codex integration boundary

Magpie owns the Codex Desktop route. The plugin must not edit `config.toml`, choose `model_provider`, own `model_catalog_json`, or repair/reconnect Magpie's desktop wiring. Magpie 0.1.3930 writes and validates that configuration itself. If Magpie reports that its configuration changed, use Magpie's normal disconnect/reconnect flow and do not run a plugin-side activation command.

The plugin's responsibility ends at its ChatGPT Web provider: browser sign-in, the persistent Chrome profile, verification recovery, model selection, the shared Anthropic-compatible SSE route, client tool rounds, context preflight and usage estimates. Magpie remains responsible for installation, the Desktop gateway address, provider selection, model catalogue generation and reconnect behavior.

For an isolated Codex CLI profile, the helper can write one separate file without touching Magpie's Desktop config:

```powershell
npm run codex-profile -- --apply
codex -p chatgpt-web-http
```

The profile is `$CODEX_HOME\chatgpt-web-http.config.toml`, or `~/.codex/chatgpt-web-http.config.toml` when `CODEX_HOME` is unset. It reads the existing Magpie provider block and gateway address, disables WebSockets only in that separate profile, and resolves the catalogue to an absolute path for CLI metadata lookup. The main `config.toml` remains read-only. `--check` never writes; `--rollback` removes only this plugin-managed CLI profile and never changes Magpie's Desktop config:

```powershell
npm run codex-profile -- --rollback
```

## Sign-in and ordinary use

Choose **ChatGPT account (browser sign-in)**. Sign-in always opens a visible Chrome window on chatgpt.com, using a plugin-owned profile below `~/.config/magpie/chatgpt-web-profile/`, separate from your normal Chrome profile. Sign in normally, including MFA or manual verification. No cookie copying, token pasting or developer tools are needed. After session confirmation, the same Chrome process and page context are retained on the same persistent account profile: normal chats move that window off-screen, while the visible-chat override brings it back on-screen. This keeps the normal installed-Chrome fingerprint instead of switching to headless Chrome. Closing the window early cancels sign-in. The sign-in window lasts **15 minutes**. A sign-in that lapses is not restarted from nothing: retrying resumes the same plugin-owned profile, so a password, MFA trust or partially completed verification already entered is still there. A completed sign-in releases that profile, and the next account you add gets its own.

Open magpie's normal model picker, choose **ChatGPT Web**, and select a model offered to your account. `magpie plugin list --json` confirms installation. Continue conversations normally and use the usual stop control to cancel a reply.

Turns run in the **background by default** using ordinary headed Chrome at `-32000,-32000`. In the provider editor, **Show browser during chats** (`visible-turns`) is the explicit visible override. Leave it off for normal chats; explicitly enable it when you want to watch a turn. A background verification automatically reveals the same window, page and browser context. After the check clears, observation resumes the same request and the window moves back off-screen. If the local turn deadline expires first, the page stays visible with its conversation binding intact so the next retry can recover it without submitting the prompt again. Chrome keeps its system proxy unless the plugin-specific `MAGPIE_CHATGPT_WEB_PROXY` override is set, so an existing Cloudflare clearance is not invalidated by forcing a different `--proxy-server`. Magpie-injected `HTTPS_PROXY` and `MAGPIE_HTTPS_PROXY` values are ignored for this browser because Chrome must use the same operating-system proxy path as the user's ordinary Chrome. Sequential turns and background reads reuse the active context for the backend lifetime. Browser-rotated session cookies are preserved across turns and window-position changes until the host supplies a new credential, and restored cookies use the site's domain to avoid duplicate session tokens.

Magpie stores the session in its credential store. Renewal starts 24 hours before expiry. Session refresh uses an HTTP-only read with a 10-second cap and no browser fallback; a challenge is surfaced for recovery. Model catalogue reads send the signed-in access token as Bearer authorization on both HTTP and browser routes and are cached for 60 seconds. Session renewal updates that token. An empty catalogue refresh or a generic upstream/network failure preserves the previous host list with a marked fallback. Classified failures, including verification challenges, are passed to the host with their status, message and recovery headers intact.

Only one turn per account runs at a time, with pacing and rate-limit cooldown. Cancellation closes the active page and drops its local conversation binding; the exception is an unresolved verification recovery, whose visible page and binding are retained for retry. The next ordinary turn can rebuild from supplied history. Bindings expire after 30 idle minutes. Temporary-chat state must be confirmed before sending; otherwise no message is submitted. The privacy contract is that turns leave no user-visible conversation artifacts in the account's chatgpt.com history. The plugin never deletes remote conversations. Temporary Chat does not imply that OpenAI retains no data: the site's own policies still apply.

## Sign-out, removal and local data

```powershell
magpie plugin logout chatgpt-web
magpie plugin rm magpie-chatgpt-web
```

Sign-out removes the sign-in from magpie's credential store. Plugin removal uninstalls the plugin; use explicit sign-out first when you want to forget the stored credential. Neither operation erases the plugin-owned Chrome profile or deletes remote conversations. Host sign-out has no plugin notification hook for automatic profile cleanup.

To erase the local browser session too, stop active requests, close the plugin-owned Chrome windows, then delete only the corresponding account profile directory below `~/.config/magpie/chatgpt-web-profile/` (on Windows, below `$HOME/.config/magpie/chatgpt-web-profile/`). Use your file manager to select that directory. Delete the entire plugin profile root only if you intend to erase every plugin account's browser session. Never delete your normal Chrome profile. Deleting the profile does not replace magpie sign-out. The plugin records one unfinished sign-in profile for resume: when it is available, a new sign-in resumes it, and a completed sign-in retires that pending reference so the next account gets a fresh directory. A concurrent host uses a separate fresh directory without replacing the pending reference; retry progress in that concurrent directory is not retained by the pending claim. Unreferenced abandoned directories require manual cleanup. To identify referenced directories, inspect only the `profile` field of each ChatGPT Web account in `~/.config/magpie/plugin-auth.json`; each value names its directory below the profile root. Do not copy, log or share the store, which contains credentials. A directory is unreferenced only if neither any stored account's `profile` nor `signin.profile` names it; after stopping all plugin activity, those unreferenced directories may be removed manually. Do not delete `signin.profile` while a sign-in window is open: it is how a retry finds the profile to resume. An operating-system socket lock prevents another host process from adopting that pending profile during sign-in; a concurrent host gets a fresh profile instead. The operating system releases ownership when the holder exits, including a crash, so no stale lock file requires cleanup. If retiring the pending claim fails, sign-in fails with `browserConfiguration` instead of returning a credential; close programs holding the file and retry. A successful sign-in is reported only after its pending claim has been removed.

Browser state is a sensitive login artifact. Use a trusted workstation and never share profiles, cookies or credentials. Session material stays in plugin-owned local storage and magpie's credential store; it must not be logged or included in error reports, and is transmitted only across the boundaries needed to operate the session. Web-session automation is unofficial, may break when the site changes, and may risk account restrictions. Use only an account you are authorized to access. There is no automated challenge solving, defense bypass, account pooling or retry loop against site defenses.

## Models, images and delivery

The inline model picker is supported, including GPT-5.6 and GPT-6 default/Instant/Thinking/Pro selection with family and effort verification before Send. The 23-entry catalogue also contains eight Work models, five request-only mini/experimental IDs, and two entries that this account's current web surface cannot complete. Work models use the separate saved-task surface and never claim Temporary Chat semantics. Request-only IDs select a verified ordinary model as their UI bridge, then replace only the submitted JSON `model` field with the exact original ID. See [the full model audit](MODEL_SUPPORT.md). The two unsupported entries are marked `[not yet supported]` and fail as `modelUnsupported`, not as an account-permission claim. Streaming requests expose the initial Anthropic SSE frame immediately and continue relaying browser turn frames as they arrive, so Codex receives progress instead of waiting for the complete browser turn.

Image input is supported up to **4 images / 10 MiB each**; non-image attachments and over-cap input are rejected before submission. The catalogue-conditional **ChatGPT Images** entry uses the site's Create image tool, saves page-owned image blobs as local PNG/JPEG/WebP files under `~/.config/magpie/chatgpt-web-artifacts`, and returns local Markdown paths. That workflow creates a saved ordinary chat because Temporary Chat disables Create image. Video generation, web search, canvas, voice and quota display are not provided. Every catalogue model keeps `toolcall: false`, `reasoning: false` and `temperature: false`; request-level client-tool emulation is separate. The descriptor reports each routed mode's conservative browser context ceiling and a 34,834-token output planning value. These are transport planning limits, not verified subscription or generation guarantees.

Before opening a browser turn, the plugin dynamically estimates the complete prepared prompt, including system text, history, client tool schemas, the ChatGPT product reserve and image reserves. Conservative browser ceilings are **41,000** tokens for Instant and unknown/page-default modes, **90,000** for reasoning and Work modes, and **111,001** for explicit Pro modes. Codex and other compatible hosts receive those limits in the model descriptor so their normal compaction can run before the browser boundary. The plugin does not use a fixed message-count or fixed-segment trimming algorithm and never silently slices history. If a host still submits an oversized prompt, it fails with `contextLength` before navigation or submission. Magpie's existing proxied-request accounting reads the same estimates from Anthropic `message_start` (`input_tokens`, zero cache counters) and terminal `message_delta` (`output_tokens`). This avoids a second `input.magpie.usage` event. See [the estimate formulas and limitations](MODEL_SUPPORT.md#local-context-and-usage-estimates).

The provider declares `npm: '@ai-sdk/anthropic'` for **Anthropic-wire emulation**: magpie sends Messages-shaped requests and receives translated responses. Requests are served through the ChatGPT web session, not the Anthropic service; this declaration does not establish native Anthropic semantics or capabilities.

Visible browser turns read only the rendered DOM answer, so hidden intermediate stream messages cannot terminate a normal thinking response. Headless mode retains its optional SSE reader. DOM snapshots are the primary answer carrier, polled every 500 ms. That polling interval is an implementation setting, not measured delivery cadence. A best-effort SSE reader may carry the answer; `x-chatgptweb-route: dom|sse` identifies the route. DOM text can lose formatting. Clone unavailability is logged as an observation change, not a fabricated successful answer or an independent failure code. Whole-block delivery is acceptable; progressive or token-level streaming is not verified. An interrupted or unterminated answer remains an error.

## Release verification status

For 0.4.6, explicit project inspection phrases now force an Agent action while conceptual and explanatory questions remain text-only. The 0.4.5 Magpie native Desktop route completed a live `chatgpt-web/gpt-6` request without changing the main Codex configuration. Earlier custom-provider checks completed `exec_command` on GPT-5.6 Pro and GPT-6 Pro, `apply_patch` followed by `exec_command` on GPT-6, a persisted-session resume, and per-round Magpie usage records. The current 330-tool Codex catalogue is bounded by the same preflight; larger client catalogues may still contain client-specific behavior beyond these tests.

For 0.4.0, ordinary GPT-6 Pro and GPT-5.6 Pro completed live source-backend turns; all eight Work IDs passed live UI selection checks and GPT-6 Luna Work completed a live saved-task turn. GPT-5.6 mini, GPT-5.6 Thinking mini and both experimental catalogue IDs passed live request-override and DOM-completion checks after their browser bundles were installed. ChatGPT Images generated and saved a valid PNG through the source backend. A representative 36-tool Claude-shaped request completed both through the source backend and the real Magpie `/v1/messages` route with HTTP 200 and the requested `tool_use`.

The larger Claude Desktop catalogue has been observed with up to 255 tools, and the current Codex host emitted 330. Preflight now accepts up to **512** tools. For a large catalogue, the plugin dynamically selects direct Agent controls and tools relevant to the current turn, then shrinks descriptions and schema detail in stages until the prepared request stays below half of the selected Web context. Stable tool names reach the model, and every returned action is checked against the original complete schema. Small catalogues keep every supplied tool. This does not claim that every client-specific tool succeeds: research, browser/computer tools and site-side behavior remain outside the verified scope.

For 0.3.1, two consecutive live `auto` turns completed through both the source backend and the installed backend on Windows, returning `BROWSER_OK_1` and `BROWSER_OK_2` over the DOM route without a manual verification click. Explicit `gpt-5-6-pro` selection also completed a live source-backend turn. The final automated suite passed 600 tests; its one default skip, the real-Chrome launch gate, passed separately. Visible turns use DOM-only observation after earlier stream-based probes exposed empty/hidden intermediate responses. These are short functional checks, not a guarantee against future site verification or a benchmark; other accounts and model families remain unverified. Historical acceptance records below describe the earlier build, not the current browser-session checks.

### Turn-budget measurement

Unmeasured: live turn measurement was blocked by the durable verification challenge recorded in `verification/verify-live-acceptance-r3.md`. No successful live-turn timing establishes the turn budget. See the `verification` row in the [failure table](#failure-messages) for the condition and manual recovery action; that action is not a verified workaround for the challenged session.

### Delivery-cadence measurement

Unmeasured: live turn measurement was blocked by the durable verification challenge recorded in `verification/verify-live-acceptance-r3.md`. The backend assembles whole-block replies and emits one content delta after observation returns, by construction (`verification/verify-live-acceptance.md:183-201`). The 500 ms DOM poll is an implementation setting, not measured delivery cadence. See the `verification` row in the [failure table](#failure-messages); no live arrival cadence is claimed.

### Running host identity and bundle SHA-256

Live verification for `0.4.6` ran against magpie `0.1.3930`, host bundle `host-e6801c6cb0f6.js`, 166 257 bytes, SHA-256 `e6801c6cb0f61553ca747c2b02209bfe87720183b37bb8840d08bcfb5352c5f3`, and Codex CLI `0.167.2`.

## Failure messages

Each row names a public error code, its condition and an action the user can take. Tool rows apply when a client explicitly supplies tools through the shared Anthropic-compatible route.

| Code | Condition | Recovery |
| --- | --- | --- |
| `expired` | The ChatGPT session expired or is no longer signed in. | Repeat browser sign-in with `magpie plugin login chatgpt-web`. |
| `cooldown` | The account is cooling down after a rate limit. | Wait for the reported `retry-after` interval, then retry; dismissing a dialog does not clear cooldown. |
| `upstream` | The upstream request failed. | Check connectivity and site availability, then retry when available. |
| `requestBudget` | A local request time budget elapsed without a confirmed result. | Retry later or shorten the request; this is not an account rate-limit diagnosis. |
| `contextLength` | The conservatively estimated browser input meets or exceeds the selected model's transport ceiling. | Start a new chat, compact the conversation, or remove history, images or tool schemas, then retry; no prompt was sent. |
| `empty` | No answer text was returned. | Retry the message; report persistent empty replies. |
| `hidden` | ChatGPT hid the reply from the conversation. | Review the request and retry with a revised message. |
| `truncated` | The reply ended without confirmed completion. | Retry or request a shorter answer; do not treat partial text as complete. |
| `unsupported` | The request carries malformed content that is neither a text string nor a content-block array. | Correct the malformed content and resend supported content: text, valid tool blocks, or acceptable images. |
| `invalidRequest` | The request shape is invalid. | Correct the client request and retry. |
| `toolDefinition` | Tool definitions are invalid or use unsupported schema keywords. | Correct the definitions to the supported subset below. |
| `toolChoice` | Tool choice is invalid or names an undefined tool. | Choose a defined tool or correct the choice value. |
| `toolUnknown` | The model requested an undefined tool. | Retry with clearer tool instructions or disable tool emulation. |
| `toolJSON` | Tool-call JSON is malformed. | Retry the request or use ordinary text without tools. |
| `toolSchema` | Tool arguments do not match the input schema. | Simplify the schema or retry; do not execute invalid arguments. |
| `toolChoiceViolation` | The model did not follow the requested tool choice. | Retry or use ordinary text; tool compliance is not guaranteed. |
| `toolParallel` | Multiple calls were emitted with parallel calls disabled. | Retry with one requested call or explicitly permit parallel calls in the client. |
| `toolIncomplete` | The reply ended inside a tool call. | Retry with a smaller request; do not execute the partial call. |
| `toolRequired` | A host explicitly required a tool call, but the model returned only text. | Retry or let the host use `tool_choice: auto` for probabilistic tool selection. |
| `toolDelimiter` | Tool-call delimiters were malformed. | Retry or disable tool emulation. |
| `toolLimit` | Tool JSON or schema validation exceeded its complexity cap. | Reduce call size, tool count or schema complexity. |
| `binding` | A conversation belongs to another account or its history changed/replayed. | Start a fresh conversation using the intended account and history. |
| `temporary` | Temporary Chat could not be confirmed; no message was sent. | Retry after checking the site's Temporary Chat state; update the plugin if this persists. |
| `harvest` | The answer reader failed without confirming a completed reply. | Retry; update the plugin and report persistent reader failures. |
| `protocol` | The backend or upstream protocol is invalid. | Update/reinstall the plugin and report persistent protocol failures. |
| `verification` | ChatGPT requested human verification, and automatic recovery did not finish before the local deadline. | Check the Chrome window revealed by the plugin, complete the verification, then retry if the current request does not resume automatically. |
| `capacity` | Local backend capacity is exhausted. | Wait for active work and cooldowns; restart the plugin backend if retained sign-in blocks persist. |
| `browserDependency` | The `playwright-core` dependency is unavailable. | Reinstall the plugin so its packaged dependency is resolved. |
| `browserProfile` | The browser profile restored an unexpected page. | Close plugin-owned Chrome, sign out and remove only its affected profile, then sign in again. |
| `browserConfiguration` | The browser account or profile-root configuration is invalid. | Check the plugin configuration and sign in again to create a valid profile. |
| `browserClosed` | The browser context closed or its supervisor stopped. | Retry to launch a new context; check Chrome if it keeps closing. |
| `backendDown` | The plugin backend is unavailable. | Check Node.js 20 or later and Chrome, then restart/reinstall the plugin. |
| `signinTimeout` | The sign-in window timed out after 15 minutes. | Start sign-in again; it resumes the same profile, so verification already completed is not lost. |
| `missingComponent` | Google Chrome, Node.js >= 20 or a plugin dependency was not found. | Install the named component or reinstall the plugin dependency as instructed. |
| `pickerMissing` | A named page component or selector is missing after a site change. | Update the plugin; if already current, report the adapter version and named component/selector. |
| `pickerAmbiguous` | The picker contains multiple entries for the requested model slug. | Retry, or enable `visible-turns` and select the model once by hand. |
| `modelUnsupported` | This adapter has no verified selector/workflow for the requested model. Account access is not inferred. | Choose a mapped model in [MODEL_SUPPORT.md](MODEL_SUPPORT.md), or update the plugin for additional adapters. |
| `modelNotOffered` | The requested slug is not offered to this account. | Pick a listed model; refresh the model list if the account changed. |
| `attachmentUnsupported` | Input is not an image or exceeds 4 images / 10 MiB each. | Remove unsupported or excess files, reduce image size, then retry. |
| `imageRejected` | ChatGPT refused an image upload. | Retry; if it persists, send the message without the image. |
| `imageOutput` | A generated image was present in the page but could not be saved locally. | Open the saved chat in ChatGPT and retrieve the image; Retry after updating the plugin. |

## Prompt-level client tool emulation

The shared layer supports client tools supplied by Codex, Claude-compatible clients and other Anthropic Messages consumers. It asks for nonce-delimited JSON in ordinary model text, validates it and renders standard synthetic `tool_use` blocks. The outer Agent executes those tools; the plugin never executes them itself. Argument objects arrive in one `input_json_delta`. Text and tool parsing occur incrementally as browser answer snapshots arrive. Tool IDs, results and error flags survive subsequent rounds in the same temporary ChatGPT task; a changed or edited history, tool catalogue, tool choice or image payload causes a safe full rebuild instead of pairing a new request with an old submitted page. Ordinary prompts containing words such as `run`, `read`, `test` or `write` remain eligible for text unless the host explicitly requested a tool or the prompt names one exact action such as `exec_command`.

The bounded schema subset supports boolean child schemas, `type` unions, `const`, `enum`, `properties`, `required`, `additionalProperties`, `items`, `uniqueItems`, `allOf`, `anyOf`, `oneOf`, `not`, local `$ref`, `$defs`, `definitions`, numeric bounds, length bounds, property-count bounds and item-count bounds. `title`, `description`, `default`, `examples`, `$comment`, `$schema` and `format` are annotations. `pattern` is validated as an ECMA-262 regular expression with a bounded per-value timeout. Other keywords, remote references, conditionals and tuple schemas are rejected. Preflight is limited to 10,000 nodes and depth 32, validation to 100,000 operations and depth 32, each call to 1 MiB JSON, and each request to 512 tools. Trailing `system` messages are merged into the system prompt; a request with no user or assistant message remains invalid.

Invalid definitions fail before dispatch. Streaming failures produce an error event without a successful `message_stop`. A successful text reply does not prove tool compliance.

## Developer verification

Install dependencies in the source checkout before testing; magpie's plugin install does not populate this checkout's `node_modules`.

```powershell
npm ci --ignore-scripts
node scripts/check-package.mjs
node --test
```

Chrome is required for browser fixtures. Without `playwright-core`, some tests skip and a smaller passing suite is not full verification. The launch gate is intentionally separate: `node test/launch-gate.mjs` checks browser lifecycle with traffic forced offline. Live sign-in and live turns require separate authorization.

The optional `node integrations/sandbox.mjs` rehearsal uses a local fixture, disposable HOME/profile/cache directories and the stock plugin host. It verifies transport and history handling, not live model intelligence. It requires the binaries and host pin named in that script and prints its checks and cleanup result. It uses the installer's dependency resolution, so a registry connection is required. Its fixture sign-in credential is never copied out; successful cleanup prints `sandbox discarded`. It does not substitute for release measurements or manual model-picker assessment.

MIT licensed. Adapted components and inherited notices are recorded in `THIRD_PARTY_NOTICES`. The plugin icon is the author's own drawing.
