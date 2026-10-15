export const compatibilityTable = Object.freeze({});

export function annotate(slug, title) {
  return { name: title || slug, imageOk: false, knownBroken: null, ...compatibilityTable[slug] };
}
