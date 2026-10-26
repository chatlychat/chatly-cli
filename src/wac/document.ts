/**
 * `chatly.json` — the document, and the only thing in this feature allowed to
 * refuse you.
 *
 * ═══ WHY THERE IS NO zod HERE, AND WHAT TAKES ITS PLACE ══════════════════
 *
 * This repo validates with zod everywhere and this schema wants it. It is not
 * here for one reason: `@chatlychat/cli` is a PUBLISHED package whose
 * dependency list is exactly `@chatlychat/sdk-node`, zod is not reachable
 * from `apps/cli` (it is in the workspace catalog, but no package here
 * declares it, so it is not installed under `apps/cli/node_modules`), and
 * CLAUDE.md §2 forbids adding a dependency without explicit approval. Adding
 * one to a published CLI is a product decision about what customers install,
 * not a tidying-up decision — the same reason `args.ts` is hand-written
 * rather than `commander`.
 *
 * So the checks below are hand-written, and deliberately shaped so the swap
 * is mechanical if that approval comes: one `parseDocument` entry point,
 * issues collected as `{ path, message }` with a dotted path, and all of them
 * reported at once rather than the first. A zod `.strict()` object and
 * `ZodError.issues` is a drop-in for the body of this file.
 *
 * ═══ WHERE STRICTNESS APPLIES, AND WHERE IT DELIBERATELY DOES NOT ════════
 *
 * CLAUDE.md records the bug twice over: a key the reader has never heard of
 * is STRIPPED, so the write answers 200 and did nothing, and `helpProfile` vs
 * `profile` cost a complete feature that way. The cure is to refuse the key
 * by name and say what the valid ones are. That is done for every part of the
 * document whose vocabulary the CLI OWNS:
 *
 *   - the top level (`version`, `workspace`, `resources`)
 *   - the resource-type keys inside `resources`
 *   - the per-row control keys the CLI invents (`bot:`, which is not an API
 *     field at all)
 *   - the natural key, which must be present and a non-empty string
 *   - any field the API RETURNS and no write path accepts (`unwritable` in
 *     `resources.ts`) — `triggers.brandId`, `brands.usage`,
 *     `macros.usageCount` and twenty more. These are the dangerous ones:
 *     they are spelled correctly, they come back on every read, and zod
 *     strips them on the way in.
 *
 * It is NOT done for the rest of a row's fields, and that is a decision
 * rather than an omission. `common.ts`'s `bodyFrom` already states the
 * position for every write on this CLI: "the body goes to the API exactly as
 * written, so the schema in `apps/api` is the only spelling that matters…
 * the CLI simply refuses to add a second renaming layer on top." A per-row
 * allow-list here would be a second COPY of nine API schemas, in a package
 * published on a different cadence, and it would reject a field the API
 * shipped yesterday — a gate that fails on correct input is a gate somebody
 * switches off.
 *
 * What replaces it is better evidence than a copied list: `plan` compares the
 * fields a row declares against the fields the SERVER returns for rows of
 * that type, and warns about one no live row has ever carried. That catches
 * `helpProfle` from the server's own vocabulary, with nothing to keep in
 * step. Its blind spot — a workspace with no rows of that type yet — is
 * reported as such rather than passed off as a clean bill. See `diff.ts`.
 */
import { keyOf, list } from './document-key.js';
import { resourceDef, RESOURCE_TYPES } from './resources.js';

import type { ResourceDef } from './resource-def.js';

/** The file format's version. Bumped only for a change that breaks a reader. */
export const DOCUMENT_VERSION = 1;

/**
 * Which document this is, as data — so there is one parser and not two.
 *
 * `chatly plan` reads a WORKSPACE document against a `ck_` key and `chatly
 * platform plan` reads a PLATFORM document against a `cp_` credential
 * (CHT-F04). The two differ in their vocabulary (nine resource types against
 * five), their guard (a workspace id against a credential prefix) and their
 * row shape (flat, against rows that name a parent workspace) — and in
 * nothing else. Every rule in this file's header applies to both verbatim:
 * refuse an unknown key by name, refuse a field the server returns and no
 * write accepts, report every issue at once, substitute `${env:…}` and refuse
 * an unset variable.
 *
 * So the alternative was a second copy of ~200 lines of parse logic in
 * `pac/`, which CLAUDE.md forbids for exactly the reason this surface keeps
 * demonstrating: a rule fixed in one copy and not the other is two systems
 * that disagree while both believe they agree.
 */
