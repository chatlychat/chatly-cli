/**
 * `chatly init <framework>` — the install wizard (CHT-F02).
 *
 * Writes the identity route, the launcher, the CSP sources and the privacy
 * table for one web channel into an existing project, from that channel's own
 * `embed` block. One read, `GET /v1/channels`, with the caller's `ck_` key —
 * the route the dashboard's install screen reads, so the CSP and the storage
 * table come from the server rather than from a list in this CLI that could
 * drift from it.
 *
 * ═══ WHAT IT WILL NOT DO ══════════════════════════════════════════════════
 *
 *  - **Overwrite a file.** Every target is checked before anything is
 *    written, and one existing file stops the whole run with the list, unless
 *    `--force`. Half a scaffold is worse than none: the summary would name
 *    files that are not the ones on disk.
 *  - **Edit the integrator's own files.** `next.config`, the root layout and
 *    the Express app are THEIRS; the summary says which line goes where.
 *    A wizard that rewrites a config it did not create is a wizard nobody
 *    re-runs.
 *  - **Write a secret.** `CHATLY_IDV_SECRET` is named, never fetched: the
 *    channel read redacts it, and a secret in a scaffolded file is a secret
 *    in git.
 *  - **Generate the e2e fixture.** CHT-F02 asks for one built on CHT-D09's
 *    `@chatlychat/widget-testing`, which is not on npm. A file importing it
 *    would scaffold a project that does not install, so the summary says so
 *    instead.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { bool, str, type ParsedArgs } from '../args.js';
import { FRAMEWORKS, NO_ATLAS, scaffold, type Framework } from '../init/templates.js';
import { printJson } from '../output.js';

import type { EmbedBlock, ScaffoldFile } from '../init/shared.js';
import type { ChatlyClient } from '@chatlychat/sdk-node';

const USAGE =
  `Usage: chatly init <${FRAMEWORKS.join('|')}> [--public-id <id>] [--identity hmac|atlas] ` +
  '[--dir <path>] [--dry-run] [--force]\n';

interface ChannelRow {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly publicId?: unknown;
  readonly enabled?: unknown;
  readonly embed?: unknown;
}

/** The web channel to scaffold for, or a sentence saying why there is none. */
export function pickChannel(
  rows: ReadonlyArray<ChannelRow>,
  publicId: string | undefined,
): { publicId: string; embed: EmbedBlock } | { error: string } {
  const web = rows.filter((r) => r.type === 'web' && typeof r.publicId === 'string');
  const chosen =
    publicId === undefined
      ? web.length === 1
        ? web[0]
        : undefined
      : web.find((r) => r.publicId === publicId);
  if (chosen === undefined) {
    if (publicId !== undefined) {
      return { error: `No web channel with publicId "${publicId}" in this workspace.` };
    }
    if (web.length === 0) {
      return { error: 'This workspace has no web channel. Create one in the dashboard first.' };
    }
    return {
      error:
        `This workspace has ${String(web.length)} web channels; name one with --public-id:\n` +
        web.map((r) => `  ${String(r.publicId)}  ${String(r.name ?? '')}`).join('\n'),
    };
  }
  const embed = chosen.embed as EmbedBlock | null | undefined;
  if (embed === null || embed === undefined) {
    return {
      error:
        `Channel ${String(chosen.publicId)} has no embed block: this deployment has not been told ` +
        'where its widget is served from. Nothing was written.',
    };
  }
  return { publicId: String(chosen.publicId), embed };
}

/** Where each framework's identity stub lives, and what to do with it. */
const WIRE_IDENTITY: Readonly<Record<Framework, string>> = {
  next: 'Wire `currentUserId` in app/api/chatly/identity/route.ts to your auth. Until you do, every visitor is anonymous.',
  remix:
    'Wire `currentUserId` in app/routes/api.chatly.identity.ts to your session. Until you do, every visitor is anonymous. ' +
    'On React Router v7, app/routes.ts must use flatRoutes() from @react-router/fs-routes for the file to be routed.',
  astro:
    'Wire `currentUserId` in src/pages/api/chatly/identity.ts to your auth. Until you do, every visitor is anonymous. ' +
    'The endpoint is `prerender = false`, so the site needs a server adapter (e.g. @astrojs/node).',
  express:
    "Mount the handler: app.get('/api/chatly/identity', chatlyIdentity((req) => req.user?.id ?? null)).",
};

