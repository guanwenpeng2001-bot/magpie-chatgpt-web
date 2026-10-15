# ChatGPT Web for magpie

Use your ChatGPT web session as a magpie provider. Sign-in always opens visible Chrome; chat turns run headless by default. This README describes the redesign contract; release verification is incomplete until the measurements below are filled in. Whole-block replies are acceptable: progressive or token-level streaming is not verified.

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

## Sign-in and ordinary use

Choose **ChatGPT account (browser sign-in)**. Sign-in always opens a visible Chrome window on chatgpt.com, using a plugin-owned profile below `~/.config/magpie/chatgpt-web-profile/`, separate from your normal Chrome profile. Sign in normally, including MFA or manual verification. No cookie copying, token pasting or developer tools are needed. The window closes after session confirmation; closing it early cancels sign-in. The sign-in window lasts **15 minutes**. A sign-in that lapses is not restarted from nothing: retrying resumes the same plugin-owned profile, so a password, MFA trust or partially completed verification already entered is still there. A completed sign-in releases that profile, and the next account you add gets its own.

Open magpie's normal model picker, choose **ChatGPT Web**, and select a model offered to your account. `magpie plugin list --json` confirms installation. Continue conversations normally and use the usual stop control to cancel a reply.

Turns run **headless by default**. In the provider editor, enable **Show browser during chats** (`visible-turns`) to run turns in visible Chrome, including when a site check needs manual attention. Sign-in remains visible regardless of that switch. Headless operation is the configured default, not a claim of measured live-site success. Idle turn browser contexts close after **5 minutes**.

Magpie stores the session in its credential store. Renewal starts 24 hours before expiry. Session refresh uses an HTTP-only read with a 10-second cap and no browser fallback; a challenge is surfaced for recovery. Model catalogue reads are cached for 60 seconds. A failed or empty catalogue refresh preserves the previous host list and shows a list error rather than silently replacing it with an empty list.

Only one turn per account runs at a time, with pacing and rate-limit cooldown. Cancellation closes the active page and drops its local conversation binding; the next turn can rebuild from supplied history. Bindings expire after 30 idle minutes. Temporary-chat state must be confirmed before sending; otherwise no message is submitted. The privacy contract is that turns leave no user-visible conversation artifacts in the account's chatgpt.com history. The plugin never deletes remote conversations. Temporary Chat does not imply that OpenAI retains no data: the site's own policies still apply.

## Sign-out, removal and local data

```powershell
magpie plugin logout chatgpt-web
magpie plugin rm magpie-chatgpt-web
```

Sign-out removes the sign-in from magpie's credential store. Plugin removal uninstalls the plugin; use explicit sign-out first when you want to forget the stored credential. Neither operation erases the plugin-owned Chrome profile or deletes remote conversations. Host sign-out has no plugin notification hook for automatic profile cleanup.

To erase the local browser session too, stop active requests, close the plugin-owned Chrome windows, then delete only the corresponding account profile directory below `~/.config/magpie/chatgpt-web-profile/` (on Windows, below `$HOME/.config/magpie/chatgpt-web-profile/`). Use your file manager to select that directory. Delete the entire plugin profile root only if you intend to erase every plugin account's browser session. Never delete your normal Chrome profile. Deleting the profile does not replace magpie sign-out. The plugin keeps at most one sign-in profile in use at a time: a new sign-in resumes the profile of an unfinished one, and a completed sign-in releases it so the next account gets a fresh directory. An abandoned directory from an interrupted sign-in therefore stays on disk until a later sign-in reuses it, and removing it is otherwise manual. Do not delete the `signin.profile` file while a sign-in window is open: it is how a retry finds the profile to resume.

Browser state is a sensitive login artifact. Use a trusted workstation and never share profiles, cookies or credentials. Session material stays in plugin-owned local storage and magpie's credential store; it must not be logged or included in error reports, and is transmitted only across the boundaries needed to operate the session. Web-session automation is unofficial, may break when the site changes, and may risk account restrictions. Use only an account you are authorized to access. There is no automated challenge solving, defense bypass, account pooling or retry loop against site defenses.

## Models, images and delivery

The model list comes from the signed-in account's full catalogue. Unknown slugs remain listed and are attempted; compatibility annotations are not an allowlist. Listing a model does not prove entitlement, picker compatibility or successful generation. Refresh the list after changing accounts. Duplicate mini-model titles include their slug to distinguish them.

