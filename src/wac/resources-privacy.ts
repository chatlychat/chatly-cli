/**
 * The data-rights opt-in as a managed resource (ForgeDeck 2026-11-05 item 10).
 *
 * Its own file because `resources.ts` reached the 650-line ceiling, and this
 * is the right thing to move: every other entry there is an ordinary
 * `GET`/`POST`/`PATCH`/`DELETE` resource, and this one needs two fields no
 * other resource uses. The next resource whose route shape is unusual belongs
 * here too rather than back in the table.
 */
import { SERVER_OWNED } from './resource-shared.js';

import type { ResourceDef } from './resource-def.js';

export const PRIVACY_PARTNERS: ResourceDef =
  /*
   * ═══ THE DATA-RIGHTS OPT-IN ════════════════════════════════════════════
   *
   * ForgeDeck 2026-11-05 item 10: the opt-in was the one piece of a privacy
   * integration a document could not hold, so a cutover was `chatly apply`
   * for everything else and a hand-written curl for the thing the audit
   * actually asks about.
   *
   * Three ways this resource is unlike every other one here, all of them
   * forced by the route rather than chosen:
   *
   *  1. `existsWhen`. `GET /v1/privacy/partners` enumerates the whole
   *     provider REGISTRY and flags each `enabled`, so without the filter
   *     every provider nobody opted into looks like an orphan to `--prune`.
   *  2. `create` is a PUT. The opt-in is an upsert keyed on the provider, so
   *     create and update are one route; there is no POST.
   *  3. `provider` is both the natural key and the id, so the key is known
   *     before the server has seen the row — which is what makes (2) legal.
   *
   * `completionSecret` is a `whsec_` secret and never reads back, so it is
   * listed in `opaque`: a plan cannot tell whether it changed, and says so
   * rather than rewriting it on every apply.
   *
   * ─── AND `secrets` IS EMPTY, WHICH IS THE WHOLE POINT ──────────────────
   *
   * It listed `completionSecret` until 2026-11-05 on the argument that the
   * entry was "DEFENSIVE and inert — kept listed so the banner would fire if
   * the response shape ever grew one". **It was not inert.** `def.secrets`
   * drives a line in `planCreate` (`wac/diff.ts`), so `plan` and `apply` both
   * printed "the create response carries a one-time completionSecret — `apply`
   * prints it once and writes it nowhere" — and then `apply` printed no secret
   * and `--json` showed `"secrets": []`, because there has never been one to
   * print. ForgeDeck reported that absence twice: once as a missing feature,
   * then again as a false promise. Someone following the line waits for a
   * secret that never comes, or concludes they lost it.
   *
   * It cannot ever arrive, by design: this value is an INPUT the operator
   * holds (the partner's own `whsec_`), and the route answers
   * `privacyPartnerBindingSchema`, which carries the boolean
   * `completionSecretSet` and never the secret. `harvestSecrets` scans a write
   * RESPONSE, so it was always scanning for something absent.
   *
   * Nothing replaces the line, because the `opaque` entry already prints the
   * true version — "completionSecret is write-only: sent on this create and
   * never readable afterwards" — which says the CALLER sends it.
   *
   * The cost of the empty list is real and accepted: if the response shape
   * ever does grow a minted secret, no banner fires. That is the right way
   * round. A promise of a secret that does not exist misleads every reader
   * today; a missing banner would mislead nobody until the day someone changes
   * the response schema, and that change is where the list should be revisited.
   *
   * The one-time credential a cutover actually needs comes from
   * `POST /v1/privacy/partners/{provider}/{externalId}/executor-key` — a
   * different route, and setup.md step 4.
   */
  {
    type: 'privacyPartners',
    label: 'privacy partner',
    naturalKey: 'provider',
    keySource: 'authored',
    keyEnforced: true,
    list: { path: '/v1/privacy/partners', paged: false },
    existsWhen: (row) => row['enabled'] === true,
    idField: 'provider',
    create: { path: '/v1/privacy/partners/{id}', method: 'PUT' },
    update: [{ method: 'PUT', path: '/v1/privacy/partners/{id}' }],
    /*
     * A PUT with no `completionsUrl` clears it, so this IS a full replace and
     * `plan` must say so on every change — the alternative is a document that
     * silently drops a completion endpoint it never mentioned.
     */
    fullReplace: true,
    // DELETE disables the opt-in; the registry row itself is not deletable.
    remove: { path: '/v1/privacy/partners/{id}' },
    removeBlocked: undefined,
    opaque: ['completionSecret'],
    /*
     * `provider` is the natural key and is checked by the key machinery;
     * `cbid` is an ordinary required body field and was not checked anywhere.
     */
    requiredFields: ['cbid'],
    /*
     * The two rules the route enforces that no generic check could see.
     *
     * ForgeDeck 2026-11-05 items 3 and 4: a document pointing `completionsUrl`
     * at `evil.example.com` planned as `create` and exited 0, and so did one
     * setting a URL with no `completionSecret` — the first then failed at apply
     * with `The completions URL must be on cookiemunch.net`, and the second
     * answered 200 while discarding the URL, so every rerun reported a
     * difference it would not explain.
     *
     * The host list is NOT hardcoded here: `completionHostSuffixes` is on every
     * row the list route returns (added to the API in the same change, because
     * the only way to learn the rule used to be to break it). So this warning
     * follows the server if the registry gains a host, which is the difference
     * between a check and a second copy of the rule.
     */
    extraWarnings: (rows, liveRows) => {
      const out: string[] = [];
      const suffixes = liveRows.flatMap((r) =>
        Array.isArray(r['completionHostSuffixes']) ? (r['completionHostSuffixes'] as string[]) : [],
      );
      for (const row of rows) {
        const url = row.body['completionsUrl'];
        if (typeof url !== 'string' || url === '') {
          continue;
        }
        if (row.body['completionSecret'] === undefined) {
          out.push(
            `privacyPartners/${row.key}: \`completionsUrl\` is set with no ` +
              '`completionSecret`, which the server refuses — a URL with nothing to sign ' +
              'with reports nothing. Add the `whsec_…` the provider gave you.',
          );
        }
        // Only when the server told us the rule; an empty list is no evidence.
        if (suffixes.length === 0) {
          continue;
        }
        let host: string;
        try {
          host = new URL(url).hostname.toLowerCase();
        } catch {
          out.push(
            `privacyPartners/${row.key}: \`completionsUrl\` is not a URL, so the write ` +
              'will be refused.',
          );
          continue;
        }
        // Label boundary, as the server matches: `evilcookiemunch.net` is not a subdomain.
        if (!suffixes.some((suf) => host === suf || host.endsWith(`.${suf}`))) {
          out.push(
            `privacyPartners/${row.key}: \`completionsUrl\` is on \`${host}\`, and this ` +
              `server only accepts ${suffixes.join(' or ')} (or a subdomain). The write will ` +
              'be refused.',
          );
        }
      }
      return out;
    },
    secrets: [],
    /*
     * Everything the list route computes. `externalId` is the workspace id,
     * `executorKeyUrl` is derived from the provider, and the four `last*`
     * and `*Set` fields are audit state no write schema accepts.
     */
    unwritable: [
      ...SERVER_OWNED,
      'label',
      'enabled',
      'externalId',
      'executorKeyUrl',
      'lastMintedAt',
      'completionSecretSet',
      'supportsCompletions',
      // Published so `plan` can check a completionsUrl host; never settable.
      'completionHostSuffixes',
      'lastSignedCompletionAt',
    ],
  };
