# Model support audit

Checked on 2026-11-12 against this account's 23-entry catalogue, the ordinary Chat picker, the Work saved-task picker and live submission results. Catalogue presence does not prove that this adapter can complete a usable answer. Twenty-one catalogue IDs have a mapped route; two remain explicitly unsupported.

On the current power picker, base IDs use the explicitly selected Medium setting; thinking aliases also select Medium. This prevents a previous Pro/Instant choice from leaking into a later request. `auto` remains the explicitly requested page-default mode.

## Local context and usage estimates

ChatGPT does not expose an official token count for this browser transport. Magpie usage is therefore a local estimate, not an OpenAI token count, quota reading or billing record. The plugin computes all values below before or while the turn runs:

```text
textTokens = ceil(UTF-8 bytes / 3) + ceil(non-ASCII code points / 2)
promptTokens = textTokens(prepared browser prompt)
imageTokens = 4,096 per default image, or 8,192 when source.detail = "original"
inputTokens = 8,192 + promptTokens + imageTokens
outputTokens = textTokens(visible assistant text + tool input JSON)
```

The prepared browser prompt already includes system text, conversation history, tool schemas, delimiters and prompt templates, so those diagnostic component counts are not added a second time. Model descriptors advertise the routed browser ceiling below instead of the former 200,000-token value, while 34,834 remains an output planning value.

| Routed mode | Conservative input ceiling | Basis |
| --- | ---: | --- |
| Instant, remote mini, page-default `auto`, unknown | 41,000 | Smallest documented Sol browser boundary |
| Default, Thinking, request-only Thinking mini, Work | 90,000 | Documented Plus Medium/High browser boundary |
| Explicit Pro | 111,001 | Documented Pro Max browser boundary |

The ceiling is inclusive of the 8,192-token product reserve and image reserves. The plugin measures the complete prepared request dynamically for every call. It does not keep a fixed number of turns, slice history into fixed segments, or silently drop messages. When a large Agent supplies hundreds of tools, the plugin keeps core controls plus tools relevant to the current turn and progressively removes verbose descriptions and nonessential schema annotations until the Web prompt fits below half the selected transport ceiling. Full schemas remain local for validating returned arguments. Compatible hosts receive the advertised ceiling and can also apply their own compaction. An estimate equal to or above the ceiling is rejected as `contextLength` with HTTP 400 before the browser turn opens. The error carries `estimated`, `limit`, `limitKind` and `model` values, and advises starting a new chat, compacting, or removing history, images or tool schemas. There is no automatic history truncation.

Magpie already records usage for proxied requests from the Anthropic stream, so the plugin does not also call `input.magpie.usage`, which is reserved for out-of-band plugin-originated requests. Every successfully translated response emits one `message_start` with estimated `input_tokens`, `cache_creation_input_tokens: 0` and `cache_read_input_tokens: 0`, then one terminal `message_delta` with estimated `output_tokens`. Streaming accumulates translated text plus tool JSON; nonstreaming reconstructs the same fields from the same frames. Tool rounds are separate responses and therefore separate usage records. Errors and cancellations stop before a successful terminal delta, preventing a second or falsely completed record.

Limits that cannot be measured locally remain outside this estimate: tokenizer merges differ from the future browser tokenizer, hidden reasoning is not emitted by the browser, uploaded image bytes are represented by a fixed reserve, Work/automatic modes use conservative shared ceilings, and caching is not exposed. The estimate must not be used as evidence of exact usage or remaining quota.

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
| `gpt-6-t-mini` | GPT-6 | Request-only exact model override after GPT-6 Thinking UI bridge (live completion checked) |
| `gpt-6-mini` | GPT-6 | Not yet supported: current live submission produced an empty answer |
| `chatgpt_alpha_model_external_access_reserved_gate_13` | Newly create multisys_rollout | Request-only exact model override after GPT-6 Instant UI bridge (live completion checked) |
| `chatgpt_alpha_model_external_access_reserved_gate_12` | New multisys_rollout model biz | Request-only exact model override after GPT-6 Instant UI bridge (live completion checked) |

The account also exposes a capability-conditional **ChatGPT Images** entry. It is synthetic rather than a catalogue model ID: it uses the ordinary Chat surface's Create image tool, generates an image, then saves a validated local PNG/JPEG/WebP file under `~/.config/magpie/chatgpt-web-artifacts`. This creates a saved ordinary chat because the Create image control is disabled in Temporary Chat. During this audit the catalogue still declared image generation, but the current Create image row was disabled; the adapter checks that live state and reports `modelNotOffered` instead of submitting. An earlier live check generated and saved a valid PNG. No video-generation control was present in this account's current Chat or Work surface.

The exact `research` override completed with HTTP 200 but produced no assistant response or research canvas. The exact `gpt-6-mini` override completed with HTTP 200 but rendered only the empty assistant label. The exact `gpt-6-t-mini` override completed with the expected `OK` answer after selecting the GPT-6 Thinking bridge.

All 23 catalogue rows declare PNG, JPEG, GIF and WebP input attachments. The model descriptor now derives image-input capability from that catalogue evidence; document and other non-image attachments remain outside the adapter.

Legacy pickers without an effort control may still select an exact base-model row; explicit Instant/Thinking/Pro variants never use that fallback.

Unsupported entries remain visible with `[not yet supported]`. Requests fail explicitly as `modelUnsupported`, without inferring account access or substituting a different model.

Windows/account-specific inspection; other accounts and future UI variants require revalidation.