Image input is supported up to **4 images / 10 MiB each**; non-image attachments and over-cap input are rejected before submission. A model advertises image input only when verified for that model. Every model keeps `toolcall: false`, `reasoning: false` and `temperature: false`. Reasoning controls/traces, native tool calling, web search, canvas, image generation, voice and quota display are not provided. Context and output limits of 200,000 and 34,834 are planning values, not verified subscription or generation guarantees. Usage is estimated from characters, not measured tokens or account quota.

The provider declares `npm: '@ai-sdk/anthropic'` for **Anthropic-wire emulation**: magpie sends Messages-shaped requests and receives translated responses. Requests are served through the ChatGPT web session, not the Anthropic service; this declaration does not establish native Anthropic semantics or capabilities.

DOM snapshots are the primary answer carrier, polled every 500 ms. That polling interval is an implementation setting, not measured delivery cadence. A best-effort SSE reader may carry the answer; `x-chatgptweb-route: dom|sse` identifies the route. DOM text can lose formatting. Clone unavailability is logged as an observation change, not a fabricated successful answer or an independent failure code. Whole-block delivery is acceptable; progressive or token-level streaming is not verified. An interrupted or unterminated answer remains an error.

The following release measurements are intentionally unfilled. Each must be replaced with measured values and an evidence-path citation before release; historical measurements from another build are not evidence for this redesign.

### Turn-budget measurement

<!-- VERIFY:turn-budget -->
TBD

### Delivery-cadence measurement

<!-- VERIFY:delivery-cadence -->
TBD

### Running host identity and bundle SHA-256

<!-- VERIFY:host-identity -->
TBD

## Failure messages

Each row names a public error code, its condition and an action the user can take. Tool errors apply only when a client explicitly exercises the dormant emulation layer.

| Code | Condition | Recovery |
| --- | --- | --- |
| `expired` | The ChatGPT session expired or is no longer signed in. | Repeat browser sign-in with `magpie plugin login chatgpt-web`. |
| `cooldown` | The account is cooling down after a rate limit. | Wait for the reported `retry-after` interval, then retry; dismissing a dialog does not clear cooldown. |
| `upstream` | The upstream request failed. | Check connectivity and site availability, then retry when available. |
| `requestBudget` | A local request time budget elapsed without a confirmed result. | Retry later or shorten the request; this is not an account rate-limit diagnosis. |
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
| `toolRequired` | The required tool call was absent. | Retry or use ordinary text; no model advertises tool compliance. |
| `toolDelimiter` | Tool-call delimiters were malformed. | Retry or disable tool emulation. |
| `toolLimit` | Tool JSON or schema validation exceeded its complexity cap. | Reduce call size, tool count or schema complexity. |
| `binding` | A conversation belongs to another account or its history changed/replayed. | Start a fresh conversation using the intended account and history. |
| `temporary` | Temporary Chat could not be confirmed; no message was sent. | Retry after checking the site's Temporary Chat state; update the plugin if this persists. |
| `harvest` | The answer reader failed without confirming a completed reply. | Retry; update the plugin and report persistent reader failures. |
| `protocol` | The backend or upstream protocol is invalid. | Update/reinstall the plugin and report persistent protocol failures. |
| `verification` | ChatGPT requested human verification. | Enable `visible-turns` (Show browser during chats), complete the site's check manually in Chrome, then retry. |
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
| `modelNotOffered` | The requested slug is not offered to this account. | Pick a listed model; refresh the model list if the account changed. |
| `attachmentUnsupported` | Input is not an image or exceeds 4 images / 10 MiB each. | Remove unsupported or excess files, reduce image size, then retry. |
| `imageRejected` | ChatGPT refused an image upload. | Retry; if it persists, send the message without the image. |

## Dormant prompt-level tool emulation

The dormant emulation layer is retained for explicitly supplied client tools and verification; no advertised model has passed the tool-compliance bar. It asks for nonce-delimited JSON in ordinary model text, validates it and renders synthetic `tool_use` blocks. It never executes tools and is not a native tool channel. Argument objects arrive in one `input_json_delta`; the wire format makes no promise about live answer cadence. Tool history preserves IDs, results and error flags as text in a fresh temporary conversation.

The bounded schema subset supports boolean child schemas, `type` unions, `const`, `enum`, `properties`, `required`, `additionalProperties`, `items`, `uniqueItems`, `allOf`, `anyOf`, `oneOf`, `not`, local `$ref`, `$defs`, `definitions`, numeric bounds, length bounds, property-count bounds and item-count bounds. `title`, `description`, `default`, `examples` and `$comment` are annotations. Other keywords, including `$schema`, `pattern`, `format`, remote references, conditionals and tuple schemas, are rejected. Preflight is limited to 10,000 nodes and depth 32, validation to 100,000 operations and depth 32, each call to 1 MiB JSON, and each request to 128 tools.

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
