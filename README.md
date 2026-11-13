# ChatGPT Web for magpie

Use your ChatGPT web session as a magpie provider. Sign-in always opens visible Chrome; chat turns run in the background by default. Sign-in lifecycle is live-verified; two consecutive live turns completed on Windows using the same ordinary Chrome session. Site verification can still occur. Turn budget and delivery cadence remain unmeasured. Whole-block replies are acceptable: progressive or token-level streaming is not verified.

Plugin version: `0.5.5`. Historical host verification used: magpie `0.1.3930` (see [release verification status](#release-verification-status) for scope and evidence).

## Native tools mode

Windows x64: the `native-tools` sign-in option is on by default. After browser sign-in, setup creates or reuses an OpenAI tunnel, a restricted Tunnels Read + Use runtime key, and a ChatGPT MCP connector with tool access. OpenAI Platform may require an additional sign-in. The pinned `codex-chatgpt-web` **v6.1.18 Full-mode daemon** and tunnel-client then run under the plugin. A failed setup leaves text mode available.

Setup adds a matching `native/<profile>/<model>` entry for each text model. An 18-model Plus account exposes 36 entries; a Pro account also gets two stable, explicit Pro selectors (38 total), even with Bigger Context off. Enabling `native-bigger-context` adds two dedicated Sol entries (38 Plus / 40 Pro total); Pro selectors retain the guarded ordinary budget. Existing aliases keep their conservative Instant-safe window; choose a dedicated Bigger Sol entry for the experimental reasoning window. Pro Bigger Context is disabled after large-context retention failed live verification. Supported Chat families use native tools. Work, mini and experimental entries that the reference daemon cannot serve use the exact matching text model and are labeled **Text fallback**; unsupported entries are labeled **Native unavailable**. The plugin never silently substitutes a different model family. Native limits and reasoning variants follow the saved account capabilities and the smallest window among an entry's efforts. Published windows use the reference auto-compaction target with a 90% mapping (Plus 32K Instant / 80K Medium–High, Pro 95K); Codex may reserve additional capacity. Pro advertises about 105.6K, and the runtime rejects compiled Pro input at or above 112,193 tokens before browser submission, even if a client still caches an older catalogue. The guard includes the reference reserve and never truncates input.

Use Magpie's native Codex Desktop route, with the built-in OpenAI provider pointing at Magpie. A generic Codex custom provider can remove native message identities before the plugin sees them. Native turns reuse the plugin-owned ordinary Chrome login context; the reference runtime disconnects from it on shutdown without closing the account browser.

The first setup downloads SHA-256-verified Windows releases (daemon v6.1.18, tunnel-client v0.0.16 including cloudflared) into `~/.config/magpie/chatgpt-web-native/`. Account storage states, runtime keys and configuration stay under that directory; protect it like your signed-in browser profile. POSIX files use mode 0600; Windows access follows the parent directory ACL. Existing mismatching installations are refused. The daemon uses its own isolated Codex state and does not configure the user's launcher. Each start stops and removes the account's earlier local tunnel aliases (the remote tunnel is kept), so only the current alias remains. The installer and account API accept an explicit root for isolated tests.

Native compaction runs in the same Full daemon as subsequent turns, using the reference's read-only summary path and its v1 replacement history, memento and v2 envelopes. A checksum-pinned Bun preload adapts the exact v6.1.18 bundle's compaction gate, browser acquisition and model-announcement parsing; the downloaded bundle remains unchanged. Continuation checkpoints survive daemon restarts through an atomic AES-256-GCM encrypted store bound to the canonical account home directory. Each account keeps at most 256 checkpoints in LRU order, with a 32 MiB serialized plaintext limit; the encryption key is stored separately. A completed compaction is returned only after its checkpoint is committed. Source hashes, task provenance and metadata checks remain enforced after recovery. The reference `/v1/models` passthrough needs a separate Codex credential, so browser model rows are derived locally.

The fallback path for native compaction requests and checkpoint-bearing continuations **fails closed with HTTP 503** (`native_compaction_unavailable` or `native_checkpoint_unavailable`) when native execution is unavailable. It submits no ordinary text request and no longer manufactures a text summary as a substitute for native compaction. Only ordinary uncompacted turns without native checkpoints are eligible for text fallback before submission. **Upgrade limitation:** checkpoints already lost by older versions cannot be recovered retroactively. For those conversations, recover trusted complete history or start a new turn with the original task; upgrading or restarting cannot recreate missing authorization.

Provider options: `native-bigger-context` defaults to **false**. `native-temporary-chats` defaults to **true**; turn it off to use saved ordinary chats for native turns, including connectors that require ordinary chats. **Restart Magpie after changing either option for it to take effect.** These options apply to native execution; ordinary text Chat still requires Temporary Chat.

Before Magpie transforms a native request, the local request hook captures its canonical body in bounded memory. The account-scoped loader restores that exact body after checking a private nonce and provider route. This preserves message identities, native metadata, tool definitions and trusted local environment paths across protocol conversion and masking. **Native mode sends original history and local paths to ChatGPT without gateway masking.** Snapshots are removed on request completion; they are never saved to disk. When the native runtime is unavailable, only ordinary uncompacted turns without native checkpoints may fall back to text before submission; a submitted native tool turn is never replayed through text mode.

中文：登录后自动创建或复用隧道、受限运行密钥及 MCP 连接器；可能需要再登录 OpenAI Platform。18 个文本模型会有 18 个对应入口；Plus 默认 36 个，Pro 另有 2 个稳定的独立 Pro 选择项，默认 38 个。Bigger Context 开启后增加 2 个专用 Sol 项，合计 Plus 38 个、Pro 40 个；Pro 大窗口因保留验证失败而停用，采用约 10.56 万的目录窗口和 112,193 tokens 的提交硬上限；原别名保留 Instant 保守窗口；参考运行时不支持的 Work、mini 等条目明确标记为文本备用，保持原模型身份。原生模式复用已登录的普通 Chrome，并通过账户目录绑定的 AES 加密检查点跨守护进程重启续接（最多 256 条、序列化明文上限 32 MiB）。旧版本已经丢失的检查点不能事后恢复。`native-temporary-chats` 默认开启，关闭后原生模式保存普通聊天；修改开关后重启 Magpie 生效。为验证 Codex 的工具环境，原生模式向 ChatGPT 发送未经网关脱敏的原始历史和本地路径；可关闭此选项并使用文本模型。原生工具提交后不会通过文本方式重放。

## Reference feature differences

Compared with `codex-chatgpt-web` v6.1.18; this is an implementation comparison, not additional live verification. Magpie owns its UI, model picker and Codex integration; the reference launcher UI is not required for this provider.

| Feature | This plugin |
| --- | --- |
| Temporary / ordinary Chat | Ordinary text Chat requires Temporary Chat. `native-temporary-chats` defaults to true; disable it for saved ordinary native chats. Restart Magpie after changing the option. Work and Images create saved tasks/chats. |
| Bigger Context | `native-bigger-context` is off by default. Enable it and restart Magpie to add two dedicated Sol entries. Pro selectors keep their guarded ordinary limits because large-context retention failed live verification. Pro selection does not require this option. Existing aliases retain conservative Instant-safe windows. |
| Native platforms | Pinned native installation is Windows x64 only. |
| Continuation checkpoints | Atomic AES-256-GCM persistence bound to the account directory; 256-entry LRU, 32 MiB serialized plaintext limit. Restarts recover committed checkpoints with source and metadata validation. Previously lost checkpoints cannot be recreated. Compaction/checkpoint text fallback fails closed with HTTP 503. |
| Native model coverage | Only supported daemon models run native tools. Other entries use the exact text model with a Text fallback label, or are marked Native unavailable. A `native/` ID alone does not imply native tool support. |
| Other reference modes | No Zero Risk manual-send workflow or Compatibility V1 selector; the daemon uses Full automatic mode and the Native subagent protocol. |

## Requirements and installation

Install magpie, Node.js 20 or later, Google Chrome and Git. No browser or runtime is bundled, and Edge fallback is not implemented. The backend runs under Node.js and drives Chrome through `playwright-core`, its sole declared npm dependency. Native mode separately downloads the pinned runtime and tunnel release described above; see [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

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

In the text backend, only one turn per account runs at a time, with pacing and rate-limit cooldown. Cancellation closes the active page and drops its local conversation binding; the exception is an unresolved verification recovery, whose visible page and binding are retained for retry. The next ordinary turn can rebuild from supplied history. Bindings expire after 30 idle minutes. For ordinary text Chat only, Temporary-chat state must be confirmed before sending; otherwise no message is submitted. The no-visible-history promise applies only to those ordinary text Chat turns. Work uses saved tasks and ChatGPT Images creates saved ordinary chats; both can leave visible account history and bypass the ordinary text Chat Temporary Chat check. Native mode uses `native-temporary-chats` (default true); disabling it saves ordinary chats after restarting Magpie. It does not use this text-backend check. The plugin never deletes remote conversations. Temporary Chat does not imply that OpenAI retains no data: the site's own policies still apply.

## Sign-out, removal and local data

```powershell
magpie plugin logout chatgpt-web
magpie plugin rm magpie-chatgpt-web
```

Sign-out removes the sign-in from magpie's credential store. Plugin removal uninstalls the plugin; use explicit sign-out first when you want to forget the stored credential. Neither operation erases the plugin-owned Chrome profile or deletes remote conversations. Host sign-out has no plugin notification hook for automatic profile cleanup.

To erase the local browser session too, stop active requests, close the plugin-owned Chrome windows, then delete only the corresponding account profile directory below `~/.config/magpie/chatgpt-web-profile/` (on Windows, below `$HOME/.config/magpie/chatgpt-web-profile/`). Use your file manager to select that directory. Delete the entire plugin profile root only if you intend to erase every plugin account's browser session. Never delete your normal Chrome profile. Deleting the profile does not replace magpie sign-out. The plugin records one unfinished sign-in profile for resume: when it is available, a new sign-in resumes it, and a completed sign-in retires that pending reference so the next account gets a fresh directory. A concurrent host uses a separate fresh directory without replacing the pending reference; retry progress in that concurrent directory is not retained by the pending claim. Unreferenced abandoned directories require manual cleanup. To identify referenced directories, inspect only the `profile` field of each ChatGPT Web account in `~/.config/magpie/plugin-auth.json`; each value names its directory below the profile root. Do not copy, log or share the store, which contains credentials. A directory is unreferenced only if neither any stored account's `profile` nor `signin.profile` names it; after stopping all plugin activity, those unreferenced directories may be removed manually. Do not delete `signin.profile` while a sign-in window is open: it is how a retry finds the profile to resume. An operating-system socket lock prevents another host process from adopting that pending profile during sign-in; a concurrent host gets a fresh profile instead. The operating system releases ownership when the holder exits, including a crash, so no stale lock file requires cleanup. If retiring the pending claim fails, sign-in fails with `browserConfiguration` instead of returning a credential; close programs holding the file and retry. A successful sign-in is reported only after its pending claim has been removed.

Browser state is a sensitive login artifact. Use a trusted workstation and never share profiles, cookies or credentials. Session material stays in plugin-owned local storage and magpie's credential store; it must not be logged or included in error reports, and is transmitted only across the boundaries needed to operate the session. Web-session automation is unofficial, may break when the site changes, and may risk account restrictions. Use only an account you are authorized to access. There is no automated challenge solving, defense bypass, account pooling or retry loop against site defenses.

## Models, images and delivery

The text model picker follows Magpie's native variant contract. ChatGPT exposes **2 base Chat families with 5 efforts each** (Instant, Medium, High, Extra High and Pro) and **8 base Work families with 6 efforts each** (Light, Medium, High, Extra High, Max and Ultra). Magpie sends the selected effort in `x-magpie-effort`; the plugin maps it to the browser's actual family and slider while keeping the public model ID stable. The account's remaining catalogue rows cover five request-only mini/experimental IDs, two explicitly unsupported entries, and a capability-conditional image model. Work models use the separate saved-task surface and never claim Temporary Chat semantics. Request-only IDs select a verified ordinary model as their UI bridge, then replace only the submitted JSON `model` field with the exact original ID. See [the full model audit](MODEL_SUPPORT.md). The two unsupported entries are marked `[not yet supported]` and fail as `modelUnsupported`, not as an account-permission claim. Streaming requests expose the initial Anthropic SSE frame immediately and continue relaying browser turn frames as they arrive, so Codex receives progress instead of waiting for the complete browser turn.

On the text path, image input is supported up to **4 images / 10 MiB each**; non-image attachments and over-cap input are rejected before submission. The catalogue-conditional **ChatGPT Images** entry uses the site's Create image tool, saves page-owned image blobs as local PNG/JPEG/WebP files under `~/.config/magpie/chatgpt-web-artifacts`, and returns local Markdown paths. That workflow creates a saved ordinary chat because Temporary Chat disables Create image. The plugin provides no dedicated video, web-search, canvas or voice workflow; this does not disable capabilities offered by ChatGPT or tools supplied by the native Codex harness. Account quota display is described below.

The model contracts differ by route. These descriptor values are transport planning metadata, not verified subscription or generation guarantees.

| Entry / route | Protocol and capabilities | Limits |
| --- | --- | --- |
| Text models | Anthropic-wire emulation; `toolcall: false`, `temperature: false`. Chat and Work base families expose effort variants through `reasoning: true`; request-level client-tool emulation is separate. | Conservative text context ceilings; output planning value 34,834, except ChatGPT Images (8,000 context / 4,096 output). Text image limits above apply. |
| Supported Native tools models | `@ai-sdk/openai`, Responses route to the Full daemon; `toolcall: true`, `reasoning: true`, `temperature: false`. Original history and tool metadata are restored before submission. | Context is the smallest published window among the entry's supported efforts; output descriptor is `0`, not a measured generation limit. Native input handling belongs to the daemon, not the text path's four-image preflight. |
| Text fallback entries | `native/` namespace and OpenAI Responses-facing descriptor, translated to the exact matching text model; `toolcall: false`, `temperature: false`. | Retain the matching text model's limits, modalities and variants. They do not gain native tools from their namespace. |

Entries labeled **Native unavailable**, including the native image entry, do not advertise native tool support. When the native runtime is unavailable, only ordinary uncompacted turns without native checkpoints may fall back to text before submission; a submitted native tool turn is never replayed through text mode.

Before opening a text-backend browser turn, the plugin dynamically estimates the complete prepared prompt, including system text, history, client tool schemas, the ChatGPT product reserve and image reserves. Conservative browser ceilings are **41,000** tokens for Instant and unknown/page-default modes, **90,000** for reasoning and Work modes, and **111,001** for Pro modes. Preflight follows the selected Magpie effort, so Instant cannot inherit a larger base-family ceiling. Codex and other compatible hosts receive a conservative model limit for their own compaction, while the same runtime estimate protects every Anthropic-compatible Agent that calls the provider. The plugin does not use a fixed message-count or fixed-segment trimming algorithm and never silently slices history. If a host still submits an oversized prompt, it fails with `contextLength` before navigation or submission. Magpie's existing proxied-request accounting reads the same estimates from Anthropic `message_start` (`input_tokens`, zero cache counters) and terminal `message_delta` (`output_tokens`). This avoids a second `input.magpie.usage` event. See [the estimate formulas and limitations](MODEL_SUPPORT.md#local-context-and-usage-estimates).

The text provider declares `npm: '@ai-sdk/anthropic'` for **Anthropic-wire emulation**: magpie sends Messages-shaped requests and receives translated responses. Requests are served through the ChatGPT web session, not the Anthropic service; this declaration does not establish native Anthropic semantics or capabilities.

In the text backend, visible browser turns read only the rendered DOM answer, so hidden intermediate stream messages cannot terminate a normal thinking response. Headless mode retains its optional SSE reader. DOM snapshots are the primary answer carrier, polled every 500 ms. That polling interval is an implementation setting, not measured delivery cadence. A best-effort SSE reader may carry the answer; `x-chatgptweb-route: dom|sse` identifies the route. DOM text can lose formatting. Clone unavailability is logged as an observation change, not a fabricated successful answer or an independent failure code. Whole-block delivery is acceptable; progressive or token-level streaming is not verified. An interrupted or unterminated answer remains an error.

## Context windows and compaction in Codex

Web entries do **not** all have a verified 1M context window. A model's underlying capacity, the browser request envelope, and the catalogue value used by Codex are different limits. Increasing a catalogue value does not increase the browser's ability to retain history.

The following values were read from the installed Magpie catalogue on the tested Pro-capable account. Bigger Context was enabled; it remains experimental. `K` means 1,000 tokens. Other account capabilities or host overrides can change these values.

| Entry | Published window | Codex effective display (95%) | Default compaction trigger (90%) |
| --- | ---: | ---: | ---: |
| Native GPT-5.6 Pro / GPT-6 Pro | 105,556 | 100,278 | 95,000 |
| Native GPT-6 Sol, Bigger Context | 240,000 | 228,000 | 216,000 |
| Native GPT-5.6 Sol, Bigger Context | 316,667 | 300,833 | 285,000 |
| Text reasoning / Work and their Text fallback entries | 90,000 | 85,500 | 81,000 |
| Text mini / conservative unknown routes | 41,000 | 38,950 | 36,900 |

These are configuration values, not successful full-window recall results. Without Bigger Context, supported Native Sol and Pro entries on this account publish 105,556 tokens. Grouped entries use the smallest window among their efforts. Unsupported entries do not become usable merely because a window is listed. GPT-6 Sol's reference target is 220,000, but this Magpie plugin contract cannot forward a separate per-model compaction threshold: Codex's 90% default starts at 216,000, earlier than that target. The current global Codex configuration has no `model_context_window` or `model_auto_compact_token_limit` override.

The reference's 1,050,000 Luna value is a separate rolling-checkpoint route. Its ordinary Free browser request budget is 28,000 tokens. That value is not evidence that a single Web request, every Work model, or the two Pro models can retain 1M tokens. Reference Bigger Context itself also uses smaller, model-specific limits.

Codex monitors estimated context usage and starts compaction at its configured threshold; `/compact` can request it explicitly. **90% is the trigger, not a fixed summary compression ratio.** The Native adapter asks the model for a continuation summary preserving progress, decisions, constraints, relevant results and unfinished work. Codex continues from the summary and retained messages. Summary length varies, and summarization can lose detail; it does not provide lossless expansion of the model window. Files already edited on disk remain on disk and can be read again.

The Native daemon records authenticated continuation state in an account-owned encrypted checkpoint store. A short live session compacted, survived a daemon restart, then read files and passed tests again. If that daemon or checkpoint state is unavailable, the plugin rejects Native compaction/continuation rather than silently substituting an unauthenticated text summary. Full large-window retention remains unverified: the Pro ~276K trials recovered only 4/12 markers. Pro expansion is consequently disabled, with a 112,193 compiled-input guard. See [the live evidence](docs/verification-0.5.4.md).

## Account quota and token accounting

Version 0.5.5 uses compact Chinese card wording: **剩余额度 / 未知：接口未返回额度**. Expiry, verification, payment issues and query failures retain distinct short reasons. The inspected reference v6.1.18 Limits screen counts local send receipts against static policies; it explicitly excludes usage outside its launcher. It does not supply a verified upstream remaining/reset response. This plugin does not present those local counts as actual ChatGPT quota.

From 0.5.4, the plugin supplies Magpie's `auth.usage` hook for the signed-in account's card under **Usage > Overview > Quota**. Without that hook, `magpie quota chatgpt-web --json` can return the host's generic `kind: "balance"` placeholder asking for a Balance URL and Balance field. That placeholder does not establish that ChatGPT Web needs a balance endpoint.

The quota path makes a non-interactive `GET /api/auth/session` read, with a 10-second budget and cancellation support. It does not submit a model request or open a browser for verification. Only allowlisted account metadata crosses the backend bridge; session credentials and raw upstream errors are not returned in the quota result.

| Account information | What the card can show |
| --- | --- |
| `account.planType` | A plan label when the response contains a recognized code: `free`, `go`, `plus`, `pro`, `prolite`, `team`, `business`, `enterprise` or `edu`. This identifies a plan, not its remaining allowance. |
| `account.isDelinquent === true` | A subscription payment-attention reason. Missing or false does not establish available quota. |
| Remaining allowance and reset times | **Unknown**, with a reason. The implementation has no verified numerical ChatGPT allowance schema and omits `used` at the JavaScript hook boundary rather than reporting a fabricated 0% used or 100% remaining. |

Installed **0.5.4** was live-verified with `magpie quota chatgpt-web --json` on Magpie **0.1.3930**: it returned `kind: "subscription"`, plan `ChatGPT Pro (prolite)` and an Unknown text window. The local evidence is `diagnosis-054-quota-live.json`. This confirms that the current account's recognized `prolite` plan reaches the quota hook; it does not verify every plan tier or the payment-attention outcome. A valid session can lack `account` or a recognized plan code, in which case the card explains that the plan and remaining allowance are unknown. Verification, expiry, rate limiting and read failures also get explicit reasons. Session expiry is not a quota reset or subscription renewal date. Plan names, advertised caps, local token totals and Codex `/wham/usage` counters are never used to infer ChatGPT remaining allowance.

The live JSON window contains `used: 0`, `remaining: 100` and `text: true`. Those numbers are **Go-normalized placeholders, not measured usage or remaining allowance**: the JavaScript boundary preserves an absent percentage as `null`, and Go fills its numeric fields while retaining the text flag. JSON consumers must honor `text: true` and display the window's `display` message, not treat it as 100% available. The installed host's UI renders Unknown without a percentage meter in both Used and Left modes; its Go routing excludes text-only windows from measured allowance, so this account is not ranked as full on that basis. The UI rendering functions were tested in an isolated DOM fixture, and focused upstream Go normalization/routing tests passed; this was not a new live UI session.

Request token accounting remains separate. The reported live checks for both Pro models already produced per-turn input/output records in `magpie usage --csv`; a missing quota card did not mean those requests were uncounted. Text-route counts remain the local estimates described above. Reading or refreshing the quota card emits no additional `input.magpie.usage` event, so it does not double-count requests. Offline tests additionally cover the installed Magpie 0.1.3930 hook contract, normalized text-window rendering and the absence of duplicate usage events. Neither the live quota result nor these tests establishes a measured remaining allowance.

## Release verification status

**0.5.4 local verification:** GPT-5.6 Pro and GPT-6 Pro each completed a real two-turn CLI read/failing-test/edit/passing-test cycle. After installation, GPT-6 Pro compacted a short session, survived a daemon restart and read files/passed tests in that same session. Large-context transmission reached about 276K input tokens, but only 4/12 independent markers were recovered. The same retention failure occurred with no tool calls and with all-Pro staging; the experimental staging change was reverted. Pro Bigger Context is therefore disabled: stable Pro selectors publish about 105.6K and the runtime enforces the ordinary 112,193-token compiled-input boundary. No full-window success is claimed. See [verification evidence](docs/verification-0.5.4.md).

**0.5.3: verified on Windows with Codex CLI 0.167.2 and Magpie 0.1.3930.** A Native session read a fixture, observed its failing test, fixed the implementation with `apply_patch`, and passed `node --test`. That session then produced two real compactions and an encrypted checkpoint. After daemon/plugin restarts, the same session executed file reads and passed its test in both ordinary and temporary chat modes, with Bigger Context enabled. Routing records confirm the plugin served the exact `gpt-6-sol` model. The Pro account catalogue exposes 40 entries with Bigger Context enabled, including the 240K Sol and approximately 316.7K Pro entries; full-window saturation was not tested.

The live run also reproduced the Web model changing the last character of a mixed-case tool capability. Native turn tokens now use 160 random bits encoded in 32 lowercase Crockford characters; exact credential matching and revocation remain enforced. The successful ordinary and temporary chat tool rounds used this format. This reduces transcription risk without claiming that model-generated tool arguments can never be wrong.

Regression evidence: 1,078 tests, 1,073 passed, 5 platform/gated skips; the separate pinned-runtime smoke passed restart/re-compaction, write-failure and exact-token authorization cases. Real headed/headless Chrome launch and package gates passed. The pinned runtime tests use synthetic browser answers; the account runs above are the separate live evidence.

For 0.5.0, a real Codex CLI 0.167.2 session on Windows used `chatgpt-web/native/<profile>/gpt-6` at high effort through Magpie 0.1.3930's built-in OpenAI route. ChatGPT Web called the account's MCP connector over the OpenAI tunnel; Codex ran `exec_command` to read a deliberately failing project, applied `apply_patch` to fix it, and ran `node --test` with 1 pass. Resuming that session with a low auto-compaction limit produced two Codex context compactions from the same Full daemon, after which native tools added a function and test and `node --test` passed 2 of 2. When Magpie translates a request (for example because Codex offers web search), it offers custom and namespaced tools as flat functions; native calls are returned in that offered shape so Codex still runs them.

For 0.4.7, Magpie `0.1.3930` exposed 18 ChatGPT Web entries: two Chat base families with five efforts each, eight Work base families with six efforts each, the request-only/experimental rows and the conditional image model. Live `gpt-6` `max` and `gpt-6.1-sol-wm` `ultra` requests completed. A real Codex CLI session using `gpt-6` ran two sequential `exec_command` tools, and a separate session completed `apply_patch` followed by an `exec_command` read without a reconnect prompt. A live streamed GPT-6 `auto` turn recovered a marker-only Web response, returned `exec_command`, resumed the same temporary Chat with the local tool result, and finished with estimated SSE usage on both rounds. Oversized input was rejected before opening a browser turn at the selected effort's boundary. The serial suite passed **710 tests with 709 passes, 0 failures and 1 intentional skip**; the separate headed/headless Chrome launch gate and package gate also passed.

For 0.4.6, explicit project inspection phrases force an Agent action while conceptual and explanatory questions remain text-only. The 0.4.5 Magpie native Desktop route completed a live `chatgpt-web/gpt-6` request without changing the main Codex configuration. Earlier custom-provider checks completed `exec_command` on GPT-5.6 Pro and GPT-6 Pro, `apply_patch` followed by `exec_command` on GPT-6, a persisted-session resume, and per-round Magpie usage records. The current 330-tool Codex catalogue is bounded by the same preflight; larger client catalogues may still contain client-specific behavior beyond these tests.

For 0.4.0, ordinary GPT-6 Pro and GPT-5.6 Pro completed live source-backend turns; all eight Work IDs passed live UI selection checks and GPT-6 Luna Work completed a live saved-task turn. GPT-5.6 mini, GPT-5.6 Thinking mini and both experimental catalogue IDs passed live request-override and DOM-completion checks after their browser bundles were installed. ChatGPT Images generated and saved a valid PNG through the source backend. A representative 36-tool Claude-shaped request completed both through the source backend and the real Magpie `/v1/messages` route with HTTP 200 and the requested `tool_use`.

The larger Claude Desktop catalogue has been observed with up to 255 tools, and the current Codex host emitted 330. Preflight now accepts up to **512** tools. For a large catalogue, the plugin retains every tool name, required input property and final validation schema, then shrinks descriptions and nonessential schema annotations in stages until the prepared request stays below half of the selected Web context. Every returned action is checked against the original complete schema. If the complete compacted catalogue still reaches the transport ceiling, preflight fails instead of silently hiding tools. This does not claim that every client-specific tool succeeds: research, browser/computer tools and site-side behavior remain outside the verified scope.

For 0.3.1, two consecutive live `auto` turns completed through both the source backend and the installed backend on Windows, returning `BROWSER_OK_1` and `BROWSER_OK_2` over the DOM route without a manual verification click. Explicit `gpt-5-6-pro` selection also completed a live source-backend turn. The final automated suite passed 600 tests; its one default skip, the real-Chrome launch gate, passed separately. Visible turns use DOM-only observation after earlier stream-based probes exposed empty/hidden intermediate responses. These are short functional checks, not a guarantee against future site verification or a benchmark; other accounts and model families remain unverified. Historical acceptance records below describe the earlier build, not the current browser-session checks.

### Turn-budget measurement

Unmeasured: live turn measurement was blocked by the durable verification challenge recorded in `verification/verify-live-acceptance-r3.md`. No successful live-turn timing establishes the turn budget. See the `verification` row in the [failure table](#failure-messages) for the condition and manual recovery action; that action is not a verified workaround for the challenged session.

### Delivery-cadence measurement

Unmeasured: live turn measurement was blocked by the durable verification challenge recorded in `verification/verify-live-acceptance-r3.md`. The backend assembles whole-block replies and emits one content delta after observation returns, by construction (`verification/verify-live-acceptance.md:183-201`). The 500 ms DOM poll is an implementation setting, not measured delivery cadence. See the `verification` row in the [failure table](#failure-messages); no live arrival cadence is claimed.

### Running host identity and bundle SHA-256

Live verification for `0.4.7` ran against magpie `0.1.3930`, host bundle `host-e6801c6cb0f6.js`, 166 257 bytes, SHA-256 `e6801c6cb0f61553ca747c2b02209bfe87720183b37bb8840d08bcfb5352c5f3`, and Codex CLI `0.167.2`.

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

The shared layer gives the Web model use of the calling Agent's local harness without exposing an inbound MCP port or tunnel. The Web model asks for a nonce-delimited action in ordinary response text; the plugin validates that action and renders a standard synthetic `tool_use` block. The outer Agent then executes it under its own local sandbox and permissions, and the tool result returns through the same browser conversation. The plugin never executes filesystem or command tools itself. Explicit host tool choices remain authoritative. With the host's usual `auto` choice, the plugin keeps every tool available and lets the Web model make the semantic decision; runtime keyword matching no longer forces a call, ranks tools or removes the tool catalogue. Large catalogues use all-tool schema compaction. If ChatGPT ends at a bare opening marker, the backend asks for only the missing JSON in the same temporary Chat, with at most two bounded repair attempts, before emitting the tool call. Exact tool names with an execution verb remain deterministic, and after a tool result the plugin re-checks each explicitly named action so a multi-step request is not reported complete while a requested command remains unexecuted.

Argument objects arrive in one `input_json_delta`. Text and tool parsing occur incrementally as browser answer snapshots arrive. Tool IDs, results and error flags survive subsequent rounds in the same temporary ChatGPT task; a changed or edited history, tool catalogue, tool choice or image payload causes a safe full rebuild instead of pairing a new request with an old submitted page.

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
