/**
 * ForgeDeck's ELEVENTH report, 2026-11-07. Every row here is one of their repros.
 *
 * One theme: the field rules read ACROSS the arms of a union body, and both
 * readings lose the fact the server enforces — a body has to satisfy one WHOLE
 * arm.
 *
 *  - `required` is the intersection, so `POST /v1/bots` reduced to
 *    `['name']` and a row with only a name looked complete.
 *  - `types` is recorded only where every arm agrees, so
 *    `POST /v1/ai/tools`' `parameters` (an array in one arm, undeclared in the
 *    other) had no type at all and an object passed.
 *
 * The second one matters because that route has NO discriminator, so the
 * report's own suggested fix — pick the arm from `type` — would have closed
 * `bots` and left `aiTools` exactly as it was.
 */
import { describe, expect, it } from 'vitest';

import { doc, live } from './__tests__/wac-fixtures.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { ROUTE_FIELD_RULES } from './field-rules.generated.js';

type Rows = Record<string, Array<Record<string, unknown>>>;
const planOf = (resources: Rows, liveRows: Rows = {}) =>
  buildPlan(parseDocument(doc(resources)), live(liveRows));
const text = (p: ReturnType<typeof buildPlan>) => p.warnings.join('\n');

describe('the generated table records each arm (their item 1, source half)', () => {
  it('carries both bot shapes with their OWN required fields', () => {
    const rules = ROUTE_FIELD_RULES['POST /v1/bots'];
    expect(rules?.arms).toHaveLength(2);
    // The premise of the whole item: the intersection hides both real shapes.
    expect(rules?.required).toEqual(['name']);
    expect(rules?.arms.map((a) => [...a.required].sort())).toEqual([
      ['name', 'type', 'webhookUrl'],
      ['name', 'systemPrompt'].sort(),
    ]);
  });

  it('carries the aiTools shapes, including the type the intersection drops', () => {
    const rules = ROUTE_FIELD_RULES['POST /v1/ai/tools'];
    expect(rules?.arms).toHaveLength(2);
    // `parameters` is an array in one arm and undeclared in the other, so the
    // merged table has no type for it. That is the aiTools defect.
    expect(rules?.types['parameters']).toBeUndefined();
    expect(rules?.arms.some((a) => a.types['parameters'] === 'array')).toBe(true);
  });

  it('leaves `arms` empty for an ordinary body, so the check never runs there', () => {
    expect(ROUTE_FIELD_RULES['POST /v1/macros']?.arms).toEqual([]);
    expect(ROUTE_FIELD_RULES['POST /v1/webhooks']?.arms).toEqual([]);
  });
});

describe('a bots row matching neither shape (their item 1)', () => {
  it('names the discriminator when the row pins no shape', () => {
    const plan = planOf({ bots: [{ slug: 'fd-nt', name: 'NT' }] });
    expect(text(plan)).toContain('accepts 2 shapes and the row matches none of them');
    // Their Verify asks for `type`, `webhookUrl` or `systemPrompt` to be named.
    expect(text(plan)).toContain('`type`');
    expect(text(plan)).toContain('`webhookUrl`');
    expect(text(plan)).toContain('`systemPrompt`');
    expect(plan.refused).toEqual(['fd-nt']);
  });

  it('names only the external shape when `type` pins it', () => {
    const plan = planOf({ bots: [{ slug: 'fd-nw', name: 'NW', type: 'external' }] });
    expect(text(plan)).toContain('`webhookUrl`');
    // The other arm is ruled out by the author's own value, so naming its
    // field would be telling them to satisfy a shape they did not choose.
    expect(text(plan)).not.toContain('`systemPrompt`');
    expect(text(plan)).not.toContain('2 shapes');
    expect(plan.refused).toEqual(['fd-nw']);
  });

  it('names only the chatly shape when `type` pins that one', () => {
    const plan = planOf({ bots: [{ slug: 'fd-nc', name: 'NC', type: 'chatly' }] });
    expect(text(plan)).toContain('`systemPrompt`');
    expect(text(plan)).not.toContain('`webhookUrl`');
    expect(plan.refused).toEqual(['fd-nc']);
  });

  it('leaves a GOOD external bot alone', () => {
    const plan = planOf({
      bots: [
        { slug: 'fd-ok-x', name: 'OK', type: 'external', webhookUrl: 'https://example.com/b' },
      ],
    });
    expect(text(plan)).not.toContain('shapes');
    expect(plan.refused).toEqual([]);
    expect(plan.items.map((i) => i.action)).toEqual(['create']);
  });

  it('leaves a GOOD chatly bot alone, which sets no `type` at all', () => {
    /*
     * The prompt is 20+ characters and the tool below is named `fd_ok_t`
     * deliberately. Both fixtures read `be kind` and `fd-ok-t` until the
     * string-constraint check landed (ForgeDeck item 3) and reported them —
     * correctly: that bot and that tool would both have been refused on
     * apply, so neither was ever the GOOD row this test claims to pin.
     */
    const plan = planOf({
      bots: [{ slug: 'fd-ok-c', name: 'OK', systemPrompt: 'Be kind to the visitor.' }],
    });
    expect(text(plan)).not.toContain('shapes');
    expect(text(plan)).not.toContain('systemPrompt');
    expect(plan.refused).toEqual([]);
    expect(plan.items.map((i) => i.action)).toEqual(['create']);
  });
});

