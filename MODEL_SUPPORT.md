# Model support audit

Checked on 2026-11-13 against this account's 23-entry catalogue, the ordinary Chat picker, the Work saved-task picker and live submission results. Catalogue presence does not prove that this adapter can complete a usable answer. Twenty-one catalogue IDs have a mapped route; two remain explicitly unsupported.

## Public model presentation

Magpie exposes the base family once and sends the chosen effort in `x-magpie-effort`. The plugin verifies the resulting browser family and slider before sending; it never silently downgrades to a different family.

| Public family group | Browser efforts |
| --- | --- |
| GPT-5.6 Chat | `low` → Instant, `medium` → Medium, `high` → High, `xhigh` → Extra High, `max` → Pro |
| GPT-6 Chat | `low` → Instant, `medium` → Medium, `high` → High, `xhigh` → Extra High, `max` → Pro |
| Each of the eight GPT-5.6/GPT-6 Work families | `low` → Light, `medium` → Medium, `high` → High, `xhigh` → Extra High, `max` → Max, `ultra` → Ultra |

The six ordinary Chat alias catalogue rows (`-instant`, `-thinking`, `-pro` for each family) are represented by these variants rather than duplicate model cards. Without an effort header, a base ID uses the verified Medium/default browser state. `auto` remains the explicitly requested page-default mode.

## Native Pro context guard (0.5.4)

Explicit Native GPT-5.6 Pro and GPT-6 Pro selectors remain available with Bigger Context off. Their published window stays approximately 105.6K with a reference 95K compaction target. Bigger Context does not enlarge Pro: ~276K live requests delivered all parts but recovered only 4/12 distributed markers in tool/no-tool controls. The runtime rejects compiled Pro input at or above 112,193 tokens before browser work, including clients holding an older 316.7K catalogue. This is the ordinary reference boundary, not a claim that every input below it has been exhaustively validated. The source history is never truncated to make it fit.

Pro compaction also checks the complete history before the reference compiler's fit recovery. With Bigger Context off, its separate 110,000-byte inline ceiling can be reached below the token limit. Eligible complete baseline summaries now try the reference's two-part and then six-part transport, with its actual staging and final-part preflight. If neither fits, the plugin returns `context_length_exceeded` without dropping records. Explicit multipart settings remain unchanged. This does not enlarge the token or inline budget or guarantee model recall. The 110,000-byte ceiling applies to compaction, not ordinary Pro requests; ordinary inputs still have their token, composer-character and attachment limits.

## Sol large-context limitation (0.5.6)

On Pro-capable accounts, Native GPT-6 Sol and GPT-5.6 Sol now retain baseline 111,193 input / 95,000 compaction settings even when Bigger Context is enabled; the published window is 105,556. Their dedicated route IDs remain available, without a Bigger Context label. Renewed near-window tests delivered every fragment, but compaction summaries preserved only 7/12 and 4/12 marker values respectively. GPT-6 finished the tool workflow; GPT-5.6 timed out after compaction. Neither passed the full-window retention gate.

The runtime rejects affected full inputs at or above 111,193 before browser work, including tools and stale-catalogue requests. Compaction rejects before dropping records to fit. This is conservative mitigation, not a measured safe capacity or a lossless repair for already oversized history. Other capability tiers require their own evidence. See [verification](docs/verification-0.5.6.md).

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

The ceiling is inclusive of the 8,192-token product reserve and image reserves. The plugin measures the complete prepared request dynamically for every call. It does not keep a fixed number of turns, slice history into fixed segments, or silently drop messages. When a large Agent supplies hundreds of tools, every tool name, required input property and final result-validation schema is retained while the browser copy progressively removes verbose descriptions and nonessential schema annotations. If that complete compacted catalogue still reaches the browser ceiling, the request fails as `contextLength` rather than hiding tools. Compatible hosts receive the advertised ceiling and can also apply their own compaction. The error carries `estimated`, `limit`, `limitKind` and `model` values, and advises starting a new chat, compacting, or removing history, images or tool schemas. There is no automatic history truncation.

Automatic turns keep the complete client tool catalogue available so the Web model, rather than a runtime keyword whitelist, decides whether an action is needed. Indirect, mixed-language, informational and otherwise unclassified prompts therefore cannot silently lose local capability. Large catalogues use the all-tool schema compaction above. Explicit host tool choices remain authoritative, and a tool named explicitly with an execution verb is handled deterministically. If the site returns only an opening action marker, the backend asks for the missing JSON in that same temporary Chat with at most two bounded repair attempts, validates the result against the original schema and emits one complete host tool call. A complete SSE action can also recover a DOM answer that rendered only a prefix when the SSE text exactly extends it. After a tool result, the plugin tracks explicitly named tool occurrences in the original request and forces only the next named action that remains; unrelated tools stay optional.

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

Legacy pickers without an effort control may still select an exact base-model row; an explicit effort variant never uses that fallback.

Unsupported entries remain visible with `[not yet supported]`. Requests fail explicitly as `modelUnsupported`, without inferring account access or substituting a different model.

Windows/account-specific inspection; other accounts and future UI variants require revalidation.
