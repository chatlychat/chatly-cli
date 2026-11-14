/**
 * `chatly csp` — the widget's Content-Security-Policy sources, on demand
 * (CH-13).
 *
 * ═══ THE ASK ══════════════════════════════════════════════════════════════
 *
 * FormFlow: "CSP for a Next.js app is hand-copied." Two halves to that, and
 * the second is the one that costs a security property:
 *
 *  1. `chatly init next` writes `chatly.csp.mjs` ONCE, at scaffold time, and
 *     there was no command that regenerated it. So a Chatly host change
 *     means an integrator editing a generated file by hand, and a file
 *     nobody regenerates is a file that is wrong the first time anything
 *     moves. This command is the build step: `chatly csp --install react >
 *     chatly.csp.mjs` in `prebuild`, and their `src/proxy.ts` (Next 16; the
 *     same file is `middleware.ts` on Next 15 and earlier) stays correct
 *     with no edit to their code.
 *
 *  2. `embed.contentSecurityPolicy.scriptSrc` includes four `'sha256-…'`
 *     hashes, and they are the hashes of the INLINE EMBED SNIPPET. A
 *     `@chatlychat/widget-react` or `<chatly-widget>` install runs no inline
 *     script — the loader arrives through `<script src>` — so those hashes
 *     match nothing on the page. An integrator reading hashes in a policy
 *     their own widget appears to violate concludes they need
 *     `'unsafe-inline'`, and adds it. That is a real weakening, caused by a
 *     list that described a different install.
 *
 * `--install react` drops them. The DEFAULT keeps them, and that direction
 * is deliberate: an unmatched hash source in a policy is inert, while a
 * MISSING one blocks the snippet outright — so the faithful answer is the
 * safe default and the narrow one is asked for by name.
 *
 * ═══ THE VARIANT THE API ALSO PUBLISHES ══════════════════════════════════
 *
 * `embed.contentSecurityPolicy.react` is the same hash-free lists, computed
 * server-side. This command still FILTERS rather than reading it, on purpose:
 * `hostsOnly` is one line of set logic and it keeps the CLI working against a
 * deployment older than that field — a self-host is not upgraded on our
 * schedule. `channel-embed.spec.ts` pins the server's variant to the same
 * rule (hashes out of `scriptSrc`, the other three identical), and
 * `csp.spec.ts` pins this one, so the duplication is two tested copies of one
 * line rather than two answers. If the field becomes universal, read it and
 * delete `hostsOnly`.
 *
 * ═══ ONE READ, AND IT IS THE SAME ONE `init` MAKES ════════════════════════
 *
 * `GET /v1/channels`, the same route, through the same `pickChannel`, into the
 * same `cspModule`. So the file is byte-identical for the same channel on the
 * same day — but MIND THE VARIANT: `chatly init next` and `init remix`
 * scaffold `<ChatlyLauncher>`, so what they write matches
 * `chatly csp --install react`, and `init astro` / `init express` paste the
 * snippet, so theirs matches the bare `chatly csp`. The generated file prints
 * its own refresh command for exactly this reason; it used to print
 * `--format next` whatever the variant, which silently put the hashes back.
 */
import { str, type ParsedArgs } from '../args.js';
import {
  cspModule,
  hostsOnly,
  pickChannel,
  type ChannelRow,
  type EmbedBlock,
} from '../init/shared.js';
import { printJson } from '../output.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

const FORMATS = ['next', 'header', 'json'] as const;
type Format = (typeof FORMATS)[number];

const INSTALLS = ['snippet', 'react'] as const;
type Install = (typeof INSTALLS)[number];

const USAGE =
  `Usage: chatly csp [--format ${FORMATS.join('|')}] [--install ${INSTALLS.join('|')}] ` +
  '[--public-id <id>]\n';

/** Header-directive name per `embed.contentSecurityPolicy` key, in order. */
const DIRECTIVES: ReadonlyArray<readonly [keyof EmbedBlock['contentSecurityPolicy'], string]> = [
  ['scriptSrc', 'script-src'],
  ['connectSrc', 'connect-src'],
  ['imgSrc', 'img-src'],
  ['mediaSrc', 'media-src'],
];

export async function csp(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const format = (str(args.flags, 'format') ?? 'next') as Format;
  if (!(FORMATS as ReadonlyArray<string>).includes(format)) {
    process.stderr.write(`Unknown --format "${format}".\n${USAGE}`);
    return 2;
  }
  const install = (str(args.flags, 'install') ?? 'snippet') as Install;
  if (!(INSTALLS as ReadonlyArray<string>).includes(install)) {
    process.stderr.write(`Unknown --install "${install}".\n${USAGE}`);
    return 2;
  }

  const rows: unknown = await chatly.request('GET', '/v1/channels');
  const picked = pickChannel(
    Array.isArray(rows) ? (rows as ChannelRow[]) : [],
    str(args.flags, 'public-id'),
  );
  if ('error' in picked) {
    process.stderr.write(`${picked.error}\n`);
    return 1;
  }

  const policy =
    install === 'react'
      ? hostsOnly(picked.embed.contentSecurityPolicy)
      : picked.embed.contentSecurityPolicy;

  if (format === 'json') {
    printJson(Object.fromEntries(DIRECTIVES.map(([key, name]) => [name, policy[key]])));
    return 0;
  }
  if (format === 'header') {
    /*
     * The directives only, with no trailing newline problem and no attempt at
     * a whole header: these are Chatly's SOURCES, to be merged into the
     * policy the host page already sends. Two `Content-Security-Policy`
     * headers INTERSECT rather than extend, so emitting a complete header
     * would block the integrator's own scripts — the same warning the
     * generated module carries.
     */
    process.stdout.write(
      `${DIRECTIVES.map(([key, name]) => [name, ...policy[key]].join(' ')).join('; ')}\n`,
    );
    return 0;
  }

  // The raw embed, not `policy`: `cspModule` filters from `install` itself —
  // one filter, so the file `chatly init next` writes and this output cannot
  // drift.
  process.stdout.write(
    cspModule({
      publicId: picked.publicId,
      embed: picked.embed,
      // Unused by `cspModule`; the identity choice belongs to `init`.
      identity: 'hmac',
      generatedOn: new Date().toISOString().slice(0, 10),
      install,
    }).contents,
  );
  return 0;
}
