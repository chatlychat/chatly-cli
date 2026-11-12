/**
 * What the ROUTE DECLARES will be refused, read out of `field-rules.generated.ts`.
 *
 * Split from `diff-warnings.ts` when these checks took that file to 671 lines.
 * The seam is the one that matters in this area: everything here is derived
 * from the OpenAPI document the API is built from, and everything left behind
 * is a HEURISTIC over live rows — `vocabularyWarnings` guesses a misspelling
 * from what other rows happen to carry, and these functions know. When the two
 * disagreed, both ran and an integrator got two warnings for one typo, so
 * `sectionWarnings` now runs the heuristic only where no declared rules exist.
 *
 * The invariant to keep: a check in here may only claim what the document
 * states. A wrong list warns about a document the server accepts, which is
 * worse than silence — that is why `types` omits a field whose shape varies
 * between union arms rather than picking one.
 */
import { ROUTE_FIELD_RULES, routeKey, type RouteFieldRules } from './field-rules.generated.js';
import { article, jsonTypeOf, stringRuleMiss, typeSatisfies } from './field-types.js';
import { routeForField } from './resource-def.js';

import type { DocumentAction } from './diff-warnings.js';
import type { DocumentRow } from './document.js';
import type { ResourceDef } from './resources.js';

/** The create route's rules, or the update route's where there is no create. */
export function rulesFor(def: ResourceDef): RouteFieldRules | undefined {
  const create = def.create;
  if (create !== null && create !== undefined) {
    const got = ROUTE_FIELD_RULES[routeKey(create.method ?? 'POST', create.path)];
    if (got !== undefined) {
      return got;
    }
  }
  // `emailTemplates` has no POST: all five kinds always exist, so every write
  // is an update and the PUT body is the only contract there is.
  const first = def.update?.[0];
  return first === undefined
    ? undefined
    : ROUTE_FIELD_RULES[routeKey(first.method ?? 'PATCH', first.path)];
}

/**
 * The rules of the route this FIELD will actually be sent to.
 *
 * ForgeDeck 2026-11-07 item 3, reproduced twice. `rulesFor` returns the POST
 * route's rules for creates and updates alike, and on `POST /v1/bots` —
 * a union body — `systemPrompt`'s `minLength` lives inside the arms and not
 * in the merged table. So a document updating a live bot to
 * `systemPrompt: 'short'` planned clean with `plan=2`, and `apply` answered
 * `PATCH /v1/bots/<id> — Invalid request body (systemPrompt: String must
 * contain at least 20 character(s))`. The generated table HAD the right
 * answer the whole time: `'PATCH /v1/bots/{}'` carries
 * `systemPrompt: { min: 20, max: 20000 }`. Nothing read that entry.
 *
 * PER FIELD, not per row, because an update row's fields do not all go to one
 * route: `routeForField` sends a bot's `webhookUrl` to
 * `/v1/bots/{id}/external` and everything else to `/v1/bots/{id}`, and
 * checking the latter's rules against the former's body is the same class of
 * mistake one level down.
 *
 * Falls back to `rulesFor` whenever the update route has no entry of its own,
 * which keeps every resource whose rules only exist on the create route
 * behaving exactly as before.
 */
export function rulesForField(
  def: ResourceDef,
  action: DocumentAction,
  field: string,
): RouteFieldRules | undefined {
  if (action !== 'update') {
    return rulesFor(def);
  }
  const route = routeForField(def, field);
  if (route === undefined) {
    return rulesFor(def);
  }
  return (
    ROUTE_FIELD_RULES[routeKey(route.method ?? 'PATCH', route.path)] ??
    // `undefined` here would mean "no rules", which silently DROPS every check
    // for a resource whose update route is simply not in the table. The create
    // route's rules are the behaviour this replaced, so they are the floor.
    rulesFor(def)
  );
}

