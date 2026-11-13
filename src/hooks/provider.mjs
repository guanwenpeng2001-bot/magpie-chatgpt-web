import { BackendError } from '../bridge.mjs';
import { describeCatalogue } from '../models.mjs';
import { requireAuth } from './auth.mjs';
import { providerNativeOptions } from '../native/models.mjs';
import { PROVIDER } from './config.mjs';

export function providerHook({ bridge, profileRoot, native, input }) {
  return {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (!auth) return provider.models;
      try {
        const enabled = native && (input?.magpie?.option?.(PROVIDER, 'native-tools') ?? true);
        const catalogue = await bridge.call({ method: 'models', auth: requireAuth(auth), profileRoot,
          ...(enabled ? { nativeOptions: providerNativeOptions(input) } : {}) });
        const models = describeCatalogue(catalogue);
        if (native && (input?.magpie?.option?.(PROVIDER, 'native-tools') ?? true)) {
          try {
            const nativeModels = await native.models(auth, models, catalogue);
            if (Object.keys(nativeModels).length) return { ...nativeModels, ...models };
          } catch { /* account remains usable through text mode */ }
        }
        if (Object.keys(models).length) return models;
      } catch (error) {
        if (error?.signIn === 'expired' || (error instanceof BackendError && error.code !== 'upstream')) throw error;
      }
      return Object.defineProperty({ ...provider.models }, Symbol.for('magpie.fellBack'), { value: true });
    },
  };
}
