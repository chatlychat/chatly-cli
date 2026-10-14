/**
 * `apply`: turning a plan into writes, and the three decisions that shape it.
 *
 * ═══ 1. PARTIAL FAILURE: CONTINUE, SKIP DEPENDENTS, EXIT NON-ZERO ════════
 *
 * Twelve resources, and the seventh answers 400. Stopping there leaves six
 * applied and five untried; continuing leaves eleven applied and one failed.
 * Both are half-applied — there is no transaction across nine REST
 * collections and pretending otherwise would be a lie — so the choice is
 * about which half-applied state is more useful, and continuing wins for
 * three reasons:
 *
 *   - It reports every problem in one run. A document with four bad rows
 *     takes one `apply` to find out, not four.
 *   - The ones that succeeded are IDEMPOTENT to re-run. Every write carries
 *     an `Idempotency-Key` (CONTRACT.md) and, more to the point, the next
 *     `plan` recomputes from live state, so a succeeded resource is simply a
 *     `noop` next time. Stopping early buys nothing that re-running does not.
 *   - Stopping at the seventh tells you nothing about the eighth, and the
 *     eighth is frequently the same mistake.
 *
 * The one thing continuing must NOT do is cascade. A routing rule that names
 * a bot whose create just failed is SKIPPED, not attempted: attempting it
 * produces a second, confusing error about a null `botId` that sends the
 * reader to the wrong place. `dependsOn` on each plan item is what makes that
 * possible, and the skip says which failure caused it.
 *
 * Whatever happened, the final output is three explicit buckets — applied,
 * failed, skipped — and the exit code is 1 if either of the last two is
 * non-empty. "Which resources changed" is never left to inference.
 *
 * ═══ 2. SECRETS: PRINTED ONCE, STORED NOWHERE ════════════════════════════
 *
 * Four creates on this surface answer with a credential that no route will
 * ever read back: a bot's `signingSecret` and its `cb_` token, a customer
 * card's `cc_` secret (returned BESIDE the card, not inside it), and a
 * webhook endpoint's `whsec_`. Losing one means delete and recreate.
 *
 * So `apply` prints them, in a block of their own, at the end, where they
 * cannot scroll past unnoticed — and writes them nowhere. Not into the
 * document, not into a state file, not into `~/.config/chatly`. Writing a
 * credential into a file that lives in git is the failure this feature would
 * otherwise industrialise, and the document is the one file we KNOW is in
 * git. There is deliberately no `--save-secrets`.
 *
 * The sweep is belt and braces: the declared `secrets` list per resource,
 * PLUS anything whose field name reads like a credential. A hand-written list
 * goes stale, and CLAUDE.md records twice over what that looks like — a
 * gate's green line counting what it managed to parse rather than what
 * exists. A field called `webhookToken` that nobody told `resources.ts` about
 * is still surfaced.
 *
 * ═══ 3. THE BODY IS BUILT FROM THE DIFF, NOT FROM THE DOCUMENT ═══════════
 *
 * An update sends only the fields that changed, to the route that owns them —
 * which is how a bot's `webhookUrl` reaches `/v1/bots/{id}/external` while
 * its `model` reaches `/v1/bots/{id}`. The exception is a `fullReplace`
 * resource, where a partial body would RESET everything it omits: `triggers`
 * writes every settable field unconditionally, and an email template's PUT
 * takes `{ subject, body }` and nothing else. For those the whole declared
 * row goes over, and `plan` says so on the line so nobody finds out from the
 * result.
 */
import { looksLikeCredential, routeForField, type ResourceDef } from './resources.js';

import type { PlanItem } from './diff.js';

