// App Store Server Notifications v2 consumer — the ONLY iap-source ledger
// writer, mirroring stripe-webhook discipline. Trust anchor: Apple's JWS x5c
// chain (no JWT). Integrity: webhook_events dedupe on notificationUUID +
// per-transaction 'iaptx:' marker (shared with POST /iap/verify). 200 only
// after DB writes commit; failures 500 so Apple retries.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { appleVerifier } from './_shared/apple-verifier.ts';
import { actionFor } from './_shared/iap-notifications.ts';
import {
  applyIapTransaction,
  clawBackIap,
  findUserByOriginalTransaction,
  setIapSubscriptionStatus,
} from './_shared/iap-grants.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req) => {
  const body = await req.json().catch(() => null);
  const signedPayload = body?.signedPayload;
  if (typeof signedPayload !== 'string') return new Response('bad request', { status: 400 });

  let payload;
  try {
    payload = await appleVerifier().verifyAndDecodeNotification(signedPayload);
  } catch {
    return new Response('invalid signature', { status: 401 });
  }

  // Dedupe: first writer wins; Apple's retries and replays exit here.
  const { error: dupe } = await admin
    .from('webhook_events')
    .insert({ id: payload.notificationUUID, type: payload.notificationType ?? 'unknown' });
  if (dupe) return new Response('already processed', { status: 200 });

  try {
    await handle(payload);
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('appstore webhook failed:', e);
    await admin.from('webhook_events').delete().eq('id', payload.notificationUUID);
    return new Response('processing failed', { status: 500 });
  }
});

// deno-lint-ignore no-explicit-any
async function handle(payload: any): Promise<void> {
  const action = actionFor(payload.notificationType ?? '', payload.subtype);
  if (action === 'ignore') return;

  const signedTx = payload.data?.signedTransactionInfo;
  if (!signedTx) {
    console.error('notification without transaction info', payload.notificationUUID);
    return;
  }
  const tx = await appleVerifier().verifyAndDecodeTransaction(signedTx);
  const transaction = {
    productId: tx.productId ?? '',
    transactionId: tx.transactionId ?? '',
    originalTransactionId: tx.originalTransactionId ?? '',
    expiresDate: tx.expiresDate,
    appAccountToken: tx.appAccountToken,
  };

  if (action === 'set_active' || action === 'set_canceled' || action === 'set_expired') {
    const status = action === 'set_active' ? 'active' : action === 'set_canceled' ? 'canceled' : 'expired';
    await setIapSubscriptionStatus(admin, transaction.originalTransactionId, status);
    return;
  }

  const userId = transaction.appAccountToken ??
    await findUserByOriginalTransaction(admin, transaction.originalTransactionId);
  if (!userId) {
    console.error('no user for iap transaction', transaction.originalTransactionId);
    return;
  }

  if (action === 'refund') {
    await clawBackIap(admin, userId, transaction);
    return;
  }
  await applyIapTransaction(admin, userId, transaction);
}
