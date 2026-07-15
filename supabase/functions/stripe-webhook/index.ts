// Stripe webhook consumer — the ONLY writer of grant ledger entries
// (cycle_reset on invoice.paid, pack_purchase on paid pack checkouts).
// Trust anchor: Stripe signature (no JWT). Integrity: webhook_events dedupe
// (event id pk) + ledger_entries.stripe_ref UNIQUE (one session, one grant).
// 200 is returned only after DB writes commit; failures 500 so Stripe retries.
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
// _shared/ is a symlink to ../_shared so the CLI bundles it (same as api).
import { PLAN_CREDITS } from './_shared/model-families.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const STUDIO_PRICE_ID = Deno.env.get('STRIPE_STUDIO_PRICE_ID');
const PRO_PRICE_ID = Deno.env.get('STRIPE_PRO_PRICE_ID');

/**
 * The subscription an invoice belongs to. Stripe moved this off the invoice in
 * the 2025 API versions (invoice.parent.subscription_details.subscription), and
 * webhook payloads use the ACCOUNT's default version regardless of what the SDK
 * pins — so read both shapes. Returning null here silently skips a cycle grant,
 * which is why this must never guess.
 */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as { subscription?: string | { id: string } }).subscription;
  if (legacy) return typeof legacy === 'string' ? legacy : legacy.id;
  const parent = (invoice as {
    parent?: { subscription_details?: { subscription?: string | { id: string } } };
  }).parent?.subscription_details?.subscription;
  if (parent) return typeof parent === 'string' ? parent : parent.id;
  return null;
}

/** Period end moved onto subscription items in the 2025 API versions. */
function periodEndIso(sub: Stripe.Subscription): string {
  const top = (sub as { current_period_end?: number }).current_period_end;
  const item = sub.items?.data?.[0] as { current_period_end?: number } | undefined;
  const epoch = top ?? item?.current_period_end;
  if (!epoch) throw new Error(`no current_period_end on subscription ${sub.id}`);
  return new Date(epoch * 1000).toISOString();
}

/**
 * Cycle grant scaled to money actually paid: a discounted invoice grants
 * proportionally fewer credits (launch coupon: Studio $10 → 1000, Pro $25 →
 * 3125), keeping the margin identical to full price. The ratio comes from the
 * invoice's own discount lines — not amount_paid — so tax never inflates it and
 * proration lines (which appear in the subtotal on upgrade invoices) never
 * shrink the upgrade grant below what the combined payments covered.
 */
function cycleGrant(invoice: Stripe.Invoice, plan: 'studio' | 'pro'): number {
  const subtotal = invoice.subtotal ?? 0;
  if (subtotal <= 0) return PLAN_CREDITS[plan];
  const discount = (invoice.total_discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0);
  const ratio = Math.min(1, Math.max(0, (subtotal - discount) / subtotal));
  return Math.round(PLAN_CREDITS[plan] * ratio);
}

function planFor(sub: Stripe.Subscription): 'studio' | 'pro' {
  const priceId = sub.items.data[0]?.price?.id;
  if (priceId === PRO_PRICE_ID) return 'pro';
  if (priceId === STUDIO_PRICE_ID) return 'studio';
  // metadata fallback (set at checkout); default studio, loud log
  const meta = sub.metadata?.plan;
  if (meta === 'pro' || meta === 'studio') return meta;
  console.error('unknown price id on subscription', sub.id, priceId);
  return 'studio';
}

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('missing signature', { status: 400 });
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch {
    return new Response('invalid signature', { status: 400 });
  }

  // Dedupe: first writer wins; replays exit here.
  const { error: dupe } = await admin
    .from('webhook_events')
    .insert({ id: event.id, type: event.type });
  if (dupe) return new Response('already processed', { status: 200 });

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== 'paid') break;
        const userId = session.metadata?.user_id;
        if (!userId) break;

        if (session.mode === 'payment') {
          const credits = Number(session.metadata?.pack_credits ?? 0);
          const usd = Number(session.metadata?.pack_usd ?? 0);
          // Integrity: server-set metadata must match Stripe's own subtotal.
          if (credits > 0 && session.amount_subtotal === usd * 100) {
            const { error } = await admin.rpc('fn_grant_pack', {
              p_user: userId, p_credits: credits, p_stripe_ref: session.id,
            });
            if (error) throw error;
          } else if (credits > 0) {
            console.error('pack amount mismatch', session.id, session.amount_subtotal, usd * 100);
          }
        }

        if (session.mode === 'subscription' && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(String(session.subscription));
          await upsertSubscription(userId, sub);
          // Grant happens on invoice.paid (fires for the first invoice too).
        }
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoiceSubscriptionId(invoice);
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const userId = sub.metadata?.user_id;
          if (userId) {
            await upsertSubscription(userId, sub);
            const plan = planFor(sub);
            const alive = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
            if (alive) {
              const { error } = await admin.rpc('fn_cycle_reset', {
                p_user: userId, p_grant: cycleGrant(invoice, plan),
              });
              if (error) throw error;
            }
          }
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        // Re-fetch rather than trust event.data.object: Stripe renders webhook
        // payloads with the ACCOUNT's default API version, which may be newer
        // than the version pinned above and drop fields we read. retrieve()
        // always answers in the pinned shape. deleted subs stay retrievable.
        const raw = event.data.object as Stripe.Subscription;
        const userId = raw.metadata?.user_id;
        if (userId) {
          const sub = await stripe.subscriptions.retrieve(raw.id);
          await upsertSubscription(userId, sub);
        }
        break;
      }
      case 'invoice.payment_failed':
        console.error('payment_failed invoice', (event.data.object as Stripe.Invoice).id);
        break;
      default:
        break; // 200-and-ignore keeps us forward-compatible
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('webhook processing failed:', e);
    // Roll the dedupe row back so Stripe's retry can reprocess.
    await admin.from('webhook_events').delete().eq('id', event.id);
    return new Response('processing failed', { status: 500 });
  }
});

/**
 * Mirror Stripe subscription state. past_due stays functionally active
 * (Stripe dunning owns retries); cancel_at_period_end shows as canceled
 * (works until period end); terminal states become expired (grace starts).
 */
async function upsertSubscription(userId: string, sub: Stripe.Subscription): Promise<void> {
  const alive = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
  const status = alive ? (sub.cancel_at_period_end ? 'canceled' : 'active') : 'expired';
  const plan = planFor(sub);
  // A scheduled change is done the moment the subscription reports the new price.
  // Clearing it on arrival (rather than waiting for the schedule to report) means
  // the reminder can never outlive the change it describes.
  const { data: existing } = await admin
    .from('subscriptions')
    .select('pending_plan')
    .eq('user_id', userId)
    .maybeSingle();
  const pendingDone = existing?.pending_plan != null && existing.pending_plan === plan;
  const { error } = await admin.from('subscriptions').upsert(
    {
      user_id: userId,
      plan,
      status,
      current_period_end: periodEndIso(sub),
      stripe_subscription_id: sub.id,
      // Mirror the cancel survey answer (metadata written by POST /billing/cancel)
      // so the backoffice sees it; a live subscription carries no reason.
      cancel_reason: sub.cancel_at_period_end ? (sub.metadata?.cancel_reason || null) : null,
      updated_at: new Date().toISOString(),
      ...(pendingDone ? { pending_plan: null, pending_at: null } : {}),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}
