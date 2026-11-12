/**
 * Rules whose answer depends on ANOTHER field in the same row.
 *
 * ForgeDeck 2026-11-07, items 2, 4 and 5. Every check in
 * `field-rules-checks.ts` reads one field against the route's declared rules
 * for that field, and these three cannot be written that way because what the
 * route does with the field is decided by a sibling value: `webhookUrl` is a
 * real field on `POST /v1/bots` and is kept only for `type: "external"`;
 * `teamId` is optional unless `scope` is `"team"`; a preset install's
 * `signingSecret` is optional unless that preset reads a verified identity.
 * None of it is in the OpenAPI document, so none of it can be generated.
 *
 * Its own file for the reason `resources-privacy.ts` is: `resources.ts` sits
 * at the 650-line ceiling and every entry in it is a plain declaration.
 */
import { asRecord, normaliseShortCode } from './resource-shared.js';

import type { ResourceDef } from './resource-def.js';

/**
 * "nothing is discarded", typed. A bare `{}` in one arm and a populated
 * literal in the other unify into a union with OPTIONAL keys, which is not
 * assignable to `Record<string, string>` — the one thing that makes these
 * three hooks need a named value at all.
 */
const NONE: Readonly<Record<string, string>> = {};

/** What `extraWarnings` is handed, narrowed to what these rules read. */
type Row = { readonly key: string; readonly body: Record<string, unknown> };

/**
 * The rows this plan will CREATE: sendable, and not already on the server.
 *
 * Its one user is create-only, and firing on an update would be a false
 * refusal — the shape of defect that cost ForgeDeck's eighth report a run on
 * a valid `botRoutes` file. The preset's `signingSecret` is required by the
 * install arm of `POST /v1/ai/tools` and an installed tool is already signed.
 *
 * The macro rule USED to be the second caller, on the same argument, and that
 * argument was wrong: it read the controller's refine instead of the service,
 * which enforces the pair on an update too. See `MACRO_WARNINGS`. The test
 * for "is this rule create-only" is what the SERVER does with an omitted
 * field, not which schema carries the refine.
 *
 * Derived rather than passed in, because `extraWarnings` is handed `willSend`
 * and that cannot tell a create from an update. The test is the one `planRow`
 * applies — no live row under the normalised key — and `willSend` is kept as
 * the first half so an unchanged row still warns about nothing.
 */
function creating(
  rows: ReadonlyArray<Row>,
  liveRows: ReadonlyArray<Record<string, unknown>>,
  keyField: string,
  willSend: (key: string) => boolean,
  norm: (key: string) => string = (k) => k,
): ReadonlyArray<Row> {
  const live = new Set(liveRows.map((r) => norm(String(r[keyField] ?? ''))));
  return rows.filter((r) => willSend(r.key) && !live.has(norm(r.key)));
}

/**
 * What the preset arm of `POST /v1/ai/tools` installs, hardcoded.
 *
 * The same kind of hardcode as `unwritable` and `requiredFields` beside it,
 * and for a hard reason: this package is PUBLISHED and `@livechat/shared` is
 * `private: true`, so the real `AI_TOOL_PRESETS` cannot be imported at
 * runtime — `commands/secret.ts` makes the same call for the same reason, and
 * `reference_published_package_internal_import` is what happens when it is
 * not made.
 *
 * `wac-report13.spec.ts` imports the real table (a devDependency is fine in a
 * spec) and asserts this one agrees on the ids, the tool names and which
 * presets need signing, so drift fails the build instead of reaching an
 * integrator.
 */
const PRESET_TOOL_NAMES: Readonly<Record<string, string>> = {
  order_lookup: 'order_lookup',
  referral_answers: 'referral_answers',
};

/** Presets with a parameter filled from a VERIFIED identity. */
const PRESETS_NEEDING_SIGNING_SECRET: ReadonlyArray<string> = ['referral_answers'];

