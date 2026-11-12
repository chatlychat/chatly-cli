/**
 * ForgeDeck's TENTH report, 2026-11-06. Every row here is one of their repros.
 *
 * Two themes, and both are about a check that was RIGHT in the common case
 * and had never been asked the next question along:
 *
 *  - The enum check compared a field's own value, so a bad value inside an
 *    ARRAY was invisible — and `eventTypes` is the likeliest field in a
 *    webhook document to carry a typo.
 *  - `Quote it.` was appended by looking for `a number` in the SENTENCE, and
 *    that sentence names both the type the document has and the type the
 *    route wants. So it fired on three documents where quoting is the bug
 *    rather than the fix.
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

describe('a bad value INSIDE an array (their item 1)', () => {
  it('names the item, its index and the accepted values, and refuses the row', () => {
    const plan = planOf({
      webhooks: [{ url: 'https://example.com/w6', eventTypes: ['conversation.nope'] }],
    });
    expect(text(plan)).toContain('`eventTypes` [0] = `conversation.nope`');
    expect(text(plan)).toContain('conversation.created');
    expect(text(plan)).toContain('so the write will be refused');
    expect(plan.refused).toEqual(['https://example.com/w6']);
  });

  it('leaves a GOOD event list alone', () => {
    const plan = planOf({
      webhooks: [{ url: 'https://example.com/w7', eventTypes: ['conversation.created'] }],
    });
    expect(text(plan)).not.toContain('eventTypes');
    expect(plan.refused).toEqual([]);
    expect(plan.items.some((i) => i.action === 'create')).toBe(true);
  });

  it('names EVERY bad item, not just the first', () => {
    const plan = planOf({
      webhooks: [
        {
          url: 'https://example.com/w8',
          eventTypes: ['conversation.created', 'nope.one', 'nope.two'],
        },
      ],
    });
    expect(text(plan)).toContain('[1] = `nope.one`');
    expect(text(plan)).toContain('[2] = `nope.two`');
  });

  it('catches a non-string item, which the server also refuses', () => {
    const plan = planOf({
      webhooks: [{ url: 'https://example.com/w9', eventTypes: [5] }],
    });
    expect(text(plan)).toContain('[0] = `5`');
    expect(plan.refused).toEqual(['https://example.com/w9']);
  });

  it('does NOT advise quoting an array item — the value is wrong, not its punctuation', () => {
    const plan = planOf({
      webhooks: [{ url: 'https://example.com/w10', eventTypes: ['conversation.nope'] }],
    });
    expect(text(plan)).not.toContain('Quote it.');
  });

  /*
   * The table is what the check reads, so an empty `itemEnums` would make
   * every assertion above pass for the wrong reason — the plan would simply
   * warn about nothing and `refused` would be empty, which is the state these
   * tests exist to distinguish from. Asserted on the DATA as well.
   */
  it('has the item enum in the generated table at all', () => {
    const rules = ROUTE_FIELD_RULES['POST /v1/webhooks'];
    expect(rules?.itemEnums['eventTypes']).toContain('conversation.created');
    expect(rules?.itemEnums['eventTypes']).not.toContain('conversation.nope');
    // And `enums` does NOT carry it, which is why a second map was needed.
    expect(rules?.enums['eventTypes']).toBeUndefined();
  });
});

describe('`Quote it.` only where quoting is the fix (their item 2)', () => {
  it('does not say it when the route wants a BOOLEAN and the value is quoted', () => {
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
    expect(text(plan)).not.toContain('Quote it.');
    expect(plan.refused).toEqual(['fd-t5']);
  });

  it('does not say it for a fraction where an integer belongs, and says what to do', () => {
    const plan = planOf({
      customerCards: [{ key: 'fd-k3', title: 'K', ttlSeconds: 1.5, url: 'https://example.com/c' }],
    });
    expect(text(plan)).toContain('the route requires an integer');
    expect(text(plan)).not.toContain('Quote it.');
    expect(text(plan)).toContain('Round it to a whole number');
  });

  it('does not say it when the route wants an ARRAY', () => {
    const plan = planOf({ webhooks: [{ url: 'https://example.com/w5', eventTypes: 5 }] });
    expect(text(plan)).toContain('`eventTypes` is a number and the route requires an array');
    expect(text(plan)).not.toContain('Quote it.');
  });

  it('STILL says it where quoting is genuinely the fix', () => {
    const plan = planOf({ brands: [{ slug: 'fd-b9', name: 5 }] });
    expect(text(plan)).toContain('`name` is a number and the route requires a string');
    expect(text(plan)).toContain('Quote it.');
  });

  it('says it for a boolean where a string belongs, too', () => {
    const plan = planOf({ brands: [{ slug: 'fd-b10', name: true }] });
    expect(text(plan)).toContain('Quote it.');
  });

  it('does not advise rounding a whole number that is merely the wrong type', () => {
    const plan = planOf({ brands: [{ slug: 'fd-b11', name: 5 }] });
    expect(text(plan)).not.toContain('Round it');
  });
});

describe('one warning per privacy mistake (their item 3)', () => {
  const count = (p: ReturnType<typeof buildPlan>, needle: string) =>
    p.warnings.filter((w) => w.includes(needle)).length;

  it('prints a wrong-type line ONCE on a row that will be sent', () => {
    const plan = planOf({
      privacyPartners: [{ provider: 'cookiemunch', cbid: 5 }],
      macros: [{ shortCode: 'fd-mx', name: 'A', scope: 'workspace', body: 'hi' }],
    });
    expect(count(plan, '`cbid` is a number')).toBe(1);
  });

  it('keeps the SENT-aware wording, which is why the privacy copy is the one kept', () => {
    const plan = planOf(
      {
        privacyPartners: [
          {
            provider: 'cookiemunch',
            cbid: 'z',
            completionsUrl: 'https://api.example.com/x',
            completionSecret: 5,
          },
        ],
      },
      {
        privacyPartners: [
          {
            provider: 'cookiemunch',
            // `existsWhen` is `enabled === true`: the list route enumerates
            // the whole registry, so without it an opted-out provider reads
            // as a row that exists.
            enabled: true,
            cbid: 'z',
            completionsUrl: 'https://api.example.com/x',
            completionSecretSet: true,
          },
        ],
      },
    );
    /*
     * An unchanged row sends nothing, so a refusal is the wrong claim — this
     * is the wording the generic table check cannot produce, and the reason
     * `ownTypeChecks` keeps the resource's copy rather than dropping it.
     */
    expect(count(plan, '`completionSecret`')).toBe(1);
    expect(text(plan)).toContain('it is not sent on this run');
    // The premise: an UNCHANGED row. Asserted, because with the live row not
    // matching this plans as a create and the refusal wording is then right,
    // which is how this test first passed for the wrong reason.
    expect(plan.items.map((i) => i.action)).toEqual(['noop']);
  });

  it('still warns about a privacy field at all — the skip is not a silencer', () => {
    const plan = planOf({
      privacyPartners: [{ provider: 'cookiemunch', cbid: 5 }],
    });
    expect(text(plan)).toContain('`cbid`');
  });

  it('does not suppress a NON-privacy resource sharing the field name', () => {
    const plan = planOf({ brands: [{ slug: 'fd-b12', name: 5 }] });
    expect(count(plan, '`name` is a number')).toBe(1);
  });
});
