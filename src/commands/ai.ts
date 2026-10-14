/**
 * The AI configuration surface: tools, tone, provider keys and spend.
 *
 * Tools and tone rules are config-as-code — the body is a document, as in
 * `config.ts`. Provider keys and quota are not: `add-provider` is two
 * scalars, and quota is a read an operator makes to answer "are we about to
 * be cut off".
 */
import { readFileSync } from 'node:fs';

import { bool, str, type ParsedArgs } from '../args.js';
import { printJson } from '../output.js';
import { bodyFrom, need, showObject, showRows } from './common.js';

import type { ChatlyClient } from '@chatlychat/sdk-node';

export async function ai(chatly: ChatlyClient, args: ParsedArgs): Promise<number> {
  const sub = args.path[1] ?? 'quota';
  switch (sub) {
    // ── Spend ─────────────────────────────────────────────────────────────
    case 'quota': {
      /*
       * Three spend figures, and reporting one as another is the mistake this
       * endpoint exists to prevent:
       *
       *   spent / platformSpent — month-to-date on the PLATFORM's key. The
       *                           only spend `budget` bounds and the only
       *                           spend that can get a call refused.
       *   byokSpent             — on the workspace's OWN key. Metered so the
       *                           customer can see it; never capped.
       *   totalSpent            — the two together.
       *
       * `budget: null` is uncapped (free with BYOK, enterprise), not an
       * error. The table labels each figure rather than picking one, because
       * a BYOK-heavy workspace shown `spent` against `budget` reads "$412 of
       * $5" for money nobody spent.
       */
      const q = await chatly.request<{
        spent?: number;
        platformSpent?: number;
        byokSpent?: number;
        totalSpent?: number;
        budget?: number | null;
        remaining?: number | null;
        plan?: string;
        periodKey?: string;
        warn?: boolean;
        projectedExhaustionAt?: string | null;
      }>('GET', '/v1/ai/quota');
      if (bool(args.flags, 'json')) {
        printJson(q);
        return 0;
      }
      const money = (v: number | null | undefined): string =>
        v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;
      process.stdout.write(`plan              ${q.plan ?? '—'}  (${q.periodKey ?? '—'})\n`);
      process.stdout.write(`platform spend    ${money(q.platformSpent ?? q.spent)}  (capped)\n`);
      process.stdout.write(`your-key spend    ${money(q.byokSpent)}  (never capped)\n`);
      process.stdout.write(`total spend       ${money(q.totalSpent)}\n`);
      process.stdout.write(
        `platform budget   ${q.budget === null || q.budget === undefined ? 'unlimited' : money(q.budget)}` +
          `${q.remaining === null || q.remaining === undefined ? '' : `, ${money(q.remaining)} left`}\n`,
      );
      if (q.warn === true) {
        process.stdout.write('\nwarning: nearing the platform cap.\n');
      }
      if (q.projectedExhaustionAt !== null && q.projectedExhaustionAt !== undefined) {
        process.stdout.write(`projected exhaustion  ${q.projectedExhaustionAt}\n`);
      }
      return 0;
    }

    // ── Provider keys ─────────────────────────────────────────────────────
    case 'providers':
      return showRows(args, await chatly.request('GET', '/v1/ai-providers'), [
        'provider',
        'status',
        'lastValidatedAt',
        'message',
      ]);
    case 'add-provider': {
      /*
       * `{ provider, apiKey }` — the names are `connectSchema`'s. The key is
       * validated against the provider on save, and only an
       * authentication-class answer refuses the write: `unverified` means
       * stored but unproven, not failed.
       */
      const provider = args.path[2] ?? str(args.flags, 'provider');
      const apiKey = str(args.flags, 'api-key');
      if (provider === undefined || apiKey === undefined) {
        throw new Error(
          'Give a provider and a key: `chatly ai add-provider openai --api-key sk-…`.\n' +
            '`chatly ai providers` lists what is connected.',
        );
      }
      return showObject(
        await chatly.request('POST', '/v1/ai-providers', { body: { provider, apiKey } }),
      );
    }
    case 'test-provider':
      // Re-checks the STORED key against the provider. Nothing is sent.
      return showObject(
        await chatly.request(
          'POST',
          `/v1/ai-providers/${encodeURIComponent(need(args, 2, 'a provider'))}/test`,
        ),
      );

    // ── Tools ─────────────────────────────────────────────────────────────
    case 'tools':
      // Secret header VALUES are never returned — `secretHeaderNames` is the
      // list of which ones are set.
      return showRows(args, await chatly.request('GET', '/v1/ai/tools'), [
        'id',
        'name',
        'method',
        'urlTemplate',
        'enabled',
        'requiresApproval',
      ]);
    case 'create-tool':
      return showObject(
        await chatly.request('POST', '/v1/ai/tools', { body: bodyFrom(args, 'the tool') }),
      );
    case 'update-tool':
      // Omit `secretHeaders` to KEEP the stored values. Sending an empty
      // object is not the same as omitting the key.
      return showObject(
        await chatly.request(
          'PATCH',
          `/v1/ai/tools/${encodeURIComponent(need(args, 2, 'a tool id'))}`,
          { body: bodyFrom(args, 'the fields to change') },
        ),
      );
    case 'delete-tool':
      return showObject(
        await chatly.request(
          'DELETE',
          `/v1/ai/tools/${encodeURIComponent(need(args, 2, 'a tool id'))}`,
        ),
      );

    // ── Tone ──────────────────────────────────────────────────────────────
    case 'tone':
      return showRows(args, await chatly.request('GET', '/v1/ai/tone'), [
        'id',
        'category',
        'rule',
        'enabled',
        'position',
      ]);
    case 'set-tone':
      /*
       * A PUT that REPLACES the whole rule set. The body is `{ rules: [...] }`
       * — a document, and the wrapper key matters: a bare array is an unknown
       * shape to `toneRulesWriteSchema`.
       *
       * There is no merge route. Read `chatly ai tone --json`, edit, send it
       * all back.
       */
      return showObject(
        await chatly.request('PUT', '/v1/ai/tone', {
          body: bodyFrom(args, 'the complete rule set, as { "rules": [ … ] }'),
        }),
      );
    case 'generate-tone': {
      /*
       * Proposes rules from a pasted style guide and SAVES NOTHING — the
       * output is a draft for a person to approve and then `set-tone`.
       *
       * The field is `styleGuide`, minimum 40 characters. A guide is usually
       * a document, so `--file` reads it as TEXT here rather than as JSON —
       * this is the one write on the surface whose input is prose.
       */
      const file = str(args.flags, 'file');
      const inline = str(args.flags, 'style-guide');
      let styleGuide: string;
      if (file !== undefined) {
        styleGuide = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
      } else if (inline !== undefined) {
        styleGuide = inline;
      } else {
        throw new Error(
          'Give a style guide: `chatly ai generate-tone --file ./voice.md`, or ' +
            "--style-guide 'your house style…'.\nIt must be at least 40 characters.",
        );
      }
      return showObject(
        await chatly.request('POST', '/v1/ai/tone/generate', { body: { styleGuide } }),
      );
    }
    default:
      throw new Error(`Unknown: ai ${sub}`);
  }
}
