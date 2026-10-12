import { createInterface } from 'node:readline/promises';

import { str, type ParsedArgs } from '../args.js';
import { CONFIG_PATH, readConfig, writeConfig } from '../config.js';
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
 * `GET /v1/api-keys/whoami` is the only api-keys route a key may call, and it
 * turns a mis-scoped key into an obvious error here rather than a 403 from an
 * unrelated endpoint three days into an integration.
 */
export async function whoami(chatly: ChatlyClient, json: boolean): Promise<number> {
  const me = await chatly.whoami();
  if (json) {
    printJson(me);
    return 0;
  }
  process.stdout.write(`workspace  ${me.workspaceId}\n`);
  process.stdout.write(`scopes     ${me.scopes.length === 0 ? '(none)' : me.scopes.join(', ')}\n`);
  return 0;
}
