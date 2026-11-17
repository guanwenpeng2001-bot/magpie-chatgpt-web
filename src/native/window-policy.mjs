import { createHash } from 'node:crypto';

// Experimental only: deliberately NOT imported by production runtime.mjs.
export const PINNED_WINDOW_CLI_SHA256 = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
export const WINDOW_POLICY_ANCHORS = Object.freeze({
  aggregate: 'return tn(o.contextWindow*Ir,o.autoCompactTokenLimit*Ir)',
  staging: 'let o=e===Ie?["low"]:t.proAvailable?["low","medium","max"]:["low","medium"];',
  trim: 'while(b()&&T.length>1){let y=_===0?1:0;',
});

/** A local experimental allocation, NOT an interpretation of max_tokens as input.
 * Nt already includes the reference's 8192 product reserve. Subtract only the
 * explicit output allowance here, not that product reserve a second time.
 */
export function nativeWindowPolicy({ accountCatalogMaxTokens = 410_000, outputReserveTokens = 16_384 } = {}) {
  if (!Number.isSafeInteger(accountCatalogMaxTokens) || accountCatalogMaxTokens <= 0) throw new TypeError('Invalid account catalogue ceiling');
  const totalWindowCeiling = Math.min(400_000, accountCatalogMaxTokens);
  if (!Number.isSafeInteger(outputReserveTokens) || outputReserveTokens <= 0
      || outputReserveTokens >= totalWindowCeiling - 8_192) throw new TypeError('Invalid output reserve');
  return Object.freeze({
    schemaVersion: 1, experimental: true, verifiedWebCapacity: false,
    officialTotalWindowTokens: 400_000, accountCatalogMaxTokens,
    catalogSemantics: 'unknown; used only as an additional conservative ceiling',
    totalWindowCeiling, outputReserveTokens,
    inputTokenCeilingExclusive: totalWindowCeiling - outputReserveTokens,
    referencePlatformReserveTokens: 8_192,
    physicalProMessageTokens: 104_000, physicalProComposerChars: 1_635_000,
    reasoningReserveVerified: false,
  });
}

export function patchNativeWindowPolicy(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('Expected pinned source text');
  if (createHash('sha256').update(source).digest('hex') !== PINNED_WINDOW_CLI_SHA256) throw new Error('Window policy pinned checksum mismatch');
  const policy = nativeWindowPolicy(options);
  for (const [name, anchor] of Object.entries(WINDOW_POLICY_ANCHORS)) {
    if (source.split(anchor).length !== 2) throw new Error(`Window policy ${name} anchor mismatch`);
  }
  if (source.includes('magpieWindowProbeEnabled')) throw new Error('Window policy helper collision');
  const enabled = 'function magpieWindowProbeEnabled(model,effort,caps,family){return model===Wn&&effort==="max"&&caps?.proAvailable===true&&caps?.experimentalWindowPolicy===true&&(family==="6"||family==="5.6")}';
  return source
    .replace(WINDOW_POLICY_ANCHORS.aggregate,
      `return magpieWindowProbeEnabled(e,t,n,r)?tn(${policy.inputTokenCeilingExclusive},Math.min(o.autoCompactTokenLimit*Ir,${policy.inputTokenCeilingExclusive - 1})):tn(o.contextWindow*Ir,o.autoCompactTokenLimit*Ir)`)
    // v_ has no final effort/family argument. Only an isolated Pro probe may set
    // this private experimental capability; it is not a provider option.
    .replace(WINDOW_POLICY_ANCHORS.staging,
      'let o=e===Wn&&t.proAvailable===true&&t.experimentalWindowPolicy===true?["max"]:e===Ie?["low"]:t.proAvailable?["low","medium","max"]:["low","medium"];')
    .replace(WINDOW_POLICY_ANCHORS.trim,
      'if(magpieWindowProbeEnabled(f,s.effort,t,e._chatgptModelFamily)&&b())throw new q("Experimental Pro compaction cannot fit complete history; no records removed",{status:400,errorType:"invalid_request_error",code:"context_length_exceeded",retryable:!1});'
      + WINDOW_POLICY_ANCHORS.trim)
    + '\n' + enabled + '\n';
}
