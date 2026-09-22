// App Store Server Notifications v2 consumer, mirroring stripe-webhook.
// Trust anchor: Apple's JWS x5c chain (no JWT). All money goes through
// fn_apply_fulfillment, keyed on Apple's transactionId, so a redelivery is
// settled by the database rather than by a marker written ahead of the grant.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { actionFor } from './_shared/iap-notifications.ts';
import {
  applyIapTransaction,
  clawBackIap,
  findUserByOriginalTransaction,
  type IapResult,
  type IapTransaction,
  type OpenDelivery,
  setIapSubscriptionStatus,
} from './_shared/iap-grants.ts';
import { deliverVerified, type Settlement } from './_shared/billing-fulfillment.ts';

// deno-lint-ignore no-explicit-any
type Decoded = any;

export interface AppstoreWebhookDeps {
  admin: SupabaseClient;
  verifyNotification(signedPayload: string): Promise<Decoded>;
  verifyTransaction(signedTransaction: string): Promise<Decoded>;
}

function statusFor(action: string): 'active' | 'canceled' | 'expired' {
  if (action === 'set_active') return 'active';
  if (action === 'set_canceled') return 'canceled';
  return 'expired';
}

/** A revoked or expired transaction owes nothing; an unknown product does. */
function settlementOf(result: IapResult): Settlement {
  if (result.outcome !== 'rejected') return 'granted';
  if (result.rejection === 'unknown_product') return 'unfulfillable:unknown_product';
  return 'nothing_owed';
}

export function createAppstoreWebhook(
  deps: AppstoreWebhookDeps,
): (req: Request) => Promise<Response> {
  const { admin, verifyNotification, verifyTransaction } = deps;

  async function handle(payload: Decoded): Promise<void> {
    const action = actionFor(payload.notificationType ?? '', payload.subtype);
    if (action === 'ignore') return;

    const signedTx = payload.data?.signedTransactionInfo;
    if (!signedTx) {
      console.error('notification without transaction info', payload.notificationUUID);
      return;
    }
    const raw = await verifyTransaction(signedTx);
    const tx: IapTransaction = {
      productId: raw.productId ?? '',
      transactionId: raw.transactionId ?? '',
      originalTransactionId: raw.originalTransactionId ?? '',
      expiresDate: raw.expiresDate,
      revocationDate: raw.revocationDate,
      appAccountToken: raw.appAccountToken,
    };
    // Verified event time, kept for ordering. Expiry is judged against the
    // current clock inside applyIapTransaction, not against this.
    const eventAt = payload.signedDate
      ? new Date(payload.signedDate).toISOString()
      : new Date().toISOString();

    if (action === 'set_active' || action === 'set_canceled' || action === 'set_expired') {
      await setIapSubscriptionStatus(admin, tx.originalTransactionId, statusFor(action));
      return;
    }

    // Money from here on. The receipt is written before the account lookup,
    // so a verified refund or purchase we then fail to place stays visible.
    const delivery: OpenDelivery = { eventId: payload.notificationUUID, receiptOpen: true };
    const businessTxnId = action === 'refund' ? `refund:${tx.transactionId}` : tx.transactionId;
    await deliverVerified(admin, {
      source: 'apple',
      eventId: delivery.eventId,
      businessTxnId,
      userId: tx.appAccountToken ?? null,
      request: { notificationType: payload.notificationType, subtype: payload.subtype, productId: tx.productId },
    }, async () => {
      const userId = tx.appAccountToken ??
        await findUserByOriginalTransaction(admin, tx.originalTransactionId);
      if (!userId) {
        console.error('no user for iap transaction', tx.originalTransactionId);
        return 'unfulfillable:no_user';
      }
      if (action === 'refund') {
        const clawedBack = await clawBackIap(admin, userId, tx, eventAt, delivery);
        return clawedBack ? 'granted' : 'unfulfillable:unknown_iap_grant';
      }
      return settlementOf(await applyIapTransaction(admin, userId, tx, eventAt, Date.now(), delivery));
    });
  }

  return async function serve(req: Request): Promise<Response> {
    const body = await req.json().catch(() => null);
    const signedPayload = body?.signedPayload;
    if (typeof signedPayload !== 'string') {
      return new Response('bad request', { status: 400 });
    }

    let payload: Decoded;
    try {
      payload = await verifyNotification(signedPayload);
    } catch {
      return new Response('invalid signature', { status: 401 });
    }

    try {
      await handle(payload);
      // Delivery marker, written last and best-effort, for the operator's
      // timeline only. A duplicate here is expected and harmless.
      const { error } = await admin
        .from('webhook_events')
        .insert({
          id: payload.notificationUUID,
          type: payload.notificationType ?? 'unknown',
        });
      if (error) {
        console.info('delivery_marker_not_written', payload.notificationUUID, error.message);
      }
      return new Response('ok', { status: 200 });
    } catch (e) {
      console.error('appstore webhook failed:', payload.notificationUUID, e);
      return new Response('processing failed', { status: 500 });
    }
  };
}
