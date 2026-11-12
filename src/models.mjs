import { IMAGE_MODEL } from '../backend/site-adapter/images.mjs';
import { compatibilityTable } from '../backend/site-adapter/compatibility.mjs';

export function describeCatalogue(catalogue, table = compatibilityTable) {
  const models = (Array.isArray(catalogue?.models) ? catalogue.models : []).filter(model =>
    typeof model?.slug === 'string' && model.slug.trim() && typeof model.title === 'string' && model.title.trim());
  const titles = new Map();
  for (const model of models) titles.set(model.title, (titles.get(model.title) ?? 0) + 1);
  const result = Object.fromEntries(models.sort((left, right) => Number(right.slug === 'auto') - Number(left.slug === 'auto')).map(({ slug, title }) => {
    const annotation = Object.hasOwn(table, slug) ? table[slug] : {};
    const imageOk = annotation.imageOk === true;
    const name = annotation.name ?? (titles.get(title) > 1 && slug.endsWith('-mini') ? `${title} (${slug})` : title);
    return [slug, {
      name: annotation.knownBroken ? `${name} [not yet supported]` : name, api: { id: slug }, limit: { context: 200_000, output: 34_834 },
      capabilities: { reasoning: false, toolcall: false, attachment: imageOk, temperature: false,
        input: { text: true, image: imageOk }, output: { text: true } },
    }];
  }));
  if (models.some(model => model.enabled_tools?.includes('image_gen_tool_enabled'))) result[IMAGE_MODEL] = {
    name: 'ChatGPT Images (saved chat - local image file)', api: { id: IMAGE_MODEL }, limit: { context: 8000, output: 4096 },
    capabilities: { reasoning: false, toolcall: false, attachment: false, temperature: false, input: { text: true, image: false }, output: { text: true } },
  };
  return result;
}
