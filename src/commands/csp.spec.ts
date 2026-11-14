/**
 * `chatly csp` / `chatly init` — the CSP variant follows the install (CH-13).
 *
 * `formflow-cli.spec.ts` covers the command's flags end to end. This file is
 * about the two things that made FormFlow's `proxy.ts` hand-copied in the
 * first place, both of which were defects in the GENERATED file rather than
 * in the flags:
 *
 *  1. `chatly init next` scaffolds `<ChatlyLauncher>` — a package install
 *     with no inline script — and wrote the inline-snippet variant beside it,
 *     hashes and all, with a comment telling the reader to find a nonce or a
 *     hash for a script the scaffold never emits.
 *
 *  2. The refresh command printed in the file's own header was
 *     `chatly csp --format next > chatly.csp.mjs` whatever the variant. That
 *     defaults to `--install snippet`, so the documented refresh of a
 *     hash-free file put the hashes back — a build step that silently changes
 *     the policy is worse than no build step.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { missingFromPolicies, parsePolicies } from './doctor-csp-site.js';
import { cspModule, hostsOnly, type EmbedBlock } from '../init/shared.js';
import { scaffold } from '../init/templates.js';

import type { ScaffoldInput } from '../init/shared.js';

/** A web channel's embed block, shaped like the API's with hashes present. */
const EMBED: EmbedBlock = {
  snippet: '<script>/* eager snippet for acme-web */</script>',
  contentSecurityPolicy: {
    scriptSrc: ["'self'", 'https://widget.chatlychat.com', "'sha256-AAA='", "'sha256-BBB='"],
    connectSrc: [
      'https://api.chatlychat.com',
      'https://ws.chatlychat.com',
      'wss://ws.chatlychat.com',
      'https://uploads.chatlychat.com',
    ],
    imgSrc: ['https://files.chatlychat.com', 'data:', 'blob:'],
    mediaSrc: ['https://files.chatlychat.com'],
  },
  storage: [],
};

const INPUT: ScaffoldInput = {
  publicId: 'acme-web',
  embed: EMBED,
  identity: 'hmac',
  generatedOn: '2026-11-13',
};

const moduleFor = (install: 'snippet' | 'react' | undefined): string =>
  cspModule(install === undefined ? INPUT : { ...INPUT, install }).contents;

const cspFileOf = (framework: 'next' | 'remix' | 'astro' | 'express'): string => {
  const file = scaffold(framework, INPUT).find((f) => f.path === 'chatly.csp.mjs');
  if (file === undefined) {
    throw new Error(`${framework} scaffolded no chatly.csp.mjs`);
  }
  return file.contents;
};

describe('hostsOnly', () => {
  it("removes every 'sha256-…' and nothing else", () => {
    expect(hostsOnly(EMBED.contentSecurityPolicy)).toEqual({
      scriptSrc: ["'self'", 'https://widget.chatlychat.com'],
      connectSrc: EMBED.contentSecurityPolicy.connectSrc,
      imgSrc: EMBED.contentSecurityPolicy.imgSrc,
      mediaSrc: EMBED.contentSecurityPolicy.mediaSrc,
    });
  });

  it("keeps a 'nonce-…' and a scheme source, which are not snippet hashes", () => {
    // The prefix test names what it removes rather than removing everything
    // quoted: a published `'nonce-…'` would be the host page's own and
    // dropping it would break the install this variant is for.
    expect(
      hostsOnly({
        scriptSrc: ["'nonce-abc'", "'strict-dynamic'", "'sha256-AAA='"],
        connectSrc: [],
        imgSrc: ['data:'],
        mediaSrc: [],
      }).scriptSrc,
    ).toEqual(["'nonce-abc'", "'strict-dynamic'"]);
  });
});

describe('cspModule', () => {
  it('the react variant prints a refresh command that reproduces the react variant', () => {
    /*
     * CONTROL: hardcode `refresh` back to
     * `chatly csp --format next > chatly.csp.mjs` in `init/shared.ts` and this
     * assertion fails — which is the whole bug, because `--format next`
     * defaults to `--install snippet`.
     */
    expect(moduleFor('react')).toContain('`chatly csp --install react > chatly.csp.mjs`');
    expect(moduleFor('react')).not.toContain('chatly csp --format next');
  });

  it('the snippet variant still prints --format next, and keeps the hashes', () => {
    expect(moduleFor('snippet')).toContain('`chatly csp --format next > chatly.csp.mjs`');
    expect(moduleFor('snippet')).toContain("'sha256-AAA='");
    // No `install` at all is the snippet install: the faithful answer is the
    // default, because a MISSING hash blocks a pasted snippet outright.
    expect(moduleFor(undefined)).toBe(moduleFor('snippet'));
  });

  it('the react variant drops the hashes from the module it writes', () => {
    const text = moduleFor('react');
    expect(text).not.toContain('sha256-');
    expect(text).toContain('\'script-src\': ["\'self\'", "https://widget.chatlychat.com"]');
  });

  it("warns that 'strict-dynamic' ignores the host it just added", () => {
    /*
     * Fact the integrator cannot be expected to know: `'strict-dynamic'` — in
     * Next's own recommended policy — makes the browser ignore every host
     * source in `script-src`, so the widget host `withChatly` appends is
     * inert and widening the policy further does nothing. Without this the
     * reader debugs a missing widget by adding hosts.
     */
    expect(moduleFor('react')).toContain("'strict-dynamic'");
    expect(moduleFor('snippet')).not.toContain("'strict-dynamic'");
  });
});

