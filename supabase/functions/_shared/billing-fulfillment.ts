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
  /** Provider event ID when available; business ID is the verified-client fallback. */
  eventId?: string;
  /** True when the webhook boundary already opened this delivery's receipt
   * with deliverVerified, so this call must not count a second attempt. */
  receiptOpen?: boolean;
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
  /** Apple only: 'sandbox' for App Review / TestFlight purchases, recorded on
   * billing_transactions.environment so revenue can leave them out. */
  environment?: 'production' | 'sandbox';
}

export interface FulfillmentResult {
  applied: boolean;
  replay: boolean;
  reason: string | null;
  credits: { plan: number; pack: number };
  entitlement: string | null;
}

/** A verified payment notification, persisted before anything else can fail. */
export interface VerifiedReceipt {
  source: 'stripe' | 'apple';
  eventId: string;
  businessTxnId: string;
  /** Null until the customer is identified; filled in when the receipt settles. */
  userId: string | null;
  request: unknown;
}

/**
 * How a verified delivery ended. 'granted' means applyFulfillment settled the
 * receipt itself. 'nothing_owed' closes it (no grant was ever due). Anything
 * unfulfillable stays open, so fn_paid_unfulfilled reports it to an operator.
 */
export type Settlement = 'granted' | 'nothing_owed' | `unfulfillable:${string}`;

export async function openReceipt(admin: SupabaseClient, receipt: VerifiedReceipt): Promise<void> {
  const { error } = await admin.rpc('fn_record_billing_delivery', {
    p_source: receipt.source, p_event_id: receipt.eventId, p_txn_id: receipt.businessTxnId,
    p_user: receipt.userId, p_request: receipt.request,
  });
  if (error) throw new Error(`billing_receipt_failed ${error.message}`);
}

async function finishReceipt(
  admin: SupabaseClient,
  source: 'stripe' | 'apple',
  eventId: string,
  errorText: string | null,
  userId: string | null,
): Promise<void> {
  const { error } = await admin.rpc('fn_finish_billing_delivery', {
    p_source: source, p_event_id: eventId, p_error: errorText, p_user: userId,
  });
  if (error) throw new Error(`billing_receipt_resolution_failed ${error.message}`);
}

function messageOf(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
}

/**
 * The durable boundary for one verified webhook delivery. The receipt is
 * written first, before the provider lookups and mirror writes that can fail;
 * only then does `work` run. A thrown error lands on the receipt and is
 * rethrown so the provider retries. Grants inside `work` must pass
 * `receiptOpen: true` and the same eventId to applyFulfillment.
 */
export async function deliverVerified(
  admin: SupabaseClient,
  receipt: VerifiedReceipt,
  work: () => Promise<Settlement>,
): Promise<void> {
  await openReceipt(admin, receipt);
  let settlement: Settlement;
  try {
    settlement = await work();
  } catch (cause) {
    await finishReceipt(admin, receipt.source, receipt.eventId, messageOf(cause), receipt.userId)
      .catch((e) => console.error('billing_receipt_error_write_failed', messageOf(e)));
    throw cause;
  }
  if (settlement === 'granted') return;
  const unresolved = settlement === 'nothing_owed' ? null : settlement;
  await finishReceipt(admin, receipt.source, receipt.eventId, unresolved, receipt.userId);
}

export async function applyFulfillment(
  admin: SupabaseClient,
  req: FulfillmentRequest,
): Promise<FulfillmentResult> {
  const eventId = req.eventId ?? req.businessTxnId;
  if (!req.receiptOpen) {
    await openReceipt(admin, {
      source: req.source, eventId, businessTxnId: req.businessTxnId, userId: req.userId, request: req,
    });
  }
  let result: FulfillmentResult;
  try {
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
      // Production is the column default and is left out, so a build that
      // reaches a database without 0038 still settles production money.
      ...(req.environment === 'sandbox' ? { p_environment: 'sandbox' } : {}),
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('fn_apply_fulfillment returned no result');
    result = data as FulfillmentResult;
  } catch (cause) {
    await finishReceipt(admin, req.source, eventId, messageOf(cause), req.userId)
      .catch((e) => console.error('billing_receipt_error_write_failed', messageOf(e)));
    throw cause;
  }
  await finishReceipt(admin, req.source, eventId, null, req.userId);
  return result;
}

/** Postgres unique-violation. Anything else is operational and must retry. */
export function isDuplicateKey(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}
