import { complete, prepare } from "./provenance.mjs";

export function onRequest(body, ctx) { return prepare(body, ctx); }
export function onResponse(_body, ctx) { complete(ctx?.state?.webGptNonce); }
