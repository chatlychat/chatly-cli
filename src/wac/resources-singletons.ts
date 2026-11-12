/**
 * The two WORKSPACE-WIDE settings a document can carry: business hours and
 * tone of voice (CH-24).
 *
 * ═══ WHY THEY WERE MISSING, AND WHY THAT MATTERED ════════════════════════
 *
 * FormFlow: "business hours are off and are not workspace-as-code with a
 * workspace key." Both facts were true and the second explains the first.
 * `businessHours`, `tone` and `settings` appeared only in the PLATFORM
 * document (`pac/platform-resources.ts`), which needs a `cp_` platform
 * credential — so a customer holding an ordinary `ck_` key had no way to
 * describe their own opening hours in the file they already apply on every
 * deploy. Two ways to configure one workspace, and neither was reachable
 * from the one a customer has.
 *
 * `PATCH /v1/workspace/business-hours` and `PUT /v1/ai/tone` are BOTH
 * `@AllowApiKey()`, on `workspace:write` and `ai:write` — verified against
 * the handlers (`apps/api/src/modules/workspaces/workspace-business-hours.ts`
 * and `apps/api/src/modules/ai-tone/ai-tone.module.ts`), not against their
 * names, which is the rule `resources.ts`'s header sets out.
 *
 * ═══ `settings` IS NOT HERE, AND THAT IS A FINDING ═══════════════════════
 *
 * `GET /v1/workspace/settings` carries `@AllowApiKey()`; `PATCH
 * /v1/workspace/settings` does NOT. A `ck_` key can read the blob and cannot
 * write a byte of it. Shipping a `settings:` section would therefore be a
 * document key that parses, plans and then fails at apply time with a 403 —
 * which is worse than not offering it, because the author finds out after
 * the deploy has started. It is refused by name instead, in
 * `WORKSPACE_SCHEMA.refusedKeys`, with that reason.
 *
 * ═══ A SINGLETON IS A ROW SET OF ONE ═════════════════════════════════════
 *
 * Both routes are singletons: one per workspace, no id, no create and no
 * delete. The engine is built on list/match/write with a natural key, so
 * each is modelled as exactly one row with the synthetic key
 * `SINGLETON_KEY`, stamped onto the live answer by `rowsFrom` and onto the
 * document row by `parseSection`. The author never writes it and never sees
 * it: the section is an OBJECT in the file, not an array.
 *
 * `create: null` is what makes that safe. If the stamping ever came apart,
 * the row would not match and would plan as a create — and there is nothing
 * to create, so the plan says `CANNOT APPLY` instead of POSTing a second
 * workspace's worth of hours somewhere.
 */
import { SINGLETON_KEY } from './resource-shared.js';

import type { ResourceDef } from './resource-def.js';

/**
 * Why `resources.settings` is refused by name — `WORKSPACE_SCHEMA.refusedKeys`
 * reads it from here, beside the two sections that ARE writable, because the
 * reason is the same verification that put those two in this file.
 */
export const SETTINGS_REFUSAL =
  'the workspace settings blob cannot be written with a workspace key: `GET ' +
  '/v1/workspace/settings` is key-accessible and `PATCH /v1/workspace/settings` is not, so a ' +
  'section here would plan cleanly and then 403 at apply time. Business hours and tone of ' +
  'voice ARE writable with a `ck_` key and have their own sections (`businessHours`, `tone`). ' +
  'For the rest of the blob, use the dashboard, or a `cp_` platform credential and ' +
  '`chatly platform apply`.';

/**
 * `GET`/`PATCH /v1/workspace/business-hours`.
 *
 * The GET answers `businessHoursConfigSchema` — `{ enabled, tz, schedule,
 * holidays }` — and the PATCH takes the same four, each optional and each
 * still fully validated. So every field the read returns is writable, which
 * is why `unwritable` is empty: there is nothing here the server owns.
 *
 * `schedule` is NOT a merge field. The PATCH merges at the TOP level only —
 * a `schedule` it receives replaces the stored one wholesale — so comparing
 * it key by key would report a day as unchanged that the write is about to
 * clear. Compared whole, which is what the route does.
 */
export const BUSINESS_HOURS: ResourceDef = {
  type: 'businessHours',
  label: 'business-hours config',
  readScope: 'workspace:read',
  writeScope: 'workspace:write',
  naturalKey: 'key',
  keySource: 'authored',
  keyEnforced: true,
  singleton: true,
  list: { path: '/v1/workspace/business-hours', paged: false },
  rowsFrom: (response) => [{ ...asRow(response), key: SINGLETON_KEY }],
  idField: 'id',
  create: null,
  update: [{ method: 'PATCH', path: '/v1/workspace/business-hours' }],
  remove: null,
  removeBlocked:
    'there is one business-hours config per workspace and no route deletes it. `--prune` ' +
    'never will; set `enabled: false` to turn it off.',
  opaque: [],
  secrets: [],
  unwritable: [],
};

/**
 * `GET`/`PUT /v1/ai/tone`.
 *
 * The read is a BARE ARRAY of rules and the write is `{ rules: [...] }`
 * replacing the whole set — there is no per-rule route, which is why this is
 * one row carrying a `rules` array rather than a row per rule.
 *
 * `project` is load bearing. A live rule carries `id` and `position`, which
 * the write schema is `.strict()` about and refuses; a document that spelled
 * them out would be a 400, and one that left them out would diff as changed
 * on every single run. So the live rules are narrowed to the three fields
 * `toneRuleInputSchema` accepts before anything is compared.
 *
 * `fullReplace` because the PUT is one: a rule the document omits is gone.
 * `plan` says so on the line.
 */
export const TONE: ResourceDef = {
  type: 'tone',
  label: 'tone-of-voice rule set',
  readScope: 'ai:read',
  writeScope: 'ai:write',
  naturalKey: 'key',
  keySource: 'authored',
  keyEnforced: true,
  singleton: true,
  list: { path: '/v1/ai/tone', paged: false },
  rowsFrom: (response) => [
    {
      key: SINGLETON_KEY,
      rules: (Array.isArray(response) ? response : []).map((rule) => {
        const r = asRow(rule);
        return { category: r['category'], rule: r['rule'], enabled: r['enabled'] };
      }),
    },
  ],
  idField: 'id',
  create: null,
  update: [{ method: 'PUT', path: '/v1/ai/tone' }],
  fullReplace: true,
  fullReplaceNote:
    '`PUT /v1/ai/tone` replaces the WHOLE rule set. A rule not in this document is deleted, ' +
    'and the ids and positions the server assigned are reassigned from the order written here.',
  remove: null,
  removeBlocked:
    'there is no delete for the rule set; write `rules: []` to empty it. `--prune` never will.',
  opaque: [],
  secrets: [],
  unwritable: [],
};

/** A JSON object from an unknown response, never `null` and never an array. */
function asRow(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
