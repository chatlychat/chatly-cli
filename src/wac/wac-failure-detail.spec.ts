/**
 * The failure line names the field the server named.
 *
 * ForgeDeck 2026-11-05 item 4, reproduced twice: `apply` printed only
 * `Invalid request body` for a document missing a required field, and
 * `--json` dropped it too, so the one piece of information that makes the
 * error actionable never reached the operator. The API had always sent it.
 */
import { describe, expect, it } from 'vitest';

import { describeWriteFailure } from './execute.js';

/** What the API actually puts on the wire: `wireError` over `ValidationError`. */
const apiError = (issues: unknown): Error & { body: string } =>
  Object.assign(new Error('Invalid request body'), {
    body: JSON.stringify({
      error: { code: 'validation_failed', message: 'Invalid request body', details: { issues } },
    }),
  });

describe('describeWriteFailure', () => {
  it('names a missing required field', () => {
    const text = describeWriteFailure(
      apiError([{ code: 'invalid_type', path: ['cbid'], message: 'Required' }]),
    );
    expect(text).toContain('cbid');
    expect(text).toContain('Required');
  });

  /*
   * `unrecognized_keys` is the one issue shape whose `path` is EMPTY — the
   * offending names are in `keys`. Reading the path alone would print nothing
   * and name no field, which is the case that produced item 1's report.
   */
  it('names a refused key, which carries an empty path', () => {
    const text = describeWriteFailure(
      apiError([
        {
          code: 'unrecognized_keys',
          keys: ['provider'],
          path: [],
          message: "Unrecognized key(s) in object: 'provider'",
        },
      ]),
    );
    expect(text).toContain('provider');
  });

  it('joins a nested path with dots', () => {
    expect(
      describeWriteFailure(apiError([{ path: ['config', 'origins'], message: 'Required' }])),
    ).toContain('config.origins');
  });

  /*
   * Silent on anything it cannot read. A failure line that invents structure
   * it did not find is worse than a terse one, so each of these keeps the
   * plain message and adds nothing.
   */
  it.each([
    ['no body at all', new Error('fetch failed')],
    ['a non-JSON body', Object.assign(new Error('Bad gateway'), { body: '<html>502</html>' })],
    ['a body with no issues', Object.assign(new Error('Forbidden'), { body: '{"error":{}}' })],
    ['an empty issue list', apiError([])],
  ])('falls back on %s', (_what, err) => {
    expect(describeWriteFailure(err)).toBe(err.message);
  });

  it('survives a thrown non-Error', () => {
    expect(describeWriteFailure('nope')).toBe('nope');
    expect(describeWriteFailure(null)).toBe('null');
  });
});
