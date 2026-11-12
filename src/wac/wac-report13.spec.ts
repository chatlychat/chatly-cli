/**
 * ForgeDeck's THIRTEENTH report, 2026-11-07. Every row here is one of their
 * repros; item 1 is server-side and is proved in
 * `apps/api/src/modules/ai-tools/ai-tool-name-conflict.integration.spec.ts`.
 *
 * Four of the five share one cause, and it is worth naming because it is not
 * "another missing rule": every check in `field-rules-checks.ts` reads ONE
 * field against the route's declared rules for that field, and the rules these
 * rows break are about a PAIR. `webhookUrl` is a real field on `POST /v1/bots`
 * and is kept only for `type: "external"`. `teamId` is `nullish()` and
 * required only in the company of `scope: "team"`. `preset` and `url` are real
 * fields that produce other columns. None of it is in the OpenAPI document, so
 * none of it could ever have been generated — which is why `discards` and
 * `extraWarnings` are hand-written and `resource-conditionals.ts` says so.
 *
 * The three that never settled are the expensive half. A field accepted and
 * discarded is diffed as `undefined` against a value, which is a change no
 * write can close: `plan` offered it, `apply` sent it, the read-back still
 * differed, and the next run did it again — writing to production for ever
 * while every exit code looked fine.
 */
import { describe, expect, it } from 'vitest';

import { doc, live } from './__tests__/wac-fixtures.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';

import type { PlanOptions } from './diff.js';

type Rows = Record<string, Array<Record<string, unknown>>>;
const planOf = (resources: Rows, liveRows: Rows = {}, opts: PlanOptions = {}) =>
  buildPlan(parseDocument(doc(resources)), live(liveRows), opts);
const text = (p: ReturnType<typeof buildPlan>) => p.warnings.join('\n');
const actionOf = (p: ReturnType<typeof buildPlan>, key: string) =>
  p.items.find((i) => i.key === key)?.action;

const LIVE_TOOL = {
  id: '0193f000-0000-7000-8000-00000000f001',
  name: 'order_lookup',
  description: 'Look up an order',
  // `urlTemplate` is what `GET /v1/ai/tools` returns. This fixture said
  // `endpointUrl`, which is not a field the API has — the invented-shape
  // trap again, found while fixing report 14's item 4.
  urlTemplate: 'https://shop.example.com/orders',
  method: 'POST',
  enabled: true,
  parameters: [],
  requiresApproval: 'none',
  secretHeaderNames: [],
  signingSecretSet: true,
};

/**
 * `externalAgent: null` is PRODUCTION'S SHAPE and this fixture omitted it,
 * which is why 21 tests passed over a live defect. `toBotView` answers
 * `row.type === 'external' ? {…} : null` — so every Chatly bot carries the
 * key, holding `null`, and the rule under test read `typeof null` as
 * `'object'`. ForgeDeck found it on a real workspace.
 *
 * Keep the `null`. A fixture that omits what the server always sends makes
 * the suite agree with the bug, and that is now the second time in this one
 * file's history (see `wac-apply.spec.ts`'s missing `type`).
 */
const LIVE_BOT = {
  id: '0193f000-0000-7000-8000-00000000b001',
  slug: 'fd-bot',
  name: 'FD bot',
  type: 'chatly',
  systemPrompt: 'You are a helpful assistant for this shop.',
  status: 'active',
  externalAgent: null,
};

