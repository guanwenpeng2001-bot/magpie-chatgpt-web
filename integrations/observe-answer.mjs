// Capture only normalized answer events, never raw upstream envelopes or credentials.
export async function observeAnswer(driver, command, guard, identity, signal) {
  const started = performance.now();
  const result = { text: '', terminal: false, deltas: [], failure: null };
  try {
    await driver.complete(command, guard, identity, signal, async frame => {
      if (frame.event === 'answer') {
        result.text += frame.data.text;
        result.deltas.push({ milliseconds: performance.now() - started, text: frame.data.text });
      } else if (frame.event === 'dom') {
        const text = frame.data.text;
        if (!text.startsWith(result.text)) throw new Error('Non-prefix answer');
        result.deltas.push({ milliseconds: performance.now() - started, text: text.slice(result.text.length) });
        result.text = text;
      } else if (frame.data?.type === 'message_stream_complete') result.terminal = true;
    });
  } catch (error) {
    result.failure = typeof error.code === 'string' && /^[a-zA-Z]{1,40}$/.test(error.code) ? error.code : 'captureFailed';
  }
  result.verified = result.terminal && result.text.trim().length > 0 && !result.failure;
  return result;
}