export interface DocumentSchema {
  /** Accepted at the root. Anything else is refused by name. */
  readonly topLevelKeys: ReadonlyArray<string>;
  /** Accepted under `resources`, INCLUDING the keys refused with a reason. */
  readonly resourceKeys: ReadonlyArray<string>;
  /** Parsed in this order, which is dependency order. */
  readonly types: ReadonlyArray<string>;
  readonly def: (type: string) => ResourceDef | undefined;
  /**
   * A resource key that is valid to write and refused to USE, mapped to the
   * reason. `channels` in the workspace document; `widgetChannel`,
   * `businessHours`, `routing` and `loginLinks` in the platform one.
   *
   * Refused by name rather than dropped from `resourceKeys`, because the
   * unknown-key message would otherwise say "channels is not a resource
   * type" — which is wrong, and sends the reader hunting for a spelling
   * mistake instead of reading the reason.
   */
  readonly refusedKeys: Readonly<Record<string, string>>;
  /**
   * Validate the optional guard at the root and return its value.
   *
   * The guard is what stops a staging document reaching production, and the
   * two documents guard on different things: a workspace document names a
   * workspace id, a platform document names its credential's prefix. The
   * COMMAND compares it against a `whoami` read; this only parses it.
   */
  readonly guard: (raw: Record<string, unknown>, issues: Issue[]) => string | undefined;
}

const TOP_LEVEL_KEYS = ['version', 'workspace', 'resources'] as const;

/**
 * `${env:NAME}` inside any string value.
 *
 * Two of these resources cannot be described at all without a secret — a
 * documentation source needs its provider token on create, a customer card
 * needs an `Authorization` header — and a config file in git is the one place
 * those must not be. An interpolation is the smallest thing that makes the
 * file usable, and it is narrow on purpose: this exact form, in a string, and
 * nothing else. No defaults, no shell, no file reads, no nesting.
 *
 * An UNSET variable is refused by name. It is not substituted with an empty
 * string, and that is the whole point: CLAUDE.md records both halves of this
 * failure — "a shell `read` cannot fail", where empty vars beat the sentinel
 * and a health check invented findings, and "env fallback reaches
 * production", where an unset variable became a localhost canonical URL on
 * every page. An empty token here would be POSTed, verified against the
 * provider, and fail with a message about the provider rather than about the
 * variable nobody exported.
 */
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface Issue {
  /** Dotted, and it is the path IN THE FILE: `resources.bots[2].slug`. */
  readonly path: string;
  readonly message: string;
}

/** One reference a row makes, by the target's natural key. */
export interface DocumentRef {
  readonly type: string;
  readonly key: string;
  readonly pathParam?: boolean;
}

export interface DocumentRow {
  /** The natural key's value, as written. */
  readonly key: string;
  /** Where in the file this row came from, for an error message. */
  readonly path: string;
  /** The row's API fields, with the CLI's own control keys removed. */
  readonly body: Readonly<Record<string, unknown>>;
  /**
   * `{ botId: { type: 'bots', key: 'support' } }` — resolved by `diff.ts`.
   * `pathParam` is copied from the definition's `ResourceRef`: the id fills a
   * route placeholder rather than a body field (CHT-F04's nested routes).
   */
  readonly refs: Readonly<Record<string, DocumentRef>>;
  /**
   * Top-level fields whose value came, wholly or partly, from `${env:…}`.
   * Rendered as the variable's name rather than its value, so a plan can be
   * pasted into a ticket.
   */
  readonly fromEnv: ReadonlyArray<string>;
}

export interface DocumentSection {
  readonly def: ResourceDef;
  readonly rows: ReadonlyArray<DocumentRow>;
}

export interface WacDocument {
  readonly version: number;
  /**
   * The optional guard value, as the schema defines it: a workspace id for a
   * workspace document, a credential prefix for a platform one. `apply`
   * refuses to run when it does not match what the credential reports.
   */
  readonly guard: string | undefined;
  /** In `RESOURCES` order — which is dependency order. */
  readonly sections: ReadonlyArray<DocumentSection>;
}