export interface WriteOp {
  readonly method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

export interface FoundSecret {
  readonly type: string;
  readonly key: string;
  readonly field: string;
  readonly value: string;
}

export interface ApplyOutcome {
  readonly type: string;
  readonly key: string;
  readonly action: PlanItem['action'];
  readonly state: 'applied' | 'failed' | 'skipped' | 'kept';
  /** The failure, or the reason for a skip. */
  readonly detail: string | undefined;
  readonly secrets: ReadonlyArray<FoundSecret>;
}

export interface ApplyOptions {
  readonly prune: boolean;
  /** Types whose live list may be short, where prune is refused regardless. */
  readonly pruneUnsafe: ReadonlyArray<string>;
  /** Send fields that cannot be read back, even when nothing else changed. */
  readonly writeOnly: boolean;
}

function fill(path: string, id: string): string {
  return path.replace('{id}', encodeURIComponent(id));
}

/**
 * The writes one plan item needs, in order.
 *
 * `refIds` carries ids for references this run created, keyed `type/key` — a
 * routing rule planned before its bot existed resolves here, at execution
 * time, with the id the create actually returned.
 */
export function writesFor(
  def: ResourceDef,
  item: PlanItem,
  refIds: ReadonlyMap<string, string>,
  opts: ApplyOptions,
): ReadonlyArray<WriteOp> {
  if (item.action === 'orphan') {
    if (!opts.prune || def.remove === null || opts.pruneUnsafe.includes(def.type)) {
      return [];
    }
    return [{ method: 'DELETE', path: fill(def.remove.path, item.liveId ?? '') }];
  }
  if (item.row === undefined || (item.action !== 'create' && item.action !== 'update')) {
    return [];
  }

  /* References: resolved at plan time where possible, here where not. */
  const wired: Record<string, unknown> = {};
  for (const [wire, id] of Object.entries(item.resolved)) {
    wired[wire] = id;
  }
  for (const [wire, ref] of Object.entries(item.row.refs)) {
    if (wired[wire] === undefined) {
      const id = refIds.get(`${ref.type}/${ref.key}`);
      if (id !== undefined) {
        wired[wire] = id;
      }
    }
  }

  if (item.action === 'create') {
    if (def.create === null) {
      return [];
    }
    return [
      {
        method: 'POST',
        path: def.create.path,
        body: { ...item.row.body, ...wired },
      },
    ];
  }

  /* ── An update. ──────────────────────────────────────────────────────── */
  const liveId = item.liveId ?? '';

  if (def.create?.upsert === true) {
    /*
     * `POST /v1/triggers` with the live id in the body. An id the workspace
     * does not hold is a 404, not a create, so the id MUST come from the row
     * this file matched by name — which is exactly what makes a declarative
     * trigger possible at all.
     */
    return [
      {
        method: 'POST',
        path: def.create.path,
        body: { id: liveId, ...item.row.body, ...wired },
      },
    ];
  }

  /*
   * Which fields go over.
   *
   * `fullReplace` sends every declared field, because a partial body RESETS
   * what it omits — an email template's PUT takes `{ subject, body }` and
   * writes both, and a trigger's upsert writes every settable column
   * unconditionally. Everything else sends only what changed, which keeps a
   * PATCH to a bot's model from touching its guardrails.
   *
   * `--write-only` adds the fields no diff can see. A customer card's
   * `headers` and a docs source's `token` are never returned, so `plan`
   * reports them as unknowable rather than changed — right by default (a diff
   * that says "changed" every run is a diff nobody reads) and wrong when you
   * have just rotated the credential in the file and need it pushed. This is
   * the only way to push them, which is why the plan line names the flag.
   */
  const wanted = new Set<string>(
    def.fullReplace === true
      ? Object.keys({ ...item.row.body, ...wired }).filter((f) => f !== def.naturalKey)
      : item.changes.map((c) => c.name),
  );
  if (opts.writeOnly) {
    for (const field of def.opaque) {
      if (item.row.body[field] !== undefined) {
        wanted.add(field);
      }
    }
  }

  /*
   * Emitted in `def.update` ORDER, not in the order the fields happened to
   * change. Two PATCHes to two routes is already an unavoidable
   * non-atomicity; making their order depend on which key the author listed
   * first would make it unreproducible as well, and a flaky request sequence
   * is a thing nobody can debug from a log.
   */
  const ops: WriteOp[] = [];
  for (const route of def.update) {
    const body: Record<string, unknown> = {};
    for (const field of wanted) {
      if (routeForField(def, field) !== route) {
        continue;
      }
      body[field] = wired[field] ?? item.row.body[field];
    }
    if (Object.keys(body).length === 0) {
      continue;
    }
    ops.push({ method: route.method, path: fill(route.path, liveId), body });
  }
  return ops;
}

/**
 * Every credential-looking string in a write response.
 *
 * Two levels deep, because `POST /v1/customer-cards` answers
 * `{ card: {...}, secret: "cc_…" }` — the secret beside the resource rather
 * than inside it. Deeper than that is not swept: a nested config object can
 * legitimately hold `__redacted__` and reporting the sentinel as a secret
 * would be noise.
 */
export function harvestSecrets(
  def: ResourceDef,
  item: PlanItem,
  response: unknown,
): ReadonlyArray<FoundSecret> {
  const out: FoundSecret[] = [];
  const seen = new Set<string>();

  const scan = (value: unknown, depth: number): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return;
    }
    for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string') {
        if (
          raw.length > 0 &&
          raw !== '__redacted__' &&
          (def.secrets.includes(field) || looksLikeCredential(field)) &&
          !seen.has(`${field}:${raw}`)
        ) {
          seen.add(`${field}:${raw}`);
          out.push({ type: def.type, key: item.key, field, value: raw });
        }
        continue;
      }
      if (depth < 1) {
        scan(raw, depth + 1);
      }
    }
  };

  scan(response, 0);
  return out;
}

