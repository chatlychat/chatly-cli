/**
 * What `apply` SENDS, and the secrets it must never write down.
 *
 * Split out of `wac.spec.ts` at 717 of the 650 lines `check-file-size`
 * allows. These suites assert on the REQUEST rather than on a canned
 * response, which is the only thing worth asserting here: a fake transport
 * that echoes whatever the caller asked for agrees with the bug, and that is
 * how four mobile SDKs shipped a handshake the gateway rejects.
 */
import { describe, expect, it } from 'vitest';

import { APPLY, def, doc, live } from './__tests__/wac-fixtures.js';
import { writesFor, harvestSecrets } from './apply.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { RESOURCE_TYPES } from './resources.js';

describe('writesFor builds the request, and the request is what is asserted', () => {
  it('sends the natural key in a create body', () => {
    const parsed = parseDocument(doc({ brands: [{ slug: 'acme', name: 'Acme' }] }));
    const plan = buildPlan(parsed, live({ brands: [] }));
    const ops = writesFor(def('brands'), plan.items[0]!, new Map(), APPLY);
    expect(ops).toEqual([
      { method: 'POST', path: '/v1/brands', body: { slug: 'acme', name: 'Acme' } },
    ]);
  });

  it('sends only the changed fields on an update, and never the key', () => {
    const parsed = parseDocument(doc({ brands: [{ slug: 'acme', name: 'Acme Inc' }] }));
    const plan = buildPlan(parsed, live({ brands: [{ id: 'b1', slug: 'acme', name: 'Acme' }] }));
    const ops = writesFor(def('brands'), plan.items[0]!, new Map(), APPLY);
    expect(ops).toEqual([{ method: 'PATCH', path: '/v1/brands/b1', body: { name: 'Acme Inc' } }]);
  });

  it("routes a bot's external config to /external and the rest to the bot", () => {
    const parsed = parseDocument(
      doc({
        bots: [{ slug: 'push', name: 'Push', model: 'gpt-4o', webhookUrl: 'https://b.test/h' }],
      }),
    );
    const plan = buildPlan(
      parsed,
      live({
        bots: [
          {
            id: 'bot1',
            slug: 'push',
            name: 'Push',
            model: 'gpt-4o-mini',
            externalAgent: { webhookUrl: 'https://a.test/h' },
          },
        ],
      }),
    );
    const ops = writesFor(def('bots'), plan.items[0]!, new Map(), APPLY);
    expect(ops).toEqual([
      { method: 'PATCH', path: '/v1/bots/bot1/external', body: { webhookUrl: 'https://b.test/h' } },
      { method: 'PATCH', path: '/v1/bots/bot1', body: { model: 'gpt-4o' } },
    ]);
  });

  it('updates a trigger by POSTing the whole body with the live id', () => {
    /*
     * The upsert keys on the body's `id`, and an id the workspace does not
     * hold is a 404 rather than a create — so the id must come from the row
     * this file matched by name. And the write REPLACES, so a partial body
     * would reset `priority` to 0.
     */
    const parsed = parseDocument(
      doc({
        triggers: [
          {
            name: 'Welcome',
            eventType: 'conversation.created',
            enabled: true,
            conditions: [],
            actions: [{ type: 'send_message', params: {} }],
            priority: 7,
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
            priority: 7,
          },
        ],
      }),
    );
    const ops = writesFor(def('triggers'), plan.items[0]!, new Map(), APPLY);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.method).toBe('POST');
    expect(ops[0]?.path).toBe('/v1/triggers');
    expect(ops[0]?.body).toMatchObject({ id: 't1', name: 'Welcome', priority: 7 });
  });

  it('PUTs an email template without its kind in the body', () => {
    // The PUT body is `.strict()` and takes only `subject` and `body`; `kind`
    // is a path segment, so sending it would be a 400.
    const parsed = parseDocument(
      doc({ emailTemplates: [{ kind: 'ticket_receipt', subject: 'S', body: 'B' }] }),
    );
    const plan = buildPlan(
      parsed,
      live({ emailTemplates: [{ kind: 'ticket_receipt', override: null }] }),
    );
    const ops = writesFor(def('emailTemplates'), plan.items[0]!, new Map(), APPLY);
    expect(ops).toEqual([
      {
        method: 'PUT',
        path: '/v1/email-templates/ticket_receipt',
        body: { subject: 'S', body: 'B' },
      },
    ]);
  });

  it('resolves a reference created earlier in the same run', () => {
    const parsed = parseDocument(
      doc({
        bots: [{ slug: 'support', name: 'S', systemPrompt: 'x'.repeat(30) }],
        botRoutes: [{ name: 'checkout', bot: 'support' }],
      }),
    );
    const plan = buildPlan(parsed, live({ bots: [], botRoutes: [] }));
    const route = plan.items.find((i) => i.type === 'botRoutes')!;
    expect(route.resolved).toEqual({});
    const ops = writesFor(def('botRoutes'), route, new Map([['bots/support', 'bot-new']]), APPLY);
    expect(ops[0]?.body).toEqual({ name: 'checkout', botId: 'bot-new' });
  });

  it('issues no DELETE for an orphan unless --prune, and never for a type that cannot', () => {
    const parsed = parseDocument(doc({ brands: [], emailTemplates: [] }));
    const plan = buildPlan(
      parsed,
      live({ brands: [{ id: 'b9', slug: 'stale' }], emailTemplates: [{ kind: 'ticket_receipt' }] }),
    );
    const brandOrphan = plan.items.find((i) => i.type === 'brands')!;
    const templateOrphan = plan.items.find((i) => i.type === 'emailTemplates')!;

    expect(writesFor(def('brands'), brandOrphan, new Map(), APPLY)).toEqual([]);
    expect(writesFor(def('brands'), brandOrphan, new Map(), { ...APPLY, prune: true })).toEqual([
      { method: 'DELETE', path: '/v1/brands/b9' },
    ]);
    // An email template cannot be deleted at all: DELETE reverts to built-in.
    expect(
      writesFor(def('emailTemplates'), templateOrphan, new Map(), { ...APPLY, prune: true }),
    ).toEqual([]);
  });

  it('refuses to prune a type whose live list may be short', () => {
    const parsed = parseDocument(doc({ macros: [] }));
    const rows = [{ id: 'm1', shortCode: 'a' }];
    const plan = buildPlan(parsed, new Map([['macros', { rows, possiblyTruncated: true }]]));
    expect(
      writesFor(def('macros'), plan.items[0]!, new Map(), {
        prune: true,
        pruneUnsafe: ['macros'],
        writeOnly: false,
      }),
    ).toEqual([]);
  });
});

