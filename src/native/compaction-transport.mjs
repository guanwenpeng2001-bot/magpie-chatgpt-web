// Called only by the checksum-pinned compiler, after the complete inline input
// passes Native's baseline guards and before any compaction fit-recovery splice.
// All formatters, counters and transport checks below are the reference's pure
// functions, not approximations of browser limits or a new context preference.
export function chooseNativeCompactionTransport(parsed, capabilities, turnToken, options, effort, reference) {
  const { compile, messages, inputTokens, messageTokens, textTokens, skillTokens,
    imageTokens, stagingMode, assertMultipart, AdapterError } = reference;
  let failure;
  for (const parts of [2, 6]) {
    try {
      // Keep the real compaction contract and family/capabilities. Explicit parts
      // suppress this fallback on re-entry; the existing pre-trim guards remain.
      const compiled = compile(parsed, capabilities, turnToken, { ...options, experimentalMultipartParts: parts });
      if (compiled.trimmedCompactionMessages || compiled.multipart?.parts.length !== parts) {
        throw new Error('Native compaction transport did not preserve complete multipart history');
      }
      const physical = messages(compiled);
      const stages = physical.slice(0, -1);
      const final = physical.at(-1);
      const maxStageMessageTokens = Math.max(...stages.map(text => textTokens(text, parsed.modelId)));
      const maxStageChars = Math.max(...stages.map(text => text.length));
      const stage = stagingMode(parsed.modelId, capabilities, maxStageMessageTokens, maxStageChars);
      assertMultipart(inputTokens(compiled, parsed.modelId), messageTokens(compiled, parsed.modelId),
        parsed.modelId, effort, capabilities, Math.max(...physical.map(text => text.length)), parts, {
          stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars,
          finalMessageTokens: textTokens(final, parsed.modelId) + skillTokens(compiled.skillFiles, parsed.modelId),
          finalMessageChars: final.length, finalImageTokens: imageTokens(compiled),
        }, parsed._chatgptModelFamily);
      return compiled;
    } catch (error) {
      // Only the reference/Native non-retryable fit error permits another
      // allocation. Capability, protocol, parser and programming errors escape.
      if (!(error instanceof AdapterError) || error.status !== 400
        || error.errorType !== 'invalid_request_error' || error.code !== 'context_length_exceeded'
        || error.retryable !== false) throw error;
      failure = error;
    }
  }
  throw failure;
}