describe('an aiTools row matching neither shape (their item 1, no discriminator)', () => {
  it('catches the per-arm TYPE error the merged table cannot see', () => {
    const plan = planOf({
      aiTools: [
        {
          // `fd_t`, not `fd-t`: a hyphen breaks the arm's own `name` pattern,
          // and this test is about `parameters`.
          name: 'fd_t',
          description: 'd',
          method: 'GET',
          urlTemplate: 'https://example.com/t',
          // An object where the arm declares an array. Their repro's third
          // complaint on apply: `parameters: Expected array, received object`.
          parameters: { q: 'x' },
        },
      ],
    });
    expect(text(plan)).toContain('accepts 2 shapes and the row matches none of them');
    expect(text(plan)).toContain('`parameters` to be an array');
    // The other arm's own missing fields, which apply also named.
    expect(text(plan)).toContain('`preset`');
    expect(text(plan)).toContain('`url`');
    expect(plan.refused).toEqual(['fd_t']);
  });

  it('leaves a GOOD custom tool alone', () => {
    const plan = planOf({
      aiTools: [
        {
          name: 'fd_ok_t',
          description: 'd',
          method: 'GET',
          urlTemplate: 'https://example.com/t',
          parameters: [{ name: 'q', type: 'string', required: true }],
        },
      ],
    });
    expect(text(plan)).not.toContain('shapes');
    expect(plan.refused).toEqual([]);
  });
});

describe('the union check does not double-report', () => {
  it('stays quiet when a per-field check already named the row', () => {
    // `type: 'galaxy'` contradicts BOTH arms, so the union check would fire —
    // but the enum check explains it better, and two messages for one defect
    // is the complaint this tracker has closed twice.
    const plan = planOf({ bots: [{ slug: 'fd-bad-t', name: 'B', type: 'galaxy' }] });
    expect(text(plan)).toContain('which is not one of');
    expect(text(plan)).not.toContain('shapes');
    expect(plan.refused).toEqual(['fd-bad-t']);
  });

  it('says nothing on an UPDATE, whose body is partial', () => {
    // A stored external bot renamed. `webhookUrl` is absent from the body
    // because it is unchanged, which is not a missing required field.
    const plan = planOf(
      { bots: [{ slug: 'fd-up', name: 'Renamed' }] },
      {
        bots: [
          { slug: 'fd-up', name: 'Old', type: 'external', webhookUrl: 'https://example.com/b' },
        ],
      },
    );
    expect(text(plan)).not.toContain('shapes');
    expect(plan.refused).toEqual([]);
  });
});

describe('`Quote it.` on a field with a closed set of values (their item 2)', () => {
  it('names the allowed values instead of advising a quote that is also refused', () => {
    const plan = planOf({ macros: [{ shortCode: 'fd-q', name: 'Q', scope: 5, body: 'hi' }] });
    expect(text(plan)).toContain('`scope` is a number and the route requires a string');
    expect(text(plan)).toContain('It must be one of `workspace`, `team`, `personal`.');
    // The whole point: the old advice produced a second document that failed
    // for a different reason.
    expect(text(plan)).not.toContain('Quote it.');
    expect(plan.refused).toEqual(['fd-q']);
  });

  it('still advises quoting where quoting IS the fix', () => {
    // `name` takes any string, so a number there is a punctuation mistake.
    const plan = planOf({ macros: [{ shortCode: 'fd-n', name: 5, body: 'hi' }] });
    expect(text(plan)).toContain('Quote it.');
    expect(text(plan)).not.toContain('It must be one of');
    expect(plan.refused).toEqual(['fd-n']);
  });

  it('still refuses the quoted form, naming the values (their expected second plan)', () => {
    const plan = planOf({ macros: [{ shortCode: 'fd-q2', name: 'Q', scope: '5', body: 'hi' }] });
    expect(text(plan)).toContain('`scope` is `5`, which is not one of');
    expect(plan.refused).toEqual(['fd-q2']);
  });
});

describe('the single bad array item reads as English (their item 3)', () => {
  it('says "is not one of the values"', () => {
    const plan = planOf({
      webhooks: [{ url: 'https://example.com/w6', eventTypes: ['conversation.nope'] }],
    });
    expect(text(plan)).toContain('is not one of the values this route accepts');
    expect(text(plan)).not.toContain('is not one the values');
  });

  it('keeps the plural form, which was already right', () => {
    const plan = planOf({
      webhooks: [{ url: 'https://example.com/w9', eventTypes: ['conversation.nope', 'bogus.x'] }],
    });
    expect(text(plan)).toContain('are not among the values this route accepts');
  });
});
