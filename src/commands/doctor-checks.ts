/**
 * `chatly doctor`'s verdicts — the whole of the judgement, as a pure function.
 *
 * ═══ WHAT THIS IS FOR ═════════════════════════════════════════════════════
 *
 * Asked for by FormFlow after a deploy: "CLI 0.8.2 still has no command that
 * health-checks a deployed site's setup. Run before this deploy, it would
 * have flagged the missing upload host."
 *
 * Two defects reached production that day and no gate saw either, because
 * both live in a BROWSER and only cross-origin:
 *
 *   1. The attachment bucket had no CORS policy at all, so every browser
 *      upload died at the preflight with `403 CORS not configured for this
 *      bucket`. Production held zero messages with an attachment, ever.
 *      Invisible to every server-side test — a server is not subject to CORS.
 *   2. The upload `PUT` host was a raw R2 account endpoint rather than a
 *      Chatly host, so an account-specific subdomain appeared in every
 *      customer's CSP.
 *
 * So the checks here are deliberately the ones a server cannot answer about
 * itself: does a browser preflight succeed, does every host we published in a
 * customer's CSP actually answer, does every asset the loader fetches serve
 * with a JavaScript content-type.
 *
 * ═══ WHY IT IS A SEPARATE FILE WITH NO RUNTIME IMPORTS ════════════════════
 *
 * Every import below is `import type`. That is what lets the real shipped
 * code be exercised in isolation — `doctor.ts` reaches the SDK, the config
 * file and the printer, and a reproduction of this logic beside it would be a
 * test of the reproduction. Keep it that way: a runtime import here moves the
 * judgement back behind a package graph.
 */

/** `warn` never fails the run; `fail` does. See `exitCodeFor`. */
export type Verdict = 'pass' | 'fail' | 'warn';

export interface DoctorCheck {
  readonly name: string;
  readonly verdict: Verdict;
  /** What was observed. */
  readonly detail: string;
  /** What to DO about it, or null when there is nothing to do. */
  readonly fix: string | null;
}

export interface DoctorDeps {
  readonly fetchFn: typeof fetch;
  /**
   * `POST /v1/uploads/presign`, answering the URL a browser would PUT to.
   *
   * The real URL rather than a guessed one, and that distinction is the check.
   * An R2 preflight is answered per BUCKET (`/{bucket}/{key}`), the bucket
   * name is published nowhere a client can read, and a workspace that
   * connected its own storage uploads somewhere else entirely — so a
   * hand-built probe path tests a bucket that may not be the one in use.
   * Signing writes no object and no row; it is pure crypto over config.
   *
   * Throws on a missing scope or an unconfigured deployment, and the check
   * reports that as a warning rather than swallowing it.
   */
  readonly presign: () => Promise<string>;
  /**
   * `GET /v1/integration-health`'s `checks` array.
   *
   * This is where the identity-provider verdict comes from, and it is a
   * deliberate choice not to resolve the key set here. `resolveOidcIssuers`
   * (`@livechat/shared/identity-verification`) is the ONE place an issuer,
   * its audiences and its JWKS URI are resolved, and this package is
   * PUBLISHED while that one is `private: true` — importing it would
   * typecheck, pass every test and throw ERR_MODULE_NOT_FOUND on a
   * customer's first `npm install`. Restating the resolution locally is the
   * other way to get it wrong: it is exactly the drift that function exists
   * to prevent.
   *
   * `GET /v1/integration-health` already runs it server-side and publishes
   * the verdict under `identity.jwks_reachable`, with a `detail` and a `fix`.
   * Its own docblock says it exists "to put the VERDICTS behind one `ck_`
   * call, which is what a deploy script can make" — this is that script.
   */
  readonly health: () => Promise<readonly unknown[]>;
}

export interface DoctorOptions {
  /** `--origin`: the site the widget is installed on. */
  readonly origin?: string | undefined;
}

/**
 * The `Origin` a probe carries when the operator named no site.
 *
 * `.invalid` is reserved (RFC 2606) so it can never collide with a real
 * customer's origin, and a correct CORS policy for this product answers `*`
 * — the widget runs on arbitrary customer sites, so there is no list to
 * enumerate. See `scripts/apply-bucket-cors.mjs` for why `*` is right here
 * and is not a weakening.
 */
const PROBE_ORIGIN = 'https://chatly-doctor-probe.invalid';

