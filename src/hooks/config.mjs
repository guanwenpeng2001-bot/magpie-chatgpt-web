export const PROVIDER = 'chatgpt-web';
export const API = 'https://chatgpt.com/backend-api';

export function configHook() {
  return async config => {
    config.provider ??= {};
    config.provider[PROVIDER] ??= { name: 'ChatGPT Web', npm: '@ai-sdk/anthropic', api: API, models: {} };
  };
}
