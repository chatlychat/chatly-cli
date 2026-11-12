/**
 * ForgeDeck's NINTH report, 2026-11-06. Every row here is one of their repros.
 *
 * The theme is that 0.9.8 shipped a generated table of `required`/`allowed`
 * and the help text claimed wrong types too, which only `privacyPartners`
 * ever had. A claimed check is worse than a missing one, because a pipeline is
 * built on the claim.
 */
import { describe, expect, it } from 'vitest';

import { doc, live } from './__tests__/wac-fixtures.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { ROUTE_FIELD_RULES, routeKey } from './field-rules.generated.js';

type Rows = Record<string, Array<Record<string, unknown>>>;
const planOf = (resources: Rows, liveRows: Rows = {}) =>
  buildPlan(parseDocument(doc(resources)), live(liveRows));
const text = (p: ReturnType<typeof buildPlan>) => p.warnings.join('\n');

describe('a wrong JSON type, on resources that are not privacyPartners', () => {
  /* Their item 2, all six documents. */
  it('names a number where a macro wants a string', () => {
    const plan = planOf({
      macros: [{ shortCode: 'fd-w', name: 5, scope: 'workspace', body: 'hi' }],
    });
    expect(text(plan)).toContain('`name` is a number and the route requires a string');
    expect(text(plan)).toContain('Quote it.');
    expect(plan.refused).toEqual(['fd-w']);
  });

  it('names a number where a brand wants a string', () => {
    const plan = planOf({ brands: [{ slug: 'fd-b5', name: 5 }] });
    expect(text(plan)).toContain('`name` is a number');
    expect(plan.refused).toEqual(['fd-b5']);
  });

  it('names a string where a card wants an integer', () => {
    const plan = planOf({
      customerCards: [
        { key: 'fd-k2', title: 'K', ttlSeconds: 'sixty', url: 'https://example.com/c' },
      ],
    });
    expect(text(plan)).toContain('`ttlSeconds` is a string and the route requires an integer');
    expect(plan.refused).toEqual(['fd-k2']);
  });

  it('names a string where a trigger wants a boolean', () => {
    const plan = planOf({
      triggers: [
        {
          name: 'fd-t5',
          eventType: 'conversation.created',
          enabled: 'yes',
          conditions: [],
          actions: [{ type: 'send_message', params: {} }],
        },
      ],
    });
    expect(text(plan)).toContain('`enabled` is a string and the route requires a boolean');
    expect(plan.refused).toEqual(['fd-t5']);
  });

  it('names a number where a webhook wants an array', () => {
    const plan = planOf({ webhooks: [{ url: 'https://example.com/w5', eventTypes: 5 }] });
    expect(text(plan)).toContain('`eventTypes` is a number and the route requires an array');
    expect(plan.refused).toEqual(['https://example.com/w5']);
  });

  /* Their closing note: "A bad enum value such as scope: 'galaxy' also passes". */
  it('names a value outside a closed set, and offers the set', () => {
    const plan = planOf({
      macros: [{ shortCode: 'fd-e', name: 'E', scope: 'galaxy', body: 'hi' }],
    });
    expect(text(plan)).toContain('`scope` is `galaxy`, which is not one of');
    expect(text(plan)).toContain('`workspace`');
    expect(plan.refused).toEqual(['fd-e']);
  });

  /* The direction that matters more: a GOOD document must stay silent. */
  it('says nothing about correctly typed fields', () => {
    const plan = planOf({
      macros: [
        { shortCode: 'ok', name: 'A', scope: 'workspace', body: 'hi', tags: ['x'], teamId: null },
      ],
    });
    expect(plan.refused).toEqual([]);
    expect(text(plan)).not.toContain('requires');
  });

  /*
   * An integer is a number and a number is not an integer. `ttlSeconds` is
   * declared `integer`, so 1.5 is refused where 60 is not — string equality
   * on the type name would get one of these wrong.
   */
  it('accepts an integer where a number is declared, and refuses a fraction where an integer is', () => {
    const ok = planOf({
      customerCards: [{ key: 'a', title: 'K', ttlSeconds: 60, url: 'https://example.com/c' }],
    });
    expect(ok.refused).toEqual([]);
    const bad = planOf({
      customerCards: [{ key: 'b', title: 'K', ttlSeconds: 1.5, url: 'https://example.com/c' }],
    });
    expect(text(bad)).toContain('requires an integer');
  });

  /*
   * A nullable field takes an explicit null; a non-nullable one does not. Both
   * come from the same `types` entry, which is why the table stores
   * `'string|null'` rather than a separate flag.
   */
  it('lets a null through on a nullable field and names it on a required one', () => {
    const okNull = planOf({
      macros: [{ shortCode: 'n', name: 'N', scope: 'workspace', teamId: null }],
    });
    expect(text(okNull)).not.toContain('`teamId` is null');
    const badNull = planOf({ brands: [{ slug: 's', name: null }] });
    expect(text(badNull)).toContain('`name` is null and the route requires a string');
  });

  /*
   * A wrong type in a PATCH body is SENT and refused, unlike a missing
   * required field, which a partial body legitimately omits.
   */
  it('warns on an update too, where the required check does not', () => {
    const plan = planOf(
      { brands: [{ slug: 'fd-u', name: 5 }] },
      { brands: [{ id: 'b1', slug: 'fd-u', name: 'U' }] },
    );
    expect(plan.items[0]?.action).toBe('update');
    expect(text(plan)).toContain('`name` is a number');
    expect(plan.refused).toEqual(['fd-u']);
  });
});