describe('scaffold', () => {
  it('next and remix write the variant they scaffold — ChatlyLauncher, no hashes', () => {
    /*
     * CONTROL: drop the `install` argument in `templates.ts` (back to
     * `cspModule(input)`) and both frameworks fail here on `sha256-`. This is
     * the defect FormFlow reported: `chatly init next` handed them a launcher
     * install and a policy describing an inline snippet.
     */
    for (const framework of ['next', 'remix'] as const) {
      expect(cspFileOf(framework)).not.toContain('sha256-');
      expect(cspFileOf(framework)).toContain('`chatly csp --install react > chatly.csp.mjs`');
    }
  });

  it('astro and express paste the snippet, so they keep the hashes', () => {
    for (const framework of ['astro', 'express'] as const) {
      expect(cspFileOf(framework)).toContain("'sha256-AAA='");
      expect(cspFileOf(framework)).toContain('`chatly csp --format next > chatly.csp.mjs`');
    }
  });

  it('the launcher next/remix scaffold really is the package install', () => {
    // The pairing above is only correct while these two scaffold a component
    // rather than a snippet. If that changes, this fails before the CSP does.
    for (const [framework, path] of [
      ['next', 'components/chatly.tsx'],
      ['remix', 'app/components/chatly.tsx'],
    ] as const) {
      const launcher = scaffold(framework, INPUT).find((f) => f.path === path);
      expect(launcher?.contents).toContain("from '@chatlychat/widget-react'");
    }
    expect(
      scaffold('astro', INPUT).find((f) => f.path === 'src/components/Chatly.astro')?.contents,
    ).toContain('set:html={snippet}');
  });
});

/**
 * FormFlow's own acceptance criterion, as a test: "`proxy.ts` imports the
 * generated list and `chatly doctor` stays green after a Chatly host change
 * with no edit to our code."
 *
 * So this evaluates the generated module, builds the header the documented
 * Next recipe builds (`/docs/sdk-react#nextjs-one-proxy-file-no-hardcoded-hosts`),
 * and runs it through the very matcher `chatly doctor --origin` uses. A docs
 * example is a product claim; this is the claim being checked rather than
 * read. `doctor-csp-site.ts` is imported read-only.
 */
describe('the documented Next recipe, end to end', () => {
  const headerFrom = async (embed: EmbedBlock, nonce: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'chatly-csp-'));
    const file = join(dir, 'chatly.csp.mjs');
    await writeFile(file, cspModule({ ...INPUT, embed, install: 'react' }).contents, 'utf8');
    const mod = (await import(pathToFileURL(file).href)) as {
      withChatly: (d: Record<string, string[]>) => Record<string, string[]>;
      toHeader: (d: Record<string, string[]>) => string;
    };
    // Verbatim the directives the recipe passes.
    return mod.toHeader(
      mod.withChatly({
        'default-src': [`'self'`],
        'script-src': [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`],
        'style-src': [`'self'`, `'nonce-${nonce}'`],
        'img-src': [`'self'`, 'data:'],
        'connect-src': [`'self'`],
      }),
    );
  };

  const unadmitted = (header: string, embed: EmbedBlock): string[] =>
    missingFromPolicies({
      policies: parsePolicies(header),
      published: hostsOnly(embed.contentSecurityPolicy),
      siteOrigin: 'https://formflow.example',
    }).map((m) => `${m.source} (${m.directive})`);

  it('admits every host the channel publishes', async () => {
    expect(unadmitted(await headerFrom(EMBED, 'n1'), EMBED)).toEqual([]);
  });

  it('a new Chatly host reaches the policy with no edit to the app', async () => {
    /*
     * The host change: Chatly starts serving files from a second origin, so
     * `embed.contentSecurityPolicy` grows one entry. `prebuild` re-runs
     * `chatly csp --install react`, nothing in the app changes, and the
     * header must admit it.
     *
     * CONTROL: build the header from the OLD embed and check it against the
     * NEW published lists — `missingFromPolicies` then names
     * `https://files2.chatlychat.com` in `img-src` and `media-src`, which is
     * the stale-file failure this command exists to prevent.
     */
    const moved: EmbedBlock = {
      ...EMBED,
      contentSecurityPolicy: {
        ...EMBED.contentSecurityPolicy,
        imgSrc: [...EMBED.contentSecurityPolicy.imgSrc, 'https://files2.chatlychat.com'],
        mediaSrc: [...EMBED.contentSecurityPolicy.mediaSrc, 'https://files2.chatlychat.com'],
      },
    };
    expect(unadmitted(await headerFrom(moved, 'n2'), moved)).toEqual([]);
    expect(unadmitted(await headerFrom(EMBED, 'n3'), moved)).toEqual([
      'https://files2.chatlychat.com (img-src)',
      'https://files2.chatlychat.com (media-src)',
    ]);
  });

  it('keeps the host entry `strict-dynamic` ignores, because doctor reads it', async () => {
    // Not decoration: a browser with no `'strict-dynamic'` support falls back
    // to the allowlist, and `chatly doctor --origin` has no other way to see
    // the widget host. Drop it from the recipe and this is what breaks.
    const header = await headerFrom(EMBED, 'n4');
    expect(header).toContain(
      "script-src 'self' 'nonce-n4' 'strict-dynamic' https://widget.chatlychat.com",
    );
  });
});
