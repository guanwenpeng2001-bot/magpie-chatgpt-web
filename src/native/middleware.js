// Magpie runs this after privacy masking, in its gateway's restricted JS
// runtime. Keep it in sync with mark() in provenance.mjs.
export function onProvider(body, ctx) {
  const provider = "chatgpt-web";
  if (!body) return;
  if (ctx.provider.id !== provider && ctx.provider.id !== provider + "-plugin") {
    if (body.client_metadata) {
      delete body.client_metadata["x-magpie-native-nonce"];
      delete body.client_metadata["x-magpie-native-checked"];
    }
    for (const item of body.input || []) if (item && typeof item === "object") {
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