/** Thrown with every issue at once, not the first one found. */
export class DocumentError extends Error {
  public readonly issues: ReadonlyArray<Issue>;

  public constructor(issues: ReadonlyArray<Issue>) {
    super(
      `${String(issues.length)} problem(s) in the document:\n` +
        issues.map((i) => `  ${i.path}\n      ${i.message}`).join('\n'),
    );
    this.name = 'DocumentError';
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Did the author mean one of the valid keys?
 *
 * Levenshtein ≤ 2, which covers the real cases: a dropped letter, a doubled
 * letter, a transposition, `botid` for `botId`, `eventTypes` for `events`.
 * Anything further is not a typo and guessing would be noise.
 */
function nearest(key: string, valid: ReadonlyArray<string>): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const candidate of valid) {
    const d = distance(key.toLowerCase(), candidate.toLowerCase());
    if (d <= 2 && (best === undefined || d < best.d)) {
      best = { name: candidate, d };
    }
  }
  return best?.name;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

function refuseUnknown(
  issues: Issue[],
  path: string,
  actual: ReadonlyArray<string>,
  valid: ReadonlyArray<string>,
  what: string,
): void {
  for (const key of actual) {
    if (valid.includes(key)) {
      continue;
    }
    const guess = nearest(key, valid);
    issues.push({
      path: `${path}.${key}`,
      message:
        `unknown ${what} "${key}".` +
        (guess === undefined ? '' : ` Did you mean "${guess}"?`) +
        ` Valid: ${list(valid)}.`,
    });
  }
}

/**
 * Substitute `${env:NAME}` throughout a value. Collects unset names.
 *
 * `env` is a parameter rather than a read of `process.env` so the spec can
 * drive it: a test that monkey-patches the process environment is a test that
 * leaks into its neighbours.
 */
function interpolate(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
  missing: Set<string>,
  used: Set<string>,
): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (_match, name: string) => {
      const found = env[name];
      if (found === undefined || found === '') {
        missing.add(name);
        return '';
      }
      used.add(name);
      return found;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolate(v, env, missing, used));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolate(v, env, missing, used);
    }
    return out;
  }
  return value;
}

/**
 * The workspace document: `chatly.json`, nine resource types, a `ck_` key.
 *
 * A resource whose `keySource` is `'server'` is refused by name (none is, now
 * that channels match on `key`); that refusal is driven by the definition and the message is
 * assembled from the definition's own route and key names, which is richer
 * than a constant string could be. Leaving it where it is also keeps this
 * schema's behaviour byte-identical to what it was before the schema existed.
 */
export const WORKSPACE_SCHEMA: DocumentSchema = {
  topLevelKeys: [...TOP_LEVEL_KEYS],
  resourceKeys: RESOURCE_TYPES,
  types: RESOURCE_TYPES,
  def: resourceDef,
  refusedKeys: {},
  guard: (raw, issues) => {
    const value = raw['workspace'];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string' || value.length === 0) {
      issues.push({
        path: 'workspace',
        message:
          'must be a workspace id string, or left out. It is a guard: `apply` refuses to run ' +
          'against any other workspace, which is what stops a staging file reaching production.',
      });
      return undefined;
    }
    return value;
  },
};

/**
 * Parse and validate. Throws `DocumentError` with every problem it found.
 *
 * Nothing here touches the network. `env` is the only ambient input and it is
 * injected, which is what lets the spec drive this with a literal object and
 * no transport at all.
 */
