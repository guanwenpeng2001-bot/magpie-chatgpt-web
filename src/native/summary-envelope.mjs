// Magpie wraps the exact memento summary in its own transparent envelope before
// Codex persists it. Decoding is transport compatibility only: the reference's
// account-owned checkpoint registry must still authenticate scope and summary.
export function decodeMagpieSummary(value) {
  if (typeof value !== 'string' || !value.startsWith('magpie1:')) return null;
  try {
    const encoded = value.slice('magpie1:'.length);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { return null; }
}
