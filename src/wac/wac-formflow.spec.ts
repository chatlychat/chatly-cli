/**
 * FormFlow's CLI gaps: a `plan` that goes green over a dead knowledge base
 * (CH-05) and workspace-wide settings a `ck_` key could not describe (CH-24).
 *
 * Every assertion here is on what the CLI COMPUTED or SENT, never on a canned
 * reply: the plan is built from literal live rows, and the apply assertions
 * read the recorded request. A transport that echoes whatever the client
 * asked agrees with the bug — which is how four SDKs here shipped unable to
 * connect with green suites.
 */
import { describe, expect, it } from 'vitest';

import { doc, issues, live } from './__tests__/wac-fixtures.js';
import { writesFor } from './apply.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { planFooter, planForJson, renderPlan } from './render.js';
import { resourceDef } from './resources.js';

const APPLY = { prune: false, pruneUnsafe: [], writeOnly: false };
const RENDER = { prune: false, pruneUnsafe: [] };

/** A `GET /v1/docs-sources` row, with the two fields nothing used to read. */
const source = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'ds_1',
  label: 'handbook',
  provider: 'gitbook',
  status: 'active',
  syncStatus: 'ok',
  lastError: null,
  lastSyncedAt: '2026-11-10T09:00:00.000Z',
  ...over,
});

describe('CH-05 — a documentation source that matches the document and is dead', () => {
  const planWith = (liveRow: Record<string, unknown>) =>
    buildPlan(
      parseDocument(doc({ docsSources: [{ label: 'handbook', status: 'active' }] })),
      live({ docsSources: [liveRow] }),
    );

  it('plans the row as unchanged — because it IS unchanged', () => {
    const plan = planWith(source({ syncStatus: 'failed', lastError: 'HTTP 401 from GitBook' }));
    expect(plan.items.map((i) => i.action)).toEqual(['noop']);
  });

  it('names it unhealthy, with syncStatus and lastError on the line', () => {
    const plan = planWith(source({ syncStatus: 'failed', lastError: 'HTTP 401 from GitBook' }));
    expect(plan.unhealthy).toEqual(['docsSources/handbook']);
    const text = renderPlan(plan, RENDER);
    expect(text).toContain('syncStatus is `failed`');
    expect(text).toContain('HTTP 401 from GitBook');
  });

  it('says so in the footer, where a reader who skimmed the diff still sees it', () => {
    const plan = planWith(source({ syncStatus: 'failed', lastError: null }));
    expect(planFooter(plan, RENDER)).toContain('FAILING on');
    expect(planFooter(plan, RENDER)).toContain('docsSources/handbook');
  });

  it('publishes it at the top level of --json, beside refused and blocked', () => {
    const plan = planWith(source({ syncStatus: 'failed' }));
    const json = planForJson(plan) as { unhealthy: string[]; refused: string[]; blocked: string[] };
    expect(json.unhealthy).toEqual(['docsSources/handbook']);
    // Three lists answering three questions. A row must never be in two.
    expect(json.refused).toEqual([]);
    expect(json.blocked).toEqual([]);
  });

  /*
   * `pending` and `syncing` are a source MID-RUN. Grading them would make the
   * exit code depend on when the pipeline happened to look, which is a flaky
   * gate rather than a gate — so they get the note and not the verdict.
   */
  it('notes a syncing source without calling it failed', () => {
    const plan = planWith(source({ syncStatus: 'pending' }));
    expect(plan.unhealthy).toEqual([]);
    expect(renderPlan(plan, RENDER)).toContain('syncStatus is `pending`');
  });

  it('is silent on a healthy source', () => {
    const plan = planWith(source());
    expect(plan.unhealthy).toEqual([]);
    expect(renderPlan(plan, RENDER)).not.toContain('syncStatus');
  });
});

