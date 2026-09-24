// The only credit-granting code for iap-source money.
//
// Idempotency lives entirely in fn_apply_fulfillment, keyed on the Apple
// transaction id, inside the same transaction as the grant. The old
// 'iaptx:<transactionId>' marker in webhook_events is GONE: it was written
// before the grant and never cleaned up, so any failure after the marker and
// before the grant lost the customer's credits permanently.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { PLAN_CREDITS } from './model-families.ts';
import { IAP_PRODUCTS, iapGrant, iapPlanFor } from './iap-products.ts';
import { applyFulfillment, type Settlement } from './billing-fulfillment.ts';
import type { AppleEnvironment } from './apple-verifier.ts';

/** Set by the webhook when deliverVerified already opened the receipt. */
export interface OpenDelivery {
  eventId: string;
  receiptOpen: true;
}

export interface IapTransaction {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  expiresDate?: number;
  revocationDate?: number;
  appAccountToken?: string;
  /** Which verifier accepted it; sandbox money is granted but kept out of revenue. */
  environment?: AppleEnvironment;
}

export type IapOutcome = 'applied' | 'already_applied' | 'rejected';

function iapOutcome(result: { replay: boolean; applied: boolean }): IapOutcome {
  if (result.replay) return 'already_applied';
  if (!result.applied) return 'rejected';
  return 'applied';
}

export type IapRejection = 'unknown_product' | 'revoked' | 'expired';

export interface IapResult {
  outcome: IapOutcome;
  credits: { plan: number; pack: number } | null;
  /** Why a 'rejected' outcome granted nothing. */
  rejection?: IapRejection;
}

/** Throws on any operational failure so the caller answers 5xx and Apple retries. */
export async function applyIapTransaction(
  admin: SupabaseClient,
  userId: string,
  tx: IapTransaction,
  eventAt = new Date().toISOString(),
  nowMs = Date.now(),
  delivery: OpenDelivery | Record<never, never> = {},
): Promise<IapResult> {
  const product = IAP_PRODUCTS[tx.productId];
  if (!product) {
    console.error('unknown iap product', tx.productId, tx.transactionId);
    return { outcome: 'rejected', credits: null, rejection: 'unknown_product' };
  }

  if (tx.revocationDate) return { outcome: 'rejected', credits: null, rejection: 'revoked' };
  // Expiry is judged against the CURRENT clock, never the notification's own
  // historical timestamp, and a subscription with no expiry is refused rather
  // than given a fabricated 30-day period.
  const subscriptionExpired = product.kind === 'subscription' &&
    (!tx.expiresDate || tx.expiresDate <= nowMs);
  if (subscriptionExpired) return { outcome: 'rejected', credits: null, rejection: 'expired' };

  if (product.kind === 'subscription') {
    const periodEnd = new Date(tx.expiresDate!).toISOString();
    const result = await applyFulfillment(admin, {
      ...delivery,
      source: 'apple',
      environment: tx.environment,
      businessTxnId: tx.transactionId,
      userId,
      kind: 'subscription_grant',
      plan: product.plan,
      credits: PLAN_CREDITS[product.plan],
      periodEnd,
      eventAt,
      entitlement: {
        plan: product.plan,
        status: 'active',
        current_period_end: periodEnd,
        iap_original_transaction_id: tx.originalTransactionId,
      },
    });
    return { outcome: iapOutcome(result), credits: result.credits };
  }

  const plan = await currentPlan(admin, userId);
  const result = await applyFulfillment(admin, {
    ...delivery,
    source: 'apple',
    environment: tx.environment,
    businessTxnId: tx.transactionId,
    userId,
    kind: 'pack_grant',
    credits: iapGrant(tx.productId, plan),
    eventAt,
  });
  return { outcome: iapOutcome(result), credits: result.credits };
}

/**
 * True when Stripe is paying for a later period than this Apple transaction
 * covered: the row has a Stripe subscription id and its period end is past
 * Apple's expiry. The user lapsed on Apple and moved to Stripe (or pays both),
 * so an Apple end-of-life event concerns only the App Store part and must
 * leave the Stripe-paid row alone. Without Apple's expiry nothing is known,
 * and Apple is trusted as before.
 */
export function stripeCarriesRow(
  row: { stripe_subscription_id?: string | null; current_period_end?: string | null } | null,
  appleExpiresMs: number | undefined,
): boolean {
  if (!row?.stripe_subscription_id || !row.current_period_end || !appleExpiresMs) return false;
  return new Date(row.current_period_end).getTime() > appleExpiresMs;
}

