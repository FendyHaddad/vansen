// Production composition for the Stripe webhook. Behaviour lives in handler.ts.
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
// _shared/ is a symlink to ../_shared so the CLI bundles it (same as api).
import { createStripeWebhook, isCataloguedPack, type PackPurchase } from './handler.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

/**
 * The purchase the SERVER recorded when it created this checkout, re-read from
 * Stripe rather than taken off the delivered event. We return only the rate
 * inputs — the dollar size and the plan in force at purchase time — and the
 * handler asks the catalog what that is worth. A grant number written on the
 * session is never consumed.
 *
 * Anything we cannot recognise (unknown pack size, missing plan, wrong
 * currency, absent line item) throws, so the delivery is retried and the
 * discrepancy stays visible instead of being settled at a guessed rate.
 */
async function retrievePackPurchase(sessionId: string): Promise<PackPurchase> {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items'],
  });
  const usd = Number(session.metadata?.pack_usd);
  if (!Number.isFinite(usd) || !isCataloguedPack(usd)) {
    throw new Error(`unrecognized_pack_size ${sessionId} ${session.metadata?.pack_usd}`);
  }
  const plan = session.metadata?.pack_plan;
  if (plan !== 'studio' && plan !== 'pro') {
    throw new Error(`unrecognized_pack_plan ${sessionId} ${plan}`);
  }
  const line = session.line_items?.data?.[0];
  if (!line) throw new Error(`pack_line_item_missing ${sessionId}`);
  if (line.quantity !== 1) {
    throw new Error(`pack_quantity_unexpected ${sessionId} ${line.quantity}`);
  }
  if (line.currency !== 'usd') {
    throw new Error(`pack_currency_unexpected ${sessionId} ${line.currency}`);
  }
  return { usd, plan };
}

const handler = createStripeWebhook({
  admin: createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  ),
  constructEvent: (payload, signature) =>
    stripe.webhooks.constructEventAsync(
      payload,
      signature,
      WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    ),
  retrieveSubscription: (id) => stripe.subscriptions.retrieve(id),
  retrievePackPurchase,
  priceIds: {
    studio: Deno.env.get('STRIPE_STUDIO_PRICE_ID'),
    pro: Deno.env.get('STRIPE_PRO_PRICE_ID'),
  },
});

Deno.serve(handler);
