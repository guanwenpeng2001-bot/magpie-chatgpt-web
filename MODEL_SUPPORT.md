# Model support audit

Checked on 2026-11-12 against this account's 23-entry catalogue, the ordinary Chat picker, the Work saved-task picker and live submission results. Catalogue presence does not prove that this adapter can complete a usable answer. Twenty catalogue IDs have a mapped route; three remain explicitly unsupported.

On the current power picker, base IDs use the explicitly selected Medium setting; thinking aliases also select Medium. This prevents a previous Pro/Instant choice from leaking into a later request. `auto` remains the explicitly requested page-default mode.

| Model ID | Catalogue name | Current plugin route |
| --- | --- | --- |
| `gpt-5-6` | GPT-5.6 Sol | GPT-5.6 Sol → Medium (UI selection checked) |
| `gpt-5-6-instant` | GPT-5.6 Sol | GPT-5.6 Sol → Instant (UI selection checked) |
| `gpt-5-6-thinking` | GPT-5.6 Sol | GPT-5.6 Sol → Medium (UI selection checked) |
| `gpt-5.6-sol-wm` | GPT-5.6 Sol | Work saved-task picker → GPT-5.6 Sol (selection checked) |
| `gpt-6-sol-wm` | GPT-6 Sol | Work saved-task picker → GPT-6 Sol (selection checked) |
| `gpt-6-luna-wm` | GPT-6 Luna | Work saved-task picker → GPT-6 Luna (live completion checked) |
| `gpt-6.1-sol-wm` | GPT-6.1 Sol | Work saved-task picker → GPT-6.1 Sol (selection checked) |
| `gpt-5.6-terra-wm` | GPT-5.6 Terra | Work saved-task picker → GPT-5.6 Terra (selection checked) |
| `gpt-5.6-luna-wm` | GPT-5.6 Luna | Work saved-task picker → GPT-5.6 Luna (selection checked) |
| `gpt-6-astra-wm` | GPT-6 Astra | Work saved-task picker → GPT-6 Astra (selection checked) |
| `gpt-6.1-terra-wm` | GPT-6.1 Terra | Work saved-task picker → GPT-6.1 Terra (selection checked) |
| `gpt-5-6-pro` | GPT-5.6 Pro | GPT-5.6 Sol → Pro (UI selection checked) |
| `gpt-6-pro` | GPT-6 Pro | GPT-6 → Pro (UI selection checked) |
| `gpt-5-6-mini` | GPT-5.6 Luna | Request-only exact model override after GPT-5.6 Instant UI bridge (live completion checked) |
| `gpt-5-6-t-mini` | GPT-5.6 Luna | Request-only exact model override after GPT-5.6 Thinking UI bridge (live completion checked) |
| `research` | Deep Research | Not yet supported: separate research workflow |
| `gpt-6` | GPT-6 | GPT-6 → Medium (UI selection checked) |
| `gpt-6-instant` | GPT-6 | GPT-6 → Instant (UI selection checked) |
| `gpt-6-thinking` | GPT-6 | GPT-6 → Medium (UI selection checked) |
| `gpt-6-t-mini` | GPT-6 | Not yet supported: current live submission produced a hidden/empty answer |
| `gpt-6-mini` | GPT-6 | Not yet supported: current live submission produced an empty answer |
| `chatgpt_alpha_model_external_access_reserved_gate_13` | Newly create multisys_rollout | Request-only exact model override after GPT-6 Instant UI bridge (live completion checked) |
| `chatgpt_alpha_model_external_access_reserved_gate_12` | New multisys_rollout model biz | Request-only exact model override after GPT-6 Instant UI bridge (live completion checked) |

The account also exposes a capability-conditional **ChatGPT Images** entry. It is synthetic rather than a catalogue model ID: it uses the ordinary Chat surface's Create image tool, generates an image, then saves a validated local PNG/JPEG/WebP file under `~/.config/magpie/chatgpt-web-artifacts`. This creates a saved ordinary chat because the Create image control is disabled in Temporary Chat. No video-generation control was present in this account's current Chat or Work surface.

Legacy pickers without an effort control may still select an exact base-model row; explicit Instant/Thinking/Pro variants never use that fallback.

Unsupported entries remain visible with `[not yet supported]`. Requests fail explicitly as `modelUnsupported`, without inferring account access or substituting a different model.

Windows/account-specific inspection; other accounts and future UI variants require revalidation.
