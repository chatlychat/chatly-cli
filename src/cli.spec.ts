/**
 * The CLI, exercised end to end with only the socket faked.
 *
 * `run()` takes argv and a client factory, so these tests drive the real
 * argument parser, the real `ChatlyClient`, the real transport, the real
 * retry policy and the real error mapping. A test that stubbed the SDK would
 * prove the CLI calls a mock, which is not the thing worth knowing.
 */
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatlyClient } from '@chatlychat/sdk-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bool, num, parseArgs, str } from './args.js';
import { resolveCredentials, writeConfig, type CliConfig } from './config.js';
import { HELP } from './help.js';
import { itemsOf, nextCursorOf } from './output.js';
import { ALIASES, COMMANDS, explain, run } from './run.js';

describe('parseArgs', () => {
  it('splits the command path from the flags', () => {
    const a = parseArgs(['conversations', 'send', 'conv_1', '--json']);
    expect(a.path).toEqual(['conversations', 'send', 'conv_1']);
    expect(a.flags).toEqual({ json: true });
  });

  it('accepts --key=value and --key value alike', () => {
    expect(str(parseArgs(['x', '--limit=5']).flags, 'limit')).toBe('5');
    expect(str(parseArgs(['x', '--limit', '5']).flags, 'limit')).toBe('5');
  });

  it('collects a repeated flag into an array', () => {
    const a = parseArgs(['events', 'track', '--prop', 'a=1', '--prop', 'b=2']);
    expect(a.flags['prop']).toEqual(['a=1', 'b=2']);
  });

  it('keeps a positional that follows a flag', () => {
    // `chatly search --limit 5 refunds` must work as well as the other order.
    const a = parseArgs(['search', '--limit', '5', 'refunds']);
    expect(a.path).toEqual(['search', 'refunds']);
    expect(str(a.flags, 'limit')).toBe('5');
  });

  it('rejects a non-numeric --limit instead of silently passing NaN', () => {
    expect(() => num(parseArgs(['x', '--limit', 'lots']).flags, 'limit')).toThrow(
      /expects a number/,
    );
  });

  it('treats a trailing flag with no value as true', () => {
    expect(bool(parseArgs(['x', '--all']).flags, 'all')).toBe(true);
  });
});

