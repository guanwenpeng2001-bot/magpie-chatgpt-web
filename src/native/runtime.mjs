import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const nativeRoot = () => resolve(homedir(), '.config/magpie/chatgpt-web-native');
export const RELEASES = Object.freeze([
  { name: 'runtime-6.1.18', url: 'https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.18/codex-chatgpt-web-windows-amd64.zip',
    sha256: '813690d379fd2fc91b0c95a54ab94026e9f53c53a5d43c39eeca98947cbf3fea', required: ['runtime/bun.exe', 'app/cli.js'] },
  { name: 'tunnel-0.0.16', url: 'https://github.com/openai/tunnel-client/releases/download/v0.0.16/tunnel-client-v0.0.16-windows-amd64.zip',
    sha256: 'edef7241b0c647fcb30f1a80ff376b6b25c51927960f257a3f01e21b17c2aba6',
    files: { 'tunnel-client.exe': '4226bb74a72388147882881f29f79801b95e285d731a138071812e3aa6766571',
      'cloudflared.exe': 'cd0bc49aec24d0d62a37b6e842dad46000f7b401f6167b4cbace4e170819c9a2',
      'cloudflared-manifest.json': '80003d8a8f38d6a0bd74aabc096e9f99a6e8fad8ed4da699e26a8231fa453aa1' } },
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const installing = new Map();

// Exact minified gate in the pinned Windows v6.1.18 bundle, corresponding to
// adapters/chatgpt-web/index.ts:936-937. Only automatic managed Chrome uses the
// existing read-only branch; Launcher/Zero Risk retain their structured handoff.
const compactionGate = 'let oe=(f.modelId!==Ie||c)&&l.localToolsEnabled;';
const sharedCompactionGate = compactionGate.slice(0, -1)
  + '&&!(e.chatgptWeb?.browserHost==="managed-chrome"&&e.chatgptWeb?.browserInteractionMode==="automatic");';
// Content-free phase boundaries distinguish an upstream delay from waiting for
// the old browser's physical settlement. They never change retirement order.
const compactionRetirement = 'if(se&&De.findConversationHead(se))await kt(De.retireConversationAndWait(se),v.abortSignal);else await De.retireAndWait(ae,v.abortSignal)';
const usageSubmissionStart = 'let ke=async()=>{if(!o)return;let E=ho(),z;';
const usageSubmissionEnd = 'm.push(ne)}},Be=c.text,ze=[];';
const ownershipEntry = 'let Qe=ed(e,f),N=await De.getOrCreateAfterOwnerRetirement(re,O,()=>C(f,D,Qe,R),Qe,v.abortSignal,qe,ve.threadId,$f(f)),K=Df(f)';
// Magpie's compact route can re-encode objects in a different key order. These
// two hashes are process-local; checkpoint hashes and their saved format stay
// unchanged so existing authenticated continuation records remain readable.
const executionIdentity = 'function Nu(e,t){return xs("sha256").update(JSON.stringify({modelId:e.modelId,reasoning:e.options.reasoning,payload:t})).digest("hex")}';
const instructionIdentity = 'let t=_i(e).map((r)=>xs("sha256").update(JSON.stringify([r.itemId??null,r.content])).digest("hex")),n=t.pop();';
const summaryDecoder = 'function $n(e){if(!e.startsWith(ni))return null;';
const cliSha256 = 'df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1';
const browserLaunch = 'ff.launch({executablePath:this.config.chromeExecutablePath,headless:!this.config.headed})';
// readChatGptModelAnnouncements, chatgpt-ui/model-picker.ts:125-127. Run in its
// existing DOM evaluation so the checked row and active header are one snapshot.
const modelAnnouncementTail = 'r.push(c.join(" "))}return r})}function fc(e)';
const checkpointRegistry = 'var Kt=new Map,dx=256;';
const checkpointRememberTail = 'while(Kt.size>dx)Kt.delete(Kt.keys().next().value)}function Nh';
const checkpointTouch = 'return Kt.delete(e),Kt.set(e,t),!0}';
const opaqueIdFactory = 'function ci(e){return`${e}_${Ev(24).toString("base64url")}`}';
const markdownGfmSetup = 'Vt.use(fC);';
const proContextGuard = 'else Iu(b,_,e.modelId,a.effort,i,y);let re=this.config.turnTimeoutMs';
const proRoundGuard = 'let D;if(y.localTools)try{D=m.resolve(f)}';
// Xt is the pinned compiler. I contains all restored records here, before
// compaction fit recovery can splice older messages out of T.
const solCompileGuard = 'A=T.length,I=v(T);if(!e._compactionRequest)return I;';
const solTrimGuard = 'while(b()&&T.length>1){let y=_===0?1:0;';
// Inside reconcileAssistantTurnBinding, after the missing/duplicate binding check
// and multipart reconciliation. This classifies failure only; it never rebinds.
const submittedAlertAnchor = 'await this.reconcileMultipartHistory(e,t,i,r);let a=new Set([...n.acceptedTurnIdentities,...t.initialTurnIdentities])';
// Only proof observation timeouts enter the original bounded recovery/progress
// catch. All other proof failures escape afterward, before response selection or
// tool acknowledgement, so liveness cannot suppress an authenticated error.
const submittedInitialObservationAnchor = 'let m;try{m=await this.submissionDomState(l,u.domCache,r),await this.reconcileMultipartHistory(l,u,m,r)}catch(w)';
const submittedInitialAlertAnchor = 'd=0,h=o?.snapshot();let g=Gi(u.initialTurnIdentities,m.responseIdentities);';
// Provenance is recorded only at the actual local multipart formatter call sites,
// never inferred from user-supplied text that happens to resemble a wrapper.
const submittedStageBaseline = 'let V=await this.captureSubmissionBaseline(O,z.text,ze);';
const submittedFinalBaseline = 'let oe=await this.captureSubmissionBaseline(O,Be,ze,c.turnToken),ae=';

// The 275K live multipart test delivered all stages but recovered only 4/12
// independent markers, even when all stages used Pro. Do not advertise or
// submit the experimental triple Pro budget until retention is verified.
// Keep the pinned reference's ordinary Pro boundary (including its reserve).
export function assertNativeProContext(inputTokens, effort, AdapterError) {
  if (effort === 'max' && inputTokens >= 112193) {
    throw new AdapterError('Native Pro input exceeds the guarded 112,193-token context limit. Compact the conversation or reduce its input; larger Pro contexts have not passed retention verification.', {
      status: 400, errorType: 'invalid_request_error', code: 'context_length_exceeded', retryable: false,
    });
  }
}

// Routing normalizes both Sol families to gpt-5.6-sol, preserving the actual
// family in _chatgptModelFamily (worker modelFamily). Do not infer family from
// a UI label, the staging effort, the Bigger toggle or caller window metadata.
export function nativeSolContextGuarded(modelId, family, effort, capabilities) {
  return modelId === 'gpt-5.6-sol' && (family === '6' || family === '5.6') && capabilities?.proAvailable === true
    && ['medium', 'high', 'xhigh'].includes(effort);
}

export function assertNativeSolContext(inputTokens, modelId, family, effort, capabilities, AdapterError, requiresTrimming = false) {
  if (!nativeSolContextGuarded(modelId, family, effort, capabilities)) return;
  if (requiresTrimming || inputTokens >= 111193) {
    throw new AdapterError(requiresTrimming
      ? `GPT-${family} Sol compaction cannot fit the complete history without dropping records. Reduce the supplied history explicitly or use another verified route; no history was silently removed.`
      : `GPT-${family} Sol input exceeds the guarded 111,193-token baseline limit for Pro-capable accounts. Larger-context retention has not passed verification. Reduce the supplied history explicitly or use another verified route; automatic compaction of this oversized history is not guaranteed.`, {
      status: 400, errorType: 'invalid_request_error', code: 'context_length_exceeded', retryable: false,
    });
  }
}
const terminalErrorDetector = 'async function wf(e){if(await e.getByTestId("regenerate-thread-error-button").last().isVisible().catch(()=>!1))throw new q("ChatGPT displayed an error for this response. Check the ChatGPT tab for the exact error, then retry the turn.",{status:502,errorType:"server_error",code:"upstream_server_error",retryable:!0});if(!await g_(e).isVisible().catch(()=>!1))return;throw new q("ChatGPT ended the turn with \'Something went wrong\'. Retry the turn.",{status:502,errorType:"server_error",code:"upstream_server_error",retryable:!0})}';

// Inspect only the bound response's visible service alert. User text and
// generated Markdown containing error words or retry buttons are not failures.
export async function nativeTerminalErrorAlert(scope, AdapterError) {
  const failed = await scope.evaluateAll(containers => {
    if (containers.length !== 1) return false;
    const container = containers[0];
    const users = container.querySelectorAll('[data-user-message-bubble]');
    if (container.hasAttribute('data-turn-key') && users.length !== 1) return false;
    return [...container.querySelectorAll('[role="alert"]')].some(alert => {
      if (alert.closest('[data-turn-key], [data-turn-id]') !== container) return false;
      if (users.length === 1 && !(users[0].compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      const excluded = '.markdown, [data-markdown-text-style], [data-user-message-bubble], [data-message-author-role="user"], [data-conversation-role="user"], [data-turn="user"], [contenteditable]:not([contenteditable="false"])';
      if (alert.closest(excluded)) return false;
      for (let node = alert; node; node = node.parentElement) {
        if (node.matches('[hidden], [inert], [aria-hidden="true"]')) return false;
      }
      if (!alert.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const rect = alert.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const text = alert.innerText.replace(/\s+/g, '');
      if (/^(?:消息流中的错误|出了点问题。请重试)(?:重试)?$/.test(text)) return true;
      if (/^(?:Errorinmessagestream|Somethingwentwrong\.?Please(?:tryagain|retry)\.?)(?:Retry|Tryagain)?$/i.test(text)) return true;
      if (/^Somethingwentwrong\.Ifthisissuepersistspleasecontactusthroughourhelpcenterathelp\.openai\.com\.?(?:Retry|Tryagain)?$/i.test(text)) return true;
      // Preserve the site's dedicated terminal retry control only inside this
      // trusted service-alert boundary, never from generated response content.
      return [...alert.querySelectorAll('[data-testid="regenerate-thread-error-button"]')]
        .some(button => !button.closest(excluded) && button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    });
  });
  if (failed) throw new AdapterError('ChatGPT displayed a terminal error for this response. Retry the turn.', {
    status: 502, errorType: 'server_error', code: 'upstream_server_error', retryable: true,
  });
}

// v6.1.18 markdown.ts uses turndown-plugin-gfm 1.0.2, whose tableCell rule
// wraps paragraph/block content verbatim, including its surrounding newlines.
// Normalize only converted TH/TD content; keep GFM's cell delimiters and let
// its existing row rule handle alignment. Never rewrite the whole Markdown.
function nativeMarkdownTableCell(content, node) {
  const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
  const normalized = content.trim().replace(/\r\n?/g, '\n').replace(/[ \t]*\n[ \t\n]*/g, '<br>');
  return `${index === 0 ? '| ' : ' '}${normalized} |`;
}

// Preserve 160 random bits in the existing 32-character token payload without
// mixed case or visually ambiguous i/l/o/u. Authentication remains exact-match;
// never normalize a model-supplied token or revive an earlier turn capability.
export function createNativeTurnToken(randomBytes) {
  const bytes = randomBytes(20);
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let buffer = 0, bits = 0, payload = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      payload += alphabet[(buffer >>> bits) & 31];
    }
  }
  return `turn_${payload}`;
}

export function appendNativeModelAnnouncement(slider, descriptions, activeHeader) {
  const normalize = text => text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  const header = normalize(activeHeader);
  if (!/^(?:Instant|Medium|High|Extra High|Pro|Max|\u5373\u65f6|\u4e2d|\u9ad8)$/i.test(header)) return descriptions;
  // Versioned evidence already belongs to the native parser. In particular, do
  // not manufacture a matching state beside a contradictory version/name/mode.
  if (descriptions.some(text => /^(?:GPT[-\s]?)?\d+(?:\.\d+)?\s+/i.test(normalize(text)))) return descriptions;
  const mode = text => ({ '\u5373\u65f6': 'instant', '\u4e2d': 'medium', '\u9ad8': 'high' }[text] ?? text.toLowerCase());
  for (const description of descriptions) {
    const effort = /^(Instant|Medium|High|Extra High|Pro|Max|\u5373\u65f6|\u4e2d|\u9ad8)(?=\p{P}|$)/iu.exec(normalize(description));
    if (effort && mode(effort[1]) !== mode(header)) return descriptions;
  }
  const menu = slider.closest('[role="menu"]');
  if (!menu) return descriptions;
  // In simple view the real model rows remain attached but inert. Include them,
  // while excluding rows belonging to a nested or unrelated picker.
  const checked = [...menu.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')]
    .filter(row => row.closest('[role="menu"]') === menu);
  if (checked.length !== 1) return descriptions;
  const row = checked[0];
  const label = normalize(row.textContent ?? '');
  if (row.hasAttribute('aria-labelledby')
    || row.hasAttribute('aria-label') && normalize(row.getAttribute('aria-label')) !== label) return descriptions;
  // A generic Latest/Default row does not prove a version. These are only the
  // exact versioned shared/named rows supported by the pinned native assertion.
  if (!/^(?:(?:GPT[-\s]?)?6(?:\s+(?:Sol|Astra))?|GPT[-\s]?5\.6\s+Sol)$/i.test(label)) return descriptions;
  return [...descriptions, `${label} ${header}`];
}

// Borrow the backend's ordinary signed-in context. The returned Playwright CDP
// Browser owns only this connection; its unmodified close() disconnects it.
// Keep this helper self-contained: the preload embeds it in the pinned bundle.
export async function launchNativeBrowser(chromium, options, endpoint = process.env.MAGPIE_NATIVE_BROWSER_CDP) {
  if (endpoint === undefined || endpoint === '') return chromium.launch(options);
  const match = typeof endpoint === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(endpoint);
  if (!match || match[0] !== endpoint || Number(match[1]) > 65535) throw new Error('Invalid MAGPIE_NATIVE_BROWSER_CDP loopback endpoint');
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('Native browser CDP connection has no default context');
    browser.newContext = async () => context;
    return browser;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export function compactionPreloadSource(cliPath) {
  // Bun loads the original entry at its original path: helper/dependency resolution
  // is unchanged and the verified download is never modified. Fail closed on drift.
  return `import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { patchReferenceFixes } from ${JSON.stringify(new URL('./reference-fixes.mjs', import.meta.url).href)};
const entry = ${JSON.stringify(resolve(cliPath))};
Bun.plugin({ name: 'magpie-shared-compaction-6.1.18', setup(build) {
  build.onLoad({ filter: /[\\\\/]cli\\.js$/ }, async ({ path }) => {
    if (resolve(path) !== entry) return;
    const bytes = await Bun.file(path).arrayBuffer();
    if (createHash('sha256').update(Buffer.from(bytes)).digest('hex') !== ${JSON.stringify(cliSha256)})
      throw new Error('Native shared compaction runtime checksum mismatch');
    const source = new TextDecoder().decode(bytes);
    const before = ${JSON.stringify(compactionGate)};
    if (source.split(before).length !== 2) throw new Error('Native shared compaction gate mismatch');
    const retirement = ${JSON.stringify(compactionRetirement)};
    if (source.split(retirement).length !== 2) throw new Error('Native compaction retirement compatibility mismatch');
    const ownership = ${JSON.stringify(ownershipEntry)};
    if (source.split(ownership).length !== 2) throw new Error('Native ownership diagnostic compatibility mismatch');
    const executionIdentity = ${JSON.stringify(executionIdentity)}, instructionIdentity = ${JSON.stringify(instructionIdentity)};
    if (source.split(executionIdentity).length !== 2 || source.split(instructionIdentity).length !== 2)
      throw new Error('Native semantic identity compatibility mismatch');
    const summaryDecoder = ${JSON.stringify(summaryDecoder)};
    if (source.split(summaryDecoder).length !== 2) throw new Error('Native summary decoder compatibility mismatch');
    const usageStart = ${JSON.stringify(usageSubmissionStart)}, usageEnd = ${JSON.stringify(usageSubmissionEnd)};
    if (source.split(usageStart).length !== 2 || source.split(usageEnd).length !== 2)
      throw new Error('Native send receipt compatibility mismatch');
    const launch = ${JSON.stringify(browserLaunch)};
    if (source.split(launch).length !== 3) throw new Error('Native browser launch compatibility mismatch');
    const announcement = ${JSON.stringify(modelAnnouncementTail)};
    if (source.split(announcement).length !== 2) throw new Error('Native model announcement compatibility mismatch');
    const markdown = ${JSON.stringify(markdownGfmSetup)};
    if (source.split(markdown).length !== 2) throw new Error('Native markdown table compatibility mismatch');
    const terminal = ${JSON.stringify(terminalErrorDetector)};
    if (source.split(terminal).length !== 2) throw new Error('Native terminal alert compatibility mismatch');
    const submittedAlert = ${JSON.stringify(submittedAlertAnchor)};
    if (source.split(submittedAlert).length !== 2) throw new Error('Native submitted alert compatibility mismatch');
    const submittedInitialAlert = ${JSON.stringify(submittedInitialAlertAnchor)};
    const submittedInitialObservation = ${JSON.stringify(submittedInitialObservationAnchor)};
    if (source.split(submittedInitialAlert).length !== 2 || source.split(submittedInitialObservation).length !== 2)
      throw new Error('Native initial submitted alert compatibility mismatch');
    const submittedStage = ${JSON.stringify(submittedStageBaseline)};
    const submittedFinal = ${JSON.stringify(submittedFinalBaseline)};
    if (source.split(submittedStage).length !== 2 || source.split(submittedFinal).length !== 2)
      throw new Error('Native submitted multipart provenance compatibility mismatch');
    const contextGuard = ${JSON.stringify(proContextGuard)};
    if (source.split(contextGuard).length !== 2) throw new Error('Native Pro context guard compatibility mismatch');
    const roundGuard = ${JSON.stringify(proRoundGuard)};
    if (source.split(roundGuard).length !== 2) throw new Error('Native Pro round guard compatibility mismatch');
    const solCompileGuard = ${JSON.stringify(solCompileGuard)}, solTrimGuard = ${JSON.stringify(solTrimGuard)};
    if (source.split(solCompileGuard).length !== 2 || source.split(solTrimGuard).length !== 2)
      throw new Error('Native Sol pre-trim context guard compatibility mismatch');
    const registry = ${JSON.stringify(checkpointRegistry)};
    const remember = ${JSON.stringify(checkpointRememberTail)};
    const touch = ${JSON.stringify(checkpointTouch)};
    const tokenFactory = ${JSON.stringify(opaqueIdFactory)};
    if (source.split(tokenFactory).length !== 2) throw new Error('Native turn token compatibility mismatch');
    if (source.split(registry).length !== 2 || source.split(remember).length !== 2 || source.split(touch).length !== 2)
      throw new Error('Native checkpoint persistence compatibility mismatch');
    let contents = source.replace(before, ${JSON.stringify('console.info("[chatgpt-web] compaction_phase entered");' + sharedCompactionGate)})
      .replace(executionIdentity, executionIdentity.replace('JSON.stringify(', 'identityJson('))
      .replace(instructionIdentity, instructionIdentity.replace('JSON.stringify(', 'identityJson('))
      .replace(summaryDecoder, 'function $n(e){if(e.startsWith("magpie1:"))return decodeMagpieSummary(e);if(!e.startsWith(ni))return null;')
      .replace(retirement, 'console.info("[chatgpt-web] compaction_phase retiring");' + retirement + ';console.info("[chatgpt-web] compaction_phase retired")')
      .replace(ownership, 'let Qe=ed(e,f),magpieLineage=$f(f),magpieOwnership=ownershipSnapshot({executionKey:re,ownerKey:O,sourceKey:f._compactionRequest?p+":"+$u(f):undefined,instruction:magpieLineage,model:f.modelId,reasoning:f.options.reasoning,identity:ve,revision:_i(f).at(-1),compaction:f._compactionRequest===true});if(magpieOwnership)console.info("[chatgpt-web] ownership "+JSON.stringify(magpieOwnership));let N=await De.getOrCreateAfterOwnerRetirement(re,O,()=>C(f,D,Qe,R),Qe,v.abortSignal,qe,ve.threadId,magpieLineage),K=Df(f)')
      .replace(usageStart, 'let magpieUsageIndex=0,magpieLegacyUsage=async()=>{if(!o)return;let E=ho(),z;')
      .replace(usageEnd, 'm.push(ne)}},ke=async()=>{let receipt=await prepareSubmissionReceipt({readAccount:()=>os(O),profile:process.env.CODEX_CHATGPT_WEB_HOME,model:nativeUsageModel(Y),effort:Y.effort,source:"native",stage:c.multipart&&magpieUsageIndex++<c.multipart.parts.length?"multipart":e.compaction?"compaction":"message"}),legacy=await magpieLegacyUsage();return()=>{receipt.confirm();m.push(receipt.flush());legacy?.()}},Be=c.text,ze=[];')
      .replace(terminal, 'async function wf(e){return nativeTerminalErrorAlert(e,q)}')
      .replace(submittedAlert, 'await this.reconcileMultipartHistory(e,t,i,r);await nativeSubmittedTerminalAlert(this,e,t,n,i,r,q,nativeTerminalErrorAlert);let a=new Set([...n.acceptedTurnIdentities,...t.initialTurnIdentities])')
      .replace(submittedInitialObservation, 'let m,magpieSubmittedFailure;try{m=await this.submissionDomState(l,u.domCache,r),await this.reconcileMultipartHistory(l,u,m,r);try{await nativeSubmittedTerminalAlert(this,l,u,undefined,m,r,q,nativeTerminalErrorAlert)}catch(magpieProofError){if(magpieProofError instanceof Mi)throw magpieProofError;magpieSubmittedFailure={error:magpieProofError}}}catch(w)')
      .replace(submittedInitialAlert, 'if(magpieSubmittedFailure)throw magpieSubmittedFailure.error;' + submittedInitialAlert)
      .replace(submittedStage, 'let V=rememberNativeMultipartSubmission(await this.captureSubmissionBaseline(O,z.text,ze),A,"stage",E+1,c.multipart.parts.length,z.text);')
      .replace(submittedFinal, 'let oe=rememberNativeMultipartSubmission(await this.captureSubmissionBaseline(O,Be,ze,c.turnToken),A,"commit",c.multipart?.parts.length,c.multipart?.parts.length,M),ae=')
      .replace(contextGuard, 'else Iu(b,_,e.modelId,a.effort,i,y);assertNativeProContext(b,a.effort,q);assertNativeSolContext(b,e.modelId,e.modelFamily,a.effort,i,q);let re=this.config.turnTimeoutMs')
      .replace(roundGuard, 'if(y.effort==="max"||nativeSolContextGuarded(f.modelId,f._chatgptModelFamily,y.effort,R)){try{let magpieInput=wo(w(f),{reasoning:[]},R,c,s,e.chatgptWeb?.appName).inputTokens;assertNativeProContext(magpieInput,y.effort,q);assertNativeSolContext(magpieInput,f.modelId,f._chatgptModelFamily,y.effort,R,q)}catch(magpieContextError){if(!(magpieContextError instanceof q))throw magpieContextError;T({type:"error",message:magpieContextError.message,status:magpieContextError.status,errorType:magpieContextError.errorType,code:magpieContextError.code,retryable:!1});return}}let D;if(y.localTools)try{D=m.resolve(f)}')
      .replace(solCompileGuard, 'A=T.length,I=v(T);if(nativeSolContextGuarded(e.modelId,e._chatgptModelFamily,s.effort,t))assertNativeSolContext(Nt(I,e.modelId),e.modelId,e._chatgptModelFamily,s.effort,t,q);if(!e._compactionRequest)return I;')
      .replace(solTrimGuard, 'if(nativeSolContextGuarded(e.modelId,e._chatgptModelFamily,s.effort,t)&&b())assertNativeSolContext(0,e.modelId,e._chatgptModelFamily,s.effort,t,q,!0);' + solTrimGuard)
      .replace(markdown, ${JSON.stringify(markdownGfmSetup + 'Vt.addRule("magpieTableCell",{filter:["th","td"],replacement:' + nativeMarkdownTableCell.toString() + '});')})
      .replace(registry, 'var magpieCheckpointPersistence=process.env.MAGPIE_NATIVE_CHECKPOINT_HOME?magpieOpenCheckpoints(process.env.MAGPIE_NATIVE_CHECKPOINT_HOME):null;var Kt=magpieCheckpointPersistence?.map??new Map,dx=256;')
      .replace(remember, 'while(Kt.size>dx)Kt.delete(Kt.keys().next().value);magpieCheckpointPersistence?.commit()}function Nh')
      .replace(touch, 'return Kt.delete(e),Kt.set(e,t),magpieCheckpointPersistence?.commit(),!0}')
      .replace(tokenFactory, 'function ci(e){return e==="turn"?createNativeTurnToken(Ev):' + tokenFactory.slice(tokenFactory.indexOf('return') + 6, -1) + '}')
      .replaceAll(launch, 'launchNativeBrowser(ff,{executablePath:this.config.chromeExecutablePath,headless:!this.config.headed})')
      .replace(announcement, ${JSON.stringify('r.push(c.join(" "));r=(' + appendNativeModelAnnouncement.toString() + ')(t,r,c.join(" "))}return r})}function fc(e)')})
      + '\\n' + ${JSON.stringify(launchNativeBrowser.toString())}
      + '\\n' + ${JSON.stringify(createNativeTurnToken.toString())}
      + '\\n' + ${JSON.stringify(nativeTerminalErrorAlert.toString())}
      + '\\n' + ${JSON.stringify(assertNativeProContext.toString())}
      + '\\n' + ${JSON.stringify(nativeSolContextGuarded.toString())}
      + '\\n' + ${JSON.stringify(assertNativeSolContext.toString())}
      + ${JSON.stringify('\nimport { checkpointStore as magpieOpenCheckpoints } from ' + JSON.stringify(new URL('./checkpoints.mjs', import.meta.url).href) + ';')}
      + ${JSON.stringify('\nimport { prepareSubmissionReceipt, nativeUsageModel } from ' + JSON.stringify(new URL('../usage/submission.mjs', import.meta.url).href) + ';')}
      + ${JSON.stringify('\nimport { ownershipSnapshot } from ' + JSON.stringify(new URL('./ownership-diagnostics.mjs', import.meta.url).href) + ';')}
      + ${JSON.stringify('\nimport { identityJson } from ' + JSON.stringify(new URL('./identity-json.mjs', import.meta.url).href) + ';')}
      + ${JSON.stringify('\nimport { decodeMagpieSummary } from ' + JSON.stringify(new URL('./summary-envelope.mjs', import.meta.url).href) + ';')}
      + ${JSON.stringify('\nimport { nativeSubmittedTerminalAlert, rememberNativeMultipartSubmission } from ' + JSON.stringify(new URL('./submitted-alert.mjs', import.meta.url).href) + ';')};
    contents = patchReferenceFixes(contents);
    return { contents, loader: 'js' };
  });
} });
`;
}

async function sharedCompactionCommand(root, runtime) {
  const entry = join(runtime, 'app/cli.js');
  if (hash(await readFile(entry)) !== cliSha256) throw new Error('Native shared compaction runtime checksum mismatch');
  const source = compactionPreloadSource(entry);
  const preload = join(root, `compaction-6.1.18-${hash(source)}.mjs`);
  try { await writeFile(preload, source, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(preload);
  if (!stat.isFile() || stat.isSymbolicLink() || await readFile(preload, 'utf8') !== source)
    throw new Error('Native shared compaction preload mismatch; refusing to overwrite');
  return [join(runtime, 'runtime/bun.exe'), '--preload', preload, entry];
}

async function extractZip(archive, destination) {
  // No shell interpolation of filesystem paths. Reject traversal before extraction.
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($env:MAGPIE_NATIVE_ARCHIVE)
    try {
      $root = [IO.Path]::GetFullPath($env:MAGPIE_NATIVE_DEST) + [IO.Path]::DirectorySeparatorChar
      foreach ($entry in $zip.Entries) {
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $entry.FullName))
        if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe ZIP entry' }
      }
    } finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($env:MAGPIE_NATIVE_ARCHIVE, $env:MAGPIE_NATIVE_DEST)
  `], { windowsHide: true, timeout: 120_000, env: { ...process.env, MAGPIE_NATIVE_ARCHIVE: archive, MAGPIE_NATIVE_DEST: destination } });
}

async function inventory(root, directory = root, result = {}) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native install contains a linked directory');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const key = relative(root, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw new Error('Native install contains a link');
    if (entry.isDirectory()) await inventory(root, path, result);
    else if (entry.isFile()) result[key] = hash(await readFile(path));
    else throw new Error('Native install contains a special file');
  }
  return result;
}

async function verify(directory, release) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native install directory is not owned; refusing to overwrite');
  const manifest = JSON.parse(await readFile(join(directory, 'install.json'), 'utf8'));
  if (manifest.archiveSha256 !== release.sha256) throw new Error('Native install pin mismatch; refusing to overwrite');
  const actual = await inventory(join(directory, 'payload'));
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(manifest.files).sort())) throw new Error('Native install checksum mismatch; refusing to overwrite');
  for (const name of release.required ?? []) if (!actual[name]) throw new Error('Native runtime file missing');
  for (const [name, digest] of Object.entries(release.files ?? {})) if (actual[name] !== digest) throw new Error('Native dependency checksum mismatch');
  return join(directory, 'payload');
}

async function install(root, release, fetchImpl, extract) {
  const target = join(root, release.name);
  try { await lstat(target); return await verify(target, release); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // A partial existing installation must also never be overwritten.
  try { await lstat(target); throw new Error('Incomplete native install; refusing to overwrite'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = join(root, `.${release.name}-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const response = await fetchImpl(release.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error('Native release download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== release.sha256) throw new Error('Native release checksum mismatch');
    const archive = join(stage, 'release.zip');
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    await extract(archive, join(stage, 'payload'));
    const files = await inventory(join(stage, 'payload'));
    await writeFile(join(stage, 'install.json'), JSON.stringify({ archiveSha256: release.sha256, files }), { flag: 'wx', mode: 0o600 });
    await verify(stage, release);
    await rm(archive);
    await rename(stage, target);
    return join(target, 'payload');
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export function ensureRuntime({ root = nativeRoot(), fetch: fetchImpl = globalThis.fetch, extract = extractZip, releases = RELEASES } = {}) {
  if (!isAbsolute(root)) throw new Error('Native root must be absolute');
  const key = resolve(root);
  if (installing.has(key)) return installing.get(key);
  const pending = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Exclusive lock protects separate backend processes; an interrupted lock is left for inspection.
    const lock = join(root, '.install-lock');
    await mkdir(lock);
    try {
      const runtime = await install(root, releases[0], fetchImpl, extract);
      const tunnel = await install(root, releases[1], fetchImpl, extract);
      const runtimeCommand = releases[0].sha256 === RELEASES[0].sha256
        ? await sharedCompactionCommand(root, runtime)
        : [join(runtime, 'runtime/bun.exe'), join(runtime, 'app/cli.js')];
      return { runtimeCommand, tunnelBinary: join(tunnel, 'tunnel-client.exe') };
    } finally { await rm(lock, { recursive: true, force: true }); }
  })().finally(() => installing.delete(key));
  installing.set(key, pending);
  return pending;
}
