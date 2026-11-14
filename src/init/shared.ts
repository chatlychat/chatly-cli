/**
 * The parts of `chatly init` (CHT-F02) that do not depend on the framework:
 * the CSP module and the privacy-policy table. Both are rendered from the
 * channel's own `embed` block, read off `GET /v1/channels` with the caller's
 * key — the same block the dashboard's install screen shows — so neither is a
 * hand-kept copy of something the server already says.
 */

/** One generated file. `path` is relative to the target directory. */
export interface ScaffoldFile {
  readonly path: string;
  readonly contents: string;
}

/** The fields of `channel.embed` this wizard reads. Everything else is ignored. */
export interface EmbedBlock {
  readonly snippet: string;
  readonly contentSecurityPolicy: {
    readonly scriptSrc: ReadonlyArray<string>;
    readonly connectSrc: ReadonlyArray<string>;
    readonly imgSrc: ReadonlyArray<string>;
    readonly mediaSrc: ReadonlyArray<string>;
  };
  readonly storage: ReadonlyArray<StorageKey>;
}

/** One row of `embed.storage` — the public storage declaration. */
export interface StorageKey {
  readonly key: string;
  readonly store: string;
  readonly purpose: string;
  readonly lifetime: string;
  readonly category: string;
  readonly writtenWhen: string;
}

