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
   * listed in `secrets` AND `opaque`: a plan cannot tell whether it changed,
   * and says so rather than rewriting it on every apply.
   *
   * `opaque` does all the work; `secrets` is DEFENSIVE and inert here.
   * `harvestSecrets` scans a write RESPONSE, and this route answers
   * `privacyPartnerBindingSchema` — which carries `completionSecretSet`, a
   * boolean, and never the secret. It cannot: this value is an INPUT the
   * operator holds (the partner's own `whsec_`), not something Chatly mints.
   * ForgeDeck read the `secrets` entry as a promise that `apply` would print a
   * one-time secret and reported its absence. The one-time credential a
   * cutover actually needs comes from
   * `POST /v1/privacy/partners/{provider}/{externalId}/executor-key` — a
   * different route, and setup.md step 4. Kept listed so the banner would fire
   * if the response shape ever grew one.
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
    secrets: ['completionSecret'],
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
      'lastSignedCompletionAt',
    ],
  };
