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
 *     moves. This command is the build step: `chatly csp --format next >
 *     chatly.csp.mjs` in `prebuild`, and their `middleware.ts` stays
 *     correct with no edit to their code.
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
 * ═══ CROSS-LANE ═══════════════════════════════════════════════════════════
 *
 * The report asked whether the API should publish a hashless `react` variant
 * of the block. It should, probably, and that is not this package's to add:
 * the CLI filters `'sha256-'` out of what the API already returns, which is a
 * complete answer today and costs the API nothing. If the variant lands, this
 * command reads it and the filter becomes dead code to delete.
 *
 * ═══ ONE READ, AND IT IS THE SAME ONE `init` MAKES ════════════════════════
 *
 * `GET /v1/channels`, the same route, through the same `pickChannel`, into the
 * same `cspModule` — so `chatly csp --format next` and the file
 * `chatly init next` wrote are byte-identical for the same channel on the
 * same day. A second renderer here would be a second answer to one question.
 */
import { str, type ParsedArgs } from '../args.js';
import { cspModule, pickChannel, type ChannelRow, type EmbedBlock } from '../init/shared.js';
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

/**
 * A `'sha256-…'` source, which is a hash of the inline embed snippet.
 *
 * Matched on the PREFIX of the quoted token, not by looking for a host that
 * is not a host: `'nonce-…'` would be the other quoted hash-like source and
 * the API does not publish one, so a prefix test that names what it removes
 * is the honest shape. Everything else — `'self'`, `data:`, `blob:` and every
 * origin — is kept by both variants.
 */
const isSnippetHash = (source: string): boolean => source.startsWith("'sha256-");

/** The published policy with the inline-snippet hashes taken out. */
function hostsOnly(
  csp: EmbedBlock['contentSecurityPolicy'],
): EmbedBlock['contentSecurityPolicy'] {
  return {
    scriptSrc: csp.scriptSrc.filter((s) => !isSnippetHash(s)),
    connectSrc: csp.connectSrc.filter((s) => !isSnippetHash(s)),
    imgSrc: csp.imgSrc.filter((s) => !isSnippetHash(s)),
    mediaSrc: csp.mediaSrc.filter((s) => !isSnippetHash(s)),
  };
}

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

  process.stdout.write(
    cspModule({
      publicId: picked.publicId,
      embed: { ...picked.embed, contentSecurityPolicy: policy },
      // Unused by `cspModule`; the identity choice belongs to `init`.
      identity: 'hmac',
      generatedOn: new Date().toISOString().slice(0, 10),
      install,
    }).contents,
  );
  return 0;
}
