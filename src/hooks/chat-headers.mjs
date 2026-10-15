import { PROVIDER } from './config.mjs';

export function chatHeadersHook() {
  return async (input, output) => {
    if (input.model?.providerID === PROVIDER && typeof input.sessionID === 'string' && input.sessionID)
      (output.headers ??= {})['x-chatgptweb-conversation'] = input.sessionID;
  };
}
