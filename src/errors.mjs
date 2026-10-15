// Canonical error taxonomy for the chatgpt-web plugin.
// backend/guard.mjs duplicates this table verbatim; keep both in lockstep
// (test/errors-parity.test.mjs runs on integrated main).

export const errors = Object.freeze({
  expired: { status: 401, template: 'Sign in again to refresh the ChatGPT session.' },
  cooldown: { status: 429, template: 'The account is cooling down after a rate limit.' },
  upstream: { status: 502, template: 'The upstream request failed.' },
  requestBudget: { status: 504, template: 'This request exceeded its local time budget and was stopped before any confirmed result.' },
  empty: { status: 502, template: 'ChatGPT returned an empty reply.' },
  hidden: { status: 502, template: 'ChatGPT hid the reply from the conversation.' },
  truncated: { status: 502, template: 'ChatGPT stopped before confirming the reply was complete.' },
  unsupported: { status: 400, template: 'This provider accepts text and client tool blocks; attachments and other content blocks are unavailable.' },
  invalidRequest: { status: 400, template: 'The request is invalid.' },
  toolDefinition: { status: 400, template: 'The tool definitions are invalid or use unsupported schema keywords.' },
  toolChoice: { status: 400, template: 'The tool choice is invalid or names an undefined tool.' },
  toolUnknown: { status: 502, template: 'ChatGPT requested an undefined tool.' },
  toolJSON: { status: 502, template: 'ChatGPT returned malformed tool-call JSON.' },
  toolSchema: { status: 502, template: 'ChatGPT tool arguments do not match the input schema.' },
  toolChoiceViolation: { status: 502, template: 'ChatGPT did not follow the requested tool choice.' },
  toolParallel: { status: 502, template: 'ChatGPT emitted multiple tool calls when parallel calls were disabled.' },
  toolIncomplete: { status: 502, template: 'ChatGPT ended the reply inside an incomplete tool call.' },
  toolRequired: { status: 502, template: 'ChatGPT did not produce the required tool call.' },
  toolDelimiter: { status: 502, template: 'ChatGPT returned a malformed tool-call delimiter.' },
  toolLimit: { status: 502, template: 'The tool call or schema validation exceeded its complexity limit.' },
  binding: { status: 409, template: 'The conversation belongs to another account or its history was replayed or changed.' },
  temporary: { status: 502, template: 'Temporary chat could not be confirmed; no message was sent.' },
  pageShape: { status: 502, template: 'The ChatGPT page or model picker changed; update the plugin.' },
  harvest: { status: 502, template: 'The answer reader failed; no completed reply can be confirmed.' },
  protocol: { status: 502, template: 'The backend or upstream protocol is invalid.' },
  verification: { status: 502, template: 'ChatGPT asked to verify you are human. Complete verification in the open browser, then retry the chat.' },
  capacity: { status: 503, template: 'Local backend capacity is exhausted; active work and cooldowns may clear, but sign-in blocks persist until the backend restarts.' },
  browserDependency: { status: 503, template: 'The playwright-core dependency is unavailable; install the packaged dependency.' },
  browserProfile: { status: 502, template: 'The browser profile restored a page other than about:blank.' },
  browserConfiguration: { status: 502, template: 'Browser account or profile root configuration is invalid.' },
  browserClosed: { status: 503, template: 'The browser context closed or its supervisor stopped.' },
  backendDown: { status: 503, template: 'Backend unavailable; install Node 20 or newer and Chrome.' },
  signinTimeout: { status: 504, template: 'Sign-in did not finish within {windowMinutes} minutes. Start sign-in again; the previous attempt was cancelled cleanly.' },
  missingComponent: { status: 503, template: '{component} was not found. {remedy}' },
  pickerMissing: { status: 502, template: 'The ChatGPT page changed: {component} was not found (selector {selector}, adapter {adapterVersion}). Update the plugin; if it is already latest, report this adapter version.' },
  pickerAmbiguous: { status: 502, template: 'The model picker shows {count} entries for {slug}; the plugin cannot choose safely. Retry, or select the model once by hand in a visible browser (enable \'visible-turns\').' },
  modelNotOffered: { status: 400, template: '{slug} is not offered to this ChatGPT account. Pick one of the listed models; refresh the model list if the account changed.' },
  attachmentUnsupported: { status: 400, template: 'This message contains {kind}, which chatgpt-web cannot send. Remove it and retry. Images are supported up to {maxCount} files / {maxBytes} each.' },
  imageRejected: { status: 502, template: 'ChatGPT refused the image upload ({detail}). Retry; if it persists, send the message without the image.' },
});

export const messageTemplate = code => Object.hasOwn(errors, code) ? errors[code].template : errors.upstream.template;
export const statusFor = code => Object.hasOwn(errors, code) ? errors[code].status : errors.upstream.status;
