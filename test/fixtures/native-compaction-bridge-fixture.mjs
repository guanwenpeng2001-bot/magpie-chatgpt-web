import { serve } from '../../backend/main.mjs';
import { CompactionService } from '../../src/native/compaction.mjs';
if (process.env.METADATA_STDOUT_CONTROL === '1') console.error = console.log;

const service = await new CompactionService({ config: { port: 1, controlToken: 'fixture-local' },
  fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    return Response.json({ id: 'compact-fixture', object: 'response.compaction', output: [],
      fixtureMetadataPresent: typeof body.client_metadata?.['x-codex-turn-metadata'] === 'string' });
  },
}).listen();
await serve(process.stdin, process.stdout, { handlers: {
  fixtureDescriptor: () => service.descriptor(), fixtureAlive: () => ({ alive: true }),
}, close: () => service.stop() });