/** Where the widget goes on the page. */
const RENDER: Readonly<Record<Framework, string>> = {
  next: 'Render <Chatly /> from components/chatly.tsx once, in app/layout.tsx. Install @chatlychat/widget-react.',
  remix:
    'Render <Chatly /> from app/components/chatly.tsx once, in app/root.tsx. Install @chatlychat/widget-react.',
  astro:
    'Render <Chatly /> from src/components/Chatly.astro once, before </body> in your layout.',
  express: 'Paste chatly/snippet.html before </body> on every page that shows the widget.',
};

/** What to do next, in the order it has to be done. */
export function nextSteps(framework: Framework, identity: 'hmac' | 'atlas'): ReadonlyArray<string> {
  const steps: string[] = [];
  if (identity === 'hmac') {
    steps.push(
      WIRE_IDENTITY[framework],
      "Set CHATLY_IDV_SECRET on the server — the channel's identity-verification secret, from the dashboard. Never in a client bundle.",
    );
  } else {
    steps.push(
      'Set the channel to identityVerification.mode "atlas" with your instance id, and create the `chatly` JWT template in Atlas.',
    );
  }
  steps.push(
    RENDER[framework],
    'Merge chatly.csp.mjs into your Content-Security-Policy with withChatly(…) — do not add a second CSP header.',
    'Copy the table in CHATLY-PRIVACY.md into your privacy policy.',
    'No e2e fixture was generated: @chatlychat/widget-testing (CHT-D09) is not on npm yet.',
  );
  return steps;
}

/** Write every file, or none: existing targets are checked first. */
export function writeAll(
  dir: string,
  files: ReadonlyArray<ScaffoldFile>,
  force: boolean,
): { written: ReadonlyArray<string> } | { existing: ReadonlyArray<string> } {
  const existing = files.filter((f) => existsSync(join(dir, f.path))).map((f) => f.path);
  if (existing.length > 0 && !force) {
    return { existing };
  }
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents);
  }
  return { written: files.map((f) => f.path) };
}

export async function init(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const framework = args.path[1];
  if (framework === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (!(FRAMEWORKS as ReadonlyArray<string>).includes(framework)) {
    process.stderr.write(`Unknown framework "${framework}".\n${USAGE}`);
    return 2;
  }
  const fw = framework as Framework;
  const identity = str(args.flags, 'identity') ?? 'hmac';
  if (identity !== 'hmac' && identity !== 'atlas') {
    process.stderr.write(`--identity must be hmac or atlas, not "${identity}".\n`);
    return 2;
  }
  if (NO_ATLAS.includes(fw) && identity === 'atlas') {
    process.stderr.write(
      `\`chatly init ${fw} --identity atlas\` is not generated: an Atlas token is minted in the ` +
        "browser, so there is no server half. Call Chatly('identify', { getToken }) from your page — " +
        'https://chatlychat.com/guides/identity-verification#passing-the-token\n',
    );
    return 2;
  }

  const rows = await chatly.request<unknown>('GET', '/v1/channels');
  const picked = pickChannel(
    Array.isArray(rows) ? (rows as ChannelRow[]) : [],
    str(args.flags, 'public-id'),
  );
  if ('error' in picked) {
    process.stderr.write(`${picked.error}\n`);
    return 1;
  }

  const files = scaffold(fw, {
    publicId: picked.publicId,
    embed: picked.embed,
    identity,
    generatedOn: new Date().toISOString().slice(0, 10),
  });
  const steps = nextSteps(fw, identity);
  const dir = resolve(str(args.flags, 'dir') ?? '.');

  if (bool(args.flags, 'dry-run')) {
    if (bool(args.flags, 'json')) {
      printJson({ publicId: picked.publicId, files, nextSteps: steps, written: false });
    } else {
      for (const file of files) {
        process.stdout.write(`── ${file.path} ──\n${file.contents}\n`);
      }
      process.stdout.write(`(dry run: nothing written to ${dir})\n`);
    }
    return 0;
  }

  const result = writeAll(dir, files, bool(args.flags, 'force'));
  if ('existing' in result) {
    process.stderr.write(
      `Nothing written — these already exist in ${dir}:\n` +
        result.existing.map((p) => `  ${p}\n`).join('') +
        'Move them, or pass --force to overwrite. --dry-run prints what would be written.\n',
    );
    return 1;
  }
  if (bool(args.flags, 'json')) {
    printJson({
      publicId: picked.publicId,
      files: result.written,
      nextSteps: steps,
      written: true,
    });
    return 0;
  }
  process.stdout.write(
    `Scaffolded Chatly for web channel ${picked.publicId} in ${dir}:\n` +
      result.written.map((p) => `  + ${p}\n`).join('') +
      '\nNext:\n' +
      steps.map((s, i) => `  ${String(i + 1)}. ${s}\n`).join(''),
  );
  return 0;
}
