/**
 * `${env:NAME}` substitution for a workspace-as-code document, and the one
 * form that is NOT it.
 *
 * Its own file because `document.ts` passed the 650-line ceiling
 * (`scripts/check-file-size.mjs`) when the refusal below was added, and this
 * is the self-contained half: a regex pair, one recursive walk and two
 * sentences. It imports nothing — in particular not `Issue`, which lives in
 * `document.ts` and would make this a cycle — so the messages are returned as
 * strings and the caller builds the issue.
 */

/**
 * `${env:NAME}` inside any string value.
 *
 * Two of these resources cannot be described at all without a secret — a
 * documentation source needs its provider token on create, a customer card
 * needs an `Authorization` header — and a config file in git is the one place
 * those must not be. An interpolation is the smallest thing that makes the
 * file usable, and it is narrow on purpose: this exact form, in a string, and
 * nothing else. No defaults, no shell, no file reads, no nesting.
 *
 * An UNSET variable is refused by name. It is not substituted with an empty
 * string, and that is the whole point: CLAUDE.md records both halves of this
 * failure — "a shell `read` cannot fail", where empty vars beat the sentinel
 * and a health check invented findings, and "env fallback reaches
 * production", where an unset variable became a localhost canonical URL on
 * every page. An empty token here would be POSTed, verified against the
 * provider, and fail with a message about the provider rather than about the
 * variable nobody exported.
 */
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * `${NAME}` without the `env:`, which is the form everybody writes first.
 *
 * It used to be LEFT ALONE, and that is the worst available outcome: the
 * literal nine-and-twenty characters `${ATLAS_CHATLY_EVENTS_SECRET}` were
 * stored as a channel's Atlas signing secret, passed `min(16)` on the way in,
 * read back as `__redacted__`, and made every one of Atlas's deliveries
 * answer 401 — with `plan` reporting the row unchanged, because a redacted
 * leaf is not diffed. FormFlow reported the symptom (126 consecutive 401s)
 * and the cause was a missing four characters in a yaml file (CH-26).
 *
 * Refused by name rather than substituted, for the same reason an unset
 * variable is refused: guessing that the author meant `env:` would make this
 * CLI resolve a form it does not document, and a document that means
 * something other than what it says is the thing `load.ts` already refuses
 * YAML tags over.
 *
 * Narrow on purpose. A shell-style variable name only — `${foo.bar}` and
 * mustache `{{x}}` are not matched, and the email templates' placeholders are
 * mustache, so no legitimate value in this document shape collides with it.
 */
const MISTAKEN_ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Substitute `${env:NAME}` throughout a value. Collects unset names.
 *
 * `env` is a parameter rather than a read of `process.env` so the spec can
 * drive it: a test that monkey-patches the process environment is a test that
 * leaks into its neighbours.
 */
export function interpolate(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
  missing: Set<string>,
  used: Set<string>,
  mistaken: Set<string>,
): unknown {
  if (typeof value === 'string') {
    const substituted = value.replace(ENV_REF, (_match, name: string) => {
      const found = env[name];
      if (found === undefined || found === '') {
        missing.add(name);
        return '';
      }
      used.add(name);
      return found;
    });
    /*
     * Scanned on the ORIGINAL string, not the substituted one. Two reasons,
     * both of which a scan of the result gets wrong: a real `${env:NAME}`
     * cannot be mistaken for this form (the name charset has no `:`, so
     * `env:NAME` never matches), and a variable whose VALUE happens to
     * contain `${X}` is not refused — the author did not write that, the
     * environment did, and refusing it would make an opaque secret unusable.
     */
    for (const match of value.matchAll(MISTAKEN_ENV_REF)) {
      const name = match[1];
      if (name !== undefined) {
        mistaken.add(name);
      }
    }
    return substituted;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolate(v, env, missing, used, mistaken));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolate(v, env, missing, used, mistaken);
    }
    return out;
  }
  return value;
}

/** `isPlainObject`, local so this file keeps its no-imports property. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `${NAME}` written without the prefix. The sentence a reader acts on.
 *
 * Both halves matter: what the right form is, and what the wrong one USED to
 * do — the literal text was stored, which on an HMAC signing secret is a
 * field set to twenty-odd characters of placeholder that passes validation,
 * reads back as `__redacted__` and makes every delivery Atlas signs 401
 * (CH-26).
 */
export const mistakenEnvRefMessage = (name: string): string =>
  `\`\${${name}}\` is not substituted — this document reads \`\${env:${name}}\`, with the ` +
  '`env:` prefix, and nothing else. Written without it the literal text is STORED as the value, ' +
  'which on a credential means the field holds twenty-odd characters of placeholder and every ' +
  'signature made with the real secret is refused. Add `env:`.';

/** `${env:NAME}` where NAME is unset or empty. Refused, never substituted. */
export const missingEnvRefMessage = (name: string): string =>
  `\${env:${name}} is used here and ${name} is unset or empty. It is NOT substituted with an ` +
  'empty string: an empty token would be sent, verified against the provider, and fail with a ' +
  `message about the provider rather than about the variable nobody exported. Export ${name} ` +
  'and run again.';