function requiredFor(def: ResourceDef): ReadonlyArray<string> {
  /*
   * A hand-written `requiredFields` still wins where one is declared, so a
   * resource can narrow the generated list — `privacyPartners` declares
   * `['cbid']` and the generator independently produced the same, which is
   * how the table was checked on arrival.
   */
  if (def.requiredFields !== undefined && def.requiredFields.length > 0) {
    return def.requiredFields;
  }
  const rules = rulesFor(def);
  if (rules === undefined) {
    return [];
  }
  // The natural key is a path segment on some routes and a body field on
  // others; `diff.ts` supplies it either way, so it is never the document's
  // omission to report.
  return rules.required.filter((f) => f !== def.naturalKey);
}

/**
 * wire name → the field a DOCUMENT writes to supply it.
 *
 * `botRoutes` declares `references: { bot: { type: 'bots', wire: 'botId' } }`:
 * the document says `bot: 'fd-bot'` and `diff.ts` resolves the slug to a uuid
 * under `botId` at send time. So the route requiring `botId` is satisfied, and
 * reading `row.body.botId` says it is missing.
 *
 * Reported 2026-11-06: a valid `botRoutes` document warned that `botId` was
 * required, exited 3 as REFUSED — and then applied cleanly, so a pipeline
 * gating on exit 3 stopped on a good file. The advice was worse than the
 * false alarm: it told the author to set `botId`, the environment-pinned uuid
 * the reference exists to keep out of the document.
 */
export function wireToRefKey(def: ResourceDef): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [key, ref] of Object.entries(def.references ?? {})) {
    out.set(ref.wire, key);
  }
  return out;
}

/**
 * ADVISORY, and deliberately not part of `sectionWarnings`.
 *
 * `refusedRowKeys` decides what the server will refuse by testing whether ANY
 * warning starts with a row's prefix — prose matching, which is what
 * `rowPrefix` exists for. An unknown field is the one per-row warning that is
 * NOT a refusal prediction: the route accepts the write and strips the key, so
 * `apply` exits 0. Routed through `sectionWarnings` it made `plan` exit 3 on a
 * document that applies cleanly, which is the sixth report's defect arriving
 * from the opposite direction — caught here by a test written to assert it
 * could not happen.
 *
 * `diff.ts` appends these after the refusing warnings for the same section and
 * keeps them out of what `refusedRowKeys` reads.
 */
/**
 * A field name the route does not have.
 *
 * ForgeDeck's eighth report, 2026-11-06 item 3: a macro written with
 * `content` instead of `body` planned clean and `apply` answered `body: A
 * macro needs reply text…`, because a non-strict zod object STRIPS an unknown
 * key — the document asked for one thing and the server stored another, with
 * nothing anywhere saying so. That is this repo's own "wire field name drift"
 * in a customer's config file.
 *
 * Skipped entirely when the body is `loose` (it takes unknown keys, or
 * declares no properties): warning there would flag every field.
 */
export function unknownFieldWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
): ReadonlyArray<string> {
  const rules = rulesFor(def);
  if (rules === undefined || rules.loose) {
    return [];
  }
  const known = knownFields(def, rules);
  const out: string[] = [];
  for (const row of rows) {
    const unknown = Object.keys(row.body).filter((f) => !known.has(f));
    if (unknown.length === 0) {
      continue;
    }
    const names = unknown.map((f) => `\`${f}\``).join(', ');
    const one = unknown.length === 1;
    out.push(
      rules.strict
        ? `${rowPrefix(def, row.key)}${names} ${one ? 'is not a field' : 'are not fields'} on ` +
            `this resource, and this route REFUSES a body carrying one, so the write will be ` +
            `refused and nothing will be written. Correct the spelling; the fields it accepts: ` +
            `${[...rules.allowed].sort().join(', ')}.`
        : `${rowPrefix(def, row.key)}${names} ${one ? 'is not a field' : 'are not fields'} on ` +
            `this resource. This route accepts the body and DROPS ${one ? 'it' : 'them'}, so ` +
            `${one ? 'it' : 'they'} will never take effect and never read back — \`plan\` and ` +
            `\`apply\` both ignore ${one ? 'it' : 'them'} so a rerun settles. Correct the ` +
            `spelling; the fields it accepts: ${[...rules.allowed].sort().join(', ')}.`,
    );
  }
  return out;
}

