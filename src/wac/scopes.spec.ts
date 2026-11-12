/**
 * The scope answer, and the two things that would make it go stale (CH-17).
 *
 * The defect being prevented is a false alarm on a readiness check: a `plan`
 * that says a key is short of a scope it holds is a gate somebody switches
 * off. So both directions are pinned — the derivation covers every resource,
 * and the implication table matches the server's.
 */
import { describe, expect, it } from 'vitest';

import { doc } from './__tests__/wac-fixtures.js';
import { parseDocument } from './document.js';
import { RESOURCES } from './resources.js';
import { missingScopes, scopesFor } from './scopes.js';

describe('every resource names the scopes its routes require', () => {
  /*
   * The whole reason these live on the def rather than in a table: a new
   * resource cannot be added without answering this, and a route that moves
   * to a different scope is one edit beside the route. A `--for` answer
   * derived from a list somebody maintains separately is the thing FormFlow
   * is complaining about.
   */
  it.each(RESOURCES.map((d) => [d.type, d] as const))('%s', (_type, def) => {
    expect(def.readScope).toBeTypeOf('string');
    expect(def.writeScope).toBeTypeOf('string');
  });
});

describe('what a command needs', () => {
  const ONE = parseDocument(doc({ docsSources: [{ label: 'handbook' }] }));

  it('narrows plan to the resources the document declares', () => {
    expect(scopesFor('plan', ONE)).toEqual(['kb:read', 'workspace:read']);
  });

  it('adds the write scope for apply, and only for apply', () => {
    expect(scopesFor('apply', ONE)).toEqual(['kb:read', 'kb:write:sources', 'workspace:read']);
  });

  /*
   * `readLive` fetches a REFERENCED type too — a botRoutes-only document
   * still reads `/v1/bots` to resolve `bot:` — so a key without
   * `triggers:read` fails on a file that declares no bots at all.
   */
  it('includes a type the document only references', () => {
    const routes = parseDocument(doc({ botRoutes: [{ name: 'r', bot: 'support' }] }));
    expect(scopesFor('plan', routes)).toContain('triggers:read');
  });

  it('widens to every resource when there is no document', () => {
    expect(scopesFor('plan').length).toBeGreaterThan(scopesFor('plan', ONE).length);
  });

  it('answers doctor from its three reads, ignoring the document', () => {
    expect(scopesFor('doctor', ONE)).toEqual([
      'channels:read',
      'uploads:create',
      'workspace:read',
    ]);
  });
});

describe('what counts as held', () => {
  it('accepts the wildcard', () => {
    expect(missingScopes(['*'], ['kb:read', 'anything'])).toEqual([]);
  });

  it('names exactly what is short, in the order asked', () => {
    expect(missingScopes(['kb:read'], ['kb:read', 'kb:write:sources', 'workspace:read'])).toEqual([
      'kb:write:sources',
      'workspace:read',
    ]);
  });

  /*
   * `IMPLIED_BY` in `@livechat/shared/permissions`. Restated in `scopes.ts`
   * because that package is private and this one is published — so this test
   * is the thing that notices if a third implication is added there and not
   * here, by failing the day somebody adds it to the list below.
   */
  it.each([
    ['kb:write:sources', 'kb:write'],
    ['contacts:write:events', 'contacts:write'],
  ])('treats %s as held by a key with %s', (child, parent) => {
    expect(missingScopes([parent], [child])).toEqual([]);
  });

  it('does not invent an implication in the other direction', () => {
    expect(missingScopes(['kb:write:sources'], ['kb:write'])).toEqual(['kb:write']);
  });
});
