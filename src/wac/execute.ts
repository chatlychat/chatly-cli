/**
 * Walking a plan and making its writes — shared by `chatly apply` and
 * `chatly platform apply` (CHT-F04).
 *
 * Moved out of `commands/workspace-as-code.ts` rather than imported from it,
 * so one command module never depends on another. The only thing that differs
 * between the two documents here is which resource table an item's type is
 * looked up in, and that is the `defOf` parameter: the workspace table for
 * a `ck_` key, the platform table for a `cp_` credential. A type absent from
 * the table passed is skipped, never guessed.
 */
import {
  harvestSecrets,
  writesFor,
  type ApplyOptions,
  type ApplyOutcome,
  type FoundSecret,
} from './apply.js';

import type { Plan } from './diff.js';
import type { ResourceDef } from './resource-def.js';
import type { ChatlyClient } from '@chatlychat/sdk-node';

/**
 * Walk the plan and do it. Continue on failure; never cascade.
 *
 * Exported so `wac.spec.ts` can drive it with a scripted transport and assert
 * on the requests that went over the wire — the shape CLAUDE.md insists on
 * ("assert on the request, not the canned response"), since a fake transport
 * that echoes whatever the caller sent agrees with the bug.
 */
export async function execute(
  chatly: ChatlyClient,
  built: Plan,
  opts: ApplyOptions,
  defOf: (type: string) => ResourceDef | undefined,
): Promise<ReadonlyArray<ApplyOutcome>> {
  const outcomes: ApplyOutcome[] = [];
  /** `type/key` → the id a create in THIS run returned. */
  const refIds = new Map<string, string>();
  /** `type/key` that failed, so its dependents are skipped not attempted. */
  const failed = new Set<string>();

  for (const item of built.items) {
    const def = defOf(item.type);
    if (def === undefined) {
      continue;
    }
    const address = `${item.type}/${item.key}`;

    if (item.action === 'noop') {
      continue;
    }
    if (item.action === 'blocked') {
      outcomes.push({ ...base(item), state: 'skipped', detail: item.reason, secrets: [] });
      continue;
    }

    const blocker = item.dependsOn.find((d) => failed.has(d));
    if (blocker !== undefined) {
      outcomes.push({
        ...base(item),
        state: 'skipped',
        detail:
          `${blocker} failed above, and this names it. Attempting it anyway would produce a ` +
          'second error about a missing id that points at the wrong thing.',
        secrets: [],
      });
      failed.add(address);
      continue;
    }

    const ops = writesFor(def, item, refIds, opts);
    if (ops.length === 0) {
      outcomes.push({
        ...base(item),
        state: 'kept',
        detail:
          item.action === 'orphan'
            ? opts.prune
              ? def.remove === null
                ? (def.removeBlocked ?? 'no DELETE route.')
                : 'this type cannot be pruned safely on this run (see the warnings)'
              : '`--prune` would delete it'
            : undefined,
        secrets: [],
      });
      continue;
    }

    const secrets: FoundSecret[] = [];
    let ok = true;
    for (const op of ops) {
      try {
        const response = await chatly.request<unknown>(
          op.method,
          op.path,
          op.body === undefined ? {} : { body: op.body },
        );
        secrets.push(...harvestSecrets(def, item, response));
        const id = idOf(response, def);
        if (id !== undefined) {
          refIds.set(address, id);
        }
      } catch (err) {
        ok = false;
        failed.add(address);
        outcomes.push({
          ...base(item),
          state: 'failed',
          detail: `${op.method} ${op.path} — ${err instanceof Error ? err.message : String(err)}`,
          secrets,
        });
        break;
      }
    }
    if (ok) {
      outcomes.push({ ...base(item), state: 'applied', detail: undefined, secrets });
    }
  }
  return outcomes;
}

function base(item: Plan['items'][number]): Omit<ApplyOutcome, 'state' | 'detail' | 'secrets'> {
  return { type: item.type, key: item.key, action: item.action };
}

/**
 * The id out of a write response, for a reference a later section needs.
 *
 * Two levels, because `POST /v1/customer-cards` answers
 * `{ card: { id }, secret }` rather than the card itself — the same envelope
 * quirk that makes the secret sweep two levels deep.
 */
function idOf(response: unknown, def: ResourceDef): string | undefined {
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  const top = response as Record<string, unknown>;
  const direct = top[def.idField];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  for (const value of Object.values(top)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>)[def.idField];
      if (typeof nested === 'string' && nested.length > 0) {
        return nested;
      }
    }
  }
  return undefined;
}