describe('CH-24 — businessHours in the workspace document', () => {
  const hours = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    enabled: true,
    tz: 'Europe/London',
    schedule: { mon: { open: '09:00', close: '17:00' } },
    holidays: [],
    ...over,
  });

  it('is a section, not an array, and needs no key from the author', () => {
    const parsed = parseDocument(doc({ businessHours: { enabled: true, tz: 'Europe/London' } }));
    const section = parsed.sections.find((s) => s.def.type === 'businessHours');
    expect(section?.rows.map((r) => r.key)).toEqual(['default']);
  });

  it('refuses an array, because there is one per workspace', () => {
    expect(issues(doc({ businessHours: [{ enabled: true }] })).join('\n')).toContain(
      'single business-hours config object',
    );
  });

  it('matches the live singleton rather than planning a create', () => {
    const plan = buildPlan(
      parseDocument(doc({ businessHours: { enabled: true, tz: 'Europe/London' } })),
      live({ businessHours: [{ ...hours(), key: 'default' }] }),
    );
    expect(plan.items.map((i) => i.action)).toEqual(['noop']);
  });

  it('PATCHes only the fields that changed, to the key-accessible route', () => {
    const plan = buildPlan(
      parseDocument(doc({ businessHours: { enabled: true, tz: 'Europe/Berlin' } })),
      live({ businessHours: [{ ...hours(), key: 'default' }] }),
    );
    const item = plan.items[0];
    expect(item?.action).toBe('update');
    const def = item === undefined ? undefined : resourceDef('businessHours');
    expect(
      def === undefined || item === undefined ? [] : writesFor(def, item, new Map(), APPLY),
    ).toEqual([
      { method: 'PATCH', path: '/v1/workspace/business-hours', body: { tz: 'Europe/Berlin' } },
    ]);
  });

  /*
   * The whole point of CH-24's warning half: hours off while a widget is
   * live means every visitor is told the same thing at 03:00 as at 11:00.
   */
  it('warns when hours are off and a web channel is enabled', () => {
    const plan = buildPlan(
      parseDocument(
        doc({ businessHours: { enabled: false }, channels: [{ key: 'web', name: 'Web' }] }),
      ),
      live({
        businessHours: [{ ...hours({ enabled: false }), key: 'default' }],
        channels: [{ id: 'ch_1', key: 'web', name: 'Web', type: 'web', enabled: true }],
      }),
    );
    expect(plan.warnings.join('\n')).toContain('businessHours.enabled is false');
  });

  it('is silent when the hours are on', () => {
    const plan = buildPlan(
      parseDocument(doc({ businessHours: { enabled: true }, channels: [{ key: 'web' }] })),
      live({
        businessHours: [{ ...hours(), key: 'default' }],
        channels: [{ id: 'ch_1', key: 'web', type: 'web', enabled: true }],
      }),
    );
    expect(plan.warnings.join('\n')).not.toContain('businessHours.enabled');
  });
});

describe('CH-24 — tone in the workspace document', () => {
  it('replaces the whole rule set through PUT /v1/ai/tone', () => {
    const plan = buildPlan(
      parseDocument(
        doc({ tone: { rules: [{ category: 'voice', rule: 'Be brief.', enabled: true }] } }),
      ),
      live({
        tone: [
          {
            key: 'default',
            rules: [{ category: 'voice', rule: 'Be long-winded.', enabled: true }],
          },
        ],
      }),
    );
    const item = plan.items[0];
    const def = resourceDef('tone');
    expect(item?.action).toBe('update');
    expect(
      def === undefined || item === undefined ? [] : writesFor(def, item, new Map(), APPLY),
    ).toEqual([
      {
        method: 'PUT',
        path: '/v1/ai/tone',
        body: { rules: [{ category: 'voice', rule: 'Be brief.', enabled: true }] },
      },
    ]);
  });

  /*
   * `id` and `position` come back on every live rule and the write schema is
   * `.strict()` about both. Without `rowsFrom`'s projection an unchanged rule
   * set would diff as changed on every run and then 400 on apply.
   */
  it('does not diff the id and position the server assigned', () => {
    const def = resourceDef('tone');
    const projected = def?.rowsFrom?.([
      { id: 'tr_1', category: 'voice', rule: 'Be brief.', enabled: true, position: 0 },
    ]);
    expect(projected).toEqual([
      { key: 'default', rules: [{ category: 'voice', rule: 'Be brief.', enabled: true }] },
    ]);
  });
});

describe('CH-24 — settings is refused rather than half-supported', () => {
  /*
   * `PATCH /v1/workspace/settings` carries no `@AllowApiKey()`. A section
   * here would parse, plan cleanly and 403 at apply time — after the deploy
   * had started.
   */
  it('names the reason, and names the two sections that DO work', () => {
    const said = issues(doc({ settings: { quickReactions: [] } })).join('\n');
    expect(said).toContain('PATCH /v1/workspace/settings');
    expect(said).toContain('businessHours');
    expect(said).toContain('tone');
  });

  it('is not reported as an unknown resource type, which would send the reader hunting', () => {
    expect(issues(doc({ settings: { quickReactions: [] } })).join('\n')).not.toContain(
      'unknown resource type',
    );
  });
});
