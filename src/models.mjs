import { IMAGE_MODEL } from '../backend/site-adapter/images.mjs';
import { compatibilityTable } from '../backend/site-adapter/compatibility.mjs';
import { selectionPlans } from '../backend/site-adapter/compatibility.mjs';
import { workModels } from '../backend/site-adapter/compatibility.mjs';
import { resolveChatGptWebContextLimit } from './usage/context.mjs';

export function describeCatalogue(catalogue, table = compatibilityTable) {
  const models = (Array.isArray(catalogue?.models) ? catalogue.models : []).filter(model =>
    typeof model?.slug === 'string' && model.slug.trim() && typeof model.title === 'string' && model.title.trim());
  const titles = new Map();
  for (const model of models) titles.set(model.title, (titles.get(model.title) ?? 0) + 1);
  const result = Object.fromEntries(models.sort((left, right) => Number(right.slug === 'auto') - Number(left.slug === 'auto')).map(model => {
    const { slug, title } = model;
    if (Object.hasOwn(selectionPlans, slug) && !['gpt-5-6', 'gpt-6'].includes(slug)) return [slug, null];
    const annotation = Object.hasOwn(table, slug) ? table[slug] : {};
    const imageMimeTypes = model.product_features?.attachments?.image_mime_types;
    const imageOk = annotation.imageOk === true || (
      Array.isArray(imageMimeTypes) && imageMimeTypes.some(type => ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(type))
    );
    const name = annotation.name ?? (titles.get(title) > 1 && slug.endsWith('-mini') ? `${title} (${slug})` : title);
    return [slug, {
      name: annotation.knownBroken ? `${name} [not yet supported]` : name, api: { id: slug },
      limit: { context: resolveChatGptWebContextLimit(slug).limit, output: 34_834 },
      prefer_websockets: false,
      capabilities: { reasoning: false, toolcall: false, attachment: imageOk, temperature: false,
        input: { text: true, image: imageOk }, output: { text: true } },
    }];
  }).filter(([, model]) => model));
  const chatVariants = Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map(level => [level, {}]));
  for (const slug of ['gpt-5-6', 'gpt-6']) {
    if (!result[slug]) continue;
    result[slug].capabilities.reasoning = true;
    result[slug].variants = chatVariants;
  }
  const workVariants = Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(level => [level, {}]));
  for (const slug of Object.keys(workModels)) {
    if (!result[slug]) continue;
    result[slug].capabilities.reasoning = true;
    result[slug].variants = workVariants;
  }
  if (models.some(model => model.enabled_tools?.includes('image_gen_tool_enabled'))) result[IMAGE_MODEL] = {
    name: 'ChatGPT Images (saved chat - local image file)', api: { id: IMAGE_MODEL }, limit: { context: 8000, output: 4096 },
    prefer_websockets: false,
    capabilities: { reasoning: false, toolcall: false, attachment: false, temperature: false, input: { text: true, image: false }, output: { text: true } },
  };
  return result;
}
