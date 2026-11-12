# Model support audit

Checked on 2026-11-12 against this account's 23-entry catalogue and the ordinary ChatGPT web picker. Catalogue presence does not prove that this adapter can select a model. All eight mapped IDs passed live UI selection checks; this is separate from sending a completed chat.

On the current power picker, base IDs use the explicitly selected Medium setting; thinking aliases also select Medium. This prevents a previous Pro/Instant choice from leaking into a later request. `auto` remains the explicitly requested page-default mode.

| Model ID | Catalogue name | Current plugin route |
| --- | --- | --- |
| `gpt-5-6` | GPT-5.6 Sol | GPT-5.6 Sol → Medium (UI selection checked) |
| `gpt-5-6-instant` | GPT-5.6 Sol | GPT-5.6 Sol → Instant (UI selection checked) |
| `gpt-5-6-thinking` | GPT-5.6 Sol | GPT-5.6 Sol → Medium (UI selection checked) |
| `gpt-5.6-sol-wm` | GPT-5.6 Sol | Not yet supported: Work mode is a different surface |
| `gpt-6-sol-wm` | GPT-6 Sol | Not yet supported: Work mode is a different surface |
| `gpt-6-luna-wm` | GPT-6 Luna | Not yet supported: Work mode is a different surface |
| `gpt-6.1-sol-wm` | GPT-6.1 Sol | Not yet supported: Work mode is a different surface |
| `gpt-5.6-terra-wm` | GPT-5.6 Terra | Not yet supported: Work mode is a different surface |
| `gpt-5.6-luna-wm` | GPT-5.6 Luna | Not yet supported: Work mode is a different surface |
| `gpt-6-astra-wm` | GPT-6 Astra | Not yet supported: Work mode is a different surface |
| `gpt-6.1-terra-wm` | GPT-6.1 Terra | Not yet supported: Work mode is a different surface |
| `gpt-5-6-pro` | GPT-5.6 Pro | GPT-5.6 Sol → Pro (UI selection checked) |
| `gpt-6-pro` | GPT-6 Pro | GPT-6 → Pro (UI selection checked) |
| `gpt-5-6-mini` | GPT-5.6 Luna | Not yet supported: no distinct mini selector in this surface |
| `gpt-5-6-t-mini` | GPT-5.6 Luna | Not yet supported: no distinct mini selector in this surface |
| `research` | Deep Research | Not yet supported: separate research workflow |
| `gpt-6` | GPT-6 | GPT-6 → Medium (UI selection checked) |
| `gpt-6-instant` | GPT-6 | GPT-6 → Instant (UI selection checked) |
| `gpt-6-thinking` | GPT-6 | GPT-6 → Medium (UI selection checked) |
| `gpt-6-t-mini` | GPT-6 | Not yet supported: no distinct mini selector in this surface |
| `gpt-6-mini` | GPT-6 | Not yet supported: no distinct mini selector in this surface |
| `chatgpt_alpha_model_external_access_reserved_gate_13` | Newly create multisys_rollout | Not yet supported: no corresponding experimental selector |
| `chatgpt_alpha_model_external_access_reserved_gate_12` | New multisys_rollout model biz | Not yet supported: no corresponding experimental selector |

Legacy pickers without an effort control may still select an exact base-model row; explicit Instant/Thinking/Pro variants never use that fallback.

Unsupported entries remain visible with `[not yet supported]`. Requests fail explicitly as `modelUnsupported`, without inferring account access or silently substituting another model.

Windows/account-specific inspection; other accounts and future UI variants require revalidation.