/**
 * 'granted' when a clawback (or entitlement expiry) was written. 'nothing_owed'
 * when the refunded Apple subscription no longer pays for the row (Stripe does):
 * nothing is written, so neither the Stripe-paid entitlement nor its plan
 * credits are touched.
 */
export async function clawBackIap(
  admin: SupabaseClient,
  userId: string,
  tx: IapTransaction,
  eventAt = new Date().toISOString(),
  delivery: OpenDelivery | Record<never, never> = {},
): Promise<Settlement> {
  const refundedPlan = iapPlanFor(tx.productId);
  if (refundedPlan) return await refundSubscription(admin, userId, tx, refundedPlan, eventAt, delivery);
  // Claw back exactly what the original grant wrote (rates may have changed).
  const { data: grant, error } = await admin
    .from('ledger_entries')
    .select('amount_credits')
    .eq('user_id', userId)
    .in('stripe_ref', [`apple:${tx.transactionId}`, `iap:${tx.transactionId}`])
    .maybeSingle();
  if (error) throw new Error(`iap_refund_lookup_failed ${error.message}`);
  if (!grant) {
    console.error('refund for unknown iap grant', tx.transactionId);
    return 'unfulfillable:unknown_iap_grant';
  }
  await applyFulfillment(admin, {
    ...delivery,
    source: 'apple',
    environment: tx.environment,
    businessTxnId: `refund:${tx.transactionId}`,
    userId,
    kind: 'clawback',
    credits: Number(grant.amount_credits),
    eventAt,
  });
  return 'granted';
}

async function refundSubscription(
  admin: SupabaseClient,
  userId: string,
  tx: IapTransaction,
  refundedPlan: 'studio' | 'pro',
  eventAt: string,
  delivery: OpenDelivery | Record<never, never>,
): Promise<Settlement> {
  const { data: row, error } = await admin
    .from('subscriptions')
    .select('stripe_subscription_id, current_period_end')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`iap_refund_row_lookup_failed ${error.message}`);
  if (stripeCarriesRow(row, tx.expiresDate)) {
    console.info('apple_refund_left_stripe_row', tx.transactionId);
    return 'nothing_owed';
  }
  await applyFulfillment(admin, {
    ...delivery,
    source: 'apple',
    environment: tx.environment,
    businessTxnId: `refund:${tx.transactionId}`,
    userId,
    kind: 'subscription_grant',
    plan: refundedPlan,
    credits: 0,
    eventAt,
    entitlement: {
      plan: refundedPlan,
      status: 'expired',
      current_period_end: eventAt,
    },
  });
  return 'granted';
}

/** Never reactivates a closed account: only a row that already exists for this
 * original transaction is moved, and a failed write is raised, not swallowed.
 * A row Stripe carries past Apple's expiry (stripeCarriesRow) is left alone;
 * the guard is in the UPDATE itself, so a Stripe write cannot slip between a
 * read and this write. */
export async function setIapSubscriptionStatus(
  admin: SupabaseClient,
  originalTransactionId: string,
  status: 'active' | 'canceled' | 'expired',
  appleExpiresMs?: number,
): Promise<void> {
  const base = admin
    .from('subscriptions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('iap_original_transaction_id', originalTransactionId);
  const guarded = appleExpiresMs
    ? base.or(appleCarriesRow(new Date(appleExpiresMs).toISOString()))
    : base;
  const { error } = await guarded;
  if (error) throw new Error(`iap_status_update_failed ${error.message}`);
}

/** The negation of stripeCarriesRow, as a PostgREST filter. */
function appleCarriesRow(appleExpiresIso: string): string {
  return [
    'stripe_subscription_id.is.null',
    'current_period_end.is.null',
    `current_period_end.lte.${appleExpiresIso}`,
  ].join(',');
}

export async function findUserByOriginalTransaction(
  admin: SupabaseClient,
  originalTransactionId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('iap_original_transaction_id', originalTransactionId)
    .maybeSingle();
  if (error) throw new Error(`iap_account_lookup_failed ${error.message}`);
  return data?.user_id ?? null;
}

async function currentPlan(admin: SupabaseClient, userId: string): Promise<'studio' | 'pro'> {
  const { data, error } = await admin
    .from('subscriptions')
    .select('plan')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`iap_plan_lookup_failed ${error.message}`);
  return data?.plan === 'pro' ? 'pro' : 'studio';
}