const TIMEOUT_MS = 15_000;

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** An https/http origin, or null. Never throws on a malformed value. */
function originOf(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const u = new URL(raw);
    /*
     * `wss://` and `ws://` are mapped, not skipped. A browser matches a
     * WebSocket against `connect-src` by SCHEME, so the realtime host appears
     * twice in the published policy — and the thing being checked is whether
     * the host answers, which is one fact about one host.
     */
    const protocol = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
    return protocol === 'https:' || protocol === 'http:' ? `${protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/** Every distinct host in the published policy, as an origin to dial. */
function cspOrigins(csp: Record<string, unknown>): readonly string[] {
  const out = new Set<string>();
  for (const key of ['scriptSrc', 'connectSrc', 'imgSrc', 'mediaSrc']) {
    for (const src of strings(csp[key])) {
      /*
       * `data:`, `blob:`, `'self'` and `'sha256-…'` are CSP sources with no
       * host. `originOf` answers null for all of them, which is why this does
       * not need a list of the ones to skip — a list is the thing that goes
       * stale when a directive gains a new keyword.
       */
      const origin = originOf(src);
      if (origin !== null) {
        out.add(origin);
      }
    }
  }
  return [...out];
}

const isChatlyHost = (host: string): boolean =>
  host === 'chatlychat.com' || host.endsWith('.chatlychat.com');

/** Any HTTP answer at all. A transport failure is the thing being looked for. */
async function reaches(
  fetchFn: typeof fetch,
  url: string,
): Promise<{ status: number; contentType: string | null } | { error: string }> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, contentType: res.headers.get('content-type') };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Exactly what a browser sends before a cross-origin `PUT`, and the one check
 * that earns this command.
 *
 * The assertion is a 2xx AND an `access-control-allow-origin` header: a
 * policy that is stored but not honoured answers the first half and not the
 * second, which is the shape `apply-bucket-cors.mjs --check` was written to
 * catch. Credential-free on purpose — the bucket's keys exist only inside the
 * api container and an operator running this has neither.
 */
async function preflight(
  fetchFn: typeof fetch,
  url: string,
  origin: string,
): Promise<{ status: number; allow: string | null } | { error: string }> {
  try {
    const res = await fetchFn(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, allow: res.headers.get('access-control-allow-origin') };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The asset names to probe, read off the HOST rather than listed here.
 *
 * `version.json` is the widget host's own manifest of what it serves
 * (`infra/docker/widget.nginx.conf`), so a chunk added to the bundle is
 * checked the day it ships. A hand-written list is what let
 * `widget-commerce.js` answer 404 in production while
 * `check-widget-assets-served` printed "all accounted for" — the asset was
 * not in its own list.
 *
 * The fallback is the two assets every deployment has, because a self-hosted
 * host predating `version.json` must still get a verdict rather than a skip.
 */
async function assetNames(
  fetchFn: typeof fetch,
  scriptOrigin: string,
): Promise<{ names: readonly string[]; derived: boolean }> {
  try {
    const res = await fetchFn(`${scriptOrigin}/version.json`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      // `: unknown` rather than letting `res.json()`'s `any` through — the
      // house rule, and here it is also the only thing stopping a manifest
      // from a host we do not control being read as a trusted shape.
      const body: unknown = await res.json();
      const names = Object.keys(rec(rec(body)['assets'])).filter((n) => n.endsWith('.js'));
      if (names.length > 0) {
        return { names, derived: true };
      }
    }
  } catch {
    // Fall through: an absent or unparseable manifest is not itself a failure.
  }
  return { names: ['loader.js', 'widget.js'], derived: false };
}

const JS_CONTENT_TYPE = /(java|ecma)script/i;

/** One channel's worth of the `GET /v1/channels` row, read defensively. */
export interface ChannelView {
  readonly label: string;
  readonly id: string | null;
  readonly embed: Record<string, unknown>;
  readonly config: Record<string, unknown>;
  readonly originsRestricted: unknown;
}

function viewOf(row: unknown): ChannelView | null {
  const r = rec(row);
  const embed = rec(r['embed']);
  // `embed` is null for every non-`web` channel: WhatsApp and the rest are
  // not installed with a script tag, so there is no install to health-check.
  if (text(embed['scriptOrigin']) === null) {
    return null;
  }
  const id = text(r['id']);
  return {
    label: text(r['publicId']) ?? id ?? '(unnamed channel)',
    id,
    embed,
    config: rec(r['config']),
    originsRestricted: r['originsRestricted'],
  };
}

/** `--channel` matches either spelling, because both are printed to people. */
export function selectChannels(rows: readonly unknown[], only: string | undefined): ChannelView[] {
  const views = rows.map(viewOf).filter((v): v is ChannelView => v !== null);
  if (only === undefined) {
    return views;
  }
  return views.filter((v) => v.label === only || v.id === only);
}

export function exitCodeFor(checks: readonly DoctorCheck[]): number {
  return checks.some((c) => c.verdict === 'fail') ? 1 : 0;
}

/**
 * Run every check. Never throws: a probe that cannot be made is a verdict.
 *
 * `channels` comes from {@link selectChannels} over `GET /v1/channels` in
 * either shape — a bare array, or the `{ items }` envelope it answers when
 * `?limit=` is sent. The caller unwraps that with `itemsOf`.
 */
export async function runChecks(
  channels: readonly ChannelView[],
  opts: DoctorOptions,
  deps: DoctorDeps,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  if (channels.length === 0) {
    return [
      {
        name: 'channels',
        verdict: 'warn',
        detail:
          'No web channel is visible to this credential, so there is no widget install to check.',
        fix:
          'Create one with `chatly channels create`, or check the key has `channels:read` ' +
          '(`chatly whoami`). `--channel <publicId>` narrows to one.',
      },
    ];
  }

  out.push(await uploadPreflightCheck(opts, deps));
  for (const ch of channels) {
    out.push(uploadHostCheck(ch));
    out.push(await cspHostsCheck(ch, deps));
    out.push(await widgetAssetsCheck(ch, deps));
    out.push(allowedOriginsCheck(ch, opts));
    const deprecated = strings(ch.embed['deprecatedFileOrigins']);
    if (deprecated.length > 0) {
      out.push({
        name: `files.deprecated (${ch.label})`,
        verdict: 'warn',
        detail:
          `Attachment URLs are still served from ${deprecated.join(', ')}, which is being ` +
          'retired. Historical attachments live there; new ones do not.',
        fix:
          'Regenerate your CSP from this channel’s `embed.contentSecurityPolicy` — it ' +
          'carries the old host alongside the new one for the length of the window, so ' +
          'copying it keeps both working.',
      });
    }
  }

  if (channels.some((ch) => rec(ch.config['identityVerification'])['enabled'] === true)) {
    out.push(await identityJwksCheck(deps));
  }
  return out;
}

async function uploadPreflightCheck(
  opts: DoctorOptions,
  deps: DoctorDeps,
): Promise<DoctorCheck> {
  const name = 'upload.preflight';
  let url: string;
  try {
    url = await deps.presign();
  } catch (err) {
    return {
      name,
      verdict: 'warn',
      detail: `Could not get a presigned upload URL to probe: ${err instanceof Error ? err.message : String(err)}`,
      fix:
        'This check signs an upload (writing nothing) to learn the exact URL a browser would ' +
        'PUT to, so it needs the `uploads:create` scope. `chatly whoami` lists what the key ' +
        'has; `chatly workspace key-scopes` lists every scope there is.',
    };
  }
  if (url.startsWith('data:')) {
    return {
      name,
      verdict: 'warn',
      detail: 'This deployment has no object storage, so the widget refuses uploads outright.',
      fix: 'Set S3_ENDPOINT / S3_BUCKET, or connect a bucket with the `s3` integration.',
    };
  }
  const origin = opts.origin ?? PROBE_ORIGIN;
  const result = await preflight(deps.fetchFn, url, origin);
  if ('error' in result) {
    return {
      name,
      verdict: 'fail',
      detail: `The upload host did not answer a browser preflight at all: ${result.error}`,
      fix: `Check that ${originOf(url) ?? url} resolves and serves HTTPS.`,
    };
  }
  if (result.status < 200 || result.status >= 300 || result.allow === null) {
    return {
      name,
      verdict: 'fail',
      detail:
        `A browser PUT preflight answered ${String(result.status)} with ` +
        `access-control-allow-origin=${result.allow ?? '(absent)'}. Every attachment upload ` +
        'from the widget and the agent inbox is blocked by the browser before it reaches ' +
        'storage, and nothing server-side can see this.',
      fix:
        'Put a CORS policy on the bucket: `node scripts/apply-bucket-cors.mjs --apply`, run ' +
        'inside the api container (it is the only place the bucket keys exist).',
    };
  }
  return {
    name,
    verdict: 'pass',
    detail:
      `A browser PUT preflight from ${origin} answered ${String(result.status)} with ` +
      `access-control-allow-origin: ${result.allow}.`,
    fix: null,
  };
}

function uploadHostCheck(ch: ChannelView): DoctorCheck {
  const name = `upload.host (${ch.label})`;
  const uploadOrigin = text(ch.embed['uploadOrigin']);
  if (uploadOrigin === null) {
    return {
      name,
      verdict: 'warn',
      detail: 'This channel publishes no upload origin, so the widget refuses attachments.',
      fix: 'Configure object storage, or ignore this if attachments are deliberately off.',
    };
  }
  let host: string;
  try {
    host = new URL(uploadOrigin).hostname;
  } catch {
    return {
      name,
      verdict: 'fail',
      detail: `\`embed.uploadOrigin\` is not a URL: ${uploadOrigin}`,
      fix: 'Fix S3_UPLOAD_PUBLIC_BASE_URL (or S3_ENDPOINT) on the deployment.',
    };
  }
  if (!isChatlyHost(host)) {
    return {
      name,
      verdict: 'warn',
      detail:
        `Uploads go to ${host}, which is not a chatlychat.com host, so an account-specific ` +
        'third-party subdomain appears in every customer’s `connect-src`. A bucket move ' +
        'then invalidates a CSP they have already deployed.',
      fix:
        'Point S3_UPLOAD_PUBLIC_BASE_URL at a Chatly host — uploads.chatlychat.com proxies to ' +
        'storage with the signed Host restored (`infra/traefik/chatly-uploads.yml`). If this ' +
        'deployment genuinely runs its own storage, this warning is expected.',
    };
  }
  return { name, verdict: 'pass', detail: `Uploads go to ${host}.`, fix: null };
}

