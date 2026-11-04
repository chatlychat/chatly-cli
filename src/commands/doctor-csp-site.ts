/**
 * `csp.site` — does the SITE's own Content-Security-Policy admit the hosts
 * this channel's widget needs?
 *
 * ═══ WHY THIS CHECK EXISTS ════════════════════════════════════════════════
 *
 * `csp.hosts` next door asks whether every host Chatly PUBLISHES in
 * `embed.contentSecurityPolicy` answers an HTTP request. That is a question
 * about our deployment. It says nothing about whether the integrator copied
 * the policy onto their site, and that is the half that breaks.
 *
 * It broke for a real integrator on 2026-11-03. Their live `connect-src` was
 * missing `https://uploads.chatlychat.com`, so every attachment upload from
 * their widget was refused by the browser before it left the page — and
 * `chatly doctor --origin <their site>` answered "5 ok, 1 warning, 0 failed",
 * because nothing in the command had ever read the site. A CSP violation is
 * invisible server-side by construction: the request is never made.
 *
 * ═══ THE MATCHER IS DELIBERATELY PERMISSIVE WHERE IT IS UNSURE ════════════
 *
 * Every simplification below errs towards PASS, and the reason is asymmetric
 * cost. A false failure sends somebody to fix a policy that was already
 * correct, and the second time that happens they stop believing the command.
 * A false pass leaves them where they were before this check existed. So:
 *
 *   * a source with no scheme matches any of http/https/ws/wss, where the
 *     spec would narrow it to the document's own scheme;
 *   * a source with no port matches any port, where the spec would narrow it
 *     to the scheme's default;
 *   * a path on a source is ignored and the host alone is compared.
 *
 * What is NOT simplified is the part that would produce a wrong verdict in
 * the direction that matters: `default-src` fallback (a site that names no
 * `connect-src` is governed by `default-src`, and reading the directive alone
 * would report every such site as broken), the scheme upgrade pair
 * (`https://realtime…` genuinely does admit `wss://realtime…`, per CSP's own
 * source-scheme matching — reporting that as missing would be the most common
 * false failure available), and policy INTERSECTION: two policies both apply,
 * so a host must survive both.
 */

/** One parsed policy: directive name (lowercased) to its source list. */
export type CspPolicy = ReadonlyMap<string, readonly string[]>;

export interface SiteCspVerdict {
  readonly verdict: 'pass' | 'fail' | 'warn';
  readonly detail: string;
  readonly fix: string | null;
}

/** The four directives `embed.contentSecurityPolicy` publishes. */
const DIRECTIVES = [
  ['scriptSrc', 'script-src'],
  ['connectSrc', 'connect-src'],
  ['imgSrc', 'img-src'],
  ['mediaSrc', 'media-src'],
] as const;

const TIMEOUT_MS = 15_000;

/**
 * Split a header value into policies, and each policy into directives.
 *
 * A comma separates POLICIES and a semicolon separates directives, and
 * `Headers.get()` joins repeated headers with `", "` — so one string can
 * carry several policies and all of them bind. No CSP source token contains a
 * comma, which is what makes the outer split safe.
 *
 * A directive repeated inside one policy is ignored after the first
 * occurrence, which is what a browser does rather than merging them.
 */
export function parsePolicies(raw: string): CspPolicy[] {
  const out: CspPolicy[] = [];
  for (const chunk of raw.split(',')) {
    const map = new Map<string, readonly string[]>();
    for (const part of chunk.split(';')) {
      const tokens = part.trim().split(/\s+/u).filter((t) => t.length > 0);
      const name = tokens[0];
      if (name === undefined) {
        continue;
      }
      const key = name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, tokens.slice(1));
      }
    }
    if (map.size > 0) {
      out.push(map);
    }
  }
  return out;
}

/**
 * Every `<meta http-equiv="Content-Security-Policy">` in the document.
 *
 * A meta policy is as binding as a header one and plenty of frameworks emit
 * it that way, so reading only the header would report a site with a working
 * policy as having none — and, worse, the inverse: a site whose META policy
 * is the one missing the host would pass.
 *
 * Attribute order is not fixed and quoting may be single or double, so this
 * matches a `<meta …>` tag and then reads its two attributes out of it
 * rather than assuming a shape. `[^>]*` cannot run past the tag.
 */
export function cspFromHtml(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<meta\s[^>]*>/giu) ?? []) {
    if (!/http-equiv\s*=\s*["']?content-security-policy["'\s>]/iu.test(tag)) {
      continue;
    }
    const content = /content\s*=\s*("([^"]*)"|'([^']*)')/iu.exec(tag);
    const value = content?.[2] ?? content?.[3];
    if (value !== undefined && value.trim().length > 0) {
      out.push(value);
    }
  }
  return out;
}

const SCHEME_ONLY = /^[a-z][a-z0-9+.-]*:$/iu;

/** CSP's source-scheme matching, which is not plain equality. */
function schemeAdmits(sourceScheme: string, urlScheme: string): boolean {
  if (sourceScheme === urlScheme) {
    return true;
  }
  if (sourceScheme === 'http') {
    return urlScheme === 'https' || urlScheme === 'ws' || urlScheme === 'wss';
  }
  // The pair that matters here: the realtime host is published as `wss://`
  // and almost every integrator's policy names it as `https://`.
  return sourceScheme === 'https' && urlScheme === 'wss';
}

interface Parsed {
  readonly scheme: string;
  readonly host: string;
}