/**
 * Whether a route REFUSES an undeclared key, so `diff.ts` can count a strict
 * route's unknown field as a refusal and a dropping route's as advice.
 *
 * Reported 2026-11-06: `POST /v1/customer-cards` is `.strict()` and answers
 * `Unrecognized key(s) in object: 'bogus'` with nothing written, while the CLI
 * had called the field "silently DROPPED… the row will apply without it".
 * Both halves were wrong for that route and right for `macros`.
 */
export function strictUnknownFieldKeys(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
): ReadonlyArray<string> {
  const rules = rulesFor(def);
  if (rules === undefined || rules.loose || !rules.strict) {
    return [];
  }
  const known = knownFields(def, rules);
  return rows
    .filter((row) => Object.keys(row.body).some((f) => !known.has(f)))
    .map((row) => row.key);
}

/**
 * The fields a document may legitimately carry for this resource.
 *
 * The create body, every update body, the natural key, the id, and the fields
 * the server owns — an `unwritable` field already has its own warning and must
 * not collect a second one calling it unknown.
 */
function knownFields(def: ResourceDef, rules: RouteFieldRules): ReadonlySet<string> {
  return new Set<string>([
    ...rules.allowed,
    def.naturalKey,
    def.idField,
    ...(def.unwritable ?? []),
    ...Object.keys(def.references ?? {}),
    ...(def.update ?? []).flatMap((u) => {
      const r = ROUTE_FIELD_RULES[routeKey(u.method ?? 'PATCH', u.path)];
      return r === undefined ? [] : [...r.allowed];
    }),
  ]);
}

/**
 * Fields in this row that the route accepts and DISCARDS.
 *
 * `plan-row.ts` must not diff on one. Reported 2026-11-06: a macro carrying
 * `content` (the author meant `body`) applied, and then the read-back said the
 * row still differed, `apply` exited 1, the next `plan` said `1 to change`,
 * and the next `apply` wrote again — for ever, **writing to production on
 * every run** while the CLI called the field harmless. `content` is never in
 * the live row, so comparing it is `undefined` against `'hello'`: a change
 * that no write can settle.
 *
 * Empty for a STRICT route. There the row is refused and nothing is written,
 * so there is no read-back to protect and the refusal is the thing to report.
 */
export function droppedFields(
  def: ResourceDef,
  row: DocumentRow,
  live?: Record<string, unknown>,
): ReadonlySet<string> {
  /*
   * The CONDITIONAL discards first, and OUTSIDE the three early returns
   * below: a field a sibling value makes meaningless is discarded whatever
   * the route's unknown-key posture is, because the route declares it as a
   * real field and the row is accepted either way. `preset` and `url` on an
   * AI tool are both in `POST /v1/ai/tools`'s allowed set, so `known.has`
   * answers true and the generic half can never reach them.
   */
  const out = new Set<string>(
    Object.keys(def.discards?.(row.body, live) ?? {}).filter((f) => row.body[f] !== undefined),
  );
  const rules = rulesFor(def);
  if (rules === undefined || rules.loose || rules.strict) {
    return out;
  }
  const known = knownFields(def, rules);
  for (const field of Object.keys(row.body)) {
    if (!known.has(field)) {
      out.add(field);
    }
  }
  return out;
}

/**
 * A field the route takes and throws away because of ANOTHER field's value.
 *
 * ADVISORY, and deliberately not routed through `sectionWarnings`, for the
 * reason written on `unknownFieldWarnings`: the write succeeds and `apply`
 * exits 0, so counting it as a refusal would make `plan` exit 3 on a document
 * the server accepts. The declaration is `ResourceDef.discards`; the reasons
 * are written where each rule is, in `resource-conditionals.ts`.
 */