/**
 * `preset` and `url` on an AI tool (ForgeDeck 2026-11-07 item 2).
 *
 * Neither is a column. The route expands the pair through
 * `presetToolCreateInput` into an ordinary tool — `name`, `description`,
 * `parameters`, `endpointUrl` — and keeps no record of which preset produced
 * it, so a read carries neither field. The PATCH body is the custom create
 * schema `.partial()` and strips both, which is the whole defect: the row
 * reported the same two changes on every run, `apply` wrote on every run, and
 * the second write hit the duplicate-name 500 this report's item 1 fixes.
 */
export const AI_TOOL_DISCARDS: NonNullable<ResourceDef['discards']> = (body, live) => {
  /*
   * NOTHING is discarded on a CREATE, and saying otherwise was its own
   * defect (ForgeDeck report 14 item 4). The preset arm REQUIRES both
   * fields: a new row was being told `preset` would never take effect and to
   * remove it, and following that advice leaves an invalid custom tool with
   * no `urlTemplate` and no `parameters`.
   *
   * `live === undefined` is exactly "this row is a create" — `planUpdate`
   * always has a live row, and `discardedFieldWarnings` passes
   * `liveFor(key)`, which misses only when nothing on the server matched.
   * Reading it here rather than taking an action argument keeps
   * `BOT_DISCARDS` warning on a create, which is right for it: the chatly
   * arm of `POST /v1/bots` really does accept those three fields and throw
   * them away.
   */
  if (live === undefined || typeof body['preset'] !== 'string') {
    return NONE;
  }
  return {
    preset:
      '`preset` is an install INSTRUCTION rather than a stored field: the route expands it ' +
      "into the tool's `name`, `description`, `parameters` and `urlTemplate` and keeps no " +
      'record of which preset it came from. Leave it in the document — it is what installs ' +
      'the tool on a workspace that does not have it yet',
    url:
      "`url` is that install's endpoint and reads back as `urlTemplate`, so a change to it " +
      'is NOT applied to a tool that already exists: this plan says `unchanged` and the old ' +
      "endpoint keeps being called. To move an installed preset's endpoint set " +
      '`urlTemplate` instead, which the PATCH does accept',
  };
};

/** Preset rules the generated table cannot state: see each message. */
export const AI_TOOL_WARNINGS: NonNullable<ResourceDef['extraWarnings']> = (
  rows,
  liveRows,
  willSend,
) => {
  const out: string[] = [];
  for (const row of creating(rows, liveRows, 'name', willSend)) {
    const preset = row.body['preset'];
    if (typeof preset !== 'string') {
      continue;
    }
    const where = `aiTools/${row.key}`;
    const toolName = PRESET_TOOL_NAMES[preset];
    /*
     * The row key must BE the preset's tool name (item 2). A `preset`
     * install ignores `name` entirely, so a row keyed `fd_t5` created a tool
     * called `order_lookup`: the create succeeded, `fd_t5` never appeared on
     * the server, and every later `plan` offered to create it again. Called
     * a refusal rather than advice because that is what it is from the
     * second run on — `POST /v1/ai/tools` answers 409 on the duplicate name
     * — and because the one run that does succeed installs a tool this
     * document can never manage.
     */
    if (toolName !== undefined && toolName !== row.key) {
      out.push(
        `${where}: a \`${preset}\` install always creates a tool named \`${toolName}\`, and ` +
          `this row is keyed \`${row.key}\`. The preset arm of the route ignores \`name\`, so ` +
          `\`${row.key}\` would never appear on the server: this plan would offer the same ` +
          'create on every run, and the second one is refused 409 as a duplicate name. ' +
          `Rename the key to \`${toolName}\`.`,
      );
    }
    if (
      PRESETS_NEEDING_SIGNING_SECRET.includes(preset) &&
      typeof row.body['signingSecret'] !== 'string'
    ) {
      out.push(
        `${where}: a \`${preset}\` install needs a \`signingSecret\` (32 to 256 characters), ` +
          'and this row has none, so the write will be refused. Its parameters are filled from ' +
          'the VERIFIED identity of the visitor, and the server will not save a tool that ' +
          'asserts one with no secret to sign it — an `identity-verified` header nobody can ' +
          'check. Use the same secret your endpoint verifies with.',
      );
    }
  }
  return out;
};

