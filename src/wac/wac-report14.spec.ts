/**
 * ForgeDeck's FOURTEENTH report, 2026-11-07 — the CLI half (their item 4).
 *
 * Both halves are my own report-13 fix being wrong at its edges rather than a
 * new surface, and both are the same mistake: a rule that knew the row was an
 * UPDATE was applied to creates as well.
 *
 * The first is advice that breaks the document it is given to. `preset` and
 * `url` ARE required by the preset arm of `POST /v1/ai/tools`, so telling the
 * author of a NEW row that they never take effect and to remove them leaves an
 * invalid custom tool with no `urlTemplate` and no `parameters`. Advice that
 * is wrong is worse than silence, because somebody follows it.
 *
 * The second is a silence that should have been a sentence. Excluding `url`
 * from the comparison is right — it reads back as `urlTemplate` — but the
 * consequence is that changing it on an installed preset gives `unchanged`
 * and `plan=0` while the old endpoint goes on being called. "It settles" and
 * "it did what you asked" are different claims, and only the first was true.
 */
import { describe, expect, it } from 'vitest';

import { doc, live } from './__tests__/wac-fixtures.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';

type Rows = Record<string, Array<Record<string, unknown>>>;
const planOf = (resources: Rows, liveRows: Rows = {}) =>
  buildPlan(parseDocument(doc(resources)), live(liveRows));
const text = (p: ReturnType<typeof buildPlan>) => p.warnings.join('\n');

const LIVE_TOOL = {
  id: '0193f000-0000-7000-8000-00000000f001',
  name: 'order_lookup',
  description: 'Look up an order',
  urlTemplate: 'https://shop.example.com/orders',
  method: 'POST',
  enabled: true,
  parameters: [],
  requiresApproval: 'none',
  secretHeaderNames: [],
  signingSecretSet: true,
};

const PRESET_ROW = {
  name: 'order_lookup',
  preset: 'order_lookup',
  url: 'https://shop.example.com/orders',
};

describe('a preset row being created is not told to remove what it needs', () => {
  it('says nothing about `preset` or `url` on a create', () => {
    /*
     * Their repro: a NEW row got `` `preset` is an install INSTRUCTION…
     * Remove it from the document. `` Both fields are required by the arm
     * that installs the preset. Control: drop the `live === undefined` test
     * in `AI_TOOL_DISCARDS` and this fails while the update test below still
     * passes — which is exactly how it shipped.
     */
    const p = planOf({ aiTools: [PRESET_ROW] });
    expect(p.items.find((i) => i.key === 'order_lookup')?.action).toBe('create');
    expect(text(p)).not.toContain('install INSTRUCTION');
    expect(text(p)).not.toContain('`url` is that install');
  });

  it('says nothing on a create even when the preset id is bogus', () => {
    // They saw the advice printed for `preset: "nope"` too. The enum check
    // owns that row; a second line about removing the field is noise on top
    // of the one message that names the real problem.
    const p = planOf({ aiTools: [{ ...PRESET_ROW, preset: 'nope' }] });
    expect(text(p)).not.toContain('install INSTRUCTION');
    expect(text(p)).toContain('`preset` to be one of');
  });

  it('still warns on an UPDATE, which is where the field really is discarded', () => {
    const p = planOf({ aiTools: [PRESET_ROW] }, { aiTools: [LIVE_TOOL] });
    expect(text(p)).toContain('install INSTRUCTION');
    expect(p.refused).toEqual([]);
  });

  it('no longer tells anyone to remove a field the create requires', () => {
    // The generic suffix used to end `Remove it from the document.` for every
    // discarded field on every resource. What to do depends on the field, so
    // each `why` says it now.
    const p = planOf({ aiTools: [PRESET_ROW] }, { aiTools: [LIVE_TOOL] });
    expect(text(p)).not.toContain('Remove it from the document');
    expect(text(p)).toContain('Leave it in the document');
  });
});

describe('a `url` change on an installed preset says what happens to it', () => {
  it('warns that the change is not applied, and names the field that is', () => {
    /*
     * `plan` said `= unchanged` with `plan=0` and the new endpoint was never
     * applied, with nothing saying so. Excluding `url` is still right — it
     * reads back as `urlTemplate` — but the silence was not.
     */
    const p = planOf(
      { aiTools: [{ ...PRESET_ROW, url: 'https://example.com/t-changed' }] },
      { aiTools: [LIVE_TOOL] },
    );
    expect(p.items.find((i) => i.key === 'order_lookup')?.action).toBe('noop');
    expect(text(p)).toContain('is NOT applied to a tool that already exists');
    expect(text(p)).toContain('set `urlTemplate` instead');
  });

  it('applies a `urlTemplate` change, which is the route that works', () => {
    // The advice has to be true. `urlTemplate` is in the PATCH body (the
    // create schema `.partial()`), so this is a real update, not a second
    // dead end — the mistake report 13 made with `Quote it.`
    const p = planOf(
      { aiTools: [{ name: 'order_lookup', urlTemplate: 'https://example.com/t-changed' }] },
      { aiTools: [LIVE_TOOL] },
    );
    const item = p.items.find((i) => i.key === 'order_lookup');
    expect(item?.action).toBe('update');
    expect(item?.changes.map((c) => c.name)).toContain('urlTemplate');
  });
});

