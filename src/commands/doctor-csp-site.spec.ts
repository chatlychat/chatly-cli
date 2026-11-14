/**
 * `csp.site` — the matcher, and the one check in this command that reads the
 * CUSTOMER's page rather than our own deployment.
 *
 * ═══ WHY EACH CASE IS HERE ════════════════════════════════════════════════
 *
 * Every one of these was control-tested by breaking the code it names and
 * watching it fail — the six breaks are listed in the commit — and two of
 * them exist because a weaker version of the test passed against the bug:
 *
 *   * `default-src restricts` pins the fallback. The obvious test (a policy
 *     naming ONLY `default-src`, with every host in it) passes with the
 *     fallback deleted, because an absent directive reads as unrestricted.
 *   * `two policies` pins the intersection. A union reads as `every` instead
 *     of `some` and the single-policy cases cannot tell the difference.
 *
 * The matcher is deliberately permissive about ports, paths and schemeless
 * sources; `doctor-csp-site.ts`'s header says why, and the two cases at the
 * end assert that permissiveness rather than leaving it undocumented.
 */
import { describe, expect, it } from 'vitest';

import {
  cspFromHtml,
  missingFromPolicies,
  parsePolicies,
  siteCspVerdict,
  sourceAdmits,
} from './doctor-csp-site.js';

/** What a web channel publishes under `embed.contentSecurityPolicy`. */
const PUBLISHED = {
  scriptSrc: ["'self'", 'https://widget.chatlychat.com'],
  connectSrc: [
    'https://api.chatlychat.com',
    'wss://realtime.chatlychat.com',
    'https://uploads.chatlychat.com',
  ],
  imgSrc: ["'self'", 'data:', 'blob:', 'https://files.chatlychat.com'],
  mediaSrc: ['blob:'],
};

const SITE = 'https://formflow.15-204-158-166.sslip.io';

const missing = (csp: string): string[] =>
  missingFromPolicies({
    policies: parsePolicies(csp),
    published: PUBLISHED,
    siteOrigin: SITE,
  })
    .map((m) => `${m.source}|${m.directive}`)
    .sort();

