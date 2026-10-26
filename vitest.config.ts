import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `@chatlychat/sdk-node` by SOURCE, not through its `exports` map.
 *
 * `cli.spec.ts` imports `ChatlyClient` from it, and the workspace symlink
 * resolves the package to `dist/` — so this suite was exercising whatever was
 * last built. `scripts/check-sibling-source-resolution.mjs` explains why that
 * is a gate rather than a preference: on 2026-10-26 the same shape produced a
 * false 82/82 in `@chatlychat/widget-react`, and all three dist-only
 * published packages had a `dist` older than their `src` at the time.
 *
 * It matters more here than almost anywhere, because the CLI's whole point is
 * to dogfood the published SDK (see `run.ts`): a suite that dogfoods a stale
 * copy is dogfooding nothing.
 */
/**
 * ── The alias applies ONLY in the monorepo, and that is not a nicety ─────
 *
 * This file is copied verbatim into the public mirror
 * (`scripts/sync-sdk-repos.mjs`), where `../../packages/sdk-node/src` does not exist — the mirror is
 * one package, not a workspace. An unconditional alias therefore redirected
 * `@chatlychat/sdk-node` to a path that was not there, and the mirror's
 * suite died with `Failed to resolve import "@chatlychat/sdk-node"`.
 *
 * That is exactly the class of bug the repo already has a note about: a path
 * that works in one checkout. It was caught in four minutes by the mirror's
 * own CI, and by nothing local — the sync script builds each mirror but does
 * not run its tests, and the publish workflow runs `npm test` BEFORE
 * `npm publish`, so the broken version never reached npm.
 *
 * In the mirror the package genuinely consumes the published dist, which is
 * the right thing to test there. In the monorepo it must read source, for the
 * reason `scripts/check-sibling-source-resolution.mjs` sets out. So: present
 * when the sibling source is, absent when it is not.
 */
const sdkNodeRoot = fileURLToPath(new URL('../../packages/sdk-node/src', import.meta.url));
const inMonorepo = existsSync(join(sdkNodeRoot, 'index.ts'));

const vitestExecution = { pool: 'threads' as const };

export default defineConfig({
  resolve: {
    alias: !inMonorepo
      ? []
      : [
          { find: /^@chatlychat\/sdk-node$/, replacement: `${sdkNodeRoot}/index.ts` },
          { find: /^@chatlychat\/sdk-node\/(.*)$/, replacement: `${sdkNodeRoot}/$1.ts` },
        ],
  },
  test: {
    // Worker THREADS, not vitest's default of a forked process per file. See @livechat/config/vitest.
    ...vitestExecution,
    environment: 'node',
  },
});