describe('a preset AI tool row that never settled (their item 2)', () => {
  it('refuses a preset row whose key is not the preset tool name', () => {
    /*
     * Their repro: `preset: order_lookup` keyed `fd_t5` created a tool called
     * `order_lookup`, and `fd_t5` never appeared on the server — so every
     * later `plan` said `+ create` and the second `apply` hit the 500 that
     * item 1 fixes. The preset arm ignores `name` entirely.
     */
    const p = planOf({
      aiTools: [{ name: 'fd_t5', preset: 'order_lookup', url: 'https://shop.example.com/o' }],
    });
    expect(text(p)).toContain('always creates a tool named `order_lookup`');
    expect(text(p)).toContain('Rename the key to `order_lookup`');
    expect(p.refused).toContain('fd_t5');
  });

  it('says nothing about the key when the row is keyed correctly', () => {
    const p = planOf({
      aiTools: [
        { name: 'order_lookup', preset: 'order_lookup', url: 'https://shop.example.com/o' },
      ],
    });
    expect(text(p)).not.toContain('Rename the key');
    expect(p.refused).toEqual([]);
  });

  it('leaves `preset` and `url` out of the comparison, so an installed row is a noop', () => {
    /*
     * The second half, and the one that was writing on every run. Neither
     * field is a column: the route expands them and the read carries
     * `endpointUrl`, so `plan` kept showing `preset: (unset) -> …` and
     * `url: (unset) -> …` for ever. Control: delete the `discards` entry for
     * `aiTools` in `resources.ts` and this row plans as `update` with two
     * changes, which is what it did before.
     */
    const p = planOf(
      {
        aiTools: [
          { name: 'order_lookup', preset: 'order_lookup', url: 'https://shop.example.com/o' },
        ],
      },
      { aiTools: [LIVE_TOOL] },
    );
    expect(actionOf(p, 'order_lookup')).toBe('noop');
    expect(text(p)).toContain('`preset` is an install INSTRUCTION');
    expect(text(p)).toContain('`url` is that install');
  });

  it('calls the discarded fields ADVICE, never a refusal', () => {
    // The write succeeds and `apply` exits 0, so a `REFUSED` line here would
    // teach the reader to ignore the line — ForgeDeck's seventh report.
    const p = planOf(
      {
        aiTools: [
          { name: 'order_lookup', preset: 'order_lookup', url: 'https://shop.example.com/o' },
        ],
      },
      { aiTools: [LIVE_TOOL] },
    );
    expect(p.refused).toEqual([]);
  });

  it('still sends `preset` and `url` on the CREATE that needs them', () => {
    // `droppedFields` is read by `planUpdate` only, which is the whole reason
    // the install keeps working: the preset arm REQUIRES both fields.
    const p = planOf({
      aiTools: [
        { name: 'order_lookup', preset: 'order_lookup', url: 'https://shop.example.com/o' },
      ],
    });
    const item = p.items.find((i) => i.key === 'order_lookup');
    expect(item?.action).toBe('create');
    // `name` is the natural key and a body field on this route; `diff.ts`
    // supplies it either way. The two that matter are both still here.
    expect(item?.changes.map((c) => c.name).sort()).toEqual(['name', 'preset', 'url']);
  });
});

describe('an update checked against the create route (their item 3)', () => {
  it('names `systemPrompt` and refuses a bot update that is too short', () => {
    /*
     * `apply` answered `PATCH /v1/bots/<id> — Invalid request body
     * (systemPrompt: String must contain at least 20 character(s))`. The
     * generated table held the answer the whole time: `'PATCH /v1/bots/{}'`
     * carries `systemPrompt: { min: 20, max: 20000 }`, and nothing read that
     * entry — `rulesFor` returns the POST route's rules, where the length
     * lives inside the union ARMS and not in the merged table.
     *
     * `--write-only` because `systemPrompt` is `opaque` on this resource: a
     * prompt does not read back, so an ordinary run leaves it alone and the
     * row is a `noop` nothing is sent for. Which is the one path that reaches
     * their error, and is how they reached it.
     */
    const p = planOf(
      { bots: [{ slug: 'fd-bot', systemPrompt: 'short' }] },
      { bots: [LIVE_BOT] },
      {
        writeOnly: true,
      },
    );
    expect(actionOf(p, 'fd-bot')).toBe('update');
    expect(text(p)).toContain('`systemPrompt` must');
    expect(p.refused).toContain('fd-bot');
  });

  it('accepts a long enough one', () => {
    const p = planOf(
      { bots: [{ slug: 'fd-bot', systemPrompt: 'You answer questions about orders.' }] },
      { bots: [LIVE_BOT] },
      { writeOnly: true },
    );
    expect(p.refused).toEqual([]);
  });

  it('reads the update route for an ordinary field too, with no flag', () => {
    /*
     * The same defect without `--write-only`: `POST /v1/bots`'s merged
     * `strings` has no `model` entry at all (it is arm-only), and
     * `'PATCH /v1/bots/{}'` says `{ min: 1, max: 64 }`. Control: make
     * `rulesForField` return `rulesFor(def)` unconditionally and both this
     * and the test above pass against the bug.
     */
    const p = planOf({ bots: [{ slug: 'fd-bot', model: '' }] }, { bots: [LIVE_BOT] });
    expect(actionOf(p, 'fd-bot')).toBe('update');
    expect(text(p)).toContain('`model` must');
    expect(p.refused).toContain('fd-bot');
  });
});

