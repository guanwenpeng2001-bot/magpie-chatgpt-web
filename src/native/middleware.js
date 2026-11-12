// 0.1.3930 runs this after the Node onRequest hook, before provider-specific
// metadata stripping. This restricted runtime has its own ctx.state and no
// raw request headers. Only the nonce crosses from the Node hook's state.
export function onProvider(body, ctx) {
  const provider = "chatgpt-web";
  if (!body) return;
  if (!ctx || !ctx.provider || (ctx.provider.id !== provider && ctx.provider.id !== provider + "-plugin")) {
    if (body.client_metadata) {
      delete body.client_metadata["x-magpie-native-nonce"];
      delete body.client_metadata["x-magpie-native-checked"];
    }
    for (const item of Array.isArray(body.input) ? body.input : []) if (item && typeof item === "object") {
      delete item.__magpie_native_ticket;
    }
    return body;
  }
  if (!body.client_metadata) return;
  const nonce = body.client_metadata["x-magpie-native-nonce"];
  const route = ctx.provider.model;
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(nonce)
      || typeof route !== "string" || !/^native\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]{1,100}$/.test(route)) return;
  body.client_metadata["x-magpie-native-checked"] = JSON.stringify({ nonce, provider: ctx.provider.id, route });
  return body;
}