describe('credential resolution', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chatly-cli-'));
    path = join(dir, 'config.json');
  });

  const write = (c: CliConfig): void => {
    writeConfig(c, path);
  };

  it('prefers --key over the environment over the file', () => {
    write({ apiKey: 'ck_file' });
    const env = { CHATLY_API_KEY: 'ck_env' } as NodeJS.ProcessEnv;
    expect(resolveCredentials('ck_flag', undefined, env, path).source).toBe('flag');
    expect(resolveCredentials(undefined, undefined, env, path).apiKey).toBe('ck_env');
    expect(resolveCredentials(undefined, undefined, {}, path).apiKey).toBe('ck_file');
  });

  /*
   * The MODE assertions are skipped on Windows, and only the mode ones.
   *
   * Windows has no POSIX permission bits: `chmod` is a no-op and `statSync`
   * reports 0o666 whatever the file was created with, so these two failed on
   * the Windows build desk with `expected 438 to be 384` — 0o666 against
   * 0o600. That is the platform, not the code.
   *
   * Skipped rather than relaxed, which is the whole point: a workspace-wide
   * bearer token in a world-readable file is a real defect on the platforms
   * this ships to (Linux in production, macOS in development), and weakening
   * the assertion to satisfy a build box would delete the check everywhere.
   * vitest reports these as SKIPPED rather than passed, so the gap is visible
   * in the summary line instead of being a green tick that proves nothing.
   *
   * Note the WRITE is still asserted on every platform below — only the
   * permission bits are conditional.
   */
  const posixModes = process.platform !== 'win32';

  it.skipIf(!posixModes)(
    'writes the config 0600, because the key is a workspace-wide bearer token',
    () => {
      write({ apiKey: 'ck_secret' });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it('writes the key back, on every platform', () => {
    write({ apiKey: 'ck_secret' });
    expect(JSON.parse(readFileSync(path, 'utf8')).apiKey).toBe('ck_secret');
  });

  it.skipIf(!posixModes)(
    're-chmods an existing file, since writeFileSync mode only applies on create',
    () => {
      write({ apiKey: 'ck_one' });
      write({ apiKey: 'ck_two' });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it('says what to do when there is no key at all', () => {
    expect(() => resolveCredentials(undefined, undefined, {}, path)).toThrow(/chatly login/);
  });

  it('survives a corrupt config file rather than refusing to run', () => {
    writeConfig({}, path);
    const env = { CHATLY_API_KEY: 'ck_env' } as NodeJS.ProcessEnv;
    expect(resolveCredentials(undefined, undefined, env, path).apiKey).toBe('ck_env');
  });
});

describe('output helpers', () => {
  it('finds items under either envelope and nowhere else', () => {
    expect(itemsOf({ items: [1, 2] })).toEqual([1, 2]);
    expect(itemsOf({ data: [3] })).toEqual([3]);
    expect(itemsOf([4])).toEqual([4]);
    expect(itemsOf({ nope: 1 })).toEqual([]);
    expect(itemsOf(null)).toEqual([]);
  });

  it('treats an empty cursor as no cursor', () => {
    expect(nextCursorOf({ nextCursor: 'c' })).toBe('c');
    expect(nextCursorOf({ nextCursor: '' })).toBeNull();
    expect(nextCursorOf({ nextCursor: null })).toBeNull();
  });
});

describe('run() against a faked socket', () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A factory whose client talks to a scripted fetch, not the network. */
  function factoryFor(
    responses: Array<{ status: number; body: string }>,
    seen: Array<{ url: string; method: string }> = [],
  ): (opts: { apiKey: string; apiUrl?: string }) => ChatlyClient {
    let i = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? 'GET' });
      const step = responses[Math.min(i, responses.length - 1)] ?? { status: 200, body: '{}' };
      i += 1;
      return new Response(step.body, {
        status: step.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return (opts) =>
      new ChatlyClient({
        ...opts,
        fetchFn,
        sleepFn: async () => undefined,
        retry: { attempts: 1 },
      });
  }

  it('prints the version, not the help, for --version', async () => {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(await run(['--version'], factoryFor([]))).toBe(0);
    /*
     * Against package.json, not against a literal.
     *
     * This asserted `'0.1.0\n'` and passed while the published package was
     * 0.1.2, so `chatly --version` lied to every user and to support. A test
     * that hard-codes the value it is checking cannot catch drift in it.
     */
    expect(out.join('')).toBe(`${version}\n`);
  });

  it('whoami prints the workspace and scopes', async () => {
    const code = await run(
      ['whoami', '--key', 'ck_test'],
      factoryFor([{ status: 200, body: '{"workspaceId":"ws_1","scopes":["contacts:read"]}' }]),
    );
    expect(code).toBe(0);
    expect(out.join('')).toContain('ws_1');
    expect(out.join('')).toContain('contacts:read');
  });

  it('whoami with a cp_ key reads /v1/platform/whoami and prints its guardrails', async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const body = JSON.stringify({
      name: 'Referalli',
      prefix: 'cp_live_ab',
      scopes: ['platform:workspaces:read'],
      expiresAt: null,
      restrictedToWorkspaceIds: null,
      restrictedToSlugPrefix: 'referalli-',
      loginLinks: 'admins-only',
      contactEmail: null,
      ipAllowlist: ['203.0.113.0/24'],
    });
    const code = await run(
      ['whoami', '--key', 'cp_live_ab_secret'],
      factoryFor([{ status: 200, body }], seen),
    );
    expect(code).toBe(0);
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(['/v1/platform/whoami']);
    const text = out.join('');
    expect(text).toContain('login links  admins-only');
    expect(text).toContain('ip allow     203.0.113.0/24');
    expect(text).toContain('slugs starting "referalli-"');
    expect(text).toContain('nobody is warned before expiry');
  });

  it('renders a list as a table, and the raw envelope with --json', async () => {
    const body = '{"items":[{"id":"c_1","name":"Ada","email":"ada@x.test"}],"nextCursor":null}';
    await run(['contacts', 'list', '--key', 'ck_test'], factoryFor([{ status: 200, body }]));
    expect(out.join('')).toContain('ID');
    expect(out.join('')).toContain('Ada');

    out.length = 0;
    await run(
      ['contacts', 'list', '--key', 'ck_test', '--json'],
      factoryFor([{ status: 200, body }]),
    );
    expect(JSON.parse(out.join(''))).toEqual({
      items: [{ id: 'c_1', name: 'Ada', email: 'ada@x.test' }],
      nextCursor: null,
    });
  });

  it('--all walks every page', async () => {
    const seen: Array<{ url: string; method: string }> = [];
    await run(
      ['contacts', 'list', '--key', 'ck_test', '--all', '--json'],
      factoryFor(
        [
          { status: 200, body: '{"items":[{"id":"a"}],"nextCursor":"p2"}' },
          { status: 200, body: '{"items":[{"id":"b"}],"nextCursor":null}' },
        ],
        seen,
      ),
    );
    expect(seen).toHaveLength(2);
    expect(JSON.parse(out.join(''))).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('api passes an arbitrary route through, with the method it was given', async () => {
    const seen: Array<{ url: string; method: string }> = [];
    await run(
      ['api', 'POST', '/v1/feature-flags', '--key', 'ck_test', '--body', '{"key":"x"}'],
      factoryFor([{ status: 200, body: '{"ok":true}' }], seen),
    );
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toContain('/v1/feature-flags');
  });

  it('api refuses a body that is not JSON instead of sending it', async () => {
    await expect(
      run(['api', 'POST', '/v1/x', '--key', 'ck_test', '--body', 'not json'], factoryFor([])),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('api refuses a path that is not a path', async () => {
    await expect(
      run(['api', 'GET', 'v1/contacts', '--key', 'ck_test'], factoryFor([])),
    ).rejects.toThrow(/Give a path/);
  });

  it('exits 2 and names the command for an unknown one', async () => {
    expect(await run(['nonsense', '--key', 'ck_test'], factoryFor([]))).toBe(2);
    expect(err.join('')).toContain('Unknown command "nonsense"');
  });

  it('refuses to send an empty reply', async () => {
    await expect(
      run(['conversations', 'send', 'conv_1', '--key', 'ck_test'], factoryFor([])),
    ).rejects.toThrow(/Nothing to send/);
  });
});

describe('explain()', () => {
  it('turns a 401 into advice about the key, not a stack trace', async () => {
    const { ChatlyAuthenticationError } = await import('@chatlychat/sdk-node');
    const e = new ChatlyAuthenticationError({
      status: 401,
      code: 'unauthorized',
      message: 'bad key',
      requestId: 'req_9',
      body: '{}',
      retryAfter: null,
    });
    const { code, message } = explain(e);
    expect(code).toBe(1);
    expect(message).toContain('req_9');
    expect(message).toContain('chatly login');
  });

  it('distinguishes a missing scope (403) from a bad key (401)', async () => {
    const { ChatlyPermissionError } = await import('@chatlychat/sdk-node');
    const { message } = explain(
      new ChatlyPermissionError({
        status: 403,
        code: 'forbidden',
        message: 'no',
        requestId: null,
        body: '{}',
        retryAfter: null,
      }),
    );
    expect(message).toContain('lacks a scope');
    expect(message).not.toContain('chatly login');
  });

  it('says a transport failure never reached Chatly', async () => {
    const { ChatlyTransportError } = await import('@chatlychat/sdk-node');
    const { message } = explain(new ChatlyTransportError('request failed: GET /v1/x'));
    expect(message).toContain('never reached Chatly');
  });
});

/**
 * `--help` and `COMMANDS`, checked against each other in both directions.
 *
 * `run.ts`'s docblock has always claimed this: "a command with no help entry
 * is a command nobody finds; a help entry with no command is a promise the
 * CLI breaks." Nothing enforced it, and fifteen of the twenty-two command
 * groups had never appeared in `--help` — `ai`, `billing`, `bots`,
 * `bot-routes`, `brands`, `customer-cards`, `docs-sources`,
 * `email-templates`, `knowledge-gaps`, `macros`, `triggers` among them. Every
 * one was implemented, tested and reachable; none was findable.
 */
describe('--help covers the command table', () => {
  /** A command line is two spaces, then the command word. */
  const helpWords = new Set(
    HELP.split('\n')
      .map((line) => /^ {2}(\S+)/.exec(line)?.[1])
      .filter((w): w is string => w !== undefined),
  );

  it('reads a plausible number of command words out of the help text', () => {
    /*
     * Anti-vacuity, and not a formality: this whole describe block is two
     * set comparisons, and a regex that stopped matching would make both of
     * them pass against the empty set. The floor is the number of command
     * GROUPS, not lines, so adding a subcommand does not move it.
     */
    expect(helpWords.size).toBeGreaterThanOrEqual(24);
  });

  it('documents every command in COMMANDS', () => {
    const undocumented = Object.keys(COMMANDS).filter((name) => !helpWords.has(name));
    expect(undocumented, 'these commands exist and `--help` never mentions them').toEqual([]);
  });

  /**
   * Words in a command position that are not in `COMMANDS`, by name.
   *
   * `chatly` is the USAGE line's own first word. `login` and `logout` are
   * real commands handled BEFORE a client is built (`run.ts` lists both in
   * `UNAUTHENTICATED`) — they write and delete the stored key, so there is no
   * key to authenticate with yet, and they cannot have the
   * `(client, args)` signature every entry in `COMMANDS` has.
   *
   * Listed rather than pattern-matched: a rule like "ignore anything short"
   * would quietly absolve a future typo, which is the thing this test is for.
   */
  const NOT_IN_TABLE = new Set(['chatly', 'login', 'logout']);

  it('documents nothing that is not a command', () => {
    /*
     * The other direction. `--help` also carries flags (`--json`), section
     * headings and continuation lines, so only words that look like a
     * command are judged: no leading dash, and not a `<placeholder>`.
     */
    const promised = [...helpWords].filter(
      (w) => !w.startsWith('-') && !w.startsWith('<') && !NOT_IN_TABLE.has(w),
    );
    const broken = promised.filter((w) => COMMANDS[w] === undefined && ALIASES[w] === undefined);
    expect(broken, 'these are promised in `--help` and are not commands').toEqual([]);
  });

  it('every named exception really is reachable, just not through COMMANDS', () => {
    /*
     * The exception list is the one place this test can be defeated by
     * widening, so each entry is held to the reason it was granted: `login`
     * and `logout` must stay in `run.ts`'s unauthenticated set, and `chatly`
     * must stay the first word of the USAGE line. An entry added without a
     * reason fails here.
     */
    expect(HELP).toMatch(/^ {2}chatly <command>/m);
    for (const name of ['login', 'logout']) {
      expect(COMMANDS[name], `${name} is in COMMANDS now — drop the exception`).toBeUndefined();
      expect(HELP).toContain(`  ${name}`);
    }
  });
});
