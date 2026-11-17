// Pinned v6.1.18 transform. The caller must validate ORIGINAL cli.js SHA-256
// df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1 first.
// Self-contained for preload embedding with patchToolDiscovery.toString().
// This changes discovery result content, shared by live broker delivery and
// prompt replay; it does not register tools or modify host call arguments.
export function patchToolDiscovery(source) {
  if (typeof source !== 'string') throw new TypeError('Native tool discovery requires source text');
  const resultAnchor = 'toolName:"tool_search",content:y&&R.length===0?`Tool search failed (status: ${b.status}).`:R.length?`Tool search loaded these tools \\u2014 they are now in your available tools. Call one by its EXACT name: ${R.join(", ")}.`:"Tool search returned no tools.",isError:y&&R.length===0,timestamp:o});continue}';
  // Bind the inserted helper to the shipped builder and inventory projection,
  // rather than recreating namespace, custom-tool, or transport-limit logic.
  const anchors = [
    resultAnchor,
    'if(M==="tool_search_output"){s.length=0;let b=I,_=Array.isArray(b.tools)?b.tools:[];l.push(..._);let R=[];',
    'function Ph(e){if(!e)return;let t=[],n=(o,i)=>{let a={name:o.name,description:o.description??"",parameters:o.parameters??{}};',
    'function mt(e){return It(e.namespace,e.name)}',
    'function Hm(e){if(Tl(e))return`${e.description}\n\n${Cl}`;',
    'function Wm(e){if(!e.namespace&&e.name==="write_stdin"){let i=structuredClone(e.parameters),a=i.properties;',
    'if(!Tl(e))return e.parameters;let t=structuredClone(e.parameters),n=t.properties&&typeof t.properties==="object"&&!Array.isArray(t.properties)?t.properties:{},r=n.timeout_ms',
  ];
  for (const [index, anchor] of anchors.entries()) {
    if (source.split(anchor).length !== 2) throw new Error(`Native tool discovery anchor mismatch: ${index}`);
  }
  if (source.includes('magpieDiscoveredToolContracts')) throw new Error('Native tool discovery anchor mismatch: helper collision');

  // Serialized into the bundle: only the checked bundle functions and standard
  // globals may be referenced. Bounds apply to complete UTF-8 JSON, never to
  // individual schema fields. No defaults, coercion, aliasing, or truncation.
  function magpieDiscoveredToolContracts(specs) {
    const tools = Ph(specs) ?? [];
    const fallback = (reason = 'tool_discovery_result_too_large') => JSON.stringify({
      tools: [], total: tools.length, schemas_included: false,
      reason,
      inventory: { tool: 'codex_tool_inventory', arguments: { include_schema: true, offset: 0, limit: 1 } },
      message: 'Complete discovered contracts are not included here. Inspect codex_tool_inventory using the current turn reference; follow next_offset or query the exact tool name. If no complete schema is available, report that limitation. Do not guess arguments.',
    });
    if (tools.length > 50) return fallback();
    const leaves = specs.flatMap(spec => spec?.type === 'namespace' && Array.isArray(spec.tools) ? spec.tools : [spec]);
    if (tools.length !== leaves.length || tools.some((tool, index) =>
      !tool.name || typeof tool.description !== 'string'
      || !tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)
      || (!tool.freeform && !tool.toolSearch && (leaves[index]?.parameters == null
        || typeof leaves[index].parameters !== 'object' || Array.isArray(leaves[index].parameters))))) {
      return fallback('tool_discovery_contract_unavailable');
    }
    const result = {
      tools: [], total: tools.length, schemas_included: true,
      message: 'Use the exact wire_name with codex_tool_call and the current turn reference. Pass structured arguments for function/tool_search tools, or input for freeform tools. These contracts describe host tools; they are not new ChatGPT-native tool registrations.',
    };
    let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    try {
      for (const tool of tools) {
        const entry = {
          wire_name: mt(tool), name: tool.name, namespace: tool.namespace ?? null,
          description: Hm(tool), kind: tool.freeform ? 'freeform' : tool.toolSearch ? 'tool_search' : 'function',
          parameters: Wm(tool),
        };
        bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8') + (result.tools.length ? 1 : 0);
        if (bytes > 65_536) return fallback();
        result.tools.push(entry);
      }
    } catch {
      return fallback('tool_discovery_contract_unavailable');
    }
    return JSON.stringify(result);
  }

  // Leave all failure statuses (including partial results), empty results, and
  // their isError/call-id behavior unchanged. Only successful nonempty search
  // results gain complete effective contracts.
  const replacement = resultAnchor.replace(':R.length?`', ':R.length?y?`')
    .replace('.`:"Tool search returned no tools."', '.`:magpieDiscoveredToolContracts(_):"Tool search returned no tools."');
  return source.replace(resultAnchor, () => replacement) + '\n' + magpieDiscoveredToolContracts.toString() + '\n';
}
