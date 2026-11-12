/**
 * ForgeDeck's TWELFTH report, 2026-11-07. Every row here is one of their repros.
 *
 * Item 1 is a defect the ELEVENTH report's fix introduced, and it is the more
 * interesting kind: the code already computed the right answer and used it only
 * to word the message. `wrongDiscriminator` (then called `contradicts`) knew
 * that a `type: 'external'` row cannot be a chatly bot, and the match test —
 * required fields and declared types — did not ask it. So a row matched an arm
 * its own value ruled out.
 *
 * The lesson is narrower than "check enums too": a check that derives a fact
 * for PRESENTATION and not for the decision is a check that will disagree with
 * itself. The whole union check exists because the field rules read across the
 * arms; this was the same shape of mistake one level in.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseArgs } from '../args.js';
import { doc, live } from './__tests__/wac-fixtures.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { plan } from '../commands/workspace-as-code.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

type Rows = Record<string, Array<Record<string, unknown>>>;
const planOf = (resources: Rows, liveRows: Rows = {}) =>
  buildPlan(parseDocument(doc(resources)), live(liveRows));
const text = (p: ReturnType<typeof buildPlan>) => p.warnings.join('\n');

describe('an arm the row fills but its own value rules out (their item 1)', () => {
  it('refuses an external bot carrying a chatly-only body', () => {
    // Fills the chatly arm's required fields (`name`, `systemPrompt`) while
    // `type: 'external'` is forbidden by that arm. `apply` answered
    // `webhookUrl: Required; type: Invalid literal value, expected "chatly"`.
    const plan = planOf({
      bots: [
        {
          slug: 'fd-ns',
          name: 'NS',
          type: 'external',
          systemPrompt: 'You are a helpful assistant.',
        },
      ],
    });
    expect(text(plan)).toContain('`webhookUrl`');
    expect(plan.refused).toEqual(['fd-ns']);
  });

  it('names the allowed values of an arm-only enum', () => {
    // `preset` is declared by ONE arm, so it is absent from the merged enum
    // table and the field-level check cannot see it at all.
    const plan = planOf({
      aiTools: [{ name: 'fd-tool3', preset: 'nope', url: 'https://example.com/t' }],
    });
    expect(text(plan)).toContain('`preset` to be one of `order_lookup`, `referral_answers`');
    expect(text(plan)).toContain('(it is `nope`)');
    expect(plan.refused).toEqual(['fd-tool3']);
  });

  it('keeps the preset arm in the message, which narrowing on any enum would drop', () => {
    // The reason `wrongDiscriminator` is restricted to SINGLE-value enums: a
    // two-member enum is an ordinary constrained field, and treating a bad
    // value in one as "wrong arm" would hide the arm the author needs to see.
    const plan = planOf({
      aiTools: [{ name: 'fd-tool3', preset: 'nope', url: 'https://example.com/t' }],
    });
    expect(text(plan)).toContain('2 shapes');
    expect(text(plan)).toContain('`description`');
  });

  it('still leaves every good row alone', () => {
    const ok = planOf({
      bots: [
        { slug: 'fd-ext', name: 'E', type: 'external', webhookUrl: 'https://example.com/b' },
        { slug: 'fd-ch', name: 'C', systemPrompt: 'Be a helpful assistant here.' },
      ],
      aiTools: [
        {
          name: 'fd_tool4',
          description: 'd',
          method: 'GET',
          urlTemplate: 'https://example.com/t',
          parameters: [],
        },
      ],
    });
    expect(text(ok)).not.toContain('shapes');
    expect(text(ok)).not.toContain('needs');
    expect(ok.refused).toEqual([]);
    expect(ok.items.map((i) => i.action)).toEqual(['create', 'create', 'create']);
  });

  it('names an arm-only LENGTH limit the row breaks (their item 3)', () => {
    // Fills the chatly arm outright — `name` and `systemPrompt` both present
    // — and breaks that arm's `minLength: 20`, which only that arm declares.
    // `apply` answered `systemPrompt: String must contain at least 20
    // character(s)`.
    const plan = planOf({ bots: [{ slug: 'fd-short', name: 'S', systemPrompt: 'Be nice' }] });
    expect(text(plan)).toContain('`systemPrompt` to be at least 20 characters (it is 7)');
    expect(plan.refused).toEqual(['fd-short']);
  });

  it('names an arm-only PATTERN the row breaks', () => {
    // `fd-tool2`: a hyphen, where the arm's own pattern allows `_` and `.`
    // only. `apply` answered `name: Invalid`.
    const plan = planOf({
      aiTools: [
        {
          name: 'fd-tool2',
          description: 'd',
          urlTemplate: 'https://example.com/t',
          parameters: [],
        },
      ],
    });
    expect(text(plan)).toContain('`name` to match `^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$`');
    expect(text(plan)).toContain('(it is `fd-tool2`)');
    expect(plan.refused).toEqual(['fd-tool2']);
  });

  it('names a MERGED limit on a route with no arms at all', () => {
    // The other half of item 3: most routes are not unions, and the merged
    // table is the only place their limits can live.
    const plan = planOf({
      macros: [{ shortCode: 'fd-m', name: 'x'.repeat(201), scope: 'workspace', body: 'b' }],
    });
    expect(text(plan)).toContain('`name` must be at most 200 characters (it is 201)');
    expect(plan.refused).toEqual(['fd-m']);
  });

  it('names a merged PATTERN, and leaves a legal value alone', () => {
    const bad = planOf({
      macros: [{ shortCode: 'Bad Code!', name: 'M', scope: 'workspace', body: 'b' }],
    });
    expect(text(bad)).toContain('`shortCode` must match');
    expect(bad.refused).toEqual(['Bad Code!']);
    // A leading slash IS allowed by the route's own pattern — the check must
    // not invent a stricter rule than the document carries.
    const ok = planOf({
      macros: [{ shortCode: '/refund', name: 'M', scope: 'workspace', body: 'b' }],
    });
    expect(text(ok)).not.toContain('shortCode');
    expect(ok.refused).toEqual([]);
  });

  it('says nothing about the LENGTH of a value that is not a string', () => {
    // The type check owns that message; blaming the length of a number would
    // be two warnings for one defect, and the wrong one first.
    const plan = planOf({
      macros: [{ shortCode: 'fd-n', name: 5, scope: 'workspace', body: 'b' }],
    });
    expect(text(plan)).toContain('requires a string');
    expect(text(plan)).not.toContain('characters');
  });

  it('still prints only the enum message for a value no arm allows', () => {
    // `type: 'galaxy'` is in the MERGED enum table, so the field-level check
    // explains it and the union check must stay quiet — their round-11 item.
    const plan = planOf({ bots: [{ slug: 'fd-bad-t', name: 'B', type: 'galaxy' }] });
    expect(text(plan)).toContain('which is not one of');
    expect(text(plan)).not.toContain('shapes');
    expect(plan.refused).toEqual(['fd-bad-t']);
  });
});

/**
 * Item 4 goes through the COMMAND, not `buildPlan`.
 *
 * `buildPlan` has taken `referenced` since the platform document needed it
 * (CHT-F04) and every test of it passed — the workspace command simply never
 * passed the argument, and `PlanOptions.referenced`'s own comment said "Empty
 * for the workspace document." So a test that calls `buildPlan` with
 * `referenced` set proves nothing about the defect; the caller is the defect.
 */