describe('a route with more than one body shape', () => {
  /*
   * Their item 6. `POST /v1/bots` is a `z.union`, and a type is recorded only
   * where every arm agrees — a field one arm calls a string and another an
   * object would otherwise refuse a valid document.
   */
  it('keeps only the types every arm agrees on', () => {
    const rules = ROUTE_FIELD_RULES[routeKey('POST', '/v1/bots')];
    expect(rules?.types['name']).toBe('string');
    expect(rules?.enums['type']).toEqual(['external', 'chatly']);
    // Required is the INTERSECTION: `webhookUrl` belongs to one arm only.
    expect(rules?.required).toEqual(['name']);
  });

  it('still refuses a wrong type on a field the arms agree about', () => {
    const plan = planOf({ bots: [{ slug: 'fd-nt', name: 5 }] });
    expect(text(plan)).toContain('`name` is a number');
  });
});

describe('a required field a reference supplies', () => {
  /*
   * Their item 1, the P1. `botRoutes` declares
   * `references: { bot: { type: 'bots', wire: 'botId' } }`: the document says
   * `bot: '<slug>'` and the CLI resolves it to `botId` at send time. A valid
   * document warned that `botId` was required, exited 3 as REFUSED — and then
   * applied cleanly, so a pipeline gating on 3 stopped on a good file.
   */
  /*
   * The bot is in the DOCUMENT as well as live, which is what their repro
   * does — `known` is built from the document's own sections as the plan walks
   * them, so a reference to a type the file does not mention cannot resolve
   * and the row is BLOCKED instead.
   *
   * That is how the first version of this test passed while the fix was
   * reverted: a blocked row skips the required-field check, so the assertion
   * held for the wrong reason. The control is what found it.
   */
  const BOT = { slug: 'fd-bot', name: 'Bot', type: 'external', webhookUrl: 'https://e.com/b' };

  it('is not reported missing, and the row is not refused', () => {
    const plan = planOf(
      { bots: [BOT], botRoutes: [{ name: 'fd-r', bot: 'fd-bot' }] },
      { bots: [{ id: 'b1', slug: 'fd-bot', name: 'Bot' }], botRoutes: [] },
    );
    const route = plan.items.find((i) => i.type === 'botRoutes');
    expect(route?.action).toBe('create');
    expect(text(plan)).not.toContain('`botId`');
    expect(text(plan)).not.toContain('is required');
    expect(plan.refused).toEqual([]);
  });

  /*
   * And when it IS missing, the warning names the field an author can set.
   * Telling them to set `botId` was worse than the false alarm: that uuid is
   * exactly what the reference exists to keep out of the document.
   */
  it('names `bot`, never `botId`, when neither is given', () => {
    const plan = planOf(
      { bots: [BOT], botRoutes: [{ name: 'fd-r2' }] },
      { bots: [{ id: 'b1', slug: 'fd-bot', name: 'Bot' }], botRoutes: [] },
    );
    expect(text(plan)).toContain('`bot`');
    expect(text(plan)).not.toContain('`botId`');
    expect(plan.refused).toEqual(['fd-r2']);
  });
});

describe('an unknown field on a route that refuses one', () => {
  /*
   * Their item 3, second half. `POST /v1/customer-cards` is `.strict()` and
   * answers `Unrecognized key(s) in object: 'bogus'` with nothing written,
   * while the CLI called the field "silently DROPPED… the row will apply
   * without it". Both halves were wrong for that route and right for macros.
   *
   * The spec could not express this until 2026-11-06 — `additionalProperties`
   * was absent for strict and stripping routes alike.
   */
  it('is a refusal on a strict route, with exit 3', () => {
    const plan = planOf({
      customerCards: [
        { key: 'fd-k', title: 'K', ttlSeconds: 60, url: 'https://example.com/c', bogus: 'x' },
      ],
    });
    expect(text(plan)).toContain('`bogus`');
    expect(text(plan)).toContain('REFUSES');
    expect(plan.refused).toEqual(['fd-k']);
  });

  it('is advice on a route that drops it, and not a refusal', () => {
    const plan = planOf({
      macros: [{ shortCode: 'fd-x', name: 'X', scope: 'workspace', body: 'hi', content: 'hello' }],
    });
    expect(text(plan)).toContain('DROPS');
    expect(plan.refused).toEqual([]);
  });

  /*
   * The defect with production consequences: the row applied, the read-back
   * said it still differed, `apply` exited 1, and every later run wrote again.
   * A dropped field is never in the live row, so diffing it is `undefined`
   * against `'hello'` — a change no write can settle.
   */
  it('is left out of the diff, so a correct row settles', () => {
    const plan = planOf(
      { macros: [{ shortCode: 'fd-x', name: 'X', scope: 'workspace', body: 'hi', content: 'z' }] },
      {
        macros: [{ id: 'm1', shortCode: 'fd-x', name: 'X', scope: 'workspace', body: 'hi' }],
      },
    );
    expect(plan.items[0]?.action).toBe('noop');
    // Still told about it — the warning is the whole point.
    expect(text(plan)).toContain('`content`');
  });

  it('does not hide a REAL change on a row that also has a dropped field', () => {
    const plan = planOf(
      { macros: [{ shortCode: 'fd-y', name: 'Renamed', scope: 'workspace', content: 'z' }] },
      { macros: [{ id: 'm1', shortCode: 'fd-y', name: 'Old', scope: 'workspace', body: 'hi' }] },
    );
    expect(plan.items[0]?.action).toBe('update');
    expect(plan.items[0]?.changes.map((c) => c.name)).toEqual(['name']);
  });
});
