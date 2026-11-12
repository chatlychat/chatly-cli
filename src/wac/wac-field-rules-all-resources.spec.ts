/**
 * `plan` answering for EVERY resource what the route will refuse, not just
 * `privacyPartners`.
 *
 * ForgeDeck's eighth report, 2026-11-06 item 3, reproduced twice: a macro
 * with no `scope` planned as a clean `create`, printed `0 that cannot be
 * applied` and exited 2, and `apply` answered `POST /v1/macros — Invalid
 * request body (scope: Required)`. One resource of twelve declared
 * `requiredFields`. Their second document showed the other half: `content`
 * where the field is `body`, which a non-strict zod object STRIPS, so the
 * write succeeded having silently dropped what the author asked for.
 *
 * The lists are not hand-written — `field-rules.generated.ts` is derived from
 * the served OpenAPI document by `scripts/gen-wac-field-rules.mjs`. A wrong
 * list warns about documents the server accepts, which this repo's own note
 * calls worse than silence.
 */
import { describe, expect, it } from 'vitest';

import { doc, live } from './__tests__/wac-fixtures.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { ROUTE_FIELD_RULES, routeKey } from './field-rules.generated.js';
import { planFooter, renderPlan } from './render.js';

const RENDER = { prune: false, pruneUnsafe: [] };

type Rows = Record<string, Array<Record<string, unknown>>>;

const planOf = (resources: Rows, liveRows: Rows = {}) =>
  buildPlan(parseDocument(doc(resources)), live(liveRows));

describe('a required field the route declares, on any resource', () => {
  /* Their first repro, verbatim. */
  it('warns that a macro has no `scope`, and counts it refused', () => {
    const plan = planOf({ macros: [{ shortCode: 'fd-b', name: 'B', body: 'hello' }] });
    expect(plan.warnings.join('\n')).toContain('`scope`');
    expect(plan.warnings.join('\n')).toContain('required');
    expect(plan.refused).toEqual(['fd-b']);
  });

  it('is silent once the macro carries it', () => {
    const plan = planOf({
      macros: [{ shortCode: 'fd-c', name: 'C', body: 'hi', scope: 'workspace' }],
    });
    expect(plan.refused).toEqual([]);
    expect(plan.warnings.join('\n')).not.toContain('required');
  });

  /*
   * A PATCH body is partial: a field absent from it means "leave as stored",
   * so an UPDATE must never be warned about. This is what the rule's own
   * docblock had always promised while taking no action argument at all —
   * harmless only because the one resource with a list requires its field on
   * every write.
   */
  it('does not warn on a row it would update', () => {
    const plan = planOf(
      { macros: [{ shortCode: 'fd-d', name: 'Renamed' }] },
      { macros: [{ id: 'm1', shortCode: 'fd-d', name: 'D', scope: 'workspace', body: 'x' }] },
    );
    expect(plan.items[0]?.action).toBe('update');
    expect(plan.warnings.join('\n')).not.toContain('required');
    expect(plan.refused).toEqual([]);
  });
});

describe('a field name the route does not have', () => {
  /* Their second repro: `content` where the field is `body`. */
  it('names `content` as not a field, and says it is dropped rather than refused', () => {
    const plan = planOf({
      macros: [{ shortCode: 'fd-e', name: 'E', content: 'hello', scope: 'workspace' }],
    });
    const text = plan.warnings.join('\n');
    expect(text).toContain('`content`');
    expect(text).toContain('not a field');
    // Says BOTH halves now: the field never takes effect, and a rerun settles.
    expect(text).toContain('DROPS');
    expect(text).toContain('a rerun settles');
    // And it points at fields that exist rather than a command that does not.
    expect(text).toContain('body');
    expect(text).not.toContain('chatly docs');
  });

  /*
   * NOT counted as refused: the server accepts the write and strips the key,
   * so `apply` exits 0. Calling it a refusal would be the sixth report's
   * defect again, from the other direction.
   */
  it('does not count a dropped field as a refusal', () => {
    const plan = planOf({
      macros: [{ shortCode: 'fd-f', name: 'F', content: 'x', scope: 'workspace' }],
    });
    expect(plan.refused).toEqual([]);
  });

  it('says nothing about a field the route does declare', () => {
    const plan = planOf({
      macros: [{ shortCode: 'fd-g', name: 'G', body: 'x', scope: 'workspace', tags: ['a'] }],
    });
    expect(plan.warnings.join('\n')).not.toContain('not a field');
  });
});

describe('the generated table', () => {
  /*
   * The one hand-written list in the repo, independently reproduced by the
   * generator. If these ever disagree, the spec moved and the hand-written
   * list is the stale one.
   */
  it('agrees with the hand-written privacyPartners list', () => {
    const rules = ROUTE_FIELD_RULES[routeKey('PUT', '/v1/privacy/partners/{id}')];
    expect(rules?.required).toEqual(['cbid']);
  });

  it('requires nothing on a PATCH, for every resource', () => {
    const patches = Object.keys(ROUTE_FIELD_RULES).filter((k) => k.startsWith('PATCH '));
    expect(patches.length).toBeGreaterThan(5);
    for (const key of patches) {
      // `webhooks/{}/schema-version` is a one-field route whose field IS the
      // whole request, so it is the single legitimate exception.
      if (key.includes('schema-version')) {
        continue;
      }
      expect(ROUTE_FIELD_RULES[key]?.required, key).toEqual([]);
    }
  });
});

describe('the `Run chatly apply` count', () => {
  /*
   * ForgeDeck's eighth report item 2, reproduced twice: a mixed document
   * printed `Run chatly apply to make 2 change(s).` directly above `1
   * document(s) will be REFUSED`, so the one number a reader acts on
   * contradicted the line beneath it.
   */
  it('counts only what the server would accept', () => {
    const plan = planOf({
      privacyPartners: [{ provider: 'cookiemunch', cbid: 5 }],
      macros: [{ shortCode: 'fd-a', name: 'A', body: 'hello', scope: 'workspace' }],
    });
    expect(plan.refused).toEqual(['cookiemunch']);
    const footer = planFooter(plan, RENDER);
    expect(footer).toContain('to make 1 change(s)');
    expect(footer).not.toContain('to make 2 change(s)');
    // The summary still reports the whole plan, including what is refused.
    expect(renderPlan(plan, RENDER)).toContain('2 to create');
    expect(renderPlan(plan, RENDER)).toContain('1 that cannot be applied');
  });

  it('is unchanged when nothing is refused', () => {
    const plan = planOf({
      macros: [
        { shortCode: 'fd-h', name: 'H', body: 'x', scope: 'workspace' },
        { shortCode: 'fd-i', name: 'I', body: 'y', scope: 'workspace' },
      ],
    });
    expect(plan.refused).toEqual([]);
    expect(planFooter(plan, RENDER)).toContain('to make 2 change(s)');
  });
});