describe('missingFromPolicies', () => {
  it('names the host a real integrator was missing', () => {
    // The live policy on 2026-11-03, with the upload host absent. `chatly
    // doctor` answered "0 failed" against this page.
    expect(
      missing(
        "default-src 'self'; script-src 'self' https://widget.chatlychat.com; " +
          "connect-src 'self' https://api.chatlychat.com wss://realtime.chatlychat.com; " +
          "img-src 'self' data: blob: https://files.chatlychat.com; media-src blob:",
      ),
    ).toEqual(['https://uploads.chatlychat.com|connect-src']);
  });

  it('reads default-src when the directive itself is absent', () => {
    expect(
      missing(
        "default-src 'self' https://widget.chatlychat.com https://api.chatlychat.com " +
          'https://uploads.chatlychat.com wss://realtime.chatlychat.com data: blob: ' +
          'https://files.chatlychat.com',
      ),
    ).toEqual([]);
  });

  it('default-src restricts as well as filling in — the fallback is not cosmetic', () => {
    expect(missing("default-src 'self'")).toEqual(
      [
        'https://widget.chatlychat.com|script-src',
        'https://api.chatlychat.com|connect-src',
        'wss://realtime.chatlychat.com|connect-src',
        'https://uploads.chatlychat.com|connect-src',
        'data:|img-src',
        'blob:|img-src',
        'https://files.chatlychat.com|img-src',
        'blob:|media-src',
      ].sort(),
    );
  });

  it('treats a directive with no policy and no default-src as unrestricted', () => {
    expect(missing("script-src 'self' https://widget.chatlychat.com")).toEqual([]);
  });

  it('intersects two policies: present in one is still blocked', () => {
    expect(missing("default-src *, connect-src 'self' https://api.chatlychat.com")).toEqual(
      [
        'https://uploads.chatlychat.com|connect-src',
        'wss://realtime.chatlychat.com|connect-src',
        // `*` is not a wildcard over `data:`/`blob:` — CSP's own carve-out,
        // so `default-src *` blocks the widget's inline images.
        'data:|img-src',
        'blob:|img-src',
        'blob:|media-src',
      ].sort(),
    );
  });

  it("reports no script host against a 'strict-dynamic' script-src", () => {
    /*
     * The false FAILURE. `'strict-dynamic'` makes the browser ignore every
     * host source and `'self'` in `script-src`, so the widget host's absence
     * is not a problem — and the fix sentence this check prints
     * ("copy `embed.contentSecurityPolicy` into the site's policy") is advice
     * that cannot work, because adding hosts there changes nothing. A
     * customer who correctly deleted the redundant entry was told their
     * policy was broken and told to put it back.
     *
     * The loader is reached through the nonce chain instead; the three other
     * directives are untouched by the keyword and must still be checked,
     * which is the second expectation.
     *
     * CONTROL: delete the `ignoresHosts` call in `missingFromPolicies` and
     * the first expectation fails with
     * `['https://widget.chatlychat.com|script-src']`.
     */
    expect(
      missing(
        "script-src 'self' 'nonce-r4nd0m' 'strict-dynamic'; " +
          "connect-src 'self' https://api.chatlychat.com wss://realtime.chatlychat.com " +
          'https://uploads.chatlychat.com; ' +
          "img-src 'self' data: blob: https://files.chatlychat.com; media-src blob:",
      ),
    ).toEqual([]);
    expect(
      missing("script-src 'strict-dynamic'; connect-src 'self'; img-src 'self'; media-src 'self'"),
    ).toEqual(
      [
        'https://api.chatlychat.com|connect-src',
        'wss://realtime.chatlychat.com|connect-src',
        'https://uploads.chatlychat.com|connect-src',
        'data:|img-src',
        'blob:|img-src',
        'https://files.chatlychat.com|img-src',
        'blob:|media-src',
      ].sort(),
    );
  });

  it('reads the keyword through the default-src fallback, for scripts only', () => {
    /*
     * `default-src 'self' 'strict-dynamic'` governs scripts that fall back to
     * it, and the browser ignores host sources for them just as it would in
     * `script-src` — so the script host must NOT be reported. Every other
     * directive still is: that is the whole of "script-src only".
     *
     * CONTROL: narrow `ignoresHosts` to a literal `script-src` by testing
     * `policy.get(directive)` instead of `effective`, and
     * `https://widget.chatlychat.com|script-src` reappears in this list.
     */
    expect(missing("default-src 'self' 'strict-dynamic'")).toEqual(
      [
        'https://api.chatlychat.com|connect-src',
        'wss://realtime.chatlychat.com|connect-src',
        'https://uploads.chatlychat.com|connect-src',
        'data:|img-src',
        'blob:|img-src',
        'https://files.chatlychat.com|img-src',
        'blob:|media-src',
      ].sort(),
    );
  });

  it('still reports a script host on a policy without the keyword', () => {
    // The 2026-11-03 half of this check, unchanged: no `'strict-dynamic'`, so
    // hosts in `script-src` are load-bearing and a missing one is real.
    expect(missing("script-src 'self' 'nonce-r4nd0m'")).toEqual([
      'https://widget.chatlychat.com|script-src',
    ]);
  });

  it("never looks for a published 'self'", () => {
    expect(
      missing(
        'script-src https://widget.chatlychat.com; connect-src https://api.chatlychat.com ' +
          'wss://realtime.chatlychat.com https://uploads.chatlychat.com; img-src data: blob: ' +
          'https://files.chatlychat.com; media-src blob:',
      ),
    ).toEqual([]);
  });
});

describe('sourceAdmits', () => {
  it('admits a wss: URL from an https: source, which is CSP’s own rule', () => {
    expect(
      sourceAdmits('https://realtime.chatlychat.com', 'wss://realtime.chatlychat.com', SITE),
    ).toBe(true);
    expect(
      sourceAdmits('http://realtime.chatlychat.com', 'wss://realtime.chatlychat.com', SITE),
    ).toBe(true);
    expect(
      sourceAdmits('https://realtime.chatlychat.com', 'ws://realtime.chatlychat.com', SITE),
    ).toBe(false);
  });

  it('matches *.host on a subdomain and not on the apex', () => {
    expect(sourceAdmits('*.chatlychat.com', 'https://uploads.chatlychat.com', SITE)).toBe(true);
    expect(sourceAdmits('*.chatlychat.com', 'https://chatlychat.com', SITE)).toBe(false);
    expect(sourceAdmits('*.example.com', 'https://uploads.chatlychat.com', SITE)).toBe(false);
  });

  it('treats * as any network scheme and not as data:', () => {
    expect(sourceAdmits('*', 'https://uploads.chatlychat.com', SITE)).toBe(true);
    expect(sourceAdmits('*', 'data:', SITE)).toBe(false);
    expect(sourceAdmits('data:', 'data:', SITE)).toBe(true);
    expect(sourceAdmits('https:', 'data:', SITE)).toBe(false);
    expect(sourceAdmits('https:', 'https://uploads.chatlychat.com', SITE)).toBe(true);
  });

  it('reads the keywords', () => {
    expect(sourceAdmits("'none'", 'https://a.b', SITE)).toBe(false);
    expect(sourceAdmits("'unsafe-inline'", 'https://a.b', SITE)).toBe(false);
    expect(sourceAdmits("'self'", SITE, SITE)).toBe(true);
    expect(sourceAdmits("'self'", 'https://uploads.chatlychat.com', SITE)).toBe(false);
  });

  it('ignores a port and a path, which is the documented permissive direction', () => {
    expect(
      sourceAdmits('https://uploads.chatlychat.com:8443', 'https://uploads.chatlychat.com', SITE),
    ).toBe(true);
    expect(
      sourceAdmits(
        'https://uploads.chatlychat.com/widget/',
        'https://uploads.chatlychat.com',
        SITE,
      ),
    ).toBe(true);
  });
});

