// Prompt-only edit to the automatic compaction contract in pinned v6.1.18.
// The production preload MUST verify the original cli.js SHA-256 first:
// df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1.
// Keep this function self-contained: its bytes are embedded in the preload.
// The compiler places this contract in inline prompts and multipart commits,
// so its existing budgeting and usage accounting include the added guidance.
// No history rewriting, extraction, recovery, routing or capability changes.
export function patchNativeCompactionGuidance(source, { retained = false } = {}) {
  if (typeof source !== 'string') throw new TypeError('Native compaction guidance source must be a string');
  const before = ':["This is a Codex history-compaction checkpoint, not a normal task turn.","Do not call local or ChatGPT-native tools. Summarize only the supplied task context according to the final compaction instruction.","Return only the checkpoint summary that the next model needs to resume the task."]:s.localTools?';
  const guidance = [
    'When the user requests later recall, preserve exact original identifier names, field labels, and key-value associations together in the checkpoint. Keep their spelling, capitalization, punctuation, units, and scope. Do not substitute a value for its identifier or replace literal names with positional descriptions or renamed labels.',
    'Prefer supplied source facts over assistant paraphrases that rename, swap, or conflate identifiers and values. Distinguish source evidence from assistant claims, and retain explicit later corrections with their attribution.',
    'If an original name, value, or association is missing, ambiguous, or conflicting in the supplied context, state the uncertainty and what is missing. Do not invent or reconstruct missing associations, or claim to recover omitted history.',
  ];
  const after = before.replace(']:s.localTools?', ',' + guidance.map(text => JSON.stringify(text)).join(',') + ']:s.localTools?');
  if (source.split(before).length !== 2) throw new Error('Native automatic compaction guidance anchor mismatch');
  source = source.replace(before, () => after);
  if (retained) {
    const control = '"Automatic Codex context compaction has started. Stop ordinary task work and do not call any more work tools.",ri,...xv(e,t),';
    if (source.split(control).length !== 2) throw new Error('Native retained compaction guidance anchor mismatch');
    source = source.replace(control, () => control.replace('ri,...xv', 'ri,' + guidance.map(text => JSON.stringify(text)).join(',') + ',...xv'));
  }
  return source;
}
