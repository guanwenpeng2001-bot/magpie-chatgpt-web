import { serve } from '../backend/main.mjs';
if (!process.env.NODE_TEST_CONTEXT) await serve(process.stdin, process.stdout);
