import { createHash } from 'node:crypto';

const fingerprint = value => value === undefined ? null
  : createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const efforts = new Set(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);

// Observe the pinned adapter's already-resolved identities. No raw identity,
// prompt, capability, model name or metadata leaves this projection.
export function ownershipSnapshot(value) {
  try {
    const effort = typeof value.reasoning === 'string' ? value.reasoning : value.reasoning?.effort;
    return { compaction: value.compaction === true,
      executionHash: fingerprint(value.executionKey), ownerHash: fingerprint(value.ownerKey),
      sourceHash: fingerprint(value.sourceKey), instructionHash: fingerprint(value.instruction?.current),
      predecessorHashes: [...(value.instruction?.predecessors ?? [])].slice(-8).map(fingerprint),
      modelHash: fingerprint(value.model),
      effort: efforts.has(effort) ? effort : 'unknown',
      turnHash: fingerprint(value.identity?.turnId), threadHash: fingerprint(value.identity?.threadId),
      itemHash: fingerprint(value.revision?.itemId), contentHash: fingerprint(value.revision?.content) };
  } catch { return null; }
}

export function parseOwnershipSnapshot(value) {
  if (!value || typeof value !== 'object' || typeof value.compaction !== 'boolean'
    || ![...efforts, 'unknown'].includes(value.effort)
    || !Array.isArray(value.predecessorHashes) || value.predecessorHashes.length > 8
    || !value.predecessorHashes.every(x => typeof x === 'string' && /^[a-f0-9]{16}$/.test(x))) return;
  const names = ['executionHash', 'ownerHash', 'sourceHash', 'instructionHash', 'modelHash',
    'turnHash', 'threadHash', 'itemHash', 'contentHash'];
  if (names.some(name => value[name] !== null && (typeof value[name] !== 'string' || !/^[a-f0-9]{16}$/.test(value[name])))) return;
  return { type: 'ownership', compaction: value.compaction, effort: value.effort,
    ...Object.fromEntries(names.map(name => [name, value[name]])), predecessorHashes: [...value.predecessorHashes] };
}
