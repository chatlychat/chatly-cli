/**
 * Rendering. Two modes, and the choice is the caller's, not ours.
 *
 * Default: a table a person reads. `--json`: the raw API response, unmodified,
 * so a script can pipe it to `jq`. The second one matters more than it looks —
 * a CLI that only pretty-prints cannot be used in a pipeline, and a CLI that
 * only emits JSON is unpleasant to use by hand.
 */

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Pick a handful of fields out of an unknown object, in order, as strings. */
function cell(row: unknown, key: string): string {
  if (typeof row !== 'object' || row === null) {
    return '';
  }
  const value = (row as Record<string, unknown>)[key];
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * A fixed-width table. Width is computed from the content, and every cell is
 * truncated to `max` so one 4KB message body cannot destroy the layout.
 */
export function printTable(
  rows: ReadonlyArray<unknown>,
  columns: ReadonlyArray<string>,
  max = 48,
): void {
  if (rows.length === 0) {
    process.stdout.write('(no results)\n');
    return;
  }
  const clip = (s: string): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  const body = rows.map((r) => columns.map((c) => clip(cell(r, c).replace(/\s+/g, ' '))));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...body.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: ReadonlyArray<string>): string =>
    cells.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ').trimEnd();

  process.stdout.write(`${line(columns.map((c) => c.toUpperCase()))}\n`);
  process.stdout.write(`${widths.map((w) => '─'.repeat(w)).join('  ')}\n`);
  for (const r of body) {
    process.stdout.write(`${line(r)}\n`);
  }
  process.stdout.write(`\n${String(rows.length)} row(s)\n`);
}

/** `{ items, nextCursor }` from a list endpoint, defensively. */
export function itemsOf(value: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const items = (value as Record<string, unknown>)['items'];
    if (Array.isArray(items)) {
      return items;
    }
    const data = (value as Record<string, unknown>)['data'];
    if (Array.isArray(data)) {
      return data;
    }
  }
  return [];
}

export function nextCursorOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null) {
    const c = (value as Record<string, unknown>)['nextCursor'];
    if (typeof c === 'string' && c.length > 0) {
      return c;
    }
  }
  return null;
}