async function cspHostsCheck(ch: ChannelView, deps: DoctorDeps): Promise<DoctorCheck> {
  const name = `csp.hosts (${ch.label})`;
  const origins = cspOrigins(rec(ch.embed['contentSecurityPolicy']));
  if (origins.length === 0) {
    return {
      name,
      verdict: 'fail',
      detail: 'The published Content-Security-Policy names no hosts at all.',
      fix: 'Check WIDGET_PUBLIC_BASE_URL and API_PUBLIC_URL are set on the deployment.',
    };
  }
  const results = await Promise.all(
    origins.map(async (o) => [o, await reaches(deps.fetchFn, o)] as const),
  );
  const dead = results.filter(([, r]) => 'error' in r);
  if (dead.length > 0) {
    return {
      name,
      verdict: 'fail',
      detail:
        `${String(dead.length)} of ${String(origins.length)} hosts we publish in this ` +
        'channel’s CSP did not answer: ' +
        dead.map(([o, r]) => `${o} (${'error' in r ? r.error : ''})`).join(', ') +
        '. A host in a customer’s CSP that does not resolve is a feature that fails ' +
        'silently in their visitors’ browsers.',
      fix:
        'Either the host is down, or the deployment publishes a host it does not serve — ' +
        'check API_PUBLIC_URL, REALTIME_PUBLIC_URL, WIDGET_PUBLIC_BASE_URL, ' +
        'S3_UPLOAD_PUBLIC_BASE_URL and S3_PUBLIC_BASE_URL.',
    };
  }
  return {
    name,
    verdict: 'pass',
    detail: `All ${String(origins.length)} published CSP hosts answer: ${origins.join(', ')}.`,
    fix: null,
  };
}

