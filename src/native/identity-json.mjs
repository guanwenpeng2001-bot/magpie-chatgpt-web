// Only process-local execution/round and instruction identities use this format.
// Do not apply it to capabilities, outgoing content or durable checkpoint hashes.
// JSON.stringify's replacer preserves its undefined/array/toJSON semantics while
// making JSON object key insertion order irrelevant, including nested objects.
export function identityJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const ordered = Object.create(null);
    for (const key of Object.keys(item).sort()) ordered[key] = item[key];
    return ordered;
  });
}