export function parseDocument(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>> = {},
  schema: DocumentSchema = WORKSPACE_SCHEMA,
): WacDocument {
  const issues: Issue[] = [];

  if (!isPlainObject(raw)) {
    throw new DocumentError([
      {
        path: '(root)',
        message:
          'the document must be an object with `version` and `resources`, not ' +
          (Array.isArray(raw) ? 'an array' : typeof raw),
      },
    ]);
  }

  refuseUnknown(issues, '(root)', Object.keys(raw), schema.topLevelKeys, 'top-level key');

  const version = raw['version'];
  if (version === undefined) {
    issues.push({
      path: 'version',
      message: `required. Write \`"version": ${String(DOCUMENT_VERSION)}\`.`,
    });
  } else if (version !== DOCUMENT_VERSION) {
    issues.push({
      path: 'version',
      message:
        `this CLI reads version ${String(DOCUMENT_VERSION)}; the document says ` +
        `${JSON.stringify(version)}. Upgrade \`@chatlychat/cli\` rather than editing the number.`,
    });
  }

  const guard = schema.guard(raw, issues);

  const resourcesRaw = raw['resources'];
  const sections: DocumentSection[] = [];
  if (resourcesRaw === undefined) {
    issues.push({
      path: 'resources',
      message: `required. An object keyed by resource type: ${list(schema.types)}.`,
    });
  } else if (!isPlainObject(resourcesRaw)) {
    issues.push({ path: 'resources', message: 'must be an object keyed by resource type.' });
  } else {
    refuseUnknown(
      issues,
      'resources',
      Object.keys(resourcesRaw),
      schema.resourceKeys,
      'resource type',
    );
    /*
     * A key that is spelled right and cannot be used, refused with the
     * reason. An EMPTY array is allowed through, as the `channels` refusal
     * allows one: a document that carries the key with nothing in it is
     * describing nothing, and failing on it would make a generated file that
     * emits every key impossible to apply.
     */
    for (const [key, reason] of Object.entries(schema.refusedKeys)) {
      const value = resourcesRaw[key];
      if (value === undefined || (Array.isArray(value) && value.length === 0)) {
        continue;
      }
      issues.push({ path: `resources.${key}`, message: reason });
    }
    /*
     * Iterated in RESOURCES order, not in the file's key order.
     *
     * The order matters at apply time — a routing rule names a bot that this
     * run may be about to create — and taking it from the file would make the
     * result depend on how somebody chose to lay out their document.
     */
    for (const type of schema.types) {
      const value = resourcesRaw[type];
      if (value === undefined) {
        continue;
      }
      const def = schema.def(type);
      if (def === undefined) {
        continue;
      }
      sections.push({ def, rows: parseSection(issues, def, value, env) });
    }
  }

  if (issues.length > 0) {
    throw new DocumentError(issues);
  }
  return { version: DOCUMENT_VERSION, guard, sections };
}