export function discardedFieldWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
  liveFor: (key: string) => Record<string, unknown> | undefined,
): ReadonlyArray<string> {
  if (def.discards === undefined) {
    return [];
  }
  const out: string[] = [];
  for (const row of rows) {
    for (const [field, why] of Object.entries(def.discards(row.body, liveFor(row.key)))) {
      if (row.body[field] === undefined) {
        continue;
      }
      /*
       * No generic advice. It used to end `Remove it from the document.`,
       * which was WRONG for the first resource that needed a different
       * answer: a preset AI tool's `preset` and `url` are REQUIRED by the
       * create, so following that line turns the row into an invalid custom
       * tool the next time the workspace is built from empty (ForgeDeck
       * 2026-11-07, report 14 item 4). What to do about a discarded field
       * depends on the field, so each `why` says it.
       */
      out.push(
        `${rowPrefix(def, row.key)}${why}. So it will never take effect and never read back ` +
          '— `plan` and `apply` both leave it out of the comparison, which is what lets a ' +
          'rerun settle.',
      );
    }
  }
  return out;
}

/**
 * A field whose JSON type or enum value the route will refuse, on ANY resource.
 *
 * `privacyPartners` had this by hand for three fields; the help text and the
 * 0.9.9 changelog claimed it for every resource, and an integrator checked:
 * `name: 5` on a macro, `scope: 5`, `name: 5` on a brand, `ttlSeconds:
 * "sixty"` on a card, `enabled: "yes"` on a trigger and `eventTypes: 5` on a
 * webhook ALL planned clean and then failed at `apply`. Claiming a check the
 * code does not do is worse than not having it, because a pipeline is built on
 * the claim.
 *
 * Creates and updates both: unlike a required field, a wrong type in a PATCH
 * body is sent and refused.
 */