describe('harvestSecrets', () => {
  it('finds a secret beside the resource, not only inside it', () => {
    // `POST /v1/customer-cards` answers `{ card: {...}, secret: "cc_…" }`.
    const parsed = parseDocument(
      doc({
        customerCards: [{ key: 'orders', title: 'O', url: 'https://x.test', ttlSeconds: 60 }],
      }),
    );
    const plan = buildPlan(parsed, live({ customerCards: [] }));
    const found = harvestSecrets(def('customerCards'), plan.items[0]!, {
      card: { id: 'c1', key: 'orders' },
      secret: 'cc_abc123',
    });
    expect(found).toEqual([
      { type: 'customerCards', key: 'orders', field: 'secret', value: 'cc_abc123' },
    ]);
  });

  it('finds a credential-looking field nobody declared, and ignores the sentinel', () => {
    /*
     * The declared `secrets` list is a floor, not a fence. A hand-written
     * list goes stale, and CLAUDE.md records twice what that looks like — a
     * gate's green line counting what it managed to parse.
     */
    const parsed = parseDocument(doc({ bots: [{ slug: 'push', name: 'P' }] }));
    const plan = buildPlan(parsed, live({ bots: [] }));
    const found = harvestSecrets(def('bots'), plan.items[0]!, {
      id: 'b1',
      webhookToken: 'wt_surprise',
      config: { secret: '__redacted__' },
    });
    expect(found.map((s) => s.field)).toEqual(['webhookToken']);
  });
});

/* ══ Anti-vacuity ═════════════════════════════════════════════════════════ */

describe('the resource table itself', () => {
  it('covers every type the document accepts, with a route per declared verb', () => {
    /*
     * A floor on the audited set, for the reason CLAUDE.md gives twice: a
     * gate's green line has been the number of things it managed to parse
     * rather than the number that exist. If a row is lost to a bad edit,
     * every assertion in this file still passes against a smaller table.
     */
    expect(RESOURCE_TYPES.length).toBeGreaterThanOrEqual(10);
    for (const type of RESOURCE_TYPES) {
      const d = def(type);
      expect(d.naturalKey.length, `${type} has no natural key`).toBeGreaterThan(0);
      expect(d.list.path.startsWith('/v1/'), `${type} list path`).toBe(true);
      for (const route of d.update) {
        expect(route.path.startsWith('/v1/'), `${type} update path`).toBe(true);
      }
      if (d.remove === null) {
        expect(d.removeBlocked, `${type} has no remove and no reason`).toBeDefined();
      }
      // A resource with named-only update routes must explain the gap.
      if (d.update.length > 0 && !d.update.some((r) => r.fields === undefined)) {
        expect(d.updateBlocked, `${type} cannot write every field and says nothing`).toBeDefined();
      }
    }
  });

  it('has no server-keyed resource left: channels match on the authored `key`', () => {
    const serverKeyed = RESOURCE_TYPES.filter((t) => def(t).keySource === 'server');
    expect(serverKeyed).toEqual([]);
    expect(def('channels').remove).toBeNull();
  });
});