function parseSection(
  issues: Issue[],
  def: ResourceDef,
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
): DocumentRow[] {
  const at = `resources.${def.type}`;

  /*
   * The resource with no usable natural key is refused here, by name, with
   * the reason.
   *
   * `channels` stays a VALID key under `resources` — dropping it would make
   * the unknown-key message say "channels is not a resource type", which is
   * wrong and sends the reader hunting for a spelling mistake. What it cannot
   * be is non-empty. `publicId` is minted as a GLOBALLY unique reservation
   * (another tenant may hold `web`), `type` and `publicId` are immutable
   * afterwards, `config` reads back redacted, and the create response carries
   * per-provider webhook registration results a diff cannot model.
   *
   * Half-supporting it — "we will update the ones we can match and ignore the
   * rest" — is worse than refusing, because the thing it silently cannot do
   * is the thing somebody put it in the file for.
   */
  if (def.keySource === 'server') {
    if (Array.isArray(value) && value.length === 0) {
      return [];
    }
    issues.push({
      path: at,
      message:
        `${def.label}s cannot be managed from a document. \`${def.naturalKey}\` is minted on ` +
        'create and is unique across every workspace, not just yours, so a row here has no key ' +
        `it can safely claim; \`type\` and \`${def.naturalKey}\` are then immutable, and ` +
        '`config` reads back with `__redacted__` in every credential key, so even an update ' +
        `diff is mostly unknowable. Use \`chatly ${def.type} create\` and ` +
        `\`chatly ${def.type} update <id>\`, and remove this section.`,
    });
    return [];
  }

  if (!Array.isArray(value)) {
    issues.push({
      path: at,
      message: `must be an array of ${def.label} objects (it is ${typeof value}).`,
    });
    return [];
  }

  const rows: DocumentRow[] = [];
  const seen = new Map<string, string>();

  for (let i = 0; i < value.length; i += 1) {
    const path = `${at}[${String(i)}]`;
    const row: unknown = value[i];
    if (!isPlainObject(row)) {
      issues.push({ path, message: `must be an object, not ${typeof row}.` });
      continue;
    }

    const keyValue = keyOf(issues, def, row, path);
    if (keyValue === undefined) {
      continue;
    }

    const duplicate = seen.get(keyValue);
    if (duplicate !== undefined) {
      issues.push({
        path: `${path}.${def.naturalKey}`,
        message:
          `duplicate ${def.naturalKey} "${keyValue}" — also at ${duplicate}. Two rows with one ` +
          'key cannot both be applied, and guessing which was meant is how the wrong resource ' +
          'gets overwritten.',
      });
      continue;
    }
    seen.set(keyValue, path);

    /*
     * Fields the API RETURNS and no write path accepts.
     *
     * The dangerous class, and the reason `unwritable` exists in
     * `resources.ts`. These are spelled correctly, they come back on every
     * read, and copying a `chatly bots list --json` row into the document is
     * the obvious way to start one — so `brands.usage`, `macros.usageCount`,
     * `triggers.brandId` and twenty more arrive looking exactly like
     * settings. zod strips every one of them and the write answers 200.
     */
    for (const field of Object.keys(row)) {
      if (!def.unwritable.includes(field)) {
        continue;
      }
      issues.push({
        path: `${path}.${field}`,
        message:
          `\`${field}\` is returned on a read and NO write path accepts it, so zod would strip ` +
          'it and the API would answer 200 having ignored you. Remove it. (A document is not a ' +
          'copy of a list row: it holds the settings you choose, not the state the server ' +
          'reports.)',
      });
    }

    const missing = new Set<string>();
    const usedEnv = new Set<string>();
    const body: Record<string, unknown> = {};
    const refs: Record<string, DocumentRef> = {};
    const fromEnv: string[] = [];

    for (const [field, rawValue] of Object.entries(row)) {
      if (def.unwritable.includes(field)) {
        continue;
      }
      const ref = def.references?.[field];
      if (ref === undefined) {
        /*
         * A FRESH set per field, not a shared one.
         *
         * This was one `usedEnv` for the whole row and the membership test
         * was `size > before`, which is correct exactly once: two fields
         * referencing the SAME variable left the second one unmarked, and an
         * unmarked field is printed by value. The spec caught it with a
         * document whose `token` and `baseUrl` both read `${env:X}` — the
         * token was masked and the live credential went out beside it.
         */
        const perField = new Set<string>();
        body[field] = interpolate(rawValue, env, missing, perField);
        if (perField.size > 0) {
          fromEnv.push(field);
          for (const name of perField) {
            usedEnv.add(name);
          }
        }
        continue;
      }
      /*
       * A reference key. `bot: "support"` is not an API field — it resolves
       * into `botId` — so it must never reach the body, and the wire field
       * must not be written by hand beside it.
       */
      if (typeof rawValue !== 'string' || rawValue.length === 0) {
        issues.push({
          path: `${path}.${field}`,
          message: `must be the \`${ref.type}\` natural key as a string.`,
        });
        continue;
      }
      if (row[ref.wire] !== undefined) {
        issues.push({
          path: `${path}.${ref.wire}`,
          message:
            `remove it: this row has both \`${field}: "${rawValue}"\` and \`${ref.wire}\`. ` +
            `\`${ref.wire}\` is a server uuid, which pins the document to one environment — ` +
            `\`${field}\` is the portable form and is what this CLI resolves.`,
        });
        continue;
      }
      refs[ref.wire] =
        ref.pathParam === true
          ? { type: ref.type, key: rawValue, pathParam: true }
          : { type: ref.type, key: rawValue };
    }

    for (const name of missing) {
      issues.push({
        path,
        message:
          `\${env:${name}} is used here and ${name} is unset or empty. It is NOT substituted ` +
          'with an empty string: an empty token would be sent, verified against the provider, ' +
          'and fail with a message about the provider rather than about the variable nobody ' +
          `exported. Export ${name} and run again.`,
      });
    }

    rows.push({ key: keyValue, path, body, refs, fromEnv });
  }

  return rows;
}