export function wrongTypeWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
  actionFor: (key: string) => DocumentAction,
): ReadonlyArray<string> {
  if (rulesFor(def) === undefined) {
    return [];
  }
  const out: string[] = [];
  for (const row of rows) {
    const action = actionFor(row.key);
    if (action !== 'create' && action !== 'update') {
      continue;
    }
    const problems: Problem[] = [];
    for (const [field, value] of Object.entries(row.body)) {
      // Per FIELD and inside the loop, because on an update each field is
      // bound for whichever route claims it — see `rulesForField`.
      const rules = rulesForField(def, action, field);
      if (rules === undefined) {
        continue;
      }
      const declared = rules.types[field];
      if (declared === undefined || value === undefined) {
        continue;
      }
      // The resource checks this field itself, with wording the table cannot
      // reach — see `ownTypeChecks`.
      if (def.ownTypeChecks?.includes(field) === true) {
        continue;
      }
      const parts = declared.split('|');
      const want = parts[0] ?? 'string';
      const rest = parts.slice(1);
      if (value === null) {
        // A null is only a problem where the field does NOT declare nullable.
        if (rest.length === 0 && want !== 'null') {
          problems.push({ text: `\`${field}\` is null and the route requires a ${want}`, want });
        }
        continue;
      }
      const got = jsonTypeOf(value);
      if (!typeSatisfies(want, got, value)) {
        problems.push({
          text:
            `\`${field}\` is ${article(got)} ${got} and the route requires ` +
            `${article(want)} ${want}`,
          want,
          got,
          value,
          // A closed set of values makes `Quote it.` the wrong advice even
          // where the type direction is right — see `advice`.
          allowedValues: rules.enums[field],
        });
        continue;
      }
      const allowedValues = rules.enums[field];
      if (
        allowedValues !== undefined &&
        typeof value === 'string' &&
        !allowedValues.includes(value)
      ) {
        problems.push({
          text: `\`${field}\` is \`${value}\`, which is not one of ${allowedValues
            .map((v) => `\`${v}\``)
            .join(', ')}`,
        });
        continue;
      }
      /*
       * Each ITEM of an array, against the field's item enum.
       *
       * The field-level enum check above cannot see this: it compares the
       * field's own value, and an array is never one of the members. So a
       * webhook's `eventTypes: ['conversation.nope']` planned clean and
       * exited 2 while `apply` answered `eventTypes.0: Invalid enum value`
       * (ForgeDeck 2026-11-06 item 1, reproduced twice).
       *
       * The INDEX is named, because that is what the server's own message
       * names and a long event list is otherwise a hunt.
       */
      /*
       * A string's declared length and form.
       *
       * After the enum check and before the item one: an enum member is a
       * string too, and a value outside a closed set is better described as
       * not being one of the members than as being the wrong length.
       */
      /*
       * ForgeDeck 2026-11-07 item 6. `name: ""` on a macro printed two lines
       * for one mistake: `requiredFieldWarnings` saying the field is required
       * and empty, and this length rule saying it must hold at least one
       * character. They fire on exactly the same condition and the required
       * one is the better sentence — it names the fix — so this one yields.
       * Both read `requiredFor`, so a resource that narrows its required list
       * cannot make them disagree.
       */
      const blankRequired =
        action === 'create' &&
        typeof value === 'string' &&
        value.trim() === '' &&
        requiredFor(def).includes(field);
      const miss = blankRequired ? undefined : stringRuleMiss(rules.strings[field], value);
      if (miss !== undefined) {
        problems.push({ text: `\`${field}\` must ${miss}` });
        continue;
      }
      const allowedItems = rules.itemEnums[field];
      if (allowedItems !== undefined && Array.isArray(value)) {
        // `Array.isArray` narrows an `unknown` to `any[]`, so the item needs
        // saying: the values here are whatever the author's JSON held.
        const items: ReadonlyArray<unknown> = value;
        const bad = items
          .map((v, i) => ({ v, i }))
          .filter(({ v }) => typeof v !== 'string' || !allowedItems.includes(v));
        if (bad.length > 0) {
          problems.push({
            text:
              `\`${field}\` ${bad
                .map(({ v, i }) => `[${String(i)}] = \`${String(v)}\``)
                .join(', ')} ${bad.length === 1 ? 'is' : 'are'} not ` +
              // `one of` / `among`: the singular had dropped its `of` and read
              // "is not one the values" (ForgeDeck 2026-11-07 item 3).
              `${bad.length === 1 ? 'one of' : 'among'} the values this route accepts ` +
              `(${allowedItems.map((v) => `\`${v}\``).join(', ')})`,
          });
        }
      }
    }
    if (problems.length > 0) {
      out.push(
        `${rowPrefix(def, row.key)}${problems.map((p) => p.text).join('; ')}, ` +
          `so the write will be refused.${advice(problems)}`,
      );
    }
  }
  return out;
}

/**
 * One wrong value, with the types that produced it rather than only its text.
 *
 * It carries `want`/`got`/`value` because `advice` has to decide from them.
 * It used to decide from the SENTENCE — appending `Quote it.` whenever the
 * text contained `a number` or `a boolean` — and that sentence names BOTH the
 * type the document has and the type the route wants, so it fired on three
 * cases where quoting is the mistake (ForgeDeck 2026-11-06 item 2, reproduced
 * twice): `enabled: "yes"` where a boolean is wanted (already quoted, and the
 * quoting IS the bug), `ttlSeconds: 1.5` where an integer is wanted (`"1.5"`
 * is refused too), and `eventTypes: 5` where an array is wanted.
 */
interface Problem {
  readonly text: string;
  readonly want?: string;
  readonly got?: string;
  readonly value?: unknown;
  /** The closed set of values the field accepts, where it declares one. */
  readonly allowedValues?: ReadonlyArray<string>;
}

/**
 * The one-line fix, where there is one that is actually a fix.
 *
 * Quoting helps in exactly one direction: the route wants a STRING and the
 * document has a number or a boolean. Everything else needs a different
 * value, not different punctuation, and `resources-privacy.ts` already had
 * this written down — "`Quote it` is the fix for a scalar and nonsense for a
 * container" — while this function ignored it.
 *
 * A fraction where a whole number belongs gets its own line, because it is
 * the one case where the author is in the right TYPE and the wrong value, and
 * "the route requires an integer" does not say what to do about `1.5`.
 */
function advice(problems: ReadonlyArray<Problem>): string {
  const out: string[] = [];
  const quotable = problems.filter(
    (p) => p.want === 'string' && (p.got === 'number' || p.got === 'boolean'),
  );
  /*
   * A field with a CLOSED SET of values is the third case where quoting is a
   * dead end, and the only one the type direction cannot reveal (ForgeDeck
   * 2026-11-07 item 2, reproduced twice). `scope: 5` on a macro wants a
   * string and has a number, so the rule below fires — and `"5"` is refused
   * too, by the enum. Following the advice produced a second plan that failed
   * for a different reason, which is worse than giving no advice at all.
   *
   * The allowed values go in its place. They are NOT reachable from the enum
   * check in `wrongTypeWarnings`: that one compares the field's own value and
   * only runs once the type is right, so it never sees `5`.
   */
  const closed = quotable.filter((p) => p.allowedValues !== undefined);
  out.push(
    ...closed.map(
      (p) => `It must be one of ${(p.allowedValues ?? []).map((v) => `\`${v}\``).join(', ')}.`,
    ),
  );
  if (quotable.length > closed.length) {
    out.push('Quote it.');
  }
  if (
    problems.some(
      (p) =>
        p.want === 'integer' &&
        p.got === 'number' &&
        typeof p.value === 'number' &&
        !Number.isInteger(p.value),
    )
  ) {
    out.push('Round it to a whole number — quoting it does not help.');
  }
  return out.length === 0 ? '' : ` ${out.join(' ')}`;
}

/**
 * A required field the document omits, or sets to something empty.
 *
 * ForgeDeck 2026-11-05 item 4, reproduced twice: a `privacyPartners` row with
 * no `cbid` and one with `cbid: ""` both planned as `create` and exited 0, and
 * `apply` then failed with `cbid: Required` and `String must contain at least
 * 1 character(s)`. Both facts were in the document the whole time.
 *
 * Only on rows this plan would CREATE, which is why `liveKeys` is taken: an
 * update sends a partial body and a field absent from it is "leave as stored",
 * so warning there would fire on every narrow edit. An empty STRING is checked
 * as well as an absent key because `""` passes a presence test and fails the
 * route, which is the second of the two reported cases.
 */
export function requiredFieldWarnings(
  def: ResourceDef,
  rows: ReadonlyArray<DocumentRow>,
  actionFor: (key: string) => DocumentAction,
): ReadonlyArray<string> {
  const required = requiredFor(def);
  if (required.length === 0) {
    return [];
  }
  const wires = wireToRefKey(def);
  const out: string[] = [];
  for (const row of rows) {
    /*
     * CREATE only, which this function's docblock promised and did not do —
     * it took no action argument at all. Harmless while `privacyPartners` was
     * the only resource with a list, because that route requires `cbid` on
     * every write; the moment `macros` arrived, whose PATCH body is partial,
     * it would have warned on every narrow edit. Exactly what the docblock
     * said must not happen.
     */
    if (actionFor(row.key) !== 'create') {
      continue;
    }
    const blank = (v: unknown): boolean =>
      v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    /*
     * A required wire name counts as present when the reference that supplies
     * it is present, and is NAMED by the document's own field when neither is
     * — `bot` is what an author can set, `botId` is not.
     */
    /*
     * `row.refs` is keyed by the WIRE name, not by the document's field: the
     * parser lifts `bot: '<slug>'` out of the body into `refs.botId`, so
     * `row.body` carries neither name and a presence test on either is false.
     * The first version of this fix read `row.body[refKey]` and still warned
     * on a valid document — caught by a test the control had just proved real.
     */
    const missing = required
      .filter((f) => blank(row.body[f]) && row.refs[f] === undefined)
      .map((f) => wires.get(f) ?? f);
    if (missing.length > 0) {
      out.push(
        `${rowPrefix(def, row.key)}${missing.map((f) => `\`${f}\``).join(', ')} ` +
          `${missing.length === 1 ? 'is' : 'are'} required and ` +
          `${missing.length === 1 ? 'is' : 'are'} missing or empty, so the write will be ` +
          'refused. Set it in the document before applying.',
      );
    }
  }
  return out;
}

/*
 * `rowPrefix` lives HERE rather than in `diff-warnings.ts`, where it was,
 * because both modules need it and the other direction is a runtime import
 * cycle — `check-import-cycles` caught it the moment these checks were split
 * out. `resources.ts` would be the other natural home and is at 632 lines.
 */
export function rowPrefix(def: ResourceDef, key: string): string {
  return `${def.type}/${key}: `;
}
