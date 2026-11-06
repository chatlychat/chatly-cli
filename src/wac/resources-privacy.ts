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
     * The route's own rules, run in `plan` instead of discovered at `apply`.
     *
     * ForgeDeck's fifth report, 2026-11-06 item 3, reproduced twice: seven
     * documents each planned as `1 to create … 0 that cannot be applied`,
     * exited 2 exactly as a good change does, and then `apply` refused every
     * one of them. Every fact needed was in the document.
     *
     * ─── THE HOST LIST COMES FROM THE SERVER, AND USED TO ARRIVE EMPTY ────
     *
     * `completionHostSuffixes` is on every row the list route returns, so this
     * is a CHECK and not a second copy of the rule — a registry that gains a
     * host needs no CLI release. But `extraWarnings` was handed `live.rows`,
     * which has had `existsWhen` applied, and `existsWhen` is
     * `row.enabled === true`. On a FIRST create the only row carrying the
     * rules is the unbound one, with `enabled: false`, so the list arrived
     * empty and every rule keyed on it did nothing — on exactly the call that
     * needed it most. It takes the UNFILTERED answer now.
     *
     * An empty list is still treated as NO EVIDENCE rather than as permission
     * to warn, so a server that does not publish the field produces no host
     * warnings instead of refusing every URL.
     *
     * ─── MIRRORED IN THE SERVER'S ORDER ──────────────────────────────────
     *
     * `checkCompletionsUrl` (`privacy-partner-registry.ts`) tests parse and
     * `https:` BEFORE the host, so an `http://` URL on a GOOD host is "must be
     * a public https URL" and not a host complaint. These warnings follow that
     * order, because a warning that names a different reason than the refusal
     * sends the reader to the wrong line of their document.
     *
     * NOT mirrored: `checkOutboundUrl`'s SSRF judgement. It resolves and
     * classifies the host, which a plan cannot do offline, so a private-range
     * URL still reaches `apply` and is refused there. Guessing at it here
     * would warn about URLs the server accepts.
     */
    fullReplaceNote:
      'the write sends every field this document declares. Fields you OMIT are kept as ' +
      'stored, not reset — to switch completions off, set `completionsUrl: null` ' +
      'explicitly. (This resource is unlike the others: the route requires `cbid` on ' +
      'every write, so the whole row is always sent.)',
    extraWarnings: (rows, liveRows) => {
      const out: string[] = [];
      const WHSEC = /^whsec_[A-Za-z0-9+/_=-]{16,256}$/;
      const suffixes = liveRows.flatMap((r) =>
        Array.isArray(r['completionHostSuffixes']) ? (r['completionHostSuffixes'] as string[]) : [],
      );
      /** The live row for a provider, bound or not — the unfiltered answer has both. */
      const liveFor = (key: string) => liveRows.find((r) => String(r['provider'] ?? '') === key);

      for (const row of rows) {
        const where = `privacyPartners/${row.key}`;
        const url = row.body['completionsUrl'];
        const secret = row.body['completionSecret'];
        const live = liveFor(row.key);

        /*
         * `cbid` must be a string. `requiredFields` catches absent, null and
         * blank; a NUMBER passes all three and is `Expected string, received
         * number` at the route.
         */
        const cbid = row.body['cbid'];
        if (cbid !== undefined && cbid !== null && typeof cbid !== 'string') {
          out.push(
            `${where}: \`cbid\` is a ${typeof cbid} and the route requires a string, so the ` +
              'write will be refused. Quote it.',
          );
        }

        if (typeof secret === 'string' && !WHSEC.test(secret)) {
          out.push(
            `${where}: \`completionSecret\` is not a \`whsec_\` secret (16 to 256 of ` +
              '`A-Za-z0-9+/_=-` after the prefix), so the write will be refused. This is the ' +
              'value the provider gave you, not one you choose.',
          );
        }

        /*
         * A secret with nowhere to report. Only when the live row has no URL
         * stored either — the service resolves each half as "what the caller
         * sent, else what is stored", so rotating the secret of a live pair is
         * legitimate and must not warn.
         */
        if (
          secret !== undefined &&
          secret !== null &&
          (url === undefined || url === null) &&
          (live?.['completionsUrl'] ?? null) === null
        ) {
          out.push(
            `${where}: \`completionSecret\` is set with no \`completionsUrl\`, and none is ` +
              'stored, so the server refuses it — a secret with nowhere to report signs ' +
              'nothing.',
          );
        }

        if (typeof url !== 'string' || url === '') {
          continue;
        }

        /*
         * A URL with nothing to sign with — UNLESS a secret is already stored.
         *
         * ForgeDeck item 4: this warned on a document that the server accepts
         * and `apply` exits 0 on, because a stored secret satisfies the pair.
         * A warning that a safe, working document will fail is worse than
         * silence: it teaches the reader to ignore warnings.
         */
        if (secret === undefined && live?.['completionSecretSet'] !== true) {
          out.push(
            `${where}: \`completionsUrl\` is set with no \`completionSecret\` and none is ` +
              'stored, so the server refuses it — a URL with nothing to sign with reports ' +
              'nothing. Add the `whsec_…` the provider gave you.',
          );
        }

        // Parse and scheme first, as the server does.
        let host: string;
        try {
          const u = new URL(url);
          host = u.hostname.toLowerCase();
          if (u.protocol !== 'https:') {
            throw new Error('not https');
          }
        } catch {
          out.push(
            `${where}: \`completionsUrl\` must be a public https URL, so the write will be ` +
              'refused.',
          );
          continue;
        }
        // Only when the server told us the rule; an empty list is no evidence.
        if (suffixes.length === 0) {
          continue;
        }
        // Label boundary, as the server matches: `evilcookiemunch.net` is not a subdomain.
        if (!suffixes.some((suf) => host === suf || host.endsWith(`.${suf}`))) {
          out.push(
            `${where}: \`completionsUrl\` is on \`${host}\`, and this server only accepts ` +
              `${suffixes.join(' or ')} (or a subdomain). The write will be refused.`,
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
