/**
 * The argument parser.
 *
 * Hand-written rather than `commander` or `yargs`, because this repo does not
 * add a dependency without approval and because the shape is small: a command
 * path, then flags. 40 lines beats a 2MB tree.
 */

export interface ParsedArgs {
  /** Positional words before the first flag: `conversations send` → ['conversations','send']. */
  readonly path: ReadonlyArray<string>;
  /** `--key value`, `--key=value`, and `--flag` (true). Repeated keys collect into an array. */
  readonly flags: Readonly<Record<string, string | boolean | string[]>>;
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const path: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  let i = 0;
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || token.startsWith('-')) {
      break;
    }
    path.push(token);
  }

  for (; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith('-')) {
      // A bare word after a flag: treat it as a positional, so
      // `chatly search --limit 5 refunds` works as well as the other order.
      path.push(token);
      continue;
    }
    const bare = token.replace(/^-+/, '');
    const eq = bare.indexOf('=');
    let name: string;
    let value: string | boolean;
    if (eq > 0) {
      name = bare.slice(0, eq);
      value = bare.slice(eq + 1);
    } else {
      name = bare;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }
    const existing = flags[name];
    if (existing === undefined) {
      flags[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      flags[name] = [String(existing), String(value)];
    }
  }

  return { path, flags };
}

/** A flag as a string, or undefined. `--limit 5` → `'5'`. */
export function str(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  if (typeof v === 'string') {
    return v;
  }
  if (Array.isArray(v)) {
    return v[v.length - 1];
  }
  return undefined;
}

/** A flag as a number, or undefined. Rejects garbage rather than coercing it to NaN. */
export function num(flags: ParsedArgs['flags'], name: string): number | undefined {
  const raw = str(flags, name);
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`--${name} expects a number, got "${raw}"`);
  }
  return n;
}

/** A flag as a boolean. Present with no value, or `--flag=true`. */
export function bool(flags: ParsedArgs['flags'], name: string): boolean {
  const v = flags[name];
  if (v === true) {
    return true;
  }
  if (typeof v === 'string') {
    return v !== 'false' && v !== '0';
  }
  return false;
}
