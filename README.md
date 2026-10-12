# ChatGPT Web for magpie

Use a ChatGPT web session as a magpie text provider. Replies arrive in batches as the site writes them. The measured long-answer sample delivered roughly 100 characters per batch, about twice per second; this is not token-level streaming. Turns currently open visible Chrome. Successful headless generation has not been established.

## Requirements and installation

Install magpie first, then Node.js 20 or later, Google Chrome and Git, all reachable on PATH. No browser or runtime is bundled. The tested platform is Windows 11 with Chrome 151 and magpie 0.1.1198. Edge fallback is not implemented.

magpie is distributed at https://usemagpie.ai, with sources at https://github.com/yetone/magpie. The project's [magpie-releases](https://github.com/yetone/magpie-releases/releases) publish `magpie-windows-amd64.exe` for Windows — the build this document was tested against — and `magpie update` upgrades an installed copy from the terminal. The commands below invoke the executable by the bare name `magpie`, so it must be on PATH under that name: if `magpie --version` fails with PowerShell's CommandNotFoundException (or the command not being recognized), rename the downloaded `magpie-windows-amd64.exe` to `magpie.exe` and add its folder to PATH, or copy it into a folder already on PATH as `magpie.exe`. Open a new terminal and confirm `magpie --version` succeeds before continuing.

The optional disposable rehearsal near the end of this document additionally needs a Bun runtime and the pinned plugin-host bundle at the exact paths listed under **Disposable cold-HOME verification**, plus dependency resolution over the network.

From the checked-out repository, in PowerShell:

```powershell
$pluginSpec = node -e "console.log('git+' + require('node:url').pathToFileURL(process.cwd()).href)"
magpie plugin add $pluginSpec
magpie plugin login chatgpt-web
```

Use a committed checkout: a git install consumes committed source. Installing restarts magpie's plugin host. The effect on the application's UI and in-flight turns has not been established in this rehearsal; finish active turns before installing. The installer resolves the sole dependency, `playwright-core ~1.62.0`; the lockfile fixes the measured package to 1.62.1. No install lifecycle scripts are needed. This repository is not published to a registry.

Choose **ChatGPT account (browser sign-in)**. Sign-in and later turns run Chrome with a plugin-owned profile below `~/.config/magpie/chatgpt-web-profile/`; that directory holds a live browser session and is separate from your normal Chrome profile. A normal Chrome window opens on chatgpt.com. Sign in normally, including any MFA requested by the site. You do not need developer tools, cookie copying or token pasting. The window closes when the session is verified. Closing it early cancels sign-in.

Open magpie's usual model picker, choose **ChatGPT Web**, and select an offered model exactly as you select another provider's model. Send a message, continue the same conversation, and use the normal stop control to cancel a reply. `magpie plugin list --json` confirms the installed provider; model selection takes place in the application's normal picker.

## Ordinary use and session cleanup

Magpie stores the session in its credential store. Renewal begins 24 hours before token expiry and uses the stored session first. A positively identified challenge routes the read through the plugin-owned browser. A failed catalogue read remains an error, not an empty list; the same applies when a successfully read catalogue contains none of the exposed slugs, so a provider with zero usable models is reported as an error rather than appearing silently. Catalogue reads are cached for 60 seconds.

Each sign-in allocates a profile below `~/.config/magpie/chatgpt-web-profile/`. Ordinary turns reuse the session, open visible Chrome on demand, and close idle browser contexts. One turn per account is allowed, with pacing and rate-limit cooldown. Temporary chats are required. Cancellation closes the active page and drops its local conversation binding; a later turn rebuilds from the full supplied history when needed. Bindings expire after 30 idle minutes. The plugin never deletes remote conversations.

To forget the magpie sign-in, run `magpie plugin logout chatgpt-web`. To remove the plugin, run `magpie plugin rm magpie-chatgpt-web`. These commands do not promise to erase Chrome profile data. After stopping active requests and closing the plugin-owned Chrome windows, remove only the corresponding directory below `~/.config/magpie/chatgpt-web-profile/` if you also want to erase its local browser session. Do not remove your normal Chrome profile. Old profile cleanup is manual.

