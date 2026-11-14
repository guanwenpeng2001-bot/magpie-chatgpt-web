// Pure, self-contained transform, serialized into the native preload. The caller
// must first check the ORIGINAL v6.1.18 cli.js SHA-256. Never edits installed bytes.
export function patchNativeBrowserReadiness(source) {
  // Executed only in the owned page's main frame. Do not read conversation text,
  // enter the challenge iframe, or interact with verification controls.
  function nativeBrowserVerification() {
    if (location.origin !== 'https://chatgpt.com') return false;
    // ASCII escapes survive the pinned Bun's function.toString serialization.
    if (!/^(?:Just a moment|\u8bf7\u7a0d\u5019)[.\u2026\u3002!\uff01]*$/i.test(document.title.trim())) return false;
    // Cloudflare may render its visible checkbox/iframe in a closed shadow root.
    // Require both an actual challenge script and an inline challenge marker;
    // body text, title alone and a generic script name are not evidence.
    const scripts = Array.from(document.scripts);
    const challengeScript = scripts.some(script => {
      const src = script.getAttribute('src');
      if (!src) return false;
      try {
        const url = new URL(src, location.href);
        return (url.origin === location.origin || url.origin === 'https://challenges.cloudflare.com')
          && url.pathname.startsWith('/cdn-cgi/challenge-platform/');
      } catch { return false; }
    });
    if (challengeScript && scripts.some(script => !script.getAttribute('src')
      && /__cf_chl_/.test(script.textContent ?? ''))) return true;
    return Array.from(document.querySelectorAll('iframe')).some(frame => {
      if (!Array.from(frame.getClientRects()).some(rect => rect.width > 0 && rect.height > 0)) return false;
      for (let node = frame; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden'
          || style.visibility === 'collapse' || style.opacity === '0') return false;
      }
      const src = frame.getAttribute('src');
      if (!src) return false;
      try {
        const url = new URL(src, location.href);
        return url.origin === 'https://challenges.cloudflare.com'
          && url.pathname.startsWith('/cdn-cgi/challenge-platform/');
      } catch { return false; }
    });
  }

  const before = 'async activeComposer(e,t=30000,n){let r=e.locator(an).filter({visible:!0}),o=Date.now()+t,i=0;while(Date.now()<o){if(Ke(n),i=await Me(Ye(r.count(),Math.max(1,Math.min(Sf,o-Date.now()))),n),i===1)return r.first();await Me(new Promise((a)=>setTimeout(a,50)),n)}throw Error("ChatGPT composer is unavailable. Reload ChatGPT and retry the task.",{cause:Error(`Visible ChatGPT composer count was ${i}`)})}';
  if (typeof source !== 'string') throw new TypeError('Native browser readiness requires source text');
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) !== -1) {
    throw new Error('Native browser readiness activeComposer anchor mismatch');
  }
  // Keep the existing 30s deadline, 5s observation cap, 50ms poll, and unique
  // composer rule. Missing UI alone is never verification/authentication proof.
  // Only the added probe can tolerate this exact Playwright navigation race.
  // Count failures, closed pages, timeouts and cancellation retain their errors.
  const navigationMessage = 'Execution context was destroyed, most likely because of a navigation';
  const navigationMessages = [navigationMessage, navigationMessage + '.',
    'page.evaluate: ' + navigationMessage, 'page.evaluate: ' + navigationMessage + '.'];
  const probe = 'if(i===0){Ke(n);let magpieRemaining=o-Date.now();if(magpieRemaining>0){'
    + 'let magpieVerification;try{magpieVerification=await Me(Ye(e.evaluate(' + nativeBrowserVerification.toString()
    + '),Math.min(Sf,magpieRemaining)),n)}catch(magpieProbeError){'
    + 'if(!(magpieProbeError instanceof Error)||magpieProbeError.name!=="Error"||!'
    + JSON.stringify(navigationMessages) + '.includes(magpieProbeError.message))throw magpieProbeError}'
    + 'Ke(n);if(magpieVerification)throw new q('
    + '"ChatGPT requires browser verification before this message can be sent. Complete the check in the signed-in ChatGPT browser, then retry.",'
    + '{status:403,errorType:"permission_error",code:"chatgpt_security_check",retryable:!1})}}';
  const after = before.replace('await Me(new Promise', probe + 'await Me(new Promise');
  return source.replace(before, () => after);
}
