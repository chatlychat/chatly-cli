/**
 * CH-10 — `provider: forumulate` with no `token` in `chatly.yaml`.
 *
 * The customer's done-when says that document must APPLY. It cannot be
 * applied by a write: the credential comes from an approved handshake whose
 * first step mints an Atlas assertion out of a live browser session, and this
 * CLI holds an API key. So what `plan` and `apply` have to do is the honest
 * remainder — parse it, say a person has to approve it once, write nothing,
 * and converge to `noop` on the next run once they have.
 *
 * Every assertion is on what the CLI COMPUTED or WOULD SEND. The one that
 * matters is `writesFor` returning nothing: a canned 201 would agree with a
 * CLI that posted a tokenless body and reported a source that does not exist.
 */
import { describe, expect, it } from 'vitest';

import { doc, issues, live } from './__tests__/wac-fixtures.js';
import { writesFor } from './apply.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { planForJson, renderPlan } from './render.js';
import { resourceDef } from './resources.js';

const APPLY = { prune: false, pruneUnsafe: [], writeOnly: false };
const RENDER = { prune: false, pruneUnsafe: [] };

/** The row FormFlow wants to write: a provider, a space, and no secret. */
const TOKENLESS = {
  label: 'FormFlow help center',
  provider: 'forumulate',
  organizationId: 'org_formflow',
  spaceId: 'docs',
};

const planFor = (
  rows: ReadonlyArray<Record<string, unknown>>,
  liveRows: ReadonlyArray<Record<string, unknown>> = [],
) => buildPlan(parseDocument(doc({ docsSources: rows })), live({ docsSources: liveRows }));

describe('a tokenless Forumulate source', () => {
  it('parses — the shape the customer asked for is a legal document', () => {
    expect(issues(doc({ docsSources: [TOKENLESS] }))).toEqual([]);
  });

  it('plans as blocked, not as a create, and the reason names the approval', () => {
    const plan = planFor([TOKENLESS]);
    expect(plan.items.map((i) => i.action)).toEqual(['blocked']);
    const [item] = plan.items;
    expect(item?.reason).toContain('approved handshake');
    expect(item?.reason).toContain('Connect without pasting a secret');
    // The label is the natural key, so it is what makes the second run match.
    expect(item?.reason).toContain('FormFlow help center');
  });

  it('describes no field changes, so nobody reads it as a diff to approve', () => {
    const [item] = planFor([TOKENLESS]).items;
    expect(item?.changes).toEqual([]);
    expect(renderPlan(planFor([TOKENLESS]), RENDER)).toContain('CANNOT APPLY');
  });

  it('is counted as blocked and NOT as refused — two different questions', () => {
    const json = planForJson(planFor([TOKENLESS])) as {
      blocked: string[];
      refused: string[];
      unhealthy: string[];
    };
    expect(json.blocked).toEqual(['FormFlow help center']);
    expect(json.refused).toEqual([]);
    expect(json.unhealthy).toEqual([]);
  });

  it('APPLY SENDS NOTHING — never a body the route answers 400 to', () => {
    const def = resourceDef('docsSources');
    const [item] = planFor([TOKENLESS]).items;
    if (def === undefined || item === undefined) {
      throw new Error('fixture');
    }
    expect(writesFor(def, item, new Map(), APPLY)).toEqual([]);
  });
});

describe('the rule fires on exactly one shape', () => {
  it('leaves a Forumulate row that DOES carry a token alone', () => {
    const plan = planFor([{ ...TOKENLESS, token: 'forumulate_live_int_' + 'x'.repeat(36) }]);
    expect(plan.items.map((i) => i.action)).toEqual(['create']);
  });

  it('leaves every other provider alone, token or not', () => {
    const plan = planFor([
      { label: 'site', provider: 'website', baseUrl: 'https://formflow.dev/docs' },
    ]);
    expect(plan.items.map((i) => i.action)).toEqual(['create']);
  });

  it('converges: once the approval has happened the same document is unchanged', () => {
    const plan = planFor(
      [TOKENLESS],
      [
        {
          id: '0192f000-0000-7000-8000-0000000000aa',
          label: 'FormFlow help center',
          provider: 'forumulate',
          organizationId: 'org_formflow',
          spaceId: 'docs',
          status: 'active',
          syncStatus: 'synced',
          lastError: null,
          lastSyncedAt: '2026-11-14T06:00:00.000Z',
        },
      ],
    );
    expect(plan.items.map((i) => i.action)).toEqual(['noop']);
    expect(plan.items[0]?.changes).toEqual([]);
  });
});