describe('parsePolicies', () => {
  it('ignores a directive repeated inside one policy, as a browser does', () => {
    const [first] = parsePolicies('connect-src https://a; connect-src https://b');
    expect(first?.get('connect-src')).toEqual(['https://a']);
  });

  it('splits several policies out of one joined header value', () => {
    expect(parsePolicies("default-src *, connect-src 'self'")).toHaveLength(2);
  });
});

describe('cspFromHtml', () => {
  it('reads a meta policy whichever way it is written', () => {
    expect(
      cspFromHtml('<meta http-equiv="Content-Security-Policy" content="connect-src https://a">'),
    ).toEqual(['connect-src https://a']);
    expect(
      cspFromHtml("<meta content='connect-src https://b' http-equiv='content-security-policy'>"),
    ).toEqual(['connect-src https://b']);
  });

  it('reads nothing from another meta tag or from a page with none', () => {
    expect(cspFromHtml('<meta http-equiv="refresh" content="0">')).toEqual([]);
    expect(cspFromHtml('<html><head><title>x</title></head></html>')).toEqual([]);
  });
});

describe('siteCspVerdict', () => {
  const page = (csp: string | null, html = ''): typeof fetch =>
    (() =>
      Promise.resolve(
        new Response(html, {
          headers: csp === null ? {} : { 'content-security-policy': csp },
        }),
      )) as unknown as typeof fetch;

  it('fails naming the missing host and the directive it belongs in', async () => {
    const v = await siteCspVerdict({
      origin: SITE,
      published: PUBLISHED,
      fetchFn: page(
        "default-src 'self' data: blob: https://files.chatlychat.com https://widget.chatlychat.com https://api.chatlychat.com wss://realtime.chatlychat.com",
      ),
    });
    expect(v.verdict).toBe('fail');
    expect(v.detail).toContain('https://uploads.chatlychat.com (connect-src)');
  });

  it("passes a 'strict-dynamic' site and names the half it cannot verify", async () => {
    /*
     * End to end, which `missingFromPolicies` on its own cannot show: the
     * recipe at /docs/sdk-react#nextjs-one-proxy-file-no-hardcoded-hosts with
     * the widget host DELETED from `script-src`, which is the correct thing to
     * do under the keyword and used to be reported as a broken policy with
     * advice that could not work.
     *
     * The second expectation is the honest cost: a pass here does not prove
     * the nonce reaches the launcher, and nothing fetched from outside can.
     *
     * CONTROL: delete the `ignoresHosts` call in `missingFromPolicies` and
     * this becomes `fail` on `https://widget.chatlychat.com (script-src)`;
     * delete the `strictDynamic` clause and the second expectation fails.
     */
    const v = await siteCspVerdict({
      origin: SITE,
      published: PUBLISHED,
      fetchFn: page(
        "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; " +
          "connect-src 'self' https://api.chatlychat.com wss://realtime.chatlychat.com " +
          'https://uploads.chatlychat.com; ' +
          "img-src 'self' data: blob: https://files.chatlychat.com; media-src blob:",
      ),
    });
    expect(v.verdict).toBe('pass');
    expect(v.detail).toContain('confirm the launcher is given the response’s nonce');
  });

  it('passes a site that sends no policy at all', async () => {
    const v = await siteCspVerdict({ origin: SITE, published: PUBLISHED, fetchFn: page(null) });
    expect(v.verdict).toBe('pass');
    expect(v.detail).toContain('no Content-Security-Policy');
  });

  it('reads a meta policy when there is no header, and fails on it', async () => {
    const v = await siteCspVerdict({
      origin: SITE,
      published: PUBLISHED,
      fetchFn: page(
        null,
        '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">',
      ),
    });
    expect(v.verdict).toBe('fail');
  });

  /*
   * A site this command cannot reach is not a verdict about the site's
   * policy, and reporting it as `fail` would send somebody to edit a header
   * that may well be correct.
   */
  it('warns rather than failing when the site cannot be fetched', async () => {
    const v = await siteCspVerdict({
      origin: SITE,
      published: PUBLISHED,
      fetchFn: (() =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as unknown as typeof fetch,
    });
    expect(v.verdict).toBe('warn');
    expect(v.detail).toContain('ENOTFOUND');
  });
});