/**
 * The external agent's delivery config on a bot that is not external
 * (ForgeDeck 2026-11-07 item 4).
 *
 * `POST /v1/bots` is a union and the Chatly arm takes none of the three:
 * `bots.controller.ts` calls `this.bots.create(...)` without them, and
 * `toBotView` emits `externalAgent` only when `row.type === 'external'`, so
 * the read carries no `webhookUrl` either. The document asked for one thing,
 * the server stored another, and `plan` offered the same change for ever.
 *
 * The effective type is the document's where it states one and the LIVE row's
 * otherwise: `type` is create-only, so an update row that omits it is
 * describing whatever is already there.
 */
export const BOT_DISCARDS: NonNullable<ResourceDef['discards']> = (body, live) => {
  const type = typeof body['type'] === 'string' ? body['type'] : live?.['type'];
  /*
   * `externalAgent` on the read is a second, independent proof, and it is
   * here because the failure directions are not symmetric: calling an
   * external bot a Chatly one DISCARDS a field the author set, silently,
   * which is the whole defect this rule exists to stop. A live row carrying
   * that OBJECT is external whatever `type` says — the DTO emits it for
   * `type === 'external'` and nothing else. Caught by `wac-apply.spec.ts`,
   * whose bot fixture has the object and no `type`.
   *
   * `asRecord`, not `typeof x === 'object'`. `typeof null` is `'object'`,
   * and `toBotView` returns `externalAgent: null` for a Chatly bot — so the
   * hand-rolled version read EVERY existing Chatly bot as external, the
   * discards never fired on an update, and the row this rule exists to
   * settle went on never settling. The warnings showed on the first `plan`
   * and never again, because a create has no live row to misread.
   * ForgeDeck found it; nothing here could, because `LIVE_BOT` omitted the
   * key rather than carrying production's `null`.
   */
  if (type === 'external' || asRecord(live?.['externalAgent']) !== undefined) {
    return NONE;
  }
  const named = typeof type === 'string' ? `\`type: "${type}"\`` : 'a Chatly bot (the default)';
  const why = (field: string): string =>
    `\`${field}\` is an EXTERNAL agent's delivery config and this bot is ${named}, so the ` +
    'route accepts the body and discards it — a Chatly bot has no `externalAgent` on the read ' +
    'for it to come back in. Remove it, or create the bot with `type: "external"`';
  return {
    webhookUrl: why('webhookUrl'),
    timeoutSeconds: why('timeoutSeconds'),
    fallbackMessage: why('fallbackMessage'),
  };
};

/** A `teamId` the server will accept: present, a string, not blank. */
function hasTeam(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}

/**
 * `scope: "team"` with no `teamId` (ForgeDeck 2026-11-07 item 5, and its
 * follow-up: the same refusal on an UPDATE).
 *
 * `POST /v1/macros` refines the pair and answers
 * `teamId is required when scope is "team"`. The generated table cannot see
 * it: `teamId` is `z.string().uuid().nullish()`, which is optional on its own
 * and required only in the company of one particular `scope`.
 *
 * ── Why this one is not `creating()` ───────────────────────────────────────
 *
 * It was, and the reasoning was wrong rather than merely narrow. The PATCH
 * schema carries no refine, so the rule looked create-only — but
 * `macros.service.ts` enforces the pair itself, against the row it reads back
 * from the database, and ForgeDeck reported the refusal arriving at `apply`
 * on a macro MOVED to team scope. `plan` has everything needed to say so
 * first: the live macro is already read and `teamId` is `nullable()` on the
 * response schema, so a macro with no team reads back as `null`.
 *
 * So this mirrors the service's two-line guard instead of the controller's
 * refine, and covers both doors into "a team macro with no team" for the same
 * reason the server needed one guard for both:
 *
 *   * `scope: "team"` where neither the row nor the stored macro has a team;
 *   * `teamId: null` on a macro that is ALREADY `team`.
 *
 * The one case that must NOT warn is the one that made this look create-only:
 * `scope: "team"` on a macro that already has a team. `?? live.teamId` is
 * what the service does with it, and a false refusal there is the defect
 * shape that cost ForgeDeck's eighth report a run.
 */
