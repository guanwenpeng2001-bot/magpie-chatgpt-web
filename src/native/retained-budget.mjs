// The retained handoff sends a short control message to an owned source page.
// Its full canonical history is counted for usage, not submitted again. Keep
// fresh-page compiler and physical-Send limits unchanged, including fallback.
export function patchNativeRetainedBudget(source) {
  const edits = [
    ['if(y.effort==="max"||nativeSolContextGuarded(f.modelId,f._chatgptModelFamily,y.effort,R)){try{let magpieInput=',
      'if((!f._compactionRequest||!magpieManagedRetention||!l.localToolsEnabled||!i)&&(y.effort==="max"||nativeSolContextGuarded(f.modelId,f._chatgptModelFamily,y.effort,R))){try{let magpieInput='],
    ['A=T.length,I=v(T);if(s.effort==="max")assertNativeProContext',
      'A=T.length,I=v(T);if(e._compactionRequest&&r?.magpieCountOnly===magpieRetainedUsageToken)return I;if(s.effort==="max")assertNativeProContext'],
    ['Qu({type:"final",answer:F},wo(f,{answer:F,reasoning:[]},R,c,s,e.chatgptWeb?.appName),T)',
      'Qu({type:"final",answer:F},magpieRetainedUsage(f,{answer:F,reasoning:[]},R,c,s,e.chatgptWeb?.appName),T)'],
  ];
  for (const [before] of edits) {
    if (source.split(before).length !== 2) throw new Error('Native retained compaction budget anchor mismatch');
  }
  for (const [before, after] of edits) source = source.replace(before, () => after);
  // A private symbol prevents serialized request/options from selecting the
  // accounting-only compiler path. Only the completed authenticated handoff
  // calls this helper; it neither prepares nor returns a browser submission.
  return source + '\nconst magpieRetainedUsageToken=Symbol("retained-usage");'
    + '\nfunction magpieRetainedUsage(e,t,n,r,o,i){let a=Du(e,n,{appName:i,magpieCountOnly:magpieRetainedUsageToken,'
    + 'captureLunaCheckpoint:!1,experimentalSkillAttachments:o,experimentalMultipartParts:r?Jn:void 0}),'
    + 's=W_(q_(t),e.modelId);return{inputTokens:a,outputTokens:s,totalTokens:a+s,estimated:!0}}';
}
