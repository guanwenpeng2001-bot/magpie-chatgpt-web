// Classify failure when the grouped assistant is absent, including before its
// initial binding. IDs, prompts and tokens stay in memory only; never rebind here.
// The pinned worker supplies its original proof/expansion methods and error type.
const multipartSubmissions = new WeakMap();

// Called ONLY at the two checksum/unique-anchor guarded local baseline capture
// sites, with the freshly generated transaction and the formatter's output.
// Recognizing nonce-looking page text alone must never confer this authority.
// Weak keys deliberately do not transfer authority to copied recovery baselines.
export function rememberNativeMultipartSubmission(baseline, transaction, kind, part, total, formattedText) {
  if (!baseline || typeof baseline !== 'object' || !/^ctx_[a-f0-9]{32}$/.test(transaction)
    || (total !== 2 && total !== 6) || !Number.isInteger(part)
    || typeof formattedText !== 'string' || formattedText !== baseline.submittedText) return baseline;
  const header = kind === 'stage' && part >= 1 && part < total
    ? `<codex_multipart_stage>\ntransaction_id: ${transaction}\npart: ${part}/${total}\npayload_sha256: `
    : kind === 'commit' && part === total
      ? `<codex_multipart_commit>\ntransaction_id: ${transaction}\nparts: ${total}\nmanifest: ` : undefined;
  if (header && formattedText.startsWith(header)) multipartSubmissions.set(baseline, formattedText);
  return baseline;
}

function hasSubmissionNonce(baseline) {
  return (typeof baseline.turnToken === 'string' && /^turn_[A-Za-z0-9_-]{32}$/.test(baseline.turnToken)
      && baseline.submittedText.includes(baseline.turnToken))
    || (multipartSubmissions.has(baseline) && multipartSubmissions.get(baseline) === baseline.submittedText);
}

function candidateUser(baseline, binding, state) {
  const initial = new Set(baseline.initialTurnIdentities);
  // Plain full-text compaction cannot distinguish reappearing identical history.
  // Locally prepared nonce proof can tolerate virtualization of older stages;
  // the original token/full-text proof is still required before classification.
  if (!hasSubmissionNonce(baseline) && [...initial].some(id => !state.turnIdentities.includes(id))) return;
  const users = state.userIdentities.filter(id => !initial.has(id));
  if (users.length !== 1 || !users[0].startsWith('group:user:')) return;
  const user = users[0], key = user.slice('group:user:'.length);
  const assistant = `group:assistant:${key}`;
  if (!key || initial.has(assistant) || state.responseIdentities.some(id => !initial.has(id))) return;
  // No surviving old owner, competing group, or unrelated new article. Both
  // logical roles exist in turnIdentities even for an alert-only group.
  if (state.turnIdentities.some(id => !initial.has(id) && id !== user && id !== assistant)) return;
  if (binding && binding.identity !== assistant && state.turnIdentities.includes(binding.identity)) return;
  if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== user
    && state.turnIdentities.includes(baseline.acceptedUserIdentity)) return;
  return { user, key };
}

// Runs synchronously in the page, immediately before the unchanged service-alert
// predicate. The original proof was read while this witness observed the entire
// document. No mutation (including text/visibility/key changes) may intervene.
function validWitness(containers, witness) {
  if (witness.dirty || witness.observer.takeRecords().length || containers.length !== 1) return false;
  const root = containers[0];
  if (root !== witness.root || !root.isConnected || root.ownerDocument !== document
    || root.getAttribute('data-turn-key') !== witness.key) return false;
  const bubbles = root.querySelectorAll('[data-user-message-bubble]');
  if (bubbles.length !== 1 || bubbles[0].closest('[data-turn-key]') !== root) return false;
  const targets = bubbles[0].querySelectorAll('[data-search-result-target]:not([data-search-result-target] [data-search-result-target])');
  if (targets.length !== 1) return false;
  const content = targets[0];
  const visible = element => {
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.matches('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  if (!visible(root) || !visible(bubbles[0]) || !visible(content)) return false;
  // The full-text reader uses source text. Hidden source characters must not
  // manufacture a match; this also tightens visibility for the token proof.
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.length && !visible(node.parentElement)) return false;
  }
  return true;
}

export async function nativeSubmittedTerminalAlert(worker, page, baseline, binding, state, signal, AdapterError, detect) {
  // An absent binding is the initial-wait path. It grants no response identity;
  // only the same unique submitted user and immutable proof can classify failure.
  if ((binding && !binding.identity.startsWith('group:assistant:')) || !baseline.submittedText) return;
  const candidate = candidateUser(baseline, binding, state);
  if (!candidate) return;
  const group = page.locator(`[data-turn-key=${JSON.stringify(candidate.key)}]`);
  if (await group.count() !== 1) return;
  // Do not expand a transient user-only group during ordinary generation.
  // This is just a cheap candidate filter; the original predicate owns the
  // service-alert verdict after submitted-user proof, never this count.
  if (await group.locator('[role="alert"]').count() === 0) return;
  const original = await group.elementHandle();
  if (!original) return;
  try {
    await worker.withExpandedUserMessage(group, async () => {
      if (signal?.aborted) throw new DOMException('ChatGPT web turn aborted', 'AbortError');
      // Pin the pre-expansion element. A locator could otherwise silently select
      // a different element inserted under the same key during expansion.
      const witness = await original.evaluateHandle((root, key) => {
        const value = { root, key, dirty: false, observer: undefined };
        value.observer = new MutationObserver(() => { value.dirty = true; });
        value.observer.observe(document.documentElement, {
          subtree: true, childList: true, characterData: true, attributes: true,
        });
        return value;
      }, candidate.key);
      try {
        const fresh = await worker.submissionDomState(page, {}, signal);
        if (candidateUser(baseline, binding, fresh)?.user !== candidate.user) return;
        // The nested expansion helper sees an already expanded bubble. This is
        // the actual reference proof, including its exact token checks or full
        // text normalization for compaction (which has no prepared turn token).
        if (!await worker.userMessageMatchesSubmission(group, baseline.submittedText, signal, baseline.turnToken)) return;
        if (signal?.aborted) throw new DOMException('ChatGPT web turn aborted', 'AbortError');
        await detect({
          evaluateAll(predicate) {
            // Compose only trusted module functions, never prompt/page strings.
            // Guard and original alert predicate run in one synchronous DOM read.
            const guarded = new Function(`return (containers, witness) => {
              if (!(${validWitness.toString()})(containers, witness)) return false;
              return (${predicate.toString()})(containers);
            }`)();
            return group.evaluateAll(guarded, witness);
          },
        }, AdapterError);
      } finally {
        // Navigation may destroy the witness; cleanup must not mask the original
        // adapter error, abort, or observation exception.
        await witness.evaluate(value => value.observer.disconnect()).catch(() => {});
        await witness.dispose().catch(() => {});
      }
    }, signal);
  } finally { await original.dispose().catch(() => {}); }
}