describe('a reference into a type the document does not declare (their item 4)', () => {
  const LIVE: Record<string, unknown> = {
    '/v1/bots': {
      items: [{ id: 'bot1', slug: 'fd-bot', name: 'FD', model: 'gpt-4o-mini' }],
      nextCursor: null,
    },
    '/v1/bot-routes': [],
  };

  /** Records every path `plan` reads, and answers from `LIVE`. */
  function client(seen: string[]) {
    return {
      request: async (method: string, path: string): Promise<unknown> => {
        seen.push(`${method} ${path}`);
        return LIVE[path] ?? [];
      },
    } as unknown as ChatlyClient;
  }

  const DOC = {
    version: 1,
    resources: {
      botRoutes: [{ name: 'fd-route', bot: 'fd-bot', match: { type: 'always' } }],
    },
  };

  it('resolves it against the server instead of blocking the row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chatly-fd12-'));
    const path = join(dir, 'chatly.json');
    writeFileSync(path, JSON.stringify(DOC));
    const seen: string[] = [];
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      const code = await plan(client(seen), parseArgs(['plan', '--file', path, '--key', 'ck_t']));
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const text = out.join('');
    expect(text).not.toContain('neither on the server');
    expect(text).not.toContain('BLOCKED');
    expect(text).toContain('create');
    // The anti-vacuity half: it passed because the bot list was READ. A plan
    // that read nothing would also contain no BLOCKED line.
    expect(seen).toContain('GET /v1/bots');
  });

  it('still blocks a reference to a bot that really is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chatly-fd12b-'));
    const path = join(dir, 'chatly.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        resources: {
          botRoutes: [{ name: 'fd-route', bot: 'fd-ghost', match: { type: 'always' } }],
        },
      }),
    );
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      await plan(client([]), parseArgs(['plan', '--file', path, '--key', 'ck_t']));
    } finally {
      spy.mockRestore();
    }
    expect(out.join('')).toContain('neither on the server');
  });
});
