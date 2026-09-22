// Stripe webhook consumer. Trust anchor: the Stripe signature (no JWT). All
// money goes through fn_apply_fulfillment, which is idempotent on the BUSINESS
// transaction — the invoice or session id, which Stripe keeps stable across
// redeliveries — so this handler never has to decide whether a retry is safe.
//
// webhook_events is now only a delivery marker for observability. It is written
// AFTER the work commits, so a crashed run leaves nothing behind to skip.
import type Stripe from 'npm:stripe@17';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { CREDIT_PACKS, packCredits, PLAN_CREDITS } from './_shared/model-families.ts';
import {
  applyFulfillment,
  deliverVerified,
  type Settlement,
  type VerifiedReceipt,
} from './_shared/billing-fulfillment.ts';

/** What the server recorded when it created the pack checkout. The grant is
 * recomputed from this through the catalog — never read off the session. */
export interface PackPurchase {
  usd: number;
  plan: 'studio' | 'pro';
}

export interface StripeWebhookDeps {
  admin: SupabaseClient;
  constructEvent(payload: string, signature: string): Promise<Stripe.Event>;
  retrieveSubscription(id: string): Promise<Stripe.Subscription>;
  retrievePackPurchase(sessionId: string): Promise<PackPurchase>;
  priceIds: { studio?: string; pro?: string };
}

/**
 * The subscription an invoice belongs to. Stripe moved this off the invoice in
 * the 2025 API versions (invoice.parent.subscription_details.subscription), and
 * webhook payloads use the ACCOUNT's default version regardless of what the SDK
 * pins — so read both shapes. Returning null here silently skips a cycle grant,
 * which is why this must never guess.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as { subscription?: string | { id: string } }).subscription;
  if (legacy) return typeof legacy === 'string' ? legacy : legacy.id;
  const parent = (invoice as {
    parent?: { subscription_details?: { subscription?: string | { id: string } } };
  }).parent?.subscription_details?.subscription;
  if (parent) return typeof parent === 'string' ? parent : parent.id;
  return null;
}

/** Period end moved onto subscription items in the 2025 API versions. */
export function periodEndIso(sub: Stripe.Subscription): string {
  const top = (sub as { current_period_end?: number }).current_period_end;
  const item = sub.items?.data?.[0] as { current_period_end?: number } | undefined;
  const epoch = top ?? item?.current_period_end;
  if (!epoch) throw new Error(`no current_period_end on subscription ${sub.id}`);
  return new Date(epoch * 1000).toISOString();
}

/** Entitlements belong to the paid line, never to today's mutable subscription. */
function invoicedEntitlement(
  invoice: Stripe.Invoice,
  subscriptionId: string,
  priceIds: StripeWebhookDeps['priceIds'],
): { plan: 'studio' | 'pro'; periodEnd: string } {
  if (!invoice.lines || invoice.lines.has_more) throw new Error('incomplete_invoice_lines');
  const entitlements = new Map<string, { plan: 'studio' | 'pro'; periodEnd: string }>();
  for (const raw of invoice.lines.data) {
    const line = raw as unknown as {
      type?: string; subscription?: string | { id: string }; amount: number;
      price?: { id: string }; period?: { end?: number };
      parent?: { subscription_item_details?: { subscription?: string } };
      pricing?: { price_details?: { price?: string | { id: string } } };
    };
    const linked = line.parent?.subscription_item_details?.subscription ?? line.subscription;
    const linkedId = typeof linked === 'string' ? linked : linked?.id;
    if (linkedId !== subscriptionId || line.amount < 0) continue;
    const price = line.pricing?.price_details?.price ?? line.price;
    const id = typeof price === 'string' ? price : price?.id;
    const plan = id && id === priceIds.pro ? 'pro' : id && id === priceIds.studio ? 'studio' : null;
    if (!plan) throw new Error('unrecognized_invoice_price');
    const epoch = line.period?.end;
    if (!epoch || !Number.isFinite(epoch)) throw new Error('missing_invoice_period');
    const periodEnd = new Date(epoch * 1000).toISOString();
    entitlements.set(`${plan}:${periodEnd}`, { plan, periodEnd });
  }
  if (entitlements.size !== 1) throw new Error('ambiguous_invoice_entitlement');
  return [...entitlements.values()][0];
}

const GRANTING_REASONS = [
  'subscription_create',
  'subscription_cycle',
  'subscription_update',
];

/**
 * D1 (vansen.md §5): the launch promotion is "first 2 cycles $10 / $25 with
 * FULL credit grant". Grants therefore follow the plan, not the money paid.
 * A verified paid subscription cycle grants the full amount even with a 100%
 * discount. A prorated upgrade tops the bucket up to the new plan without ever
 * taking credits away from someone who just paid more.
 */
