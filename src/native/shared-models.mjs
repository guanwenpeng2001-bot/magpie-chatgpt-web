import { nativeRoute } from './models.mjs';

// The host can rotate accounts only when their catalogues share a model ID.
// Keep old account-specific IDs for existing chats; automatic selectors are
// published only by an account whose native runtime can serve that exact model.
export function withSharedNativeModels(models) {
  const shared = {}, pinned = {};
  for (const [id, descriptor] of Object.entries(models)) {
    const route = nativeRoute(id);
    if (!route?.daemonSupported || route.profile === 'auto' || descriptor.capabilities?.toolcall !== true) {
      pinned[id] = descriptor;
      continue;
    }
    const common = `native/auto/${route.slug}`;
    shared[common] = { ...structuredClone(descriptor), id: common,
      api: { ...descriptor.api, id: common } };
    pinned[id] = { ...descriptor, name: `${descriptor.name} — Pinned account` };
  }
  return { ...shared, ...pinned };
}
