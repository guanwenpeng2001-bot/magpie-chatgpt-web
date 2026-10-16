import { BackendError } from '../bridge.mjs';
import { describeCatalogue } from '../models.mjs';
import { requireAuth } from './auth.mjs';
import { PROVIDER } from './config.mjs';

export function providerHook({ bridge, profileRoot }) {
  return {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (!auth) return provider.models;
      try {
        const models = describeCatalogue(await bridge.call({ method: 'models', auth: requireAuth(auth), profileRoot }));
        if (Object.keys(models).length) return models;
      } catch (error) {
        if (error?.signIn === 'expired' || (error instanceof BackendError && error.code !== 'upstream')) throw error;
      }
      return Object.defineProperty({ ...provider.models }, Symbol.for('magpie.fellBack'), { value: true });
    },
  };
}
