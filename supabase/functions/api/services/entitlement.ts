// The one entitlement rule, read by the gateway and published on /profile so
// both apps stop re-deriving it: `active`, or `canceled` inside the paid
// period. A canceled row with no period end is still inside it.
export interface EntitlementRow {
  status: string;
  current_period_end: string | null;
}

export function isEntitled(row: EntitlementRow | null | undefined, nowMs: number): boolean {
  if (!row) return false;
  if (row.status === "expired") return false;
  if (row.status !== "canceled") return true;
  if (!row.current_period_end) return true;
  return new Date(row.current_period_end).getTime() >= nowMs;
}
