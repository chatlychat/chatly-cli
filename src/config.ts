import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the API key comes from, in order of precedence.
 *
 * 1. `--key` on the command line — for a one-off against another workspace.
 * 2. `CHATLY_API_KEY` in the environment — the CI shape.
 * 3. `~/.config/chatly/config.json`, written by `chatly login`.
 *
 * The file is created 0600. A workspace API key is a bearer credential for an
 * entire workspace; a world-readable config file is a credential leak on a
 * shared machine, and this repo has already had 35 database dumps readable by
 * anyone who guessed a URL.
 */
export const CONFIG_PATH = join(
  process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
  'chatly',
  'config.json',
);

export interface CliConfig {
  apiKey?: string;
  apiUrl?: string;
}

export function readConfig(path: string = CONFIG_PATH): CliConfig {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    return {
      ...(typeof obj['apiKey'] === 'string' ? { apiKey: obj['apiKey'] } : {}),
      ...(typeof obj['apiUrl'] === 'string' ? { apiUrl: obj['apiUrl'] } : {}),
    };
  } catch {
    // A corrupt config must not stop `--key` from working.
    return {};
  }
}

export function writeConfig(next: CliConfig, path: string = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // `mode` on writeFileSync only applies when the file is CREATED. An existing
  // file keeps whatever permissions it had, so set them explicitly.
  chmodSync(path, 0o600);
}

export interface Resolved {
  readonly apiKey: string;
  readonly apiUrl: string | undefined;
  readonly source: 'flag' | 'env' | 'config';
}

export function resolveCredentials(
  flagKey: string | undefined,
  flagUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  path: string = CONFIG_PATH,
): Resolved {
  const file = readConfig(path);
  const apiUrl = flagUrl ?? env['CHATLY_API_URL'] ?? file.apiUrl;
  if (flagKey !== undefined && flagKey.length > 0) {
    return { apiKey: flagKey, apiUrl, source: 'flag' };
  }
  const fromEnv = env['CHATLY_API_KEY'];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { apiKey: fromEnv, apiUrl, source: 'env' };
  }
  if (file.apiKey !== undefined && file.apiKey.length > 0) {
    return { apiKey: file.apiKey, apiUrl, source: 'config' };
  }
  throw new Error(
    'No API key. Run `chatly login`, set CHATLY_API_KEY, or pass --key.\n' +
      // The path the sidebar actually renders — `check-nav-instructions.mjs`
      // compares this string against the real navigation tree, which is how
      // "Settings → API keys" (wrong on both levels) was caught here.
      'Create one in the dashboard under Workspace → Integrations → Developer → API keys.',
  );
}
