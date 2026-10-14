/**
 * The `chatly.yaml` schema and the plan diff.
 *
 * What is pinned: an unknown key is REFUSED rather than stripped (a silently
 * dropped key is the failure that cost this repo a complete feature twice),
 * and `buildPlan` tells create from update on a fresh checkout using the
 * natural key rather than our uuid.
 *
 * `writesFor`, `harvestSecrets` and the resource table are in
 * `wac-apply.spec.ts`; the fixtures both files share are in
 * `__tests__/wac-fixtures.ts`.
 */
import { describe, expect, it } from 'vitest';

import { doc, issues, live } from './__tests__/wac-fixtures.js';
import { buildPlan, sameValue, tally } from './diff.js';
import { parseDocument } from './document.js';

describe('parseDocument refuses a key rather than stripping it', () => {
  it('names an unknown top-level key and lists the valid ones', () => {
    const found = issues({ version: 1, resources: {}, prune: true });
    expect(found.join('\n')).toContain('unknown top-level key "prune"');
    expect(found.join('\n')).toContain('version, workspace and resources');
  });

  it('names an unknown resource type and suggests the near miss', () => {
    /*
     * The failure CLAUDE.md records twice: a key the reader has never heard
     * of is STRIPPED, the write answers 200, and nothing happened.
     * `helpProfile` vs `profile` cost a complete feature that way.
     */
    const found = issues(doc({ bot: [] })).join('\n');
    expect(found).toContain('unknown resource type "bot"');
    expect(found).toContain('Did you mean "bots"?');
  });

  it('requires the natural key, and says why a uuid is the wrong answer', () => {
    const found = issues(doc({ bots: [{ id: 'f1b9…', name: 'Support' }] })).join('\n');
    expect(found).toContain('resources.bots[0].slug');
    expect(found).toContain('without a server uuid');
  });

  it('refuses a duplicate natural key instead of applying one of them', () => {
    const found = issues(doc({ brands: [{ slug: 'a' }, { slug: 'a' }] })).join('\n');
    expect(found).toContain('duplicate slug "a"');
    expect(found).toContain('resources.brands[0]');
  });

  it('refuses a field the API returns and no write path accepts', () => {
    /*
     * The dangerous class. `usage` is on every brand row because the list
     * route calls `listWithUsage`, so copying a `brands list --json` row into
     * the document brings it along looking exactly like a setting — and zod
     * strips it on the way back in.
     */
    const found = issues(doc({ brands: [{ slug: 'a', name: 'A', usage: { channels: 2 } }] }));
    expect(found.join('\n')).toContain('resources.brands[0].usage');
    expect(found.join('\n')).toContain('answer 200 having ignored you');
  });

  it('refuses the resource whose key the server mints, by name and reason', () => {
    const found = issues(doc({ channels: [{ publicId: 'web', name: 'Site' }] })).join('\n');
    expect(found).toContain('channels cannot be managed from a document');
    expect(found).toContain('unique across every workspace');
    // …and an empty section is fine, so a template file may carry the key.
    expect(issues(doc({ channels: [] }))).toEqual([]);
  });

  it('rejects a version it cannot read rather than guessing', () => {
    expect(issues(doc({}, { version: 2 })).join('\n')).toContain('this CLI reads version 1');
    expect(issues({ resources: {} }).join('\n')).toContain('version');
  });

  it('reports every problem at once, not the first', () => {
    const found = issues(doc({ bots: [{ name: 'no slug' }], brands: [{ name: 'no slug' }] }));
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves ${env:NAME} and refuses an unset one by name', () => {
    const parsed = parseDocument(
      doc({
        docsSources: [
          {
            label: 'Docs',
            provider: 'gitbook',
            organizationId: 'o',
            spaceId: 's',
            token: '${env:GB_TOKEN}',
          },
        ],
      }),
      { GB_TOKEN: 'secret-value' },
    );
    const row = parsed.sections[0]?.rows[0];
    expect(row?.body['token']).toBe('secret-value');
    expect(row?.fromEnv).toEqual(['token']);

    const found = issues(
      doc({
        docsSources: [
          {
            label: 'Docs',
            provider: 'gitbook',
            organizationId: 'o',
            spaceId: 's',
            token: '${env:GB_TOKEN}',
          },
        ],
      }),
      {},
    ).join('\n');
    expect(found).toContain('${env:GB_TOKEN} is used here and GB_TOKEN is unset');
    // The thing that must NOT happen: an empty string going over the wire.
    expect(found).toContain('NOT substituted');
  });

  it('refuses a row that carries both the portable ref and the raw uuid', () => {
    const found = issues(doc({ botRoutes: [{ name: 'r', bot: 'support', botId: '0199-…' }] })).join(
      '\n',
    );
    expect(found).toContain('resources.botRoutes[0].botId');
    expect(found).toContain('pins the document to one environment');
  });

  it('iterates sections in dependency order, not in the file order', () => {
    const parsed = parseDocument(
      doc({ botRoutes: [{ name: 'r', bot: 'support' }], bots: [{ slug: 'support', name: 'S' }] }),
    );
    expect(parsed.sections.map((s) => s.def.type)).toEqual(['bots', 'botRoutes']);
  });
});

