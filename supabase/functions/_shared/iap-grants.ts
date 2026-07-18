// The only credit-granting code for iap-source money. Idempotency:
//  - webhook_events 'iaptx:<transactionId>' marker: first writer wins across
//    BOTH appstore-webhook and POST /iap/verify (blocks the replay-refill
//    exploit on fn_cycle_reset, which is a snap-to-grant, not an insert).
//  - fn_grant_pack / fn_iap_clawback additionally bounce on stripe_ref UNIQUE.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { PLAN_CREDITS } from './model-families.ts';
import { IAP_PRODUCTS, iapGrant, iapPlanFor } from './iap-products.ts';

export interface IapTransaction {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  expiresDate?: number;
  appAccountToken?: string;
}

export async function applyIapTransaction(
  admin: SupabaseClient,
  userId: string,
  tx: IapTransaction,
): Promise<boolean> {
  const product = IAP_PRODUCTS[tx.productId];
  if (!product) {
    console.error('unknown iap product', tx.productId, tx.transactionId);
    return false;
  }
  const { error: dupe } = await admin
    .from('webhook_events')
    .insert({ id: `iaptx:${tx.transactionId}`, type: 'iap_transaction' });
  if (dupe) return false;

  if (product.kind === 'subscription') {
    await upsertIapSubscription(admin, userId, product.plan, tx);
    const { error } = await admin.rpc('fn_cycle_reset', {
      p_user: userId,
      p_grant: PLAN_CREDITS[product.plan],
    });
    if (error) throw error;
    return true;
  }

  const plan = await currentPlan(admin, userId);
  const { error } = await admin.rpc('fn_grant_pack', {
    p_user: userId,
    p_credits: iapGrant(tx.productId, plan),
    p_stripe_ref: `iap:${tx.transactionId}`,
  });
  if (error) throw error;
  return true;
}

export async function clawBackIap(
  admin: SupabaseClient,
  userId: string,
  tx: IapTransaction,
): Promise<void> {
  if (iapPlanFor(tx.productId)) {
    await setIapSubscriptionStatus(admin, tx.originalTransactionId, 'expired');
    const { error } = await admin.rpc('fn_cycle_reset', { p_user: userId, p_grant: 0 });
    if (error) throw error;
    return;
  }
  // Claw back exactly what the original grant wrote (rate may have changed since).
  const { data: grant } = await admin
    .from('ledger_entries')
    .select('amount_credits')
    .eq('stripe_ref', `iap:${tx.transactionId}`)
    .maybeSingle();
  if (!grant) {
    console.error('refund for unknown iap grant', tx.transactionId);
    return;
  }
  const { error } = await admin.rpc('fn_iap_clawback', {
    p_user: userId,
    p_credits: grant.amount_credits,
    p_ref: `iap-refund:${tx.transactionId}`,
  });
  if (error) throw error;
}

export async function setIapSubscriptionStatus(
  admin: SupabaseClient,
  originalTransactionId: string,
  status: 'active' | 'canceled' | 'expired',
): Promise<void> {
  const { error } = await admin
    .from('subscriptions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('iap_original_transaction_id', originalTransactionId);
  if (error) throw error;
}

export async function findUserByOriginalTransaction(
  admin: SupabaseClient,
  originalTransactionId: string,
): Promise<string | null> {
  const { data } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('iap_original_transaction_id', originalTransactionId)
    .maybeSingle();
  return data?.user_id ?? null;
}

async function upsertIapSubscription(
  admin: SupabaseClient,
  userId: string,
  plan: 'studio' | 'pro',
  tx: IapTransaction,
): Promise<void> {
  const periodEnd = tx.expiresDate
    ? new Date(tx.expiresDate).toISOString()
    : new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  const { error } = await admin.from('subscriptions').upsert(
    {
      user_id: userId,
      plan,
      status: 'active',
      current_period_end: periodEnd,
      iap_original_transaction_id: tx.originalTransactionId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

async function currentPlan(admin: SupabaseClient, userId: string): Promise<'studio' | 'pro'> {
  const { data } = await admin
    .from('subscriptions')
    .select('plan')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.plan === 'pro' ? 'pro' : 'studio';
}
