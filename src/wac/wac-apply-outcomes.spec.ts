/**
 * What `renderOutcomes` prints after `apply`, and what it must NOT reprint.
 *
 * `apply` writes the whole plan before it writes a single row, so anything
 * `renderPlan` already said is on screen directly above this block. A blocked
 * row's `detail` IS its plan reason, so printing it here put the same
 * sentence up twice — ForgeDeck's TENTH report item 4, reproduced twice, and
 * noted once in their ninth.
 *
 * The distinction the tests below pin: a row skipped because a DEPENDENCY
 * failed carries detail no plan could have known, and that one still prints.
 */
import { describe, expect, it } from 'vitest';

import { renderOutcomes, type ApplyOutcome } from './apply.js';

const base = {
  type: 'webhooks',
  key: 'https://example.com/w2',
  secrets: [] as never[],
};
const FROZEN =
  '`eventTypes` changed, and a webhook endpoint is frozen at create; delete it and declare ' +
  'a new one.';

describe('a blocked row in the outcomes block', () => {
  it('names the row but does NOT reprint the reason the plan already gave', () => {
    const out = renderOutcomes([
      { ...base, action: 'blocked', state: 'skipped', detail: FROZEN } as ApplyOutcome,
    ]);
    expect(out).toContain('Skipped (1)');
    expect(out).toContain('webhooks/https://example.com/w2');
    expect(out).not.toContain(FROZEN);
  });

  it('prints the reason exactly ZERO times here, counted rather than matched', () => {
    const out = renderOutcomes([
      { ...base, action: 'blocked', state: 'skipped', detail: FROZEN } as ApplyOutcome,
    ]);
    expect(out.split(FROZEN).length - 1).toBe(0);
  });
});

describe('a row skipped because a dependency failed', () => {
  const DEP =
    'bots/fd-bot failed above, and this names it. Attempting it anyway would produce a ' +
    'second error about a missing id that points at the wrong thing.';

  it('DOES print its detail — no plan could have known the write would fail', () => {
    const out = renderOutcomes([
      {
        ...base,
        type: 'botRoutes',
        key: 'r1',
        action: 'create',
        state: 'skipped',
        detail: DEP,
      } as ApplyOutcome,
    ]);
    expect(out).toContain(DEP);
  });

  it('prints it for an update that depended on a failure too', () => {
    const out = renderOutcomes([
      {
        ...base,
        type: 'botRoutes',
        key: 'r2',
        action: 'update',
        state: 'skipped',
        detail: DEP,
      } as ApplyOutcome,
    ]);
    expect(out).toContain(DEP);
  });
});

describe('the other outcome states are untouched', () => {
  it('still prints a FAILED row detail, which no plan could have known', () => {
    const out = renderOutcomes([
      {
        ...base,
        action: 'create',
        state: 'failed',
        detail: 'POST /v1/webhooks — Invalid request body',
      } as ApplyOutcome,
    ]);
    expect(out).toContain('Failed (1)');
    expect(out).toContain('Invalid request body');
  });

  it('still lists an applied row', () => {
    const out = renderOutcomes([
      { ...base, action: 'create', state: 'applied', detail: undefined } as ApplyOutcome,
    ]);
    expect(out).toContain('Applied (1)');
    expect(out).toContain('created');
  });

  it('mixes a blocked skip and a dependency skip correctly in one run', () => {
    const out = renderOutcomes([
      { ...base, action: 'blocked', state: 'skipped', detail: FROZEN } as ApplyOutcome,
      {
        ...base,
        type: 'botRoutes',
        key: 'r3',
        action: 'create',
        state: 'skipped',
        detail: DEP_TEXT,
      } as ApplyOutcome,
    ]);
    expect(out).toContain('Skipped (2)');
    expect(out).not.toContain(FROZEN);
    expect(out).toContain(DEP_TEXT);
  });
});

const DEP_TEXT = 'bots/fd-bot failed above, and this names it.';
