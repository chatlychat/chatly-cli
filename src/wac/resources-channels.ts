/**
 * The `channels` resource definition.
 *
 * Its own file because `resources.ts` reached the 650-line ceiling, and this
 * is the def with the most self-contained story: a natural key that had to be
 * ADDED to the schema before a document could describe one at all.
 *
 * `publicId` is a RESERVATION, not a name — `channels_public_id_unique` is
 * global, so another tenant may already hold `web`, and the server mints one
 * when none is sent. Until 2026-10-26 a `channels:` section was refused for
 * that reason. Migration 0680 added `channels.key`, a workspace-unique name
 * the author chooses, and the section matches on it. `publicId` stays an
 * OUTPUT (printed after `apply`); `type` is fixed at create; credentials
 * inside `config` are write-only per leaf; and `--prune` never deletes one.
 */
import { SERVER_OWNED } from './resource-shared.js';

import type { ResourceDef } from './resource-def.js';

export const CHANNELS: ResourceDef = {
  type: 'channels',
  readScope: 'channels:read',
  writeScope: 'channels:write',
  label: 'channel',
  /*
   * `key` (migration 0680): a workspace-unique name the AUTHOR picks,
   * enforced by a partial unique index. `publicId` cannot be the key — it is
   * a globally unique reservation the server mints — so it is an OUTPUT:
   * refused in a document (`unwritable`) and printed after `apply`.
   * Channels that predate the column have no key and cannot be matched;
   * `chatly channels set-key <id> <key>` adopts one.
   */
  naturalKey: 'key',
  keySource: 'authored',
  keyEnforced: true,
  keyPattern: /^[a-z][a-z0-9-]{0,63}$/,
  keylessHint:
    'adopt one with `chatly channels set-key <id> <key>`, or a create here makes a second channel.',
  list: { path: '/v1/channels', paged: false },
  idField: 'id',
  create: { path: '/v1/channels' },
  /*
   * No catch-all: `type` is fixed at create, so a changed `type` is reported
   * as un-appliable instead of sent to a PATCH that strips it. `config` is
   * merged by the server (RFC 7396), so it is compared on the keys named.
   */
  update: [
    {
      method: 'PATCH',
      path: '/v1/channels/{id}',
      fields: [
        'name',
        'enabled',
        'config',
        'autoCreateTickets',
        'autoAcknowledge',
        'acknowledgeTemplate',
        'acknowledgeSubject',
      ],
    },
  ],
  updateBlocked:
    '`type` is fixed at create. Give the new channel another `key` (the old one then shows ' +
    'as on the server only) or delete it in the dashboard first.',
  mergeFields: ['config'],
  /*
   * `DELETE /v1/channels/{id}` exists but is not key-accessible, and it
   * detaches the channel's conversations. Not something `--prune` should do.
   */
  remove: null,
  removeBlocked:
    'a channel cannot be deleted with an API key, and deleting one detaches its conversations. ' +
    'Delete it in the dashboard; `--prune` never will.',
  /*
   * Credentials live inside `config` and read back as `__redacted__`; they
   * are split out per leaf in `diff.ts` (write-only, `--write-only` to push).
   */
  opaque: [],
  secrets: [],
  unwritable: [
    ...SERVER_OWNED,
    'publicId',
    'originsRestricted',
    'originWarnings',
    'embed',
    'brandId',
    'lastMessageAt',
    'staleEndpoints',
  ],

};
