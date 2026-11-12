import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Bridge } from './bridge.mjs';
import { configHook, PROVIDER } from './hooks/config.mjs';
import { authHook } from './hooks/auth.mjs';
import { providerHook } from './hooks/provider.mjs';
import { chatHeadersHook } from './hooks/chat-headers.mjs';
import { describeCatalogue } from './models.mjs';
import { makeLoader } from './loader.mjs';
import { repairActivatedCodexRoute, resolveCodexHome } from './codex-profile.mjs';

function createHooks(env) {
  return { config: configHook(), auth: authHook(env), provider: providerHook(env), 'chat.headers': chatHeadersHook() };
}

export default {
  id: PROVIDER,
  async server(input) {
    const codexHome = resolveCodexHome();
    const log = input?.client?.app?.log;
    const repairCodexRoute = async () => {
      try {
        const result = await repairActivatedCodexRoute({ codexHome });
        if (result.changed) await log?.({ body: { service: PROVIDER, level: 'info', message: 'codexHttpRouteRepaired' } });
      } catch (error) {
        try {
          await log?.({
            body: { service: PROVIDER, level: 'warn', message: 'codexHttpRouteRepairFailed', extra: { error: String(error?.message ?? error) } },
          });
        } catch {}
      }
    };
    await repairCodexRoute();
    const hooks = createHooks({ input, bridge: new Bridge(), profileRoot: resolve(homedir(), '.config', 'magpie', 'chatgpt-web-profile') });
    const models = hooks.provider.models;
    hooks.provider.models = async function modelsAfterRouteRepair(...args) {
      await repairCodexRoute();
      return models.apply(this, args);
    };
    return hooks;
  },
};
export const _internal = { createHooks, mapModels: describeCatalogue, describeCatalogue, makeLoader };