export const MACRO_WARNINGS: NonNullable<ResourceDef['extraWarnings']> = (
  rows,
  liveRows,
  willSend,
) => {
  const live = new Map(
    liveRows.map((r) => [normaliseShortCode(String(r['shortCode'] ?? '')), r] as const),
  );
  const out: string[] = [];
  for (const row of rows) {
    if (!willSend(row.key)) {
      continue;
    }
    const stored = live.get(normaliseShortCode(row.key));
    const scope = row.body['scope'] ?? stored?.['scope'];
    if (scope !== 'team') {
      continue;
    }
    /*
     * The service's `'teamId' in patch ? patch.teamId : stored.teamId`. An
     * explicit `teamId: null` is the caller REMOVING the team, so it must not
     * fall back to the stored one — but `scope: "team"` beside it re-pins the
     * stored team, which is what `?? stored?.teamId` does there.
     */
    const clears = row.body['teamId'] === null && row.body['scope'] === undefined;
    const team = clears ? null : (row.body['teamId'] ?? stored?.['teamId']);
    if (hasTeam(team)) {
      continue;
    }
    const where =
      stored === undefined
        ? 'this row has none'
        : hasTeam(stored['teamId'])
          ? 'this row clears it'
          : 'neither this row nor the macro on the server has one';
    out.push(
      `macros/${row.key}: \`scope: "team"\` needs a \`teamId\` — the team's uuid — and ${where}, ` +
        'so the write will be refused with `teamId is required when scope is "team"`. ' +
        'Set it, or use `scope: "workspace"` for a macro the whole workspace can type.',
    );
  }
  return out;
};

/**
 * Is a documentation source actually WORKING — `ResourceDef.liveState` for
 * `docsSources` (CH-05).
 *
 * A source that matches the document in every declared field and has failed
 * its last three syncs is a `noop` to every other rule in this engine, and
 * `noop` is the truth about the DIFF. It is not the truth about the source.
 * `syncStatus` and `lastError` have been on the list read all along — they
 * are in the resource's own `unwritable` list, because a document may not set
 * them — and nothing had ever read them. FormFlow's deploy gate printed `0 to
 * create, 0 to change, 4 unchanged` over two dead knowledge sources.
 *
 * Only `failed` is failing. `pending` and `syncing` are a source mid-run, and
 * grading them would make the exit code depend on when the pipeline happened
 * to look — a flaky gate rather than a gate. They still get the note.
 */
export function docsSourceState(
  live: Readonly<Record<string, unknown>>,
): { note: string; failed: boolean } | undefined {
  const status = live['syncStatus'];
  if (typeof status !== 'string' || status === '' || status === 'ok') {
    return undefined;
  }
  const err = typeof live['lastError'] === 'string' ? live['lastError'] : null;
  const when = typeof live['lastSyncedAt'] === 'string' ? live['lastSyncedAt'] : 'never';
  return {
    note:
      `syncStatus is \`${status}\` (last synced ${when})${err === null ? '' : `: ${err}`}. ` +
      'The articles this source imports are stale or missing, whatever this plan says about ' +
      'its settings.',
    failed: status === 'failed',
  };
}
