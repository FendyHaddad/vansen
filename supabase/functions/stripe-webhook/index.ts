// Stripe webhook consumer — the ONLY writer of grant ledger entries
// (cycle_reset on invoice.paid, pack_purchase on paid pack checkouts).
// Trust anchor: Stripe signature (no JWT). Integrity: webhook_events dedupe
// (event id pk) + ledger_entries.stripe_ref UNIQUE (one session, one grant).
// 200 is returned only after DB writes commit; failures 500 so Stripe retries.
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
// NOTE: deployed via MCP with _shared/ nested inside the function bundle;
// keep this specifier matching the deploy layout (same convention as api).
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
        const subId = invoice.subscription ? String(invoice.subscription) : null;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const userId = sub.metadata?.user_id;
          if (userId) {
            await upsertSubscription(userId, sub);
            const plan = planFor(sub);
            const alive = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
            if (alive) {
              const { error } = await admin.rpc('fn_cycle_reset', {
                p_user: userId, p_grant: PLAN_CREDITS[plan],
              });
              if (error) throw error;
            }
          }
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;
        if (userId) await upsertSubscription(userId, sub);
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
  const { error } = await admin.from('subscriptions').upsert(
    {
      user_id: userId,
      plan: planFor(sub),
      status,
      current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
      stripe_subscription_id: sub.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}
