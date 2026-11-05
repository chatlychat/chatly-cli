/**
 * Values shared by `resources.ts` and the resource definitions that live
 * outside it.
 *
 * Its own file because the first attempt had `resources-privacy.ts` import
 * `SERVER_OWNED` back from `resources.ts`, which `check-import-cycles` caught
 * as a RUNTIME cycle — the kind that crashes at boot rather than failing to
 * build, since both modules evaluate a `const` at module scope.
 */

/** Columns the server owns on every resource; no document may write them. */
export const SERVER_OWNED = ['id', 'workspaceId', 'createdAt', 'updatedAt'] as const;