Browser state is a sensitive login artifact; never share the profile; use a trusted workstation. Web-session automation is unofficial, can break when the site changes, and may risk account restrictions. Use only an account you are authorized to access. Challenges and rate limits are not bypassed or retried automatically.

## Model availability and delivery notes

The catalogue is an account-specific enumeration, not proof that every slug can generate. The archived HTTP catalogue has eight entries, while the observed picker has GPT-6, GPT-5.6 Sol and GPT-5.5. Sol and the catalogue's Luna are different labels and are not silently equated. GPT-6 Mini cannot be inferred from the shared GPT-6 title. The generation smoke is separate from tool-compliance testing.

Release verification is incomplete. The current candidate filter contains **Auto** (`chatgpt-web/auto`) and **GPT-6** (`chatgpt-web/gpt-6`), in that order, when the account catalogue contains them. The live instrument observed runtime `gpt-6` metadata and a seven-character DOM node for each, but did not establish that the node was assistant answer text. These observations do not verify generation or incremental delivery, and this candidate must not be released as verified. GPT-5.5 was selectable but the instrument timed out without confirming an answer; this does not establish that the site generated no reply. The other five catalogue slugs have no supported picker mapping: `gpt-5-6`, `gpt-5-3-mini`, `gpt-5-5-mini`, `gpt-5-6-mini`, and `gpt-6-mini`. This is a dated compatibility filter, not proof of every account's entitlement. New catalogue slugs remain unexposed until selectability and generation are verified.

Every model advertises `toolcall: false`, `reasoning: false`, `attachment: false` and `temperature: false`, with text-only input and output. The live tool-compliance matrix is pending. A successful text smoke proves nothing about tool compliance. Advertised context and output limits, 200,000 and 34,834 respectively, are planning values rather than verified subscription or generation guarantees. Usage is estimated from characters, not measured tokens or account quota.

No attachment or image input, reasoning controls or traces, native tool API, web search, canvas, image generation, voice, or quota display is provided. Headless generation, long-term session expiry/rotation behaviour, and full output-limit semantics remain unmeasured. These need respectively a future browser-mode measurement, passive session-lifetime observation, and a separately authorized long-output measurement. Tool capability remains gated on the separate INC-5 compliance matrix.

## Failure messages

| Condition | Behaviour and recovery |
| --- | --- |
| Expired session | Magpie requests sign-in again; repeat the same browser sign-in flow. |
| Interactive verification | The request fails with “ChatGPT asked to verify you are human. Complete verification in the open browser, then retry the chat.” Complete the site's check manually. No automatic challenge solving or retry occurs. |
| Rate limit | The account cooldown remains even if a dialog is dismissed. Wait for the reported cooldown. |
| Empty or hidden answer | An explicit error is returned; no completed assistant answer is fabricated. |
| Changed picker or protocol | A page/protocol error is returned. Update the plugin after a compatible fix is available. |
| Missing Chrome, Node or dependency | Startup fails. Confirm the declared machine requirements and that dependencies installed successfully. |
| Browser crash | The current request fails; a later request may launch a new browser and rebuild history. |
| Local time budget | HTTP 504 reports “This request exceeded its local time budget and was stopped before any confirmed result.” It is not an account rate-limit diagnosis. |
| Unsupported input | Attachments and other unsupported content blocks are rejected before submission. |

A read has a default 20-second Node budget and, only after a confirmed challenge, one independent 20-second browser fallback budget. Queue time and account pacing are additional. A recognized expiry or cooldown is retained even when cleanup outlasts the caller's budget. Network collection preserves answer text and Markdown. If cloning is unavailable before text is forwarded, DOM snapshots provide plain text with reduced formatting. Reader failure after collection starts, incomplete streams and changed vocabulary remain errors.

## Prompt-level tool emulation

The dormant emulation layer accepts explicitly supplied client tool definitions for verification. It asks for nonce-delimited JSON in ordinary model text, validates it, and renders synthetic `tool_use` blocks; it never executes a tool. This is not a native tool channel. Argument objects arrive in one `input_json_delta`. Text outside calls streams incrementally. Tool history preserves IDs, results and error flags as text in a fresh temporary conversation.

