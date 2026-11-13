import { complete, prepare } from "./provenance.mjs";

export function onRequest(body, ctx) { return prepare(body, ctx); }
export function onResponse(_body, ctx) {
  // The installed host reuses this hook's private state on success/failure;
  // middleware state is a different object and must never own this cleanup.
  complete(ctx?.state?.webGptNonce);
  if (ctx?.state) delete ctx.state.webGptNonce;
}