describe('a Chatly bot still warns on its create, because there it IS discarded', () => {
  it('warns on a create', () => {
    /*
     * The asymmetry with `aiTools` above is the point, and it is why the test
     * lives in the hook rather than in a shared action argument. The chatly
     * arm of `POST /v1/bots` really does accept `webhookUrl` and throw it
     * away, so a create is exactly when the author needs telling. ForgeDeck
     * listed this one under "works, no action needed", so it is pinned.
     */
    const p = planOf({
      bots: [
        {
          slug: 'fd-cw',
          name: 'CW',
          type: 'chatly',
          systemPrompt: 'You are a helpful assistant for this shop.',
          webhookUrl: 'https://example.com/hook',
          timeoutSeconds: 15,
          fallbackMessage: 'sorry',
        },
      ],
    });
    expect(p.items.find((i) => i.key === 'fd-cw')?.action).toBe('create');
    for (const field of ['webhookUrl', 'timeoutSeconds', 'fallbackMessage']) {
      expect(text(p)).toContain(`\`${field}\` is an EXTERNAL agent's delivery config`);
    }
    expect(text(p)).toContain('create the bot with `type: "external"`');
  });
});

/*
 * Their follow-up to item 1, after the server half shipped as a clean 400:
 * "plan still doesn't warn before a macro is moved to team scope with no
 * teamId; the error only appears at apply. The CLI already reads the live
 * macro, which reads back with no team, so it could catch this."
 *
 * Right, and my report-13 note arguing the rule was create-only was reasoning
 * from the wrong file. The PATCH schema carries no refine — but
 * `macros.service.ts` enforces the pair against the row it reads back, so the
 * refusal is real on an update and `plan` has both sides already.
 */
const liveMacro = (over: Record<string, unknown> = {}) => ({
  id: '0193f000-0000-7000-8000-00000000c001',
  shortCode: 'fd-team',
  name: 'T',
  scope: 'workspace',
  body: 'hi',
  // `nullable()` on the response schema, so a macro with no team reads back as
  // `null` rather than omitting the key — the shape that made report 13's bot
  // rule read every Chatly bot as external when the fixture omitted it.
  teamId: null,
  language: 'en',
  tags: [],
  actions: [],
  ...over,
});

describe('moving a macro to team scope with no team is caught by `plan`', () => {
  it('warns and refuses before `apply` reaches the 400', () => {
    const p = planOf(
      { macros: [{ shortCode: 'fd-team', name: 'T', scope: 'team', body: 'hi' }] },
      { macros: [liveMacro()] },
    );
    expect(p.items.find((i) => i.key === 'fd-team')?.action).toBe('update');
    expect(text(p)).toContain('neither this row nor the macro on the server has one');
    expect(p.refused).toContain('fd-team');
  });

  it('warns when the row CLEARS the team of a macro that is already team-scoped', () => {
    /*
     * The second door into the same refusal, and the one ForgeDeck could only
     * infer: `teamId: null` with NO `scope`, which the service writes straight
     * through. One guard covers both there; one rule covers both here.
     *
     * `scope` is deliberately absent. Writing `scope: "team"` beside the null
     * makes this LEGITIMATE — the service reads `body.teamId ?? stored.teamId`
     * on that arm, so the team is re-pinned rather than cleared — and the
     * first draft of this test asserted a warning for it and failed. The rule
     * was right; the test was describing a refusal that does not happen.
     */
    const p = planOf(
      { macros: [{ shortCode: 'fd-team', name: 'T', body: 'hi', teamId: null }] },
      { macros: [liveMacro({ scope: 'team', teamId: '0193f000-0000-7000-8000-00000000e001' })] },
    );
    expect(text(p)).toContain('this row clears it');
    expect(p.refused).toContain('fd-team');
  });

  it('stays silent when `scope: "team"` re-pins a team the macro already has', () => {
    /*
     * The case that made the rule look create-only, and the one a generalised
     * rule can get wrong: the service writes `body.teamId ?? stored.teamId`,
     * so this is legitimate and a refusal here is the false-refusal shape that
     * cost ForgeDeck's eighth report a run. Control: drop `?? stored?.teamId`
     * and this fails while the two above still pass.
     */
    const p = planOf(
      { macros: [{ shortCode: 'fd-team', name: 'T', scope: 'team', body: 'bye' }] },
      { macros: [liveMacro({ scope: 'team', teamId: '0193f000-0000-7000-8000-00000000e001' })] },
    );
    expect(text(p)).not.toContain('needs a `teamId`');
    expect(p.refused).toEqual([]);
  });

  it('stays silent on a workspace macro whose stored team is null', () => {
    // `scope` is read from the live row when the document omits it, so the
    // rule must not fire on every macro that simply has no team.
    const p = planOf(
      { macros: [{ shortCode: 'fd-team', name: 'T2', body: 'hi' }] },
      { macros: [liveMacro()] },
    );
    expect(p.items.find((i) => i.key === 'fd-team')?.action).toBe('update');
    expect(text(p)).not.toContain('needs a `teamId`');
  });
});
