import { compatibilityTable } from '../backend/site-adapter/compatibility.mjs';

export function describeCatalogue(catalogue, table = compatibilityTable) {
  const models = (Array.isArray(catalogue?.models) ? catalogue.models : []).filter(model =>
    typeof model?.slug === 'string' && model.slug.trim() && typeof model.title === 'string' && model.title.trim());
  const titles = new Map();
  for (const model of models) titles.set(model.title, (titles.get(model.title) ?? 0) + 1);
  return Object.fromEntries(models.sort((left, right) => Number(right.slug === 'auto') - Number(left.slug === 'auto')).map(({ slug, title }) => {
    const annotation = Object.hasOwn(table, slug) ? table[slug] : {};
    const imageOk = annotation.imageOk === true;
    const name = annotation.name ?? (titles.get(title) > 1 && slug.endsWith('-mini') ? `${title} (${slug})` : title);
    return [slug, {
      name, api: { id: slug }, limit: { context: 200_000, output: 34_834 },
      capabilities: { reasoning: false, toolcall: false, attachment: imageOk, temperature: false,
        input: { text: true, image: imageOk }, output: { text: true } },
    }];
  }));
}
