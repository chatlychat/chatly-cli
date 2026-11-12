/**
 * The per-arm ITEM enum: `arm.itemEnums`, read by `armNeeds`.
 *
 * Why it is tested against a hand-built arm rather than a route. The merged
 * `itemEnums` map carries a field only where EVERY arm declares it — the same
 * rule as `enums`, `types` and `strings`, and for the same reason: a tighter
 * guess would refuse a document the server accepts. So an array field that one
 * arm closes to a set and another leaves open has no merged entry at all, and
 * the arm's own list is the only record of what the server will refuse.
 *
 * No route in the served document is in that state today — `POST /v1/webhooks`
 * declares the one item enum there and is not a union — so a spec driven
 * through `buildPlan` could only assert that the maps are empty, which is a
 * fact about today's surface and not about the check. `armNeeds` is a pure
 * function of (arm, row); calling it directly is what lets the branch be
 * control-tested at all.
 *
 * CONTROL (2026-11-07): with the `arm.itemEnums` block deleted from
 * `armNeeds`, `refuses an arm whose item enum the row contradicts` fails with
 * three of the five fail — `refuses an arm whose item enum the row
 * contradicts`, `names a non-string item rather than ignoring it` and
 * `prefers the arm whose items fit`, all with `expected [] to have a length of
 * 1`. The other two are the negative half and pass either way, which is what
 * makes them worth keeping separate.
 */
import { describe, expect, it } from 'vitest';

import { armNeeds } from './union-arm-checks.js';

import type { DocumentRow } from './document.js';
import type { RouteFieldArm } from './field-rules.generated.js';

const row = (body: Record<string, unknown>): DocumentRow => ({
  key: 'r1',
  path: 'resources.webhooks[0]',
  body,
  refs: {},
  fromEnv: [],
});

const arm = (over: Partial<RouteFieldArm> = {}): RouteFieldArm => ({
  required: [],
  types: {},
  enums: {},
  itemEnums: {},
  strings: {},
  ...over,
});

const NO_WIRES = new Map<string, string>();

describe('an arm that closes an array field', () => {
  it('refuses an arm whose item enum the row contradicts', () => {
    const needs = armNeeds(
      arm({ itemEnums: { eventTypes: ['conversation.created', 'conversation.closed'] } }),
      row({ eventTypes: ['conversation.created', 'conversation.nope'] }),
      NO_WIRES,
    );
    expect(needs).toHaveLength(1);
    // Names the values, not the positions: the merged check reports indices
    // because it is describing THE route, where this one is describing one
    // candidate shape among several.
    expect(needs[0]).toContain('`conversation.nope`');
    expect(needs[0]).toContain('`conversation.created`');
  });

  it('accepts a row whose items are all members', () => {
    expect(
      armNeeds(
        arm({ itemEnums: { eventTypes: ['conversation.created'] } }),
        row({ eventTypes: ['conversation.created'] }),
        NO_WIRES,
      ),
    ).toEqual([]);
  });

  it('names a non-string item rather than ignoring it', () => {
    const needs = armNeeds(
      arm({ itemEnums: { eventTypes: ['conversation.created'] } }),
      row({ eventTypes: [7] }),
      NO_WIRES,
    );
    expect(needs).toHaveLength(1);
    expect(needs[0]).toContain('`7`');
  });

  it('says nothing about a field the arm leaves open', () => {
    expect(armNeeds(arm(), row({ eventTypes: ['anything.at.all'] }), NO_WIRES)).toEqual([]);
  });

  it('prefers the arm whose items fit — which is the point of carrying it', () => {
    /*
     * The shape the merged table cannot express: arm A closes `eventTypes`,
     * arm B does not. A row carrying a member of neither-but-B must leave A
     * unmatched and B matched, so the plan describes A's refusal and not B's.
     */
    const closed = arm({ itemEnums: { eventTypes: ['conversation.created'] } });
    const open = arm();
    const r = row({ eventTypes: ['ticket.created'] });
    expect(armNeeds(closed, r, NO_WIRES)).toHaveLength(1);
    expect(armNeeds(open, r, NO_WIRES)).toEqual([]);
  });
});