/** The three buckets, as `apply` prints them. */
export function renderOutcomes(outcomes: ReadonlyArray<ApplyOutcome>): string {
  const applied = outcomes.filter((o) => o.state === 'applied');
  const failed = outcomes.filter((o) => o.state === 'failed');
  const skipped = outcomes.filter((o) => o.state === 'skipped');
  const kept = outcomes.filter((o) => o.state === 'kept');

  const lines: string[] = [];
  const verb = (o: ApplyOutcome): string =>
    o.action === 'orphan' ? 'deleted' : o.action === 'create' ? 'created' : 'changed';

  if (applied.length > 0) {
    lines.push(`Applied (${String(applied.length)})`);
    for (const o of applied) {
      lines.push(`  ✓ ${o.type}/${o.key}   ${verb(o)}`);
    }
  }
  if (failed.length > 0) {
    lines.push('', `Failed (${String(failed.length)}) — nothing was written for these`);
    for (const o of failed) {
      lines.push(`  ✗ ${o.type}/${o.key}`);
      lines.push(`      ${o.detail ?? 'no detail recorded, which is itself a bug.'}`);
    }
  }
  if (skipped.length > 0) {
    lines.push('', `Skipped (${String(skipped.length)}) — not attempted`);
    for (const o of skipped) {
      lines.push(`  · ${o.type}/${o.key}`);
      lines.push(`      ${o.detail ?? 'no detail recorded, which is itself a bug.'}`);
    }
  }
  if (kept.length > 0) {
    lines.push('', `Left alone (${String(kept.length)}) — on the server, not in the document`);
    for (const o of kept) {
      lines.push(`  · ${o.type}/${o.key}${o.detail === undefined ? '' : `   ${o.detail}`}`);
    }
  }

  const secrets = outcomes.flatMap((o) => o.secrets);
  if (secrets.length > 0) {
    /*
     * Last, and loud. These are shown exactly once by the API and this is the
     * only moment they exist anywhere outside the database. The banner says
     * what to do rather than merely that they are secret, because "copy it
     * now" is the actionable part and the recovery (delete and recreate) is
     * worse than it sounds for a webhook endpoint.
     */
    lines.push(
      '',
      '─── SHOWN ONCE ────────────────────────────────────────────────────',
      'The API returns each of these exactly once and no route reads them',
      'back. Copy them into your secret store NOW. They are not written to',
      'the document, to a state file, or to disk anywhere — losing one means',
      'deleting and recreating the resource.',
      '',
    );
    for (const s of secrets) {
      lines.push(`  ${s.type}/${s.key}  ${s.field} = ${s.value}`);
    }
    lines.push('───────────────────────────────────────────────────────────────────');
  }

  if (lines.length === 0) {
    return 'Nothing to do — the workspace already matches the document.\n';
  }
  return `${lines.join('\n')}\n`;
}
