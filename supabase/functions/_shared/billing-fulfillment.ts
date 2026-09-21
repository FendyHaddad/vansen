// The only path from verified provider money to a credit balance.
//
// Everything about "did this already happen" lives in the database, inside the
// same transaction as the effect. This module's job is to name the business
// transaction correctly — the Stripe invoice/session id, the Apple transaction
// id, never the event delivery id — and to refuse to guess when the RPC does
// not answer.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export type FulfillmentKind = 'subscription_grant' | 'pack_grant' | 'clawback';

export interface FulfillmentRequest {
  source: 'stripe' | 'apple';
  /** Stable across redeliveries: invoice id, checkout session id, Apple transactionId. */
  businessTxnId: string;
  userId: string;
  kind: FulfillmentKind;
  plan?: 'studio' | 'pro' | null;
  credits: number;
  periodEnd?: string | null;
  eventAt: string;
  /** Finished `subscriptions` row patch, or null to leave the mirror alone. */
  entitlement?: Record<string, unknown> | null;
  /** Upgrade semantics: top the plan bucket up, never take credits away. */
  neverLower?: boolean;
  clearPending?: boolean;
}

export interface FulfillmentResult {
  applied: boolean;
  replay: boolean;
  reason: string | null;
  credits: { plan: number; pack: number };
  entitlement: string | null;
}

export async function applyFulfillment(
  admin: SupabaseClient,
  req: FulfillmentRequest,
): Promise<FulfillmentResult> {
  const { data, error } = await admin.rpc('fn_apply_fulfillment', {
    p_source: req.source,
    p_txn_id: req.businessTxnId,
    p_user: req.userId,
    p_kind: req.kind,
    p_plan: req.plan ?? null,
    p_credits: req.credits,
    p_period_end: req.periodEnd ?? null,
    p_event_at: req.eventAt,
    p_entitlement: req.entitlement ?? null,
    p_never_lower: req.neverLower ?? false,
    p_clear_pending: req.clearPending ?? false,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('fn_apply_fulfillment returned no result');
  return data as FulfillmentResult;
}

/** Postgres unique-violation. Anything else is operational and must retry. */
export function isDuplicateKey(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}
