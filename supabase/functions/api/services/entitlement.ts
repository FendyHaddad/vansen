// The one entitlement rule, read by the gateway and published on /profile so
// both apps stop re-deriving it: `active`, or `canceled` inside the paid
// period. A canceled row with no period end is still inside it.
//
// An `active` row must also have a period end later than now minus
// ENTITLEMENT_GRACE_MS (or none). The grace covers a renewal webhook that
// lands late; past it, a row whose EXPIRED notification never arrived stops
// granting access. fn_reserve_persona (0037) applies the same rule in SQL.
export interface EntitlementRow {
  status: string;
  current_period_end: string | null;
}

export const ENTITLEMENT_GRACE_MS = 3 * 86_400_000;

export function isEntitled(row: EntitlementRow | null | undefined, nowMs: number): boolean {
  if (!row) return false;
  if (row.status === "expired") return false;
  if (!row.current_period_end) return true;
  const periodEndMs = new Date(row.current_period_end).getTime();
  if (row.status === "canceled") return periodEndMs >= nowMs;
  return periodEndMs > nowMs - ENTITLEMENT_GRACE_MS;
}
