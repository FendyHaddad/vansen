// Keyset paging for the library and the ledger, plus the version-chain walk.
// Cursors are base64("created_at|id"). decodeCursor() refuses anything that
// is not plainly a timestamp and an id, because the halves are pasted into
// a PostgREST filter string.

export const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;

/**
 * Keyset cursor: created_at plus id, so rows sharing a timestamp still order
 * deterministically. Offset paging skips and repeats rows whenever a
 * generation lands between two page fetches.
 */
export function encodeCursor(row: Record<string, unknown>): string {
  return btoa(`${row.created_at}|${row.id}`);
}

/**
 * The decoded halves are pasted into a PostgREST filter string, so anything
 * that is not plainly a timestamp and an id is refused here rather than
 * sent to the database.
 */
export function decodeCursor(raw: string): { createdAt: string; id: string } | null {
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return null;
  }
  const parts = decoded.split("|");
  if (parts.length !== 2) return null;
  const [createdAt, id] = parts;
  if (!createdAt || !id) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  if (!/^[0-9T:.+\-]+Z?$/.test(createdAt)) return null;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
  return { createdAt, id };
}

export function pageSize(raw: string | undefined): number {
  const asked = Number(raw ?? DEFAULT_PAGE);
  if (!Number.isFinite(asked) || asked < 1) return DEFAULT_PAGE;
  return Math.min(Math.floor(asked), MAX_PAGE);
}

/**
 * Ancestors (via parent_id) + the row itself + every descendant, oldest
 * first — the same chain the client used to assemble from loaded rows only.
 */
export function versionChain(
  all: Record<string, unknown>[],
  root: Record<string, unknown>,
): Record<string, unknown>[] {
  const byId = new Map(all.map((r) => [String(r.id), r]));
  const chain: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | undefined = byId.get(
    String(root.id),
  ) ?? root;
  while (current) {
    chain.unshift(current);
    const parent: unknown = current.parent_id;
    current = parent ? byId.get(String(parent)) : undefined;
  }
  let frontier = [String(root.id)];
  const seen = new Set(chain.map((r) => String(r.id)));
  while (frontier.length) {
    const children = all.filter(
      (r) => r.parent_id && frontier.includes(String(r.parent_id)),
    );
    for (const child of children) {
      if (seen.has(String(child.id))) continue;
      seen.add(String(child.id));
      chain.push(child);
    }
    frontier = children.map((r) => String(r.id));
  }
  return chain.sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at))
  );
}