async function widgetAssetsCheck(ch: ChannelView, deps: DoctorDeps): Promise<DoctorCheck> {
  const name = `widget.assets (${ch.label})`;
  const scriptOrigin = text(ch.embed['scriptOrigin']);
  if (scriptOrigin === null) {
    return {
      name,
      verdict: 'fail',
      detail: 'This channel publishes no script origin, so the snippet has nothing to load.',
      fix: 'Set WIDGET_PUBLIC_BASE_URL on the deployment.',
    };
  }
  const { names, derived } = await assetNames(deps.fetchFn, scriptOrigin);
  const results = await Promise.all(
    names.map(async (n) => [n, await reaches(deps.fetchFn, `${scriptOrigin}/${n}`)] as const),
  );
  const broken = results.filter(
    ([, r]) => 'error' in r || r.status !== 200 || !JS_CONTENT_TYPE.test(r.contentType ?? ''),
  );
  const how = derived
    ? `${String(names.length)} assets named by ${scriptOrigin}/version.json`
    : `loader.js and widget.js (${scriptOrigin}/version.json is absent, so the chunk list could not be derived)`;
  if (broken.length > 0) {
    return {
      name,
      verdict: 'fail',
      detail:
        `${String(broken.length)} widget asset(s) do not serve as JavaScript: ` +
        broken
          .map(([n, r]) =>
            'error' in r
              ? `${n} (${r.error})`
              : `${n} (HTTP ${String(r.status)}, content-type ${r.contentType ?? 'absent'})`,
          )
          .join(', ') +
        '. A missing chunk is a console warning the integrator reads as their own CSP.',
      fix:
        'The asset is built and not served. Each one needs a `location` in ' +
        '`infra/docker/widget.nginx.conf`, a size budget in ' +
        '`scripts/lib/bundle-budgets.mjs` (which is what stages it into the image) and an ' +
        'entry in `scripts/deploy-verify.sh` — `node scripts/check-widget-assets-served.mjs` ' +
        'names which is missing.',
    };
  }
  return { name, verdict: 'pass', detail: `${how} all serve as JavaScript.`, fix: null };
}

