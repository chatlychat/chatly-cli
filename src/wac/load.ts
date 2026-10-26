/**
 * Getting a document off disk, for both `chatly plan` and
 * `chatly platform plan`.
 *
 * ═══ JSON AND YAML ════════════════════════════════════════════════════════
 *
 * `.yaml` / `.yml` parse as YAML, `.json` as JSON, and `--file -` is sniffed:
 * JSON if the first non-space character is `{`, YAML otherwise. The owner
 * approved `yaml` (zero dependencies) as the CLI's only runtime dependency on
 * 2026-10-26. Both paths produce a plain value that goes through the SAME
 * `parseDocument` validation; there is nothing YAML-specific past the parser.
 *
 * Strict mode, unique keys, and any warning is an error — an unknown tag such
 * as `!!js/function` only WARNS in `yaml`, and a document that loads while
 * meaning something other than what it says is the failure we refuse.
 *
 * ═══ WHY IT MOVED HERE ════════════════════════════════════════════════════
 *
 * `chatly platform plan` needs the identical loader with a different default
 * filename and a different schema. The alternative — importing it from
 * `commands/workspace-as-code.ts` — would have one command module depend on
 * another for a filesystem helper, and the YAML refusal is the sort of thing
 * that gets copied and then diverges in one copy. `workspace-as-code.ts`
 * re-exports `loadDocument`, so nothing that imported it from there moved.
 */
import { readFileSync } from 'node:fs';

import { parseDocument as parseYamlDocument } from 'yaml';

import { parseDocument, type DocumentSchema, type WacDocument } from './document.js';
import { str, type ParsedArgs } from '../args.js';

export interface LoadOptions {
  /** Looked for in order when `--file` is absent. */
  readonly defaultFiles: ReadonlyArray<string>;
  /** Which document this is. See `DocumentSchema`. */
  readonly schema: DocumentSchema;
  /** The worked example this CLI points at when no file is found. */
  readonly docsUrl: string;
  /** `plan` for the workspace document, `platform plan` for the other. */
  readonly command: string;
}

function readFile(path: string): string {
  try {
    // `0` is stdin, so `converter | chatly plan --file -` works.
    return path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function findDefault(opts: LoadOptions): string {
  for (const candidate of opts.defaultFiles) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      continue;
    }
  }
  const names = opts.defaultFiles.join(', ');
  throw new Error(
    `No document found. Looked for ${names} in this directory.\n` +
      `Pass one with --file, or --file - to read stdin.\n` +
      `There is a worked example at ${opts.docsUrl}`,
  );
}

/** By extension; anything else (stdin, no extension) by sniffing for a leading `{`. */
export function isYaml(path: string, raw: string): boolean {
  if (/\.ya?ml$/i.test(path)) {
    return true;
  }
  if (/\.json$/i.test(path)) {
    return false;
  }
  return !/^\s*\{/.test(raw);
}

function parseYaml(path: string, raw: string): unknown {
  const doc = parseYamlDocument(raw, { strict: true, uniqueKeys: true, prettyErrors: true });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    const at = problem.linePos?.[0];
    const where = at ? ` (line ${at.line}, column ${at.col})` : '';
    throw new Error(`${path} is not valid YAML${where}: ${problem.message}`);
  }
  return doc.toJS();
}

/** Read, parse as JSON or YAML by extension (stdin: by sniffing), validate against the schema. */
export function loadFrom(args: ParsedArgs, env: NodeJS.ProcessEnv, opts: LoadOptions): WacDocument {
  const path = str(args.flags, 'file') ?? findDefault(opts);
  const raw = readFile(path);
  let parsed: unknown;
  if (isYaml(path, raw)) {
    parsed = parseYaml(path, raw);
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : '?'}`);
    }
  }
  return parseDocument(parsed, env, opts.schema);
}
