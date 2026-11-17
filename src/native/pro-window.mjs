// Local allocation within the 400K total, not an official maximum input or
// generation entitlement. outputReserve covers reasoning and output together;
// Nt already includes the pinned 8192-token platform reserve.
export function nativeProWindowPolicy() {
  return { totalWindow: 400000, outputReserve: 128000, headroom: 16000, inputCeilingExclusive: 256000,
    autoCompact: 230400, codexEffectivePercent: 95, platformReserve: 8192,
    physicalMessageTokens: 104000, physicalComposerChars: 1635000 };
}

export function nativeProWindowEnabled(model, effort, capabilities, family) {
  return model === 'gpt-5.6-sol' && effort === 'max' && capabilities?.solAvailable === true
    && capabilities?.proAvailable === true && (family === undefined || family === '6' || family === '5.6');
}

export function chooseNativeProTransport(parsed, capabilities, turnToken, options, reference) {
  const { compile, messages, inputTokens, messageTokens, messageChars, textTokens, skillTokens,
    imageTokens, assertOrdinary, assertMultipart, AdapterError } = reference;
  let failure;
  const candidates = options?.experimentalMultipartParts === undefined ? [undefined, 2, 6] : [options.experimentalMultipartParts];
  for (const parts of candidates) {
    try {
      const compiled = compile(parsed, capabilities, turnToken, { ...options, experimentalMultipartParts: parts });
      if (compiled.trimmedCompactionMessages || (parts !== undefined && compiled.multipart?.parts.length !== parts)) {
        throw new Error('Native Pro transport must preserve every complete history record');
      }
      const total = inputTokens(compiled, parsed.modelId), maximum = messageTokens(compiled, parsed.modelId);
      if (!Number.isFinite(total) || total >= nativeProWindowPolicy().inputCeilingExclusive) {
        throw new AdapterError(`Native Pro input must remain below ${nativeProWindowPolicy().inputCeilingExclusive.toLocaleString('en-US')} tokens including the platform reserve.`, {
          status: 400, errorType: 'invalid_request_error', code: 'context_length_exceeded', retryable: false,
        });
      }
      if (!compiled.multipart) assertOrdinary(total, maximum, parsed.modelId, 'max', capabilities, messageChars(compiled));
      else {
        const physical = messages(compiled), stages = physical.slice(0, -1), final = physical.at(-1);
        assertMultipart(total, maximum, parsed.modelId, 'max', capabilities, messageChars(compiled), parts, {
          stagingEffort: 'max', maxStageMessageTokens: Math.max(...stages.map(text => textTokens(text, parsed.modelId))),
          maxStageChars: Math.max(...stages.map(text => text.length)),
          finalMessageTokens: textTokens(final, parsed.modelId) + skillTokens(compiled.skillFiles, parsed.modelId),
          finalMessageChars: final.length, finalImageTokens: imageTokens(compiled),
        }, parsed._chatgptModelFamily);
      }
      return compiled;
    } catch (error) {
      if (!(error instanceof AdapterError) || error.status !== 400 || error.errorType !== 'invalid_request_error'
          || error.code !== 'context_length_exceeded' || error.retryable !== false) throw error;
      failure = error;
    }
  }
  throw failure;
}

// Applied after the existing production patches, under runtime's original SHA
// check. Anchors must remain unique; no installed bundle is ever rewritten.
export function patchNativeProWindow(source) {
  const edits = [
    ['function at(e,t,n,r){', 'function at(e,t,n,r){if(nativeProWindowEnabled(e,t,n,r)){let p=nativeProWindowPolicy();return tn(p.inputCeilingExclusive,p.autoCompact)}'],
    ['function Xt(e,t,n,r){', 'function magpieCompileProOriginal(e,t,n,r){'],
    ['function Bu(e,t,n=!1,r){', 'function Bu(e,t,n=!1,r){if(nativeProWindowEnabled(e.modelId,e.options.reasoning,t,e._chatgptModelFamily))return;'],
    ['X=I?v_(e.modelId,i,L,W):a,', 'X=I?(nativeProWindowEnabled(e.modelId,a.effort,i,e.modelFamily)?ht(e.modelId,"max",i):v_(e.modelId,i,L,W)):a,'],
    ['if(c.multipart)y_(b,_,e.modelId,a.effort,i,y,c.multipart.parts.length,',
      'if(nativeProWindowEnabled(e.modelId,a.effort,i,e.modelFamily)&&I&&M)b=Math.max(b,nativeProWindowPolicy().platformReserve+I.reduce((z,V)=>z+Pe(V.text,e.modelId)+Pe(V.acknowledgement,e.modelId),0)+Pe(M,e.modelId)+Pi(c)+pn(c.skillFiles,e.modelId));if(c.multipart)y_(b,_,e.modelId,a.effort,i,y,c.multipart.parts.length,'],
    ['function y_(e,t,n,r,o,i,a,s,c){', 'function y_(e,t,n,r,o,i,a,s,c){if(nativeProWindowEnabled(n,r,o,c)&&s&&s.stagingEffort!=="max")throw new q("Native Pro stages must use max effort",{status:400,errorType:"invalid_request_error",code:"context_length_exceeded",retryable:!1});'],
    ['return delete u.comp_hash,delete u.availability_nux,u}',
      'if(nativeProWindowEnabled(t.backendModel,t.adapterEffort,n,i)){let p=nativeProWindowPolicy();Object.assign(u,{context_window:p.inputCeilingExclusive,max_context_window:p.inputCeilingExclusive,effective_context_window_percent:p.codexEffectivePercent,auto_compact_token_limit:p.autoCompact})}return delete u.comp_hash,delete u.availability_nux,u}'],
  ];
  if (typeof source !== 'string' || source.includes('function magpieCompileProOriginal(')) throw new Error('Native Pro window source mismatch');
  for (const [index, [before]] of edits.entries()) if (source.split(before).length !== 2) throw new Error('Native Pro window anchor mismatch: ' + index);
  for (const [before, after] of edits) source = source.replace(before, () => after);
  return source + '\nfunction Xt(e,t,n,r){if(!r?.manualControl&&nativeProWindowEnabled(e.modelId,e.options.reasoning,t,e._chatgptModelFamily)'
    + '&&!(e._compactionRequest&&r?.magpieCountOnly===magpieRetainedUsageToken))return chooseNativeProTransport(e,t,n,r,'
    + '{compile:magpieCompileProOriginal,messages:Ai,inputTokens:Nt,messageTokens:gs,messageChars:fs,textTokens:Pe,skillTokens:pn,imageTokens:Pi,assertOrdinary:Iu,assertMultipart:y_,AdapterError:q});'
    + 'return magpieCompileProOriginal(e,t,n,r)}\n';
}
