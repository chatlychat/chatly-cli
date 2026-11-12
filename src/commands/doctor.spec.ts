/**
 * `chatly doctor`, with only the network and the two API reads faked.
 *
 * ═══ WHAT THESE ASSERT ON ═════════════════════════════════════════════════
 *
 * **What the command SENT**, not what a canned response said. A fake
 * transport that answers every probe with a 200 agrees with whatever the code
 * asked it, which is exactly how four mobile SDKs here shipped unable to
 * connect with green suites. The preflight assertions below read the recorded
 * request: the method, the two `access-control-request-*` headers and the
 * `Origin` — because a preflight missing any of them is not the request a
 * browser makes, and a bucket can answer it while refusing the real one.
 *
 * `doctor-checks.ts` has no runtime imports precisely so these drive the
 * shipped judgement rather than a reproduction of it.
 */
import { describe, expect, it } from 'vitest';

import { HEALTHY, PRESIGNED, channelRow, check } from './__tests__/doctor-fixtures.js';

describe('upload.preflight — the check that earns the command', () => {
  it('sends the preflight a real browser sends, to the real presigned URL', async () => {
    const { check: c, sent } = await check('upload.preflight', [channelRow()], HEALTHY, {
      origin: 'https://app.example.com',
    });
    expect(c.verdict).toBe('pass');

    const pre = sent.find((s) => s.method === 'OPTIONS');
    expect(pre, 'no OPTIONS preflight was sent at all').toBeDefined();
    /*
     * The URL is the presigned one, query and all. R2 answers a preflight per
     * BUCKET (`/{bucket}/{key}`), and a bare-path probe gets a 403 with no
     * CORS headers at all — so a guessed path is a different question.
     */
    expect(pre?.url).toBe(PRESIGNED);
    expect(pre?.headers['access-control-request-method']).toBe('PUT');
    expect(pre?.headers['access-control-request-headers']).toBe('content-type');
    // `--origin` is the site, so the probe asks the question that site asks.
    expect(pre?.headers['origin']).toBe('https://app.example.com');
  });

  it('carries a reserved Origin when the operator named no site', async () => {
    const { sent } = await check('upload.preflight', [channelRow()]);
    const origin = sent.find((s) => s.method === 'OPTIONS')?.headers['origin'];
    expect(origin).toMatch(/^https:\/\/[a-z-]+\.invalid$/);
  });

  it('FAILS when a 2xx carries no access-control-allow-origin — a stored policy that is not honoured', async () => {
    // The 2026-11-04 defect, in the one shape a status code alone cannot see.
    const { check: c } = await check('upload.preflight', [channelRow()], {
      ...HEALTHY,
      [PRESIGNED]: { status: 204 },
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('access-control-allow-origin=(absent)');
    expect(c.fix).toContain('apply-bucket-cors');
  });

  it('FAILS on the 403 an unconfigured bucket answers', async () => {
    const { check: c } = await check('upload.preflight', [channelRow()], {
      ...HEALTHY,
      [PRESIGNED]: { status: 403 },
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('403');
  });

  it('SKIPS rather than failing when the key cannot presign, and names the scope', async () => {
    const { check: c } = await check(
      'upload.preflight',
      [channelRow()],
      HEALTHY,
      {},
      {
        presign: () => Promise.reject(new Error('Missing permission: uploads:create')),
      },
    );
    /*
     * The probe was never MADE, so this says nothing about the bucket in
     * either direction — and `doctor`'s summary must not count it as an ok
     * (CH-05). `warn` was the old answer and reads as "we looked and it is
     * nearly fine".
     */
    expect(c.verdict).toBe('skip');
    expect(c.fix).toContain('uploads:create');
  });

  it('warns when the deployment has no object storage at all', async () => {
    const { check: c } = await check(
      'upload.preflight',
      [channelRow()],
      HEALTHY,
      {},
      {
        presign: async () => 'data:no-s3-configured;key=x',
      },
    );
    expect(c.verdict).toBe('warn');
    expect(c.detail).toContain('no object storage');
  });
});

describe('upload.host', () => {
  it('warns when uploads do not go to a Chatly host', async () => {
    // Defect 2: an account-specific R2 subdomain in every customer's CSP.
    const { check: c } = await check('upload.host', [
      channelRow({
        embed: { uploadOrigin: 'https://039852fe.r2.cloudflarestorage.com' },
      }),
    ]);
    expect(c.verdict).toBe('warn');
    expect(c.detail).toContain('039852fe.r2.cloudflarestorage.com');
    expect(c.fix).toContain('S3_UPLOAD_PUBLIC_BASE_URL');
  });

  it('passes a chatlychat.com subdomain', async () => {
    const { check: c } = await check('upload.host', [channelRow()]);
    expect(c.verdict).toBe('pass');
  });

  it('does not mistake a lookalike suffix for a Chatly host', async () => {
    const { check: c } = await check('upload.host', [
      channelRow({ embed: { uploadOrigin: 'https://uploads.notchatlychat.com' } }),
    ]);
    expect(c.verdict).toBe('warn');
  });
});

describe('csp.hosts', () => {
  it('FAILS and names the host when one we published does not resolve', async () => {
    const { check: c } = await check('csp.hosts', [channelRow()], {
      ...HEALTHY,
      'https://rt.chatlychat.com': null,
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('rt.chatlychat.com');
  });

  it('accepts any HTTP status, because the question is whether the host answers', async () => {
    const { check: c } = await check('csp.hosts', [channelRow()]);
    expect(c.verdict).toBe('pass');
  });

  it('maps a wss source to https rather than dropping it', async () => {
    /*
     * The fixture names the realtime host ONLY as `wss://`, which is the case
     * a scheme-blind reader gets wrong invisibly: `fetch` cannot dial `wss:`,
     * so the natural "skip what is not http(s)" drops the host entirely and
     * reports a pass for a host nobody checked. The published policy usually
     * carries both schemes — a browser matches a WebSocket by scheme — so the
     * https twin would otherwise hide this.
     */
    const { sent } = await check('csp.hosts', [
      channelRow({
        embed: {
          contentSecurityPolicy: {
            scriptSrc: ['https://widget.chatlychat.com'],
            connectSrc: ['wss://rt.chatlychat.com'],
            imgSrc: ['data:', 'blob:'],
            mediaSrc: [],
          },
        },
      }),
    ]);
    const dialled = sent.filter((s) => s.method === 'GET').map((s) => s.url);
    expect(dialled).toContain('https://rt.chatlychat.com');
  });

  it('dials a host named in two directives once, and skips data:/blob:/hashes', async () => {
    const { sent } = await check('csp.hosts', [channelRow()]);
    const dialled = sent.filter((s) => s.method === 'GET').map((s) => s.url);
    expect(dialled.filter((u) => u === 'https://rt.chatlychat.com')).toHaveLength(1);
    expect(dialled.some((u) => u.startsWith('wss:') || u.startsWith('data:'))).toBe(false);
    expect(dialled.some((u) => u.includes('sha256'))).toBe(false);
  });
});

describe('widget.assets', () => {
  it('derives the chunk list from the host’s own version.json', async () => {
    const { check: c, sent } = await check('widget.assets', [channelRow()]);
    expect(c.verdict).toBe('pass');
    const got = sent.map((s) => s.url);
    expect(got).toContain('https://widget.chatlychat.com/widget-engine.js');
    // `.js` only: the manifest also lists media, which is not a script.
    expect(got.some((u) => u.endsWith('hold-music.wav'))).toBe(false);
  });

  it('FAILS on a chunk that 404s — built, referenced, never served', async () => {
    const { check: c } = await check('widget.assets', [channelRow()], {
      ...HEALTHY,
      /*
       * A JavaScript content-type ON the 404, so only the STATUS check can
       * catch this. With `content-type: absent` the content-type assertion
       * catches it too and deleting the status check leaves the suite green —
       * which is what the control run found.
       */
      'https://widget.chatlychat.com/widget-engine.js': {
        status: 404,
        headers: { 'content-type': 'application/javascript' },
      },
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('widget-engine.js');
    expect(c.detail).toContain('HTTP 404');
  });

  it('FAILS on a 200 that is not JavaScript — an SPA fallback answering for a missing file', async () => {
    const { check: c } = await check('widget.assets', [channelRow()], {
      ...HEALTHY,
      'https://widget.chatlychat.com/widget.js': {
        status: 200,
        headers: { 'content-type': 'text/html' },
      },
    });
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('text/html');
  });

  it('falls back to the two bootstrap assets when there is no manifest', async () => {
    const { check: c, sent } = await check('widget.assets', [channelRow()], {
      ...HEALTHY,
      'https://widget.chatlychat.com/version.json': { status: 404 },
    });
    expect(c.verdict).toBe('pass');
    expect(c.detail).toContain('version.json is absent');
    expect(sent.map((s) => s.url)).toContain('https://widget.chatlychat.com/loader.js');
  });
});

describe('csp.site', () => {
  /*
   * Not emitted without `--origin`, because there is no site to read — and a
   * check that prints "not checked" on every run without a flag is the noise
   * that teaches people to skim the output.
   */
  it('is absent without --origin', async () => {
    const { all } = await check('csp.hosts', [channelRow()]);
    expect(all.map((c) => c.name).filter((n) => n.startsWith('csp.site'))).toEqual([]);
  });

  it('FAILS on a site whose own policy does not admit the upload host', async () => {
    const { check: c, sent } = await check(
      'csp.site',
      [channelRow()],
      {
        ...HEALTHY,
        'https://their-site.com': {
          status: 200,
          headers: {
            'content-security-policy':
              "default-src 'self' https://widget.chatlychat.com https://api.chatlychat.com " +
              'https://rt.chatlychat.com https://files.chatlychat.com data: blob:',
          },
        },
      },
      { origin: 'https://their-site.com' },
    );
    expect(c.verdict).toBe('fail');
    expect(c.detail).toContain('https://uploads.chatlychat.com (connect-src)');
    // It actually read the page, rather than deriving a verdict from config.
    expect(sent.some((x) => x.url === 'https://their-site.com')).toBe(true);
  });

  it('passes a site that copied the whole policy, wss included', async () => {
    const { check: c } = await check(
      'csp.site',
      [channelRow()],
      {
        ...HEALTHY,
        'https://their-site.com': {
          status: 200,
          headers: {
            'content-security-policy':
              "script-src 'self' https://widget.chatlychat.com; connect-src " +
              'https://api.chatlychat.com https://rt.chatlychat.com ' +
              'https://uploads.chatlychat.com; img-src https://files.chatlychat.com data: ' +
              'blob:; media-src https://files.chatlychat.com',
          },
        },
      },
      { origin: 'https://their-site.com' },
    );
    // `wss://rt.chatlychat.com` is published and the site names only
    // `https://rt.chatlychat.com`, which CSP's source-scheme matching admits.
    expect(c.verdict).toBe('pass');
  });
});

describe('widget.origins', () => {
  it('warns rather than passing when the list is empty, because that admits anyone', async () => {
    const { check: c } = await check('widget.origins', [
      channelRow({ config: { allowedOrigins: [] }, originsRestricted: false }),
    ]);
    expect(c.verdict).toBe('warn');
    expect(c.detail).toContain('ANY origin');
  });

  it('FAILS on --origin that is not allowed, and the fix carries the exact value to add', async () => {
    const { check: c } = await check('widget.origins', [channelRow()], HEALTHY, {
      origin: 'https://their-site.com',
    });
    expect(c.verdict).toBe('fail');
    expect(c.fix).toContain('"https://example.com","https://their-site.com"');
  });

  it('passes --origin that is allowed, comparing by origin rather than by string', async () => {
    /*
     * Both sides are deliberately unequal as strings — the stored value has
     * the trailing slash a browser's own `location.origin` never has, and the
     * flag carries a path. A `list.includes(flag)` reads false for a site
     * that IS allowed, and tells the operator to add an origin that is
     * already there.
     */
    const { check: c } = await check(
      'widget.origins',
      [channelRow({ config: { allowedOrigins: ['https://example.com/'] } })],
      HEALTHY,
      { origin: 'https://example.com/pricing' },
    );
    expect(c.verdict).toBe('pass');
  });
});

describe('files.deprecated', () => {
  it('warns only when a host is actually being retired', async () => {
    const { all } = await check('upload.host', [channelRow()]);
    expect(all.some((c) => c.name.startsWith('files.deprecated'))).toBe(false);

    const { check: c } = await check('files.deprecated', [
      channelRow({ embed: { deprecatedFileOrigins: ['https://old.chatlychat.com'] } }),
    ]);
    expect(c.verdict).toBe('warn');
    expect(c.detail).toContain('old.chatlychat.com');
  });
});
