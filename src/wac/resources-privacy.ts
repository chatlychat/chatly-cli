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

/**
 * `cbid`, `completionsUrl` and `completionSecret` are all `z.string()` at the
 * route, so a non-string of any JSON type is `Expected string, received
 * <type>` — ForgeDeck's seventh report, 2026-11-06 item 1, reproduced twice
 * for a number and seen once each for a boolean, an array and an object. Only
 * `cbid` was checked; the other two guarded with `typeof x === 'string'`,
 * which SKIPS a wrong type instead of reporting it, so `plan` said
 * `0 that cannot be applied` and `apply` exited 1.
 *
 * `null` is never flagged here. For `completionsUrl` it is the documented off
 * switch; for the other two `requiredFields` already answers absent, null and
 * blank, and a second message about the same field sends the reader looking
 * for two problems.
 *
 * An array is reported as `array`, not `object` — that is what zod and
 * therefore the route's own refusal says, and a warning that names a
 * different type than the error sends the reader to the wrong line.
 */
function wrongJsonType(
  where: string,
  field: string,
  value: unknown,
  sent: boolean,
): string | undefined {
  if (value === undefined || value === null || typeof value === 'string') {
    return undefined;
  }
  const kind = Array.isArray(value) ? 'array' : typeof value;
  // "Quote it" is the fix for a scalar and nonsense for a container.
  const advice = kind === 'number' || kind === 'boolean' ? ' Quote it.' : '';
  const article = kind === 'array' || kind === 'object' ? 'an' : 'a';
  /*
   * ForgeDeck's EIGHTH report, 2026-11-06 item 1: this said "the write will be
   * refused" on a row `apply` does not send, which is the mismatch the
   * SEVENTH report fixed for the stray-secret message ONE BRANCH BELOW. The
   * wording was taken from a rule that is always sent and reused by a rule
   * that is not. A credential is excluded from the diff, so a wrong-type
   * `completionSecret` on an otherwise-matching row plans as `unchanged` and
   * nothing is written.
   *
   * Still worth saying: the document is wrong either way, and a reader who
   * fixes the row later wants to know now.
   */
  return sent
    ? `${where}: \`${field}\` is ${article} ${kind} and the route requires a string, so the ` +
        `write will be refused.${advice}`
    : `${where}: \`${field}\` is ${article} ${kind} and the route requires a string, so it ` +
        `would be refused if sent — it is not sent on this run.${advice}`;
}

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
    readScope: 'workspace:read',
    writeScope: 'workspace:write',
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
     * This resource warns about these three itself, below, worded by whether
     * the row is SENT. Without this the generic table check fires too and
     * every one printed twice.
     */
    ownTypeChecks: ['cbid', 'completionsUrl', 'completionSecret'],
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
    extraWarnings: (rows, liveRows, willSend) => {
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
         * All three string fields, in document order. `requiredFields`
         * catches absent, null and blank; a wrong TYPE passes all three.
         */
        const sent = willSend(row.key);
        for (const field of ['cbid', 'completionsUrl', 'completionSecret'] as const) {
          const message = wrongJsonType(where, field, row.body[field], sent);
          if (message !== undefined) {
            out.push(message);
          }
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
          /*
           * Two wordings, because the same document is two different things
           * depending on whether this row is sent. ForgeDeck's seventh report,
           * item 2: on an unchanged row `apply` sends nothing and exits 0, so
           * "the server refuses it" describes an exchange that never happens.
           * Under `--write-only` the secret IS sent and the server DOES refuse
           * it, which is why this asks the plan rather than comparing fields.
           */
          out.push(
            sent
              ? `${where}: \`completionSecret\` is set with no \`completionsUrl\`, and none is ` +
                  'stored, so the server refuses it — a secret with nowhere to report signs ' +
                  'nothing.'
              : `${where}: this secret is not sent — there is no \`completionsUrl\` for it to ` +
                  'sign, and nothing else on this row changed. Add the URL, or drop the secret ' +
                  'from the document.',
          );
        }

        /*
         * PRESENCE, not truthiness. `null` is the documented off switch and
         * must stay silent; `''` is a value the route refuses
         * (`completionsUrl: Invalid url`) and used to skip every check below
         * it, so `plan` exited 2 and `apply` then failed — ForgeDeck's sixth
         * report, 2026-11-06 item 2, reproduced twice. An empty string now
         * falls through to `new URL('')`, which throws, which is the same
         * "must be a public https URL" the server answers for `not a url`.
         */
        if (typeof url !== 'string') {
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
        /*
         * ForgeDeck's eighth report item 4: `completionSecret: null` beside a
         * good URL planned clean and `apply` answered 400. The route resolves
         * `input.completionSecret === undefined ? stored : input.completionSecret`
         * (privacy-partner.service.ts:222) and then refuses a non-null URL
         * with a null secret — so an EXPLICIT null is not "leave it alone", it
         * overrides a stored secret too. That is why `completionSecretSet`
         * only rescues the ABSENT case.
         *
         * A comment here used to claim `requiredFields` covered absent, null
         * and blank for this field. `requiredFields` lists `cbid` and nothing
         * else; it never saw this one.
         */
        const stored = live?.['completionSecretSet'] === true;
        const secretResolvesNull = secret === null || (secret === undefined && !stored);
        if (secretResolvesNull) {
          /*
           * Worded by whether the row is SENT and by whether a secret is
           * actually stored — the third of the three warnings in this file to
           * need it, reported 2026-11-06 after the other two were fixed.
           *
           * The unchanged-row case is the one that read falsely: a credential
           * is kept out of the diff, so a row carrying only an explicit
           * `completionSecret: null` plans as `unchanged`, nothing is sent,
           * and the line claimed the server refuses it AND that none is
           * stored while one was.
           */
          out.push(
            sent
              ? `${where}: \`completionsUrl\` is set and \`completionSecret\` resolves to ` +
                  `null${stored ? ' (an explicit null overrides the stored one)' : ' and none is stored'}, ` +
                  'so the server refuses it — a URL with nothing to sign with reports nothing. ' +
                  'Add the `whsec_…` the provider gave you.'
              : `${where}: \`completionSecret\` is null, which would leave \`completionsUrl\` ` +
                  'with nothing to sign with and be refused if sent — this row is unchanged, so ' +
                  'nothing is sent on this run. A credential is never part of the diff; pass ' +
                  '`--write-only` to send it.',
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