describe('a Chatly bot carrying external delivery config (their item 4)', () => {
  it('warns and leaves `webhookUrl` out of the comparison', () => {
    /*
     * The server drops it: `bots.controller.ts` calls `this.bots.create(...)`
     * without the field on the chatly arm, and `toBotView` emits
     * `externalAgent` only for `type === 'external'`. Control: delete the
     * `discards` entry for `bots` and this plans as `update`.
     */
    const p = planOf(
      { bots: [{ slug: 'fd-bot', webhookUrl: 'https://example.com/hook' }] },
      { bots: [LIVE_BOT] },
    );
    expect(actionOf(p, 'fd-bot')).toBe('noop');
    expect(text(p)).toContain("`webhookUrl` is an EXTERNAL agent's delivery config");
    expect(p.refused).toEqual([]);
  });

  it('reads the LIVE type when the update row omits it', () => {
    // `type` is create-only, so an update row that omits it is describing
    // whatever is already there — and for an external bot the field is real.
    const p = planOf(
      { bots: [{ slug: 'fd-ext', webhookUrl: 'https://example.com/new' }] },
      {
        bots: [
          {
            ...LIVE_BOT,
            id: '0193f000-0000-7000-8000-00000000b002',
            slug: 'fd-ext',
            type: 'external',
            externalAgent: { webhookUrl: 'https://example.com/old', timeoutSeconds: 20 },
          },
        ],
      },
    );
    expect(actionOf(p, 'fd-ext')).toBe('update');
    expect(text(p)).not.toContain('delivery config');
  });

  it('does NOT read `externalAgent: null` as an external agent', () => {
    /*
     * `typeof null === 'object'`. The first version of this rule tested
     * `typeof live?.['externalAgent'] === 'object'`, so every existing
     * Chatly bot was read as external, the discards never fired on an
     * update, and the row went on never settling — the warnings showed on
     * the first `plan` (a create has no live row to misread) and never
     * again. Control: put the `typeof` test back and this fails while the
     * two below still pass, which is exactly how it shipped.
     *
     * Asserted here as well as through `LIVE_BOT` so the guarantee survives
     * somebody "tidying" that fixture.
     */
    const p = planOf(
      { bots: [{ slug: 'fd-null', webhookUrl: 'https://example.com/hook' }] },
      {
        bots: [
          {
            id: '0193f000-0000-7000-8000-00000000b004',
            slug: 'fd-null',
            name: 'N',
            type: 'chatly',
            externalAgent: null,
          },
        ],
      },
    );
    expect(actionOf(p, 'fd-null')).toBe('noop');
    expect(text(p)).toContain("`webhookUrl` is an EXTERNAL agent's delivery config");
  });

  it('takes `externalAgent` on the read as proof, with no `type` at all', () => {
    /*
     * The two signals are not interchangeable and the asymmetry is the point:
     * calling an external bot a Chatly one DISCARDS a field the author set,
     * silently, which is the defect this rule exists to stop. Control: drop
     * the `externalAgent` arm of the test in `BOT_DISCARDS` and this fails.
     */
    const p = planOf(
      { bots: [{ slug: 'fd-ext2', webhookUrl: 'https://example.com/new' }] },
      {
        bots: [
          {
            id: '0193f000-0000-7000-8000-00000000b003',
            slug: 'fd-ext2',
            name: 'E2',
            externalAgent: { webhookUrl: 'https://example.com/old' },
          },
        ],
      },
    );
    expect(actionOf(p, 'fd-ext2')).toBe('update');
    expect(text(p)).not.toContain('delivery config');
  });

  it('reads the DOCUMENT type on a create', () => {
    const p = planOf({
      bots: [{ slug: 'fd-new', name: 'N', type: 'external', webhookUrl: 'https://e.example/h' }],
    });
    expect(text(p)).not.toContain('delivery config');
  });
});

