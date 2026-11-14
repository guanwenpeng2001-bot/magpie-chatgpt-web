export function patchNativeAdditionalContext(source) {
  const helper = `function magpieNativeAdditionalContext(e){return e?.type==="function_call_output"&&e.namespace==="agent"&&typeof e.name==="string"&&e.name.trim().length>0&&typeof e.id==="string"&&e.id.startsWith("fco_")&&!Object.hasOwn(e,"call_id")&&typeof e.output==="string"&&!!Se(e)?.trim()&&Q(e.internal_chat_message_metadata_passthrough)?.content_item_kinds===void 0&&yr(e)===void 0}function magpieHasAdditionalContext(e){let n=Q(e._rawBody)?.input;return Array.isArray(n)&&n.some(magpieNativeAdditionalContext)}`;
  const edits = [
    ['function zl(e){', helper + 'function zl(e){'],
    ['let _=I,R=Rh(i,_.call_id);i.push({role:"toolResult",toolCallId:_.call_id,toolName:R.name,toolNamespace:R.namespace,content:Sh(_.output),isError:!1,timestamp:o});continue}',
      'let _=I,R=magpieNativeAdditionalContext(_)?{name:_.name,namespace:_.namespace}:Rh(i,_.call_id);i.push({role:"toolResult",toolCallId:_.call_id,toolName:R.name,toolNamespace:R.namespace,content:Sh(_.output),isError:!1,timestamp:o});continue}'],
    ['while(s?.type==="message"&&(s.role==="developer"||zl(s))){',
      'while(s?.type==="message"&&(s.role==="developer"||zl(s))||magpieNativeAdditionalContext(s)){'],
    ['while(a?.type==="message"&&(a.role==="developer"||wx(a)||zl(a))){',
      'while(a?.type==="message"&&(a.role==="developer"||wx(a)||zl(a))||magpieNativeAdditionalContext(a)){'],
    ['if(o.cwd===void 0||i||this.codexHomes.length>1||o.sandboxPolicy.type!=="dangerFullAccess"&&!r.statesNetworkAccess)',
      'if(o.cwd===void 0||i||this.codexHomes.length>1||magpieHasAdditionalContext(e)||o.sandboxPolicy.type!=="dangerFullAccess"&&!r.statesNetworkAccess)'],
    ['this.codexHomes.length>1?"current native task ownership":"network access"',
      'this.codexHomes.length>1||magpieHasAdditionalContext(e)?"current native task ownership":"network access"'],
    ['this.codexHomes.length>1)throw Error("No current native Codex task proof in the trusted homes",{cause:r});',
      'this.codexHomes.length>1||magpieHasAdditionalContext(e))throw Error("No current native Codex task proof in the trusted homes",{cause:r});'],
  ];
  for (const [before] of edits) if (source.split(before).length !== 2) throw new Error('Native additional context anchor mismatch');
  for (const [before, after] of edits) source = source.replace(before, () => after);
  return source;
}