The bounded schema subset supports boolean child schemas, `type` unions, `const`, `enum`, `properties`, `required`, `additionalProperties`, `items`, `uniqueItems`, `allOf`, `anyOf`, `oneOf`, `not`, local `$ref`, `$defs`, `definitions`, numeric bounds, length bounds, property-count bounds and item-count bounds. `title`, `description`, `default`, `examples` and `$comment` are annotations. Other keywords, including `$schema`, `pattern`, `format`, remote references, conditionals and tuple schemas, are rejected. Preflight is limited to 10,000 nodes and depth 32, validation to 100,000 operations and depth 32, each call to 1 MiB JSON, and each request to 128 tools.

Invalid definitions produce HTTP 400 before dispatch. Unknown tools, malformed JSON/delimiters, schema mismatch, choice violations, disabled parallel calls, incomplete calls and missing required calls are explicit failures. Streaming failures have an error event without a successful `message_stop`.

## Disposable cold-HOME verification

This developer rehearsal uses a local fixture in place of chatgpt.com. It does not sign in to a real account or spend live turns. It tests the stock plugin host API; it does not substitute for a person assessing the application's model-picker UI.

On the measured Windows machine, the harness requires the existing magpie binary at `~/Downloads/magpie-windows-amd64.exe`, Bun at `~/.cache/magpie/bun/1.4.2/magpie-bun.exe`, and pinned host bundle `~/.cache/magpie/plugin-host/host-6e85b6c721c8.js`. A different installation layout needs a harness adjustment. It verifies host SHA-256 `6e85b6c721c84bc0326ec38e9dad67a105919e3b5712646750f502f5e03e7fcd`. It uses the installer's dependency resolution, so a registry connection is required; the harness points the install at a fresh empty cache directory, so a warm package cache elsewhere does not satisfy it.

From a clean committed checkout, the package check needs no installed dependency. `node --test` runs the dependency-free tests and visibly skips the answer-observer test when `playwright-core` is absent; it also visibly skips the separately invoked launch gate. To run the answer-observer test and launch gate, install Google Chrome and the locked local dependency first:

```powershell
npm ci --ignore-scripts
```

This setup requires registry access or an already populated npm cache (`npm ci --offline --ignore-scripts` uses only that cache and fails explicitly if it is incomplete). Magpie's plugin installation does not install dependencies into this source checkout. The answer-observer test runs automatically when the dependency is present; rerun it alone with `node --test test/answer-observer.test.mjs`. Chrome must also be installed in that case; its launch failure is not silently skipped.

Run the following checks from the committed checkout after satisfying their prerequisites. The final sandbox command additionally requires the exact binaries, host bundle and registry connection stated above; omit it when working under an offline-only constraint:

```powershell
node scripts/check-package.mjs
node --test
node test/launch-gate.mjs
node integrations/sandbox.mjs
```

`node --test` skips `test/launch-gate.mjs` with a visible reason because it launches real Chrome; run `node test/launch-gate.mjs` separately to exercise the browser launch, idle-close and crash-relaunch lifecycle. The gate forces browser traffic offline and requires both Google Chrome and a resolvable `playwright-core` dependency (installed by the setup command above); without that dependency, the direct command fails with `ERR_MODULE_NOT_FOUND`.

The last command performs one sequence. It creates `%TEMP%/chatgpt-web-sandbox-<random>/`, with `home/` as HOME and USERPROFILE, separate config/cache/AppData paths, `package/` as a disposable committed Git repository, and a private copy of the executable. It installs using `magpie plugin add git+file:///.../package`, lists the provider, checks the credential store is absent before fixture sign-in, performs fixture browser sign-in, discovers models and asserts the exposed list through the stock host, streams a three-turn conversation on the site-default model (`auto`) and exercises no non-default model selection, aborts and reuses the session, checks unsupported-input and expiry failures, and deletes the sandbox in `finally`. The synthetic `plugin-auth.json` is never copied out. The harness prints the allocated path and each checked result; success is exit code 0 and `sandbox discarded`.

The fixture changes only the upstream boundary through a harness wrapper. Browser login, pipe transport, model mapping, translation, stock-host credential persistence and stock-host streaming execute production code. Fixture replies prove transport and history handling, not live model intelligence. Live generation smoke requires separate explicit authorization and is never part of this command.

MIT licensed. Adapted components and inherited notices are recorded in `THIRD_PARTY_NOTICES`.