function allowedOriginsCheck(ch: ChannelView, opts: DoctorOptions): DoctorCheck {
  const name = `widget.origins (${ch.label})`;
  const allowed = strings(ch.config['allowedOrigins']);
  const wanted = originOf(opts.origin ?? null);
  /*
   * An EMPTY list means any origin is accepted, and that is invisible in the
   * JSON — which is why the channel read publishes `originsRestricted`
   * alongside it. Read that when it is there and fall back to the list's own
   * length, so a deployment predating the field still gets the verdict.
   */
  const restricted =
    typeof ch.originsRestricted === 'boolean' ? ch.originsRestricted : allowed.length > 0;
  if (wanted !== null) {
    if (!restricted) {
      return {
        name,
        verdict: 'warn',
        detail: `${wanted} is accepted, but so is every other origin on the internet.`,
        fix: `Restrict the channel: \`chatly channels update ${ch.id ?? '<id>'} --body '{"config":{"allowedOrigins":["${wanted}"]}}'\``,
      };
    }
    if (!allowed.some((a) => originOf(a) === wanted)) {
      return {
        name,
        verdict: 'fail',
        detail:
          `${wanted} is NOT in this channel’s allowedOrigins (${allowed.join(', ')}), so ` +
          'the widget is refused on that site.',
        fix: `Add it: \`chatly channels update ${ch.id ?? '<id>'} --body '{"config":{"allowedOrigins":${JSON.stringify([...allowed, wanted])}}}'\``,
      };
    }
    return { name, verdict: 'pass', detail: `${wanted} is in allowedOrigins.`, fix: null };
  }
  if (!restricted) {
    return {
      name,
      verdict: 'warn',
      detail:
        'allowedOrigins is empty, which means ANY origin is accepted — anyone can embed this ' +
        'channel’s widget on any site.',
      fix: `Set it to the sites you install on: \`chatly channels update ${ch.id ?? '<id>'} --body '{"config":{"allowedOrigins":["https://example.com"]}}'\`. Pass \`--origin <url>\` to assert one.`,
    };
  }
  return {
    name,
    verdict: 'pass',
    detail: `Restricted to ${allowed.join(', ')}. Pass \`--origin <url>\` to assert a site.`,
    fix: null,
  };
}

async function identityJwksCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'identity.jwks';
  let checks: readonly unknown[];
  try {
    checks = await deps.health();
  } catch (err) {
    return {
      name,
      verdict: 'warn',
      detail: `Could not read GET /v1/integration-health: ${err instanceof Error ? err.message : String(err)}`,
      fix:
        'Identity verification is on for a channel here, and the key set it resolves to is ' +
        'resolved server-side. That verdict needs the `workspace:read` scope.',
    };
  }
  const found = checks.map(rec).find((c) => c['id'] === 'identity.jwks_reachable');
  if (found === undefined) {
    return {
      name,
      verdict: 'warn',
      detail: 'GET /v1/integration-health did not report `identity.jwks_reachable`.',
      fix: 'Upgrade the Chatly deployment, or read the channel’s issuer settings by hand.',
    };
  }
  /*
   * `ok: null` is a real third answer and means NOT DETERMINED — an unprobed
   * channel, a stale probe, or a scope the credential lacks. Grading it
   * `fail` would turn "we do not know" into "it is broken".
   */
  const ok = found['ok'];
  return {
    name,
    verdict: ok === true ? 'pass' : ok === false ? 'fail' : 'warn',
    detail: text(found['detail']) ?? 'No detail.',
    fix: text(found['fix']),
  };
}
