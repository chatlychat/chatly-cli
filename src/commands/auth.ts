import { createInterface } from 'node:readline/promises';

import { bool, str, type ParsedArgs } from '../args.js';
import { CONFIG_PATH, readConfig, resolveCredentials, writeConfig } from '../config.js';
import { printJson } from '../output.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

/**
 * Store a key.
 *
 * Takes it from `--key` when given, otherwise prompts. The prompt reads from
 * stdin with no echo suppression available in `readline/promises`, so it
 * tells the reader that the key will be visible and offers the flag — better
 * than pretending to hide it.
 */
export async function login(args: ParsedArgs): Promise<number> {
  let key = str(args.flags, 'key');
  if (key === undefined) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(
      'Paste a workspace API key (Settings → API keys). It will be visible as you type;\n' +
        'use `chatly login --key ck_…` from a shell with history disabled to avoid that.\n',
    );
    key = (await rl.question('API key: ')).trim();
    rl.close();
  }
  if (!key.startsWith('ck_')) {
    process.stderr.write(
      `That does not look like a workspace API key (expected a ck_ prefix, got "${key.slice(0, 6)}…").\n` +
        'A dashboard session token is not an API key — create one under Settings → API keys.\n',
    );
    return 1;
  }
  const existing = readConfig();
  writeConfig({ ...existing, apiKey: key });
  process.stdout.write(`Saved to ${CONFIG_PATH} (0600). Run \`chatly whoami\` to check it.\n`);
  return 0;
}

export function logout(): number {
  const existing = readConfig();
  delete existing.apiKey;
  writeConfig(existing);
  process.stdout.write(`Removed the stored key from ${CONFIG_PATH}.\n`);
  return 0;
}

/**
 * The first call anyone should make.
 *
 * It turns a mis-scoped key into an obvious error here rather than a 403 from
 * an unrelated endpoint three days into an integration.
 *
 * This said `whoami` was "the only api-keys route a key may call", which was
 * true when it was written and is not now: list, revoke, revoke-self, rotate
 * and `scopes` opened on 2026-10-24, and minting on 2026-10-26 — which is
 * what `chatly api-keys create` drives.
 */
export async function whoami(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const json = bool(args.flags, 'json');
  // Resolved the same way run.ts resolved the key this client holds.
  const key = resolveCredentials(str(args.flags, 'key'), undefined).apiKey;
  if (key.startsWith('cp_')) {
    return platformWhoami(chatly, json);
  }
  const me = await chatly.whoami();
  if (json) {
    printJson(me);
    return 0;
  }
  process.stdout.write(`workspace  ${me.workspaceId}\n`);
  process.stdout.write(`scopes     ${me.scopes.length === 0 ? '(none)' : me.scopes.join(', ')}\n`);
  return 0;
}

interface PlatformWhoami {
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly restrictedToWorkspaceIds: readonly string[] | null;
  readonly restrictedToSlugPrefix: string | null;
  readonly loginLinks?: string;
  readonly contactEmail?: string | null;
  readonly ipAllowlist?: readonly string[] | null;
}

/**
 * A `cp_` platform credential: `GET /v1/platform/whoami`, with the CHT-S01
 * guardrails an operator set on it. They are shown because a credential can
 * read but never change them, and "why was my login link refused" or "why
 * a 403 from CI" is otherwise a support ticket.
 */
async function platformWhoami(chatly: ChatlyClient, json: boolean): Promise<number> {
  const me = await chatly.request<PlatformWhoami>('GET', '/v1/platform/whoami');
  if (json) {
    printJson(me);
    return 0;
  }
  const restriction =
    me.restrictedToWorkspaceIds !== null
      ? `${String(me.restrictedToWorkspaceIds.length)} workspace(s)`
      : me.restrictedToSlugPrefix !== null
        ? `slugs starting "${me.restrictedToSlugPrefix}"`
        : 'none';
  const lines: Array<[string, string]> = [
    ['platform', `${me.name} (${me.prefix}…)`],
    ['scopes', me.scopes.length === 0 ? '(none)' : me.scopes.join(', ')],
    ['expires', me.expiresAt ?? 'never'],
    ['restricted', restriction],
    ['login links', me.loginLinks ?? 'enabled'],
    ['ip allow', me.ipAllowlist == null ? 'any address' : me.ipAllowlist.join(', ')],
    ['contact', me.contactEmail ?? '(none — nobody is warned before expiry)'],
  ];
  for (const [label, value] of lines) {
    process.stdout.write(`${label.padEnd(13)}${value}\n`);
  }
  return 0;
}