export interface ChannelRow {
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

export interface ScaffoldInput {
  readonly publicId: string;
  readonly embed: EmbedBlock;
  /** `hmac` signs the user id on your server; `atlas` passes an Atlas token. */
  readonly identity: 'hmac' | 'atlas';
  /** ISO date, stamped into each header so a stale file can be recognised. */
  readonly generatedOn: string;
  /**
   * Which install the CSP is FOR (CH-13).
   *
   * `snippet` (the default) keeps the `'sha256-…'` sources the API publishes
   * for the inline embed snippet. `react` is a `@chatlychat/widget-react` or
   * `<chatly-widget>` install, which loads the loader from a `<script src>`
   * and runs no inline script at all — so those hashes match nothing, and a
   * reader seeing them in `script-src` concludes they need `'unsafe-inline'`
   * and weakens their policy for a script that does not exist.
   *
   * This filters the lists AND changes the refresh command the file prints,
   * and the second half is the one that was wrong: the header said
   * `chatly csp --format next > chatly.csp.mjs` whatever the variant, and
   * `--format next` defaults to `--install snippet` — so the documented
   * refresh of a react file put the hashes straight back.
   */
  readonly install?: 'snippet' | 'react';
}

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

/**
 * The published policy with the inline-snippet hashes taken out.
 *
 * Exported because `chatly csp --format header|json` needs the same answer as
 * `--format next`, and two filters would be two answers to one question.
 */
export function hostsOnly(
  csp: EmbedBlock['contentSecurityPolicy'],
): EmbedBlock['contentSecurityPolicy'] {
  return {
    scriptSrc: csp.scriptSrc.filter((s) => !isSnippetHash(s)),
    connectSrc: csp.connectSrc.filter((s) => !isSnippetHash(s)),
    imgSrc: csp.imgSrc.filter((s) => !isSnippetHash(s)),
    mediaSrc: csp.mediaSrc.filter((s) => !isSnippetHash(s)),
  };
}

/**
 * The module every framework's CSP is merged from.
 *
 * `.mjs` and dependency-free on purpose: `next.config.{js,mjs,ts}` and an
 * Express server can both import it, and a header built from it needs no
 * library. It does NOT write a header itself — the host page already has a
 * policy, and a second `Content-Security-Policy` header INTERSECTS with the
 * first rather than extending it, which would block the host's own scripts.
 * So it merges into the directives the integrator already has.
 */
export function cspModule(input: ScaffoldInput): ScaffoldFile {
  const react = input.install === 'react';
  const csp = react
    ? hostsOnly(input.embed.contentSecurityPolicy)
    : input.embed.contentSecurityPolicy;
  const refresh = `chatly csp${react ? ' --install react' : ' --format next'} > chatly.csp.mjs`;
  const list = (values: ReadonlyArray<string>): string =>
    `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
  return {
    path: 'chatly.csp.mjs',
    contents: `/**
 * Chatly's Content-Security-Policy sources for the web channel ${input.publicId}.
 *
 * Generated on ${input.generatedOn} from the channel's own
 * \`embed.contentSecurityPolicy\`. REFRESH it with
 * \`${refresh}\` — put that in \`prebuild\` and
 * it cannot go stale. \`chatly init\` wrote it the first time and will not
 * overwrite it, so re-running init is not the refresh. The lists are the
 * origins CHATLY serves from, not an image URL an operator put in a theme.
 *
 * MERGE these into your existing directives; do not send a second
 * Content-Security-Policy header. Two headers intersect, so a second one
 * would block your own scripts rather than allow Chatly's.
 *
 * ${
   react
     ? `This list is for a @chatlychat/widget-react or <chatly-widget> install:\n * the inline-snippet hashes are NOT in it, because that install runs no\n * inline script. If a host allowlist is your whole script-src then this\n * list is the whole job: you do not need a nonce and you do not need\n * 'unsafe-inline'. If you switch to the embed snippet, regenerate without\n * --install react.\n *\n * If your script-src carries 'strict-dynamic' — Next's own recommendation —\n * the browser IGNORES every host source in it, including the widget host\n * this module adds. That is not a bug to widen your way out of: the loader\n * is reached through the nonce chain instead (pass \`nonce\` to\n * <ChatlyLauncher>). The host entry is here so the same module is correct\n * for a policy WITHOUT 'strict-dynamic'; adding more hosts to script-src\n * while it is present changes nothing at all.`
     : `The embed snippet is an inline <script>: your script-src needs a nonce or\n * hash for it, or load the widget with @chatlychat/widget-react instead and\n * regenerate with \`chatly csp --install react\`.`
 }
 */
export const chatlyCsp = {
  'script-src': ${list(csp.scriptSrc)},
  'connect-src': ${list(csp.connectSrc)},
  'img-src': ${list(csp.imgSrc)},
  'media-src': ${list(csp.mediaSrc)},
};

/**
 * Your directives with Chatly's sources appended, de-duplicated.
 * Directive names are the header's own (\`'script-src'\`, not \`scriptSrc\`).
 *
 * @param {Record<string, string[]>} directives
 * @returns {Record<string, string[]>}
 */
export function withChatly(directives) {
  const out = { ...directives };
  for (const [name, sources] of Object.entries(chatlyCsp)) {
    out[name] = [...new Set([...(out[name] ?? ["'self'"]), ...sources])];
  }
  return out;
}

/**
 * Directives to a header value: \`"script-src 'self' https://…; connect-src …"\`.
 *
 * @param {Record<string, string[]>} directives
 * @returns {string}
 */
export function toHeader(directives) {
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ');
}
`,
  };
}

/** Escape a value for a Markdown table cell. */
function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/**
 * The privacy-policy table (CHT-DOC12's content, rendered for this channel).
 *
 * Every key with the channel's `publicId` already substituted, which is the
 * form a privacy policy or a consent tool's cookie scan needs. `cookies` is
 * stated as none because the declaration says so — an omitted row reads as
 * "not declared", not as "none".
 */
export function privacyTable(input: ScaffoldInput): ScaffoldFile {
  const rows = input.embed.storage.map(
    (k) =>
      `| \`${cell(k.key)}\` | ${cell(k.store)} | ${cell(k.purpose)} | ${cell(k.lifetime)} | ` +
      `${cell(k.category)} | ${cell(k.writtenWhen)} |`,
  );
  return {
    path: 'CHATLY-PRIVACY.md',
    contents: `# What the Chatly widget stores in a visitor's browser

Generated by \`chatly init\` on ${input.generatedOn} from the storage
declaration of web channel \`${input.publicId}\` — the same list Chatly
publishes for that channel without a key. Paste the table into your privacy
policy or cookie notice.

**Cookies: none.** The widget sets no cookies.

| Key | Store | Purpose | Lifetime | Category | Written when |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

Whether ANY of these is written is decided by the \`storage\` option on your
embed, which the server never sees — \`storage: 'deny'\` writes none of them.
See https://chatlychat.com/guides/consent.
`,
  };
}
