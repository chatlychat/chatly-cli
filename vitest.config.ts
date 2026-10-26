import { defineConfig } from 'vitest/config';

const vitestExecution = { pool: 'threads' as const };

export default defineConfig({
  test: {
    // Worker THREADS, not vitest's default of a forked process per file. See @livechat/config/vitest.
    ...vitestExecution,
    environment: 'node',
  },
});