describe('conditional requirements the generated table cannot state (their item 5)', () => {
  it('refuses a team-scoped macro with no `teamId`', () => {
    const p = planOf({ macros: [{ shortCode: 'fd-team', name: 'T', scope: 'team', body: 'hi' }] });
    expect(text(p)).toContain('`scope: "team"` needs a `teamId`');
    expect(p.refused).toContain('fd-team');
  });

  it('accepts one that has it, and says nothing about a workspace macro', () => {
    const p = planOf({
      macros: [
        {
          shortCode: 'fd-team',
          name: 'T',
          scope: 'team',
          body: 'hi',
          teamId: '0193f000-0000-7000-8000-00000000e001',
        },
        { shortCode: 'fd-ws', name: 'W', scope: 'workspace', body: 'hi' },
      ],
    });
    expect(text(p)).not.toContain('needs a `teamId`');
    expect(p.refused).toEqual([]);
  });

  it('does not fire on an UPDATE of a macro that already has a team', () => {
    /*
     * `teamId: undefined` in a PATCH means "leave as stored", so a patch that
     * sets `scope: "team"` on a macro that already has a team is legitimate.
     * Warning here is the false-refusal shape that cost the eighth report a
     * run on a valid file.
     *
     * This test read "does not fire on an UPDATE" when it shipped, and the
     * rule really was create-only. That was too narrow — the service enforces
     * the pair on an update as well — so `wac-report14.spec.ts` covers the
     * updates that DO warn, and what this one pins is the exception.
     */
    const p = planOf(
      { macros: [{ shortCode: 'fd-team', name: 'T', scope: 'team', body: 'bye' }] },
      {
        macros: [
          {
            id: '0193f000-0000-7000-8000-00000000c001',
            shortCode: 'fd-team',
            name: 'T',
            scope: 'team',
            body: 'hi',
            teamId: '0193f000-0000-7000-8000-00000000e001',
            language: 'en',
            tags: [],
            actions: [],
          },
        ],
      },
    );
    expect(actionOf(p, 'fd-team')).toBe('update');
    expect(text(p)).not.toContain('needs a `teamId`');
  });

  it('matches the live row through the server normaliser, so `/FD-Team` is not a create', () => {
    // `normaliseShortCode` is shared with `normalizeKey` for exactly this:
    // two copies would disagree about which live macro this row is, and the
    // rule reads the live `scope` and `teamId` to decide.
    const p = planOf(
      { macros: [{ shortCode: '/FD-Team', name: 'T', scope: 'team', body: 'bye' }] },
      {
        macros: [
          {
            id: '0193f000-0000-7000-8000-00000000c001',
            shortCode: 'fd-team',
            name: 'T',
            scope: 'team',
            body: 'hi',
            teamId: '0193f000-0000-7000-8000-00000000e001',
            language: 'en',
            tags: [],
            actions: [],
          },
        ],
      },
    );
    expect(text(p)).not.toContain('needs a `teamId`');
  });

  it('refuses a `referral_answers` install with no `signingSecret`', () => {
    const p = planOf({
      aiTools: [{ name: 'referral_answers', preset: 'referral_answers', url: 'https://e.co/r' }],
    });
    expect(text(p)).toContain('needs a `signingSecret`');
    expect(p.refused).toContain('referral_answers');
  });

  it('accepts one that has it, and never asks `order_lookup` for one', () => {
    const p = planOf({
      aiTools: [
        {
          name: 'referral_answers',
          preset: 'referral_answers',
          url: 'https://e.co/r',
          signingSecret: 'x'.repeat(40),
        },
        { name: 'order_lookup', preset: 'order_lookup', url: 'https://e.co/o' },
      ],
    });
    expect(text(p)).not.toContain('needs a `signingSecret`');
    expect(p.refused).toEqual([]);
  });
});

describe('one warning for one mistake (their item 6)', () => {
  it('says a blank required field is required, and not also that it is short', () => {
    const p = planOf({
      macros: [{ shortCode: 'fd-blank', name: '', body: 'hi', scope: 'workspace' }],
    });
    const about = p.warnings.filter((w) => w.includes('`name`'));
    expect(about).toHaveLength(1);
    expect(about[0]).toContain('required');
    expect(text(p)).not.toContain('at least 1 character');
    expect(p.refused).toContain('fd-blank');
  });

  it('still reports a too-SHORT value that is not blank', () => {
    // The suppression is keyed on blank-and-required, not on the field having
    // a length rule: a one-character `language` is still the length rule's.
    const p = planOf({
      macros: [{ shortCode: 'fd-lang', name: 'L', body: 'hi', scope: 'workspace', language: 'e' }],
    });
    expect(text(p)).toContain('`language` must');
    expect(p.refused).toContain('fd-lang');
  });
});

describe('the hardcoded preset table', () => {
  it('agrees with the real one in @livechat/shared', async () => {
    /*
     * The CLI is PUBLISHED and `@livechat/shared` is `private: true`, so the
     * real table cannot be imported at runtime — `commands/secret.ts` makes
     * the same call. A devDependency is fine HERE, in a spec, and this is the
     * control that keeps the copy honest: a new preset, or a preset whose
     * tool name or identity sources change, fails the build.
     */
    const { AI_TOOL_PRESETS, presetNeedsSigningSecret } = await import(
      '@livechat/shared/ai-tools/presets'
    );
    for (const preset of AI_TOOL_PRESETS) {
      const p = planOf({
        aiTools: [{ name: preset.toolName, preset: preset.id, url: 'https://e.co/x' }],
      });
      // Keyed as the real `toolName`: no rename line, whatever that name is.
      expect(text(p)).not.toContain('Rename the key to');
      // And the signing rule asks exactly when the real predicate says so.
      expect(text(p).includes('needs a `signingSecret`')).toBe(presetNeedsSigningSecret(preset.id));
    }
  });
});