/** A published source as scheme + host, or null when it has no host. */
function parseUrlSource(raw: string): Parsed | null {
  try {
    const u = new URL(raw);
    return { scheme: u.protocol.replace(':', '').toLowerCase(), host: u.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

/** Does one source expression admit one published URL? */
export function sourceAdmits(source: string, published: string, siteOrigin: string): boolean {
  const s = source.trim();
  if (s.length === 0 || s === "'none'") {
    return false;
  }
  const isSchemeOnly = SCHEME_ONLY.test(published);
  if (s === '*') {
    /*
     * `*` matches any URL with a network scheme and deliberately NOT `data:`
     * or `blob:` — that is CSP's own carve-out, not a simplification, and the
     * widget publishes both in `img-src`.
     */
    return !isSchemeOnly || /^(https?|wss?):$/iu.test(published);
  }
  if (isSchemeOnly) {
    return s.toLowerCase() === published.toLowerCase();
  }
  const url = parseUrlSource(published);
  if (url === null) {
    return false;
  }
  if (s === "'self'") {
    const self = parseUrlSource(siteOrigin);
    return self !== null && self.host === url.host && schemeAdmits(self.scheme, url.scheme);
  }
  if (SCHEME_ONLY.test(s)) {
    return schemeAdmits(s.slice(0, -1).toLowerCase(), url.scheme);
  }
  if (s.startsWith("'")) {
    // `'unsafe-inline'`, `'nonce-…'`, `'sha256-…'`: not host sources.
    return false;
  }
  const schemeSplit = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/iu.exec(s);
  if (schemeSplit !== null) {
    const [, scheme = '', rest = ''] = schemeSplit;
    return schemeAdmits(scheme.toLowerCase(), url.scheme) && hostAdmits(rest, url.host);
  }
  // No scheme: see the header — any network scheme, rather than the
  // document's own, because narrowing it is the false-failure direction.
  return hostAdmits(s, url.host);
}

/** Host-part matching, including `*.example.com`. Port and path are ignored. */
function hostAdmits(rest: string, host: string): boolean {
  const hostPart = (rest.split('/')[0] ?? '').split(':')[0] ?? '';
  const pattern = hostPart.toLowerCase();
  if (pattern.startsWith('*.')) {
    // `*.example.com` admits `a.example.com` and NOT `example.com`, which is
    // the browser's reading and the one an integrator gets wrong.
    return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  }
  return pattern === host;
}

/**
 * Which published hosts no policy on the page admits.
 *
 * `undefined` sources for a directive means the page does not restrict it at
 * all —
 * neither the directive nor `default-src` is present — so everything is
 * allowed and nothing is missing. That fallback is the difference between
 * this check and one that reports every site with a bare `default-src` as
 * broken.
 */
export function missingFromPolicies(input: {
  readonly policies: readonly CspPolicy[];
  readonly published: Readonly<Record<string, unknown>>;
  readonly siteOrigin: string;
}): Array<{ readonly directive: string; readonly source: string }> {
  const missing: Array<{ directive: string; source: string }> = [];
  for (const [key, directive] of DIRECTIVES) {
    const sources = input.published[key];
    if (!Array.isArray(sources)) {
      continue;
    }
    for (const raw of sources) {
      if (typeof raw !== 'string' || raw === "'self'" || raw.startsWith("'")) {
        // `'self'` published means the page's own origin, which is whatever
        // site this is; there is nothing to look for.
        continue;
      }
      const blocked = input.policies.some((policy) => {
        const effective = policy.get(directive) ?? policy.get('default-src');
        return (
          effective !== undefined && !effective.some((s) => sourceAdmits(s, raw, input.siteOrigin))
        );
      });
      if (blocked) {
        missing.push({ directive, source: raw });
      }
    }
  }
  return missing;
}

/**
 * Fetch the site and compare its policy with what this channel publishes.
 *
 * Takes plain values rather than a `ChannelView` so this file has no imports
 * at all — the property `doctor-checks.ts` keeps for the same reason, and
 * what lets both be exercised without a client or a network.
 */
export async function siteCspVerdict(input: {
  readonly origin: string;
  readonly published: Readonly<Record<string, unknown>>;
  readonly fetchFn: typeof fetch;
}): Promise<SiteCspVerdict> {
  let res: Response;
  let html: string;
  try {
    res = await input.fetchFn(input.origin, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    html = await res.text();
  } catch (err) {
    return {
      verdict: 'warn',
      detail: `Could not fetch ${input.origin} to read its Content-Security-Policy: ${
        err instanceof Error ? err.message : String(err)
      }`,
      fix: 'Check the URL, or run this from somewhere that can reach the site.',
    };
  }
  const header = res.headers.get('content-security-policy');
  const raws = [...(header === null ? [] : [header]), ...cspFromHtml(html)];
  if (raws.length === 0) {
    return {
      verdict: 'pass',
      detail: `${input.origin} sends no Content-Security-Policy, so nothing on the page blocks the widget.`,
      fix: null,
    };
  }
  const policies = raws.flatMap((raw) => parsePolicies(raw));
  const missing = missingFromPolicies({
    policies,
    published: input.published,
    siteOrigin: input.origin,
  });
  if (missing.length > 0) {
    return {
      verdict: 'fail',
      detail:
        `${input.origin} sends a Content-Security-Policy that does not admit ` +
        `${String(missing.length)} host(s) the widget needs: ` +
        missing.map((m) => `${m.source} (${m.directive})`).join(', ') +
        '. The browser refuses those requests before they are made, so nothing server-side ' +
        'can see it — the widget simply does less than it should.',
      fix:
        'Copy this channel’s `embed.contentSecurityPolicy` into the site’s policy — ' +
        '`chatly channels get <id>` prints it. Each listed source belongs in the directive ' +
        'named beside it, alongside whatever is already there.',
    };
  }
  return {
    verdict: 'pass',
    detail: `${input.origin}’s Content-Security-Policy (${String(policies.length)} policy/policies) admits every host this channel publishes.`,
    fix: null,
  };
}
