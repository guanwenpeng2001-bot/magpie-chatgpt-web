// Bounded ports from 1cc49aaa627a995d3f0cf2f971fde7f764996649 (v6.1.18)
// to f08d16509e6a5447a0d0f2943abb172c69705160. The caller MUST first validate
// the original cli.js SHA-256:
// df24ed1df556e0f51470ad13e48ebded6a4efa345afa165f0f64ead4a3fe87c1.
// These literal edits also accept the unrelated, already-patched preload output.
// Nothing reads/writes the installed bundle or starts the CLI/browser here.

// Serialized into the page callback itself: no module/global dependency may be
// added here. Selection and replacement must occur in ONE synchronous DOM step.
function replacePlainTextInComposer(element, value) {
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  if (!selection.anchorNode || !element.contains(selection.anchorNode)
    || (selection.focusNode != null && !element.contains(selection.focusNode))) return false;
  return document.execCommand('insertText', false, value);
}

// Runs inside responseDomSnapshot's existing page evaluation, on its clone.
// Keep source/code views and markers inside literal pre/code content intact.
function removeMermaidPreviewShells(content) {
  for (const preview of Array.from(content.querySelectorAll('[data-chatgpt-mermaid-preview]'))) {
    if (preview.closest('pre, code')) continue;
    if (!preview.querySelector('pre, code, [data-markdown-copy="code-block"], .cm-content[data-language]')) {
      preview.remove();
    } else {
      for (const chrome of Array.from(preview.querySelectorAll('[data-block-actions="true"][data-markdown-copy="exclude"]'))) {
        if (!chrome.closest('pre, code')) chrome.remove();
      }
    }
  }
}

const plainDispatch = 'await this.insertPromptText(e,t,o),await this.assertPromptAttached(e,t,o);return}let l=await this.selectConnector(e,r,i,a,o);';
const insertMethod = 'async insertPromptText(e,t,n){Ke(n);let r=await this.activeComposer(e,30000,n);await r.focus({signal:n,timeout:$e});let o=await r.evaluate(L_,t,{timeout:20000,signal:n});if(Ke(n),!o)throw new Zn("ChatGPT composer rejected the plain-text editing command")}';
const widgetCleanup = 'for(let F of Array.from(S.querySelectorAll(".chart-widget-container, [data-code-block-preview-pane], script, style, svg, img, picture, source")))F.remove();';
const calendarFragment = String.raw`let c=(g)=>/^<environment_context>\s*<current_date>\d{4}-\d{2}-\d{2}<\/current_date>\s*(?:<timezone>[^<>]+<\/timezone>\s*)?<filesystem>\s*(?:<workspace_roots>((?:\s*<root>[^<>]+<\/root>\s*)+)<\/workspace_roots>\s*)?(<permission_profile type="(?:disabled|managed)">[\s\S]*?<\/permission_profile>)\s*<\/filesystem>\s*(?:<subagents>\s*(?:<agent name="[^<>"\r\n]+"\s*\/>\s*)*<\/subagents>\s*)?<\/environment_context>$/.exec(g),l=[]`;
const uuidLine = String.raw`-[ \t]+[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}(?::[ \t]*[^<>\r\n]+)?`;
const calendarWithUuid = String.raw`let c=(g)=>/^<environment_context>\s*<current_date>\d{4}-\d{2}-\d{2}<\/current_date>\s*(?:<timezone>[^<>]+<\/timezone>\s*)?<filesystem>\s*(?:<workspace_roots>((?:\s*<root>[^<>]+<\/root>\s*)+)<\/workspace_roots>\s*)?(<permission_profile type="(?:disabled|managed)">[\s\S]*?<\/permission_profile>)\s*<\/filesystem>\s*(?:<subagents>\s*(?:(?:<agent name="[^<>"\r\n]+"\s*\/>\s*)*|${uuidLine}(?:[ \t]*\r?\n[ \t]*${uuidLine})*\s*)<\/subagents>\s*)?<\/environment_context>$/.exec(g),l=[]`;
const capabilityProbe = 'async function ma(e,t={}){let n=await wc(e,t);if(!n)return{solAvailable:!1,extraHighAvailable:!1,proAvailable:!1};try{let o=await e.locator(pc).last().isVisible().catch(()=>!1),i=await n.getAttribute("aria-expanded").catch(()=>null);if(!o&&i!=="true")await n.press("Enter");return await bc(fc(e),t)}finally{await e.keyboard.press("Escape").catch(()=>{})}}';

const patches = [
  ['plain/stage composer dispatch', plainDispatch,
    'await this.insertPromptText(e,t,o,!0),await this.assertPromptAttached(e,t,o);return}let l=await this.selectConnector(e,r,i,a,o);'],
  ['atomic composer insertion', insertMethod,
    'async insertPromptText(e,t,n,magpieReplace=false){Ke(n);let r=await this.activeComposer(e,30000,n);await r.focus({signal:n,timeout:$e});let o=await r.evaluate(magpieReplace?('
      + replacePlainTextInComposer.toString() + '):L_,t,{timeout:20000,signal:n});if(Ke(n),!o)throw new Zn("ChatGPT composer rejected the plain-text editing command")}'],
  ['Mermaid preview cleanup', widgetCleanup,
    widgetCleanup + '(' + removeMermaidPreviewShells.toString() + ')(S);'],
  ['calendar UUID inventory', calendarFragment, calendarWithUuid],
  // sr is the existing activateChatGptEffortMenu in the pinned bundle; bc/wc
  // retain the native availability and stable-control checks. Port the full
  // capability probe behavior, including the optional before-cleanup callback.
  // Diagnostic trace ids/files in browser-helper-main/worker are NOT ported.
  ['capability menu activation', capabilityProbe,
    'async function ma(e,t={}){let n;try{n=await wc(e,t)}catch(r){await t.onFailureBeforeCleanup?.(r);throw r}if(!n)return{solAvailable:!1,extraHighAvailable:!1,proAvailable:!1};try{let r=await sr(e,n,{settleMs:t.settleMs});t.signal?.throwIfAborted();return await bc(r,t)}catch(r){await t.onFailureBeforeCleanup?.(r);throw r}finally{await e.keyboard.press("Escape").catch(()=>{})}}'],
];

/** Apply once, after original checksum validation; return source or throw. */
export function patchReferenceFixes(source) {
  if (typeof source !== 'string') throw new TypeError('Native reference fixes require source text');
  // Validate every site before editing any site. No regex/global replacement,
  // fuzzy match, partial success, file I/O, or unbound injected helper imports.
  for (const [name, before] of patches) {
    const index = source.indexOf(before);
    if (index < 0 || source.indexOf(before, index + 1) !== -1) {
      throw new Error(`Native reference fix anchor mismatch: ${name}`);
    }
  }
  let result = source;
  for (const [, before, after] of patches) result = result.replace(before, () => after);
  return result;
}
