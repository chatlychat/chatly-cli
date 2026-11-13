/**
 * ForgeDeck 2026-11-13, CH-16: a closed set of values ONE LEVEL DOWN.
 *
 * `identityVerification.tokenProvider: "atlsa"` planned as a clean change and
 * exited 2, and `apply` then answered 400 — although the served OpenAPI
 * document has listed the seven providers since the field existed. The enum
 * check read a top-level field's own value, and `config` is an object, so
 * nothing in the table could reach the typo.
 */
import { describe, expect, it } from 'vitest';

import { doc, live } from './__tests__/wac-fixtures.js';
import { buildPlan } from './diff.js';
import { parseDocument } from './document.js';
import { ROUTE_FIELD_RULES } from './field-rules.generated.js';

type Rows = Record<string, Array<Record<string, unknown>>>;
const planOf = (resources: Rows, liveRows: Rows = {}) =>
  buildPlan(parseDocument(doc(resources)), live(liveRows));
const text = (p: ReturnType<typeof buildPlan>) => p.warnings.join('\n');

const channel = (identityVerification: Record<string, unknown>) => ({
  key: 'web-main',
  name: 'Web',
  type: 'web',
  config: { identityVerification },
});

describe('the table carries nested enums by dotted path', () => {
  it('has the seven token providers under PATCH /v1/channels/{}', () => {
    const rules = ROUTE_FIELD_RULES['PATCH /v1/channels/{}'];
    expect(rules?.nestedEnums['config.identityVerification.tokenProvider']).toEqual([
      'generic',
      'atlas',
      'clerk',
      'auth0',
      'okta',
      'entra',
      'cognito',
    ]);
  });

  it('records no path for a top-level field — `enums` already holds those', () => {
    const rules = ROUTE_FIELD_RULES['POST /v1/macros'];
    expect(Object.keys(rules?.nestedEnums ?? {}).some((k) => !k.includes('.'))).toBe(false);
  });
});

describe('a typo in a nested enum (their CH-16)', () => {
  it('names the full path, the value and the accepted set, and refuses the row', () => {
    const plan = planOf({
      channels: [channel({ mode: 'oidc', tokenProvider: 'atlsa' })],
    });
    expect(text(plan)).toContain('`config.identityVerification.tokenProvider` is `atlsa`');
    expect(text(plan)).toContain('`clerk`');
    expect(text(plan)).toContain('so the write will be refused');
    expect(plan.refused).toEqual(['web-main']);
  });

  it('leaves a GOOD provider alone', () => {
    const plan = planOf({
      channels: [channel({ mode: 'oidc', tokenProvider: 'clerk' })],
    });
    expect(text(plan)).not.toContain('tokenProvider');
    expect(plan.refused).toEqual([]);
  });

  it('says nothing when the key is absent', () => {
    const plan = planOf({ channels: [channel({ mode: 'oidc' })] });
    expect(text(plan)).not.toContain('tokenProvider');
    expect(plan.refused).toEqual([]);
  });

  it('ignores a null, which is how a merge patch DELETES the key', () => {
    const plan = planOf({ channels: [channel({ tokenProvider: null })] });
    expect(text(plan)).not.toContain('tokenProvider');
    expect(plan.refused).toEqual([]);
  });

  it('does not walk into a value that is not an object', () => {
    const plan = planOf({
      channels: [
        { key: 'web-main', name: 'Web', type: 'web', config: { identityVerification: 7 } },
      ],
    });
    expect(text(plan)).not.toContain('tokenProvider');
  });

  it('catches a typo two levels down, not just under `identityVerification`', () => {
    const plan = planOf({
      channels: [
        { key: 'web-main', name: 'Web', type: 'web', config: { theme: { position: 'middle' } } },
      ],
    });
    expect(text(plan)).toContain('`config.theme.position` is `middle`');
    expect(plan.refused).toEqual(['web-main']);
  });
});
