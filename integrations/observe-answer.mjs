// Capture only normalized answer events, never raw upstream envelopes or credentials.
export async function observeAnswer(driver, command, guard, identity, signal) {
  const started = performance.now();
  const result = { text: '', terminal: false, deltas: [], failure: null };
  try {
    await driver.complete(command, guard, identity, signal, async frame => {
      if (frame.type === 'delta') {
        result.text += frame.text;
        result.deltas.push({ milliseconds: performance.now() - started, text: frame.text });
      } else if (frame.type === 'finish' && frame.reason === 'complete') result.terminal = true;
    });
  } catch (error) {
    result.failure = typeof error.code === 'string' && /^[a-zA-Z]{1,40}$/.test(error.code) ? error.code : 'captureFailed';
  }
  result.verified = result.terminal && result.text.trim().length > 0 && !result.failure;
  return result;
}