export function cycleGrant(
  plan: 'studio' | 'pro',
  billingReason: string | null,
  amountPaid: number,
): { credits: number; neverLower: boolean } | null {
  if (!GRANTING_REASONS.includes(billingReason ?? '')) return null;
  if (amountPaid < 0) throw new Error('invalid_invoice_amount');
  const neverLower = billingReason === 'subscription_update';
  return { credits: PLAN_CREDITS[plan], neverLower };
}

/** The `subscriptions` mirror patch. Same status mapping as before: past_due
 * stays functionally active (Stripe dunning owns retries), cancel_at_period_end
 * shows as canceled, terminal states become expired. */
export function stripeEntitlement(
  sub: Stripe.Subscription,
  plan: 'studio' | 'pro',
  periodEnd: string,
): Record<string, unknown> {
  const alive = sub.status === 'active' || sub.status === 'trialing' ||
    sub.status === 'past_due';
  const status = alive ? (sub.cancel_at_period_end ? 'canceled' : 'active') : 'expired';
  return {
    plan,
    status,
    current_period_end: periodEnd,
    stripe_subscription_id: sub.id,
    cancel_reason: sub.cancel_at_period_end ? (sub.metadata?.cancel_reason || null) : null,
  };
}

export function createStripeWebhook(
  deps: StripeWebhookDeps,
): (req: Request) => Promise<Response> {
  const { admin, constructEvent, retrieveSubscription, retrievePackPurchase, priceIds } = deps;

  /** Never guess a plan for money: an unrecognized price halts the grant
   * loudly rather than charging one plan and granting another. */
  function planFor(sub: Stripe.Subscription): 'studio' | 'pro' {
    const priceId = sub.items.data[0]?.price?.id;
    if (priceId === priceIds.pro) return 'pro';
    if (priceId === priceIds.studio) return 'studio';
    throw new Error(`unrecognized_subscription_price ${sub.id} ${priceId}`);
  }

  /** A scheduled change is done the moment the subscription reports the new price. */
  async function pendingDone(userId: string, plan: string): Promise<boolean> {
    const { data } = await admin
      .from('subscriptions')
      .select('pending_plan')
      .eq('user_id', userId)
      .maybeSingle();
    return data?.pending_plan != null && data.pending_plan === plan;
  }

  async function handleInvoicePaid(event: Stripe.Event): Promise<Settlement> {
    const invoice = event.data.object as Stripe.Invoice;
    const subId = invoiceSubscriptionId(invoice);
    if (!subId) return 'nothing_owed';
    if (!GRANTING_REASONS.includes(invoice.billing_reason ?? '')) return 'nothing_owed';
    const sub = await retrieveSubscription(subId);
    const userId = sub.metadata?.user_id;
    if (!userId) return 'unfulfillable:no_user_id';
    const alive = sub.status === 'active' || sub.status === 'trialing' ||
      sub.status === 'past_due';
    if (!alive) return `unfulfillable:subscription_${sub.status}`;
    const { plan, periodEnd } = invoicedEntitlement(invoice, subId, priceIds);
    const grant = cycleGrant(plan, invoice.billing_reason ?? null, invoice.amount_paid ?? 0);
    if (!grant) {
      console.info('non_cycle_invoice_not_granted', invoice.id);
      return 'nothing_owed';
    }
    // Refresh the current mirror independently. A late invoice then reaches the
    // SQL stale-period guard with its ORIGINAL period and cannot refill it.
    const currentPlan = planFor(sub);
    const { error } = await admin.from('subscriptions').upsert({
      user_id: userId,
      ...stripeEntitlement(sub, currentPlan, periodEndIso(sub)),
      ...(await pendingDone(userId, currentPlan) ? { pending_plan: null, pending_at: null } : {}),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw new Error(`subscription_mirror_failed ${error.message}`);
    await applyFulfillment(admin, {
      source: 'stripe',
      eventId: event.id,
      receiptOpen: true,
      businessTxnId: String(invoice.id),
      userId,
      kind: 'subscription_grant',
      plan,
      credits: grant.credits,
      periodEnd,
      eventAt: new Date(event.created * 1000).toISOString(),
      neverLower: grant.neverLower,
    });
    return 'granted';
  }

  async function handleCheckout(event: Stripe.Event): Promise<Settlement> {
    const session = event.data.object as Stripe.Checkout.Session;
    // An unpaid completion is followed by async_payment_succeeded, its own event.
    if (session.payment_status !== 'paid') return 'nothing_owed';
    const userId = session.metadata?.user_id;
    if (!userId) return 'unfulfillable:no_user_id';

    if (session.mode === 'subscription' && session.subscription) {
      const sub = await retrieveSubscription(String(session.subscription));
      const plan = planFor(sub);
      const periodEnd = periodEndIso(sub);
      // Mirror only. The grant lands on invoice.paid, which fires for the
      // first invoice too and carries the id we key the grant on.
      const { error } = await admin.from('subscriptions').upsert(
        {
          user_id: userId,
          ...stripeEntitlement(sub, plan, periodEnd),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
      if (error) throw new Error(`subscription_mirror_failed ${error.message}`);
      return 'nothing_owed';
    }

    if (session.mode !== 'payment') return 'nothing_owed';
    // The grant is the CATALOG's answer for the purchased pack, never a number
    // carried on the session. Tampered pack_credits cannot move it.
    const { usd, plan } = await retrievePackPurchase(String(session.id));
    const credits = packCredits(usd, plan);
    if (!Number.isSafeInteger(credits) || credits <= 0) {
      throw new Error(`invalid_pack_purchase ${session.id}`);
    }
    // Integrity: the recorded purchase must agree with Stripe's own subtotal. A
    // mismatch is a bug or an attack, never a routine case — it throws so the
    // delivery is retried and the discrepancy stays visible instead of being
    // consumed.
    if (session.amount_subtotal !== usd * 100) {
      throw new Error(
        `pack amount mismatch ${session.id}: subtotal ${session.amount_subtotal} vs ${usd * 100}`,
      );
    }
    await applyFulfillment(admin, {
      source: 'stripe',
      eventId: event.id,
      receiptOpen: true,
      businessTxnId: String(session.id),
      userId,
      kind: 'pack_grant',
      credits,
      eventAt: new Date(event.created * 1000).toISOString(),
    });
    return 'granted';
  }

  const MONEY_EVENTS = new Set([
    'invoice.paid',
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
  ]);

  /** The receipt for a verified payment event, knowable from the payload alone. */
  function receiptFor(event: Stripe.Event): VerifiedReceipt | null {
    if (!MONEY_EVENTS.has(event.type)) return null;
    const object = event.data.object as { id: string; metadata?: { user_id?: string } };
    return {
      source: 'stripe',
      eventId: event.id,
      businessTxnId: String(object.id),
      userId: object.metadata?.user_id ?? null,
      request: { type: event.type },
    };
  }

  function settleMoneyEvent(event: Stripe.Event): Promise<Settlement> {
    if (event.type === 'invoice.paid') return handleInvoicePaid(event);
    return handleCheckout(event);
  }

  async function handleSubscriptionChanged(event: Stripe.Event): Promise<void> {
    // Re-fetch rather than trust event.data.object: Stripe renders webhook
    // payloads with the ACCOUNT's default API version, which may drop fields
    // we read. retrieve() always answers in the pinned shape.
    const raw = event.data.object as Stripe.Subscription;
    const userId = raw.metadata?.user_id;
    if (!userId) return;
    const sub = await retrieveSubscription(raw.id);
    const plan = planFor(sub);
    const periodEnd = periodEndIso(sub);
    const clear = await pendingDone(userId, plan);
    const { error } = await admin.from('subscriptions').upsert(
      {
        user_id: userId,
        ...stripeEntitlement(sub, plan, periodEnd),
        ...(clear ? { pending_plan: null, pending_at: null } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
    if (error) throw new Error(`subscription_mirror_failed ${error.message}`);
  }

  return async function handle(req: Request): Promise<Response> {
    const signature = req.headers.get('stripe-signature');
    if (!signature) return new Response('missing signature', { status: 400 });
    const payload = await req.text();

    let event: Stripe.Event;
    try {
      event = await constructEvent(payload, signature);
    } catch {
      return new Response('invalid signature', { status: 400 });
    }

    try {
      const receipt = receiptFor(event);
      if (receipt) await deliverVerified(admin, receipt, () => settleMoneyEvent(event));
      if (event.type === 'customer.subscription.updated') {
        await handleSubscriptionChanged(event);
      }
      if (event.type === 'customer.subscription.deleted') {
        await handleSubscriptionChanged(event);
      }
      if (event.type === 'invoice.payment_failed') {
        console.error('payment_failed invoice', (event.data.object as Stripe.Invoice).id);
      }
      // Delivery marker, written last and best-effort: it exists for the
      // operator's timeline, never as an idempotency gate. A duplicate id on a
      // redelivery is expected and must not fail the response.
      const { error } = await admin
        .from('webhook_events')
        .insert({ id: event.id, type: event.type });
      if (error) console.info('delivery_marker_not_written', event.id, error.message);
      return new Response('ok', { status: 200 });
    } catch (e) {
      console.error('webhook processing failed:', event.id, e);
      return new Response('processing failed', { status: 500 });
    }
  };
}

/** Allowlist check shared by the production `retrievePackPurchase`. */
export function isCataloguedPack(usd: number): boolean {
  return CREDIT_PACKS.some((p) => p.usd === usd);
}
