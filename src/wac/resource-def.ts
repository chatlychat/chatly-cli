/**
 * The SHAPE of a resource definition, and the helpers that read one.
 *
 * Split out of `resources.ts` only because the two together ran past the
 * 650-line ceiling (`scripts/check-file-size.mjs`). The division is the
 * useful one anyway: this file is the vocabulary, `resources.ts` is the nine
 * answers written in it, and reading one does not require reading the other.
 * `resources.ts` re-exports everything here, so every importer sees one
 * module.
 */

/** The verbs a document can cause. */
export type Action = 'create' | 'update' | 'noop' | 'orphan' | 'blocked';

export interface ResourceRef {
  /** The resource type the value names. */
  readonly type: string;
  /** The field the API actually reads, which the ref resolves into. */
  readonly wire: string;
}

export interface UpdateRoute {
  readonly method: 'PATCH' | 'PUT';
  /** `{id}` is replaced with the encoded live id. */
  readonly path: string;
  /**
   * The ONLY fields this route can change. Omitted means "anything not
   * claimed by a more specific route" — the catch-all. A resource with no
   * catch-all can only change the fields its routes name, and a diff on any
   * other field is reported as un-appliable instead of being sent somewhere
   * that will strip it and answer 200.
   */
  readonly fields?: ReadonlyArray<string>;
}

export interface ResourceDef {
  /** The key under `resources:` and the word in every plan line. */
  readonly type: string;
  /** Singular, for a sentence. */
  readonly label: string;
  /** The field holding the natural key, in the document and on the live row. */
  readonly naturalKey: string;
  readonly keySource: 'authored' | 'server';
  /** True when the database enforces the key. False when only this file does. */
  readonly keyEnforced: boolean;
  /** The server's own normalisation, applied to both sides before matching. */
  readonly normalizeKey?: (key: string) => string;
  readonly list: { readonly path: string; readonly paged: boolean };
  /** The field on a live row that identifies it in a write path. */
  readonly idField: string;
  readonly create: {
    readonly path: string;
    /** POST is an upsert keyed on the body's `id`, not a plain create. */
    readonly upsert?: boolean;
  } | null;
  /** Empty means there is no way to change one in place. */
  readonly update: ReadonlyArray<UpdateRoute>;
  /** Said when a changed field matches no update route. */
  readonly updateBlocked?: string;
  /**
   * The write REPLACES the resource: a field the document omits reverts to
   * its default. `plan` says so on every change to one of these.
   */
  readonly fullReplace?: boolean;
  /** `null` when `--prune` cannot delete one; `removeBlocked` says why. */
  readonly remove: { readonly path: string } | null;
  readonly removeBlocked?: string;
  /**
   * Fields that are never readable back, so a diff must not claim they
   * changed. Half the answer; the other half is the `__redacted__` sentinel,
   * detected at runtime in `diff.ts`.
   */
  readonly opaque: ReadonlyArray<string>;
  /**
   * Fields a CREATE answers with exactly once. A floor, not a fence:
   * `apply.ts` also sweeps every response for anything that looks like a
   * credential, so a field added next month is surfaced rather than dropped.
   */
  readonly secrets: ReadonlyArray<string>;
  /**
   * Returned on a read and accepted by NO write path. A document declaring
   * one is refused at parse time: zod would strip it and answer 200, and the
   * author would never find out.
   */
  readonly unwritable: ReadonlyArray<string>;
  /** The live row, reshaped into the vocabulary the document writes. */
  readonly project?: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Document-only keys naming another resource by ITS natural key. */
  readonly references?: Readonly<Record<string, ResourceRef>>;
}

/** The server's spelling of a key, for matching. */
export function normalizedKey(def: ResourceDef, key: string): string {
  return def.normalizeKey === undefined ? key : def.normalizeKey(key);
}

/** The live row in the vocabulary the document writes. */
export function projected(def: ResourceDef, row: Record<string, unknown>): Record<string, unknown> {
  return def.project === undefined ? row : def.project(row);
}

/**
 * Which update route owns a field, or `undefined` if none does.
 *
 * A route with no `fields` is the catch-all and is tried last, so a field a
 * specific route claims (`webhookUrl` → `/v1/bots/{id}/external`) is never
 * swept into the general PATCH.
 */
export function routeForField(def: ResourceDef, field: string): UpdateRoute | undefined {
  return (
    def.update.find((r) => r.fields?.includes(field) === true) ??
    def.update.find((r) => r.fields === undefined)
  );
}

/**
 * Anything that reads like a credential, by NAME.
 *
 * `secrets` on each definition is a hand-written list, and a hand-written
 * list goes stale — the failure CLAUDE.md names twice, where a gate's green
 * line counts what it managed to parse rather than what exists. So `apply`
 * also runs every write response through this, and a field called
 * `webhookToken` that nobody told this file about is still surfaced to the
 * operator instead of being dropped on the floor. False positives are cheap:
 * the cost is one extra line of output.
 */
export function looksLikeCredential(field: string): boolean {
  return /secret|token|password|credential|privatekey|apikey/i.test(field);
}