/* ══ The diff ═════════════════════════════════════════════════════════════ */

describe('buildPlan', () => {
  it('tells a create from an update from a no-op, on the natural key alone', () => {
    const parsed = parseDocument(
      doc({
        brands: [
          { slug: 'acme', name: 'Acme' },
          { slug: 'new', name: 'New' },
        ],
      }),
    );
    const plan = buildPlan(
      parsed,
      live({
        brands: [
          { id: 'b1', slug: 'acme', name: 'Acme' },
          { id: 'b2', slug: 'gone' },
        ],
      }),
    );
    const byKey = new Map(plan.items.map((i) => [i.key, i]));
    expect(byKey.get('acme')?.action).toBe('noop');
    expect(byKey.get('new')?.action).toBe('create');
    expect(byKey.get('gone')?.action).toBe('orphan');
    expect(tally(plan)).toMatchObject({ create: 1, noop: 1, orphan: 1, update: 0 });
  });

  it('compares only the fields the document declares', () => {
    const parsed = parseDocument(doc({ brands: [{ slug: 'acme', name: 'Acme' }] }));
    const plan = buildPlan(
      parsed,
      live({ brands: [{ id: 'b1', slug: 'acme', name: 'Acme', primaryColor: '#ff0000' }] }),
    );
    // `primaryColor` is unmanaged, so it is not drift and is never mentioned.
    expect(plan.items[0]?.action).toBe('noop');
  });

  it('does not diff a write-only field, and says it cannot', () => {
    const parsed = parseDocument(
      doc({
        customerCards: [
          {
            key: 'orders',
            title: 'Orders',
            url: 'https://x.test/c',
            ttlSeconds: 60,
            headers: { Authorization: 'Bearer z' },
          },
        ],
      }),
    );
    const plan = buildPlan(
      parsed,
      live({
        customerCards: [
          {
            id: 'c1',
            key: 'orders',
            title: 'Orders',
            url: 'https://x.test/c',
            ttlSeconds: 60,
            headerNames: ['Authorization'],
          },
        ],
      }),
    );
    expect(plan.items[0]?.action).toBe('noop');
    expect(plan.items[0]?.notes.join(' ')).toContain('headers is write-only');
  });

  it('sends a write-only field only when --write-only asks', () => {
    const parsed = parseDocument(
      doc({
        customerCards: [
          {
            key: 'orders',
            title: 'Orders',
            url: 'https://x.test/c',
            ttlSeconds: 60,
            headers: { Authorization: 'Bearer z' },
          },
        ],
      }),
    );
    const section = live({
      customerCards: [
        {
          id: 'c1',
          key: 'orders',
          title: 'Orders',
          url: 'https://x.test/c',
          ttlSeconds: 60,
          headerNames: ['Authorization'],
        },
      ],
    });
    const plan = buildPlan(parsed, section, { writeOnly: true });
    expect(plan.items[0]?.action).toBe('update');
    expect(plan.items[0]?.changes.map((c) => c.name)).toEqual(['headers']);
  });

  it('does not diff a value that reads back as __redacted__', () => {
    /*
     * Not a declared `opaque` field: detected at runtime from the sentinel,
     * so a field nobody told `resources.ts` about still cannot produce a
     * phantom change on every run.
     */
    const parsed = parseDocument(
      doc({ docsSources: [{ label: 'Docs', baseUrl: 'https://d.test' }] }),
    );
    const plan = buildPlan(
      parsed,
      live({ docsSources: [{ id: 'd1', label: 'Docs', baseUrl: '__redacted__' }] }),
    );
    expect(plan.items[0]?.action).toBe('noop');
    expect(plan.items[0]?.notes.join(' ')).toContain('__redacted__');
  });

  it('projects an email template out of `override` instead of reporting drift for ever', () => {
    const parsed = parseDocument(
      doc({ emailTemplates: [{ kind: 'ticket_receipt', subject: 'Got it', body: 'Hi' }] }),
    );
    const unchanged = buildPlan(
      parsed,
      live({
        emailTemplates: [
          { kind: 'ticket_receipt', label: 'Receipt', override: { subject: 'Got it', body: 'Hi' } },
        ],
      }),
    );
    expect(unchanged.items[0]?.action).toBe('noop');

    // `override: null` is a kind still on the built-in copy: a real change.
    const changed = buildPlan(
      parsed,
      live({ emailTemplates: [{ kind: 'ticket_receipt', label: 'Receipt', override: null }] }),
    );
    expect(changed.items[0]?.action).toBe('update');
    expect(changed.items[0]?.changes.map((c) => c.name).sort()).toEqual(['body', 'subject']);
  });

  it("projects a bot's external config out of `externalAgent`", () => {
    const parsed = parseDocument(
      doc({ bots: [{ slug: 'push', name: 'Push', webhookUrl: 'https://a.test/hook' }] }),
    );
    const plan = buildPlan(
      parsed,
      live({
        bots: [
          {
            id: 'bot1',
            slug: 'push',
            name: 'Push',
            externalAgent: { webhookUrl: 'https://a.test/hook', timeoutSeconds: 10 },
          },
        ],
      }),
    );
    expect(plan.items[0]?.action).toBe('noop');
  });

  it("normalises a macro's shortCode the way the server does", () => {
    /*
     * `normaliseShortCode` strips a leading `/` and lowercases. Without this,
     * `/Refund` never matches the stored `refund`, `apply` creates on every
     * run, and the unique index refuses it for ever — a config file broken
     * permanently by a capital letter.
     */
    const parsed = parseDocument(
      doc({ macros: [{ shortCode: '/Refund', name: 'Refund', scope: 'workspace', body: 'x' }] }),
    );
    const plan = buildPlan(
      parsed,
      live({
        macros: [{ id: 'm1', shortCode: 'refund', name: 'Refund', scope: 'workspace', body: 'x' }],
      }),
    );
    expect(plan.items.map((i) => i.action)).toEqual(['noop']);
  });

  it('blocks a webhook change no route can write, and says what it would cost', () => {
    const parsed = parseDocument(
      doc({ webhooks: [{ url: 'https://h.test/x', eventTypes: ['message.created'] }] }),
    );
    const plan = buildPlan(
      parsed,
      live({
        webhooks: [{ id: 'w1', url: 'https://h.test/x', eventTypes: ['conversation.created'] }],
      }),
    );
    expect(plan.items[0]?.action).toBe('blocked');
    expect(plan.items[0]?.reason).toContain('`eventTypes` changed');
    expect(plan.items[0]?.reason).toContain('whsec_');
  });

  it('warns that a trigger write replaces everything the document omits', () => {
    const parsed = parseDocument(
      doc({
        triggers: [
          {
            name: 'Welcome',
            eventType: 'conversation.created',
            enabled: true,
            conditions: [],
            actions: [{ type: 'send_message', params: {} }],
          },
        ],
      }),
    );
    const plan = buildPlan(
      parsed,
      live({
        triggers: [
          {
            id: 't1',
            name: 'Welcome',
            eventType: 'conversation.created',
            enabled: false,
            conditions: [],
            actions: [],
          },
        ],
      }),
    );
    expect(plan.items[0]?.action).toBe('update');
    expect(plan.items[0]?.notes.join(' ')).toContain('REPLACES');
  });

  it('resolves `bot:` to a live id, and blocks a reference to nothing', () => {
    const resolvable = buildPlan(
      parseDocument(doc({ botRoutes: [{ name: 'checkout', bot: 'support' }] })),
      live({ botRoutes: [], bots: [{ id: 'bot1', slug: 'support' }] }),
    );
    // `bots` is not a section of this document, so the ref has nothing to
    // resolve against: the block is correct and names the fix.
    expect(resolvable.items[0]?.action).toBe('blocked');
    expect(resolvable.items[0]?.reason).toContain('resources.bots');

    const together = buildPlan(
      parseDocument(
        doc({
          bots: [{ slug: 'support', name: 'S', systemPrompt: 'x'.repeat(30) }],
          botRoutes: [{ name: 'checkout', bot: 'support' }],
        }),
      ),
      live({ bots: [{ id: 'bot1', slug: 'support', name: 'S' }], botRoutes: [] }),
    );
    const route = together.items.find((i) => i.type === 'botRoutes');
    expect(route?.action).toBe('create');
    expect(route?.resolved).toEqual({ botId: 'bot1' });
    expect(route?.dependsOn).toEqual(['bots/support']);
  });

  it('refuses to touch a key that is on two live rows', () => {
    const parsed = parseDocument(doc({ botRoutes: [{ name: 'dup', priority: 5 }] }));
    const plan = buildPlan(
      parsed,
      live({
        botRoutes: [
          { id: 'r1', name: 'dup' },
          { id: 'r2', name: 'dup' },
        ],
      }),
    );
    expect(plan.items[0]?.action).toBe('blocked');
    expect(plan.items[0]?.reason).toContain('more than one routing rule');
    expect(plan.warnings.join(' ')).toContain('does not make `name` unique');
  });

  it("warns about a field no live row carries, from the server's own vocabulary", () => {
    const parsed = parseDocument(doc({ brands: [{ slug: 'acme', nmae: 'Acme' }] }));
    const plan = buildPlan(parsed, live({ brands: [{ id: 'b1', slug: 'other', name: 'Other' }] }));
    const text = plan.warnings.join('\n');
    expect(text).toContain('`nmae`');
    expect(text).toContain('zod STRIPS an unknown key');
    expect(text).toContain('name');
  });

  it('says nothing about a type the document does not mention', () => {
    const parsed = parseDocument(doc({ brands: [] }));
    const plan = buildPlan(parsed, live({ brands: [], bots: [{ id: 'b', slug: 'orphan' }] }));
    expect(plan.items).toEqual([]);
  });

  it('refuses prune for a capped list that came back full', () => {
    const parsed = parseDocument(doc({ macros: [] }));
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: `m${String(i)}`,
      shortCode: `s${String(i)}`,
    }));
    const plan = buildPlan(parsed, new Map([['macros', { rows, possiblyTruncated: true }]]));
    expect(plan.pruneUnsafe).toEqual(['macros']);
    expect(plan.warnings.join(' ')).toContain('invisible, not absent');
  });

  it('counts a keyless live row as unmanageable rather than as an orphan', () => {
    const parsed = parseDocument(doc({ macros: [] }));
    const plan = buildPlan(
      parsed,
      live({ macros: [{ id: 'm1', shortCode: null, name: 'No code' }] }),
    );
    expect(plan.items).toEqual([]);
    expect(plan.warnings.join(' ')).toContain('have no `shortCode`');
  });
});

describe('sameValue', () => {
  it('treats absent and undefined as one state, and null as a value', () => {
    expect(sameValue(undefined, undefined)).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, undefined)).toBe(false);
  });

  it('compares nested objects and arrays structurally', () => {
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameValue([1], [1, 2])).toBe(false);
  });
});

/* ══ The writes ═══════════════════════════════════════════════════════════ */
