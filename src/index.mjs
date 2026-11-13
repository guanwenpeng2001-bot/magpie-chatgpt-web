import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Bridge } from './bridge.mjs';
import { configHook, PROVIDER } from './hooks/config.mjs';
import { authHook } from './hooks/auth.mjs';
import { providerHook } from './hooks/provider.mjs';
import { chatHeadersHook } from './hooks/chat-headers.mjs';
import { describeCatalogue } from './models.mjs';
import { makeLoader } from './loader.mjs';
import { nativeClient } from './native/index.mjs';
import { usageHook } from './hooks/usage.mjs';

function createHooks(env) {
  return { config: configHook(), auth: { ...authHook(env), usage: usageHook(env) }, provider: providerHook(env), 'chat.headers': chatHeadersHook() };
}

export default {
  id: PROVIDER,
  async server(input) {
    const env = {
      input,
      bridge: new Bridge(),
      profileRoot: resolve(homedir(), '.config', 'magpie', 'chatgpt-web-profile'),
    };
    env.native = nativeClient(env);
    return createHooks(env);
  },
};
export const _internal = { createHooks, mapModels: describeCatalogue, describeCatalogue, makeLoader };
