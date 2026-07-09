# Vansen Phase 2 — Stripe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test-mode Stripe end to end: hosted checkout (mixed first cart $10 credits + $5 Studio), top-ups, signature-verified webhook → ledger with double-credit-proof constraints, Billing Portal, reconcile self-heal, Studio lifecycle + purge cron, billing UI.

**Architecture:** `api` gateway grows `/billing/*` routes that create Checkout/Portal sessions; a second Edge Function `stripe-webhook` (signature-trust, no JWT) is the ONLY writer of `topup` ledger rows, guarded by `webhook_events` dedupe + `ledger_entries.stripe_ref UNIQUE`. Subscriptions table mirrors Stripe via webhooks; daily pg_cron purge enforces the 30-day grace.

**Tech Stack:** Stripe SDK `npm:stripe` in Deno Edge Functions, Stripe test mode, pg_cron, Angular signals frontend.

## Global Constraints

- **NEVER git commit/branch/push** — user commits. Steps end at green build/verification.
- Test mode only; live keys are phase 4.
- Presets: top-up `{10,20,50,100}` USD, min $10, server-validated. First purchase adds $5 Studio (due 15/25/55/105).
- Studio fee NEVER touches the wallet ledger; only credit lines become `topup +N`.
- `topup` ledger writes exist ONLY in `stripe-webhook`; `stripe_ref` UNIQUE is the double-credit backstop.
- Webhook returns 200 only after DB commit; anything else 500 (Stripe retries).
- Components ts/html/css separate; enums from `core/enums.ts`; no client money math.
- Build/tests: nvm 22.23.1 prefix as phase 1. Supabase ops via MCP (`execute_sql`, `deploy_edge_function`, `get_logs`). Project `bnorhcxhvxydkgvcxjad`.
- Error body `{ error: { code, message } }`; new codes: `billing_failed`, `invalid_amount`.

---

### Task 1: Migration 0003 — billing schema + purge cron

**Files:**
- Create: `supabase/migrations/0003_billing.sql` (repo record; applied via MCP `execute_sql`)

**Interfaces:**
- Produces: `profiles.stripe_customer_id text unique`, `ledger_entries.stripe_ref text unique`, `webhook_events(id text pk, type, received_at)` RLS-enabled deny-all, pg_cron job `purge_lapsed_libraries` daily 03:00 UTC.

- [ ] **Step 1: Apply via MCP + save file:**

```sql
alter table public.profiles add column stripe_customer_id text unique;
alter table public.ledger_entries add column stripe_ref text unique;

create table public.webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
alter table public.webhook_events enable row level security;

create extension if not exists pg_cron;

-- Day 31 after the paid period ends: library rows die; ledger never purged.
select cron.schedule(
  'purge_lapsed_libraries',
  '0 3 * * *',
  $$
  delete from public.generations g
  using public.subscriptions s
  where s.user_id = g.user_id
    and s.status in ('canceled','expired')
    and s.current_period_end < now() - interval '30 days'
  $$
);
```

- [ ] **Step 2: Verify** — `list_tables` shows `webhook_events` rls_enabled; `select jobname from cron.job` contains `purge_lapsed_libraries`; `get_advisors(security)` still clean (INFO-only).

---

### Task 2: USER ACTIONS — Stripe test-mode setup (BLOCKING)

**Request explicitly, wait for "done":**

1. Stripe Dashboard (test mode) → **Products → Add product**: name `Vansen Studio`, recurring, $5.00 USD monthly → save → copy the **price id** (`price_...`).
2. **Developers → API keys** → copy the test **Secret key** (`sk_test_...`).
3. **Developers → Webhooks → Add endpoint**: URL `https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/stripe-webhook`; events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` → copy **Signing secret** (`whsec_...`).
4. Supabase Dashboard → project vansen → **Edge Functions → Secrets** → add:
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_STUDIO_PRICE_ID`.

(Promo code optional, anytime: Products → Coupons → e.g. 30% off, then Promotion code `LAUNCH30`. Zero code changes.)

---

### Task 3: `api` v3 — billing routes + deletion hook

**Files:**
- Modify: `supabase/functions/api/index.ts` (+ redeploy with `_shared/*`)

**Interfaces:**
- Consumes: secrets from Task 2; `profiles.stripe_customer_id`.
- Produces routes (all JWT-authed):
  - `POST /billing/checkout` `{ creditsUsd?: 10|20|50|100, studioOnly?: boolean }` → `{ url }`
  - `POST /billing/portal` → `{ url }`
  - `POST /billing/reconcile` → `{ credited: number, balanceUsd: number }`
  - `DELETE /profile` now cancels active Stripe subscription first.

- [ ] **Step 1: Add Stripe client + helpers** (top of file):

```typescript
import Stripe from 'npm:stripe@17';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});
const STUDIO_PRICE_ID = Deno.env.get('STRIPE_STUDIO_PRICE_ID')!;
const APP_ORIGIN = 'http://localhost:4200';
const TOPUP_PRESETS = [10, 20, 50, 100];

async function stripeCustomerFor(userId: string, email: string): Promise<string> {
  const { data: profile } = await admin
    .from('profiles').select('stripe_customer_id').eq('id', userId).single();
  if (profile?.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await stripe.customers.create({ email, metadata: { user_id: userId } });
  await admin.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', userId);
  return customer.id;
}

async function hasActiveStudio(userId: string): Promise<boolean> {
  const { data } = await admin.from('subscriptions').select('status,current_period_end')
    .eq('user_id', userId).maybeSingle();
  if (!data || data.status !== 'active') return false;
  return !data.current_period_end || new Date(data.current_period_end) > new Date();
}
```

- [ ] **Step 2: Routes:**

```typescript
app.post('/billing/checkout', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const studioOnly = body.studioOnly === true;
  const creditsUsd = Number(body.creditsUsd);
  if (!studioOnly && !TOPUP_PRESETS.includes(creditsUsd)) {
    return fail(c, 400, 'invalid_amount', `creditsUsd must be one of ${TOPUP_PRESETS.join(', ')} (min $10)`);
  }
  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    const active = await hasActiveStudio(userId);
    const needsStudio = studioOnly || !active;

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    if (needsStudio) lineItems.push({ price: STUDIO_PRICE_ID, quantity: 1 });
    if (!studioOnly) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Vansen generation credits' },
          unit_amount: creditsUsd * 100,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer,
      mode: needsStudio ? 'subscription' : 'payment',
      line_items: lineItems,
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/app?checkout=success`,
      cancel_url: `${APP_ORIGIN}/app?checkout=canceled`,
      metadata: { user_id: userId, credits_usd: studioOnly ? '0' : String(creditsUsd) },
      subscription_data: needsStudio ? { metadata: { user_id: userId } } : undefined,
    });
    return c.json({ url: session.url });
  } catch (e) {
    console.error('checkout_failed:', e);
    return fail(c, 400, 'billing_failed', 'Could not start checkout');
  }
});

app.post('/billing/portal', async (c) => {
  try {
    const customer = await stripeCustomerFor(c.get('userId'), c.get('email'));
    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${APP_ORIGIN}/app/settings`,
    });
    return c.json({ url: portal.url });
  } catch (e) {
    console.error('portal_failed:', e);
    return fail(c, 400, 'billing_failed', 'Could not open billing portal');
  }
});

app.post('/billing/reconcile', async (c) => {
  const userId = c.get('userId');
  try {
    const { data: profile } = await admin
      .from('profiles').select('stripe_customer_id').eq('id', userId).single();
    if (!profile?.stripe_customer_id) return c.json({ credited: 0, balanceUsd: await balanceOf(userId) });
    const sessions = await stripe.checkout.sessions.list({
      customer: profile.stripe_customer_id, limit: 100,
    });
    let credited = 0;
    for (const s of sessions.data) {
      if (s.payment_status !== 'paid') continue;
      const credits = Number(s.metadata?.credits_usd ?? 0);
      if (!credits) continue;
      const { error } = await admin.from('ledger_entries').insert({
        user_id: userId, type: 'topup', amount_usd: credits,
        note: 'Top-up (reconciled)', stripe_ref: s.id,
      });
      if (!error) credited += 1; // unique(stripe_ref) bounces already-credited sessions
    }
    return c.json({ credited, balanceUsd: await balanceOf(userId) });
  } catch (e) {
    console.error('reconcile_failed:', e);
    return fail(c, 400, 'billing_failed', 'Reconcile failed');
  }
});
```

- [ ] **Step 3: DELETE /profile prepends:**

```typescript
const { data: prof } = await admin.from('profiles').select('stripe_customer_id').eq('id', userId).single();
if (prof?.stripe_customer_id) {
  const subs = await stripe.subscriptions.list({ customer: prof.stripe_customer_id, status: 'active' });
  for (const sub of subs.data) await stripe.subscriptions.cancel(sub.id);
}
```

- [ ] **Step 4:** Redeploy `api` (same `_shared` files). Verify: authed `POST /billing/checkout {creditsUsd: 7}` → 400 invalid_amount; `{creditsUsd: 20}` → 200 with `url` starting `https://checkout.stripe.com/`.

---

### Task 4: `stripe-webhook` function

**Files:**
- Create: `supabase/functions/stripe-webhook/index.ts`; deploy `verify_jwt: false` (signature is the auth).

- [ ] **Step 1: Full implementation:**

```typescript
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('missing signature', { status: 400 });
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch {
    return new Response('invalid signature', { status: 400 });
  }

  // Dedupe: first writer wins; replays exit here.
  const { error: dupe } = await admin.from('webhook_events').insert({ id: event.id, type: event.type });
  if (dupe) return new Response('already processed', { status: 200 });

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== 'paid') break;
        const userId = session.metadata?.user_id;
        if (!userId) break;

        const credits = Number(session.metadata?.credits_usd ?? 0);
        if (credits > 0) {
          // Integrity: metadata amount must match Stripe's own subtotal for the credits line.
          // Subtotal = credits*100 (+500 when the cart carried the Studio subscription).
          const expected = credits * 100 + (session.mode === 'subscription' ? 500 : 0);
          if (session.amount_subtotal !== expected) {
            console.error('amount mismatch', session.id, session.amount_subtotal, expected);
            break; // no credit on mismatch; loud log
          }
          const { error } = await admin.from('ledger_entries').insert({
            user_id: userId, type: 'topup', amount_usd: credits,
            note: 'Top-up', stripe_ref: session.id,
          });
          if (error && !error.message.includes('duplicate')) throw error;
        }

        if (session.mode === 'subscription' && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(String(session.subscription));
          await upsertSubscription(userId, sub);
        }
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoice.subscription ? String(invoice.subscription) : null;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const userId = sub.metadata?.user_id;
          if (userId) await upsertSubscription(userId, sub);
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

async function upsertSubscription(userId: string, sub: Stripe.Subscription): Promise<void> {
  const status = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due'
    ? (sub.cancel_at_period_end ? 'canceled' : 'active')
    : 'expired';
  const { error } = await admin.from('subscriptions').upsert(
    {
      user_id: userId,
      plan: 'studio',
      status,
      current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
      stripe_subscription_id: sub.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}
```

Status mapping note: `past_due` stays functionally active (Stripe dunning owns retries); portal-cancel shows as `canceled` (works until period end); terminal states → `expired` (grace clock = period end).

- [ ] **Step 2:** Deploy (`verify_jwt: false`). Verify: POST without signature → 400; garbage signature → 400; `get_logs` clean boot.

---

### Task 5: Frontend billing

**Files:**
- Modify: `src/app/core/api/dtos.ts` (+`CheckoutResponse { url }`, `ReconcileResponse { credited, balanceUsd }`), `src/app/core/profile/profile-store.ts` (add `reload()` alias), new `src/app/core/billing/billing-service.ts`, `billing-tab.{ts,html,css}`, `workspace-page.{ts,html}`, `editor-page.ts`, `settings-page.ts`, `plans-page.{ts,html}`
- Test: `src/app/core/billing/billing-service.spec.ts`

**Interfaces:**
- Produces: `BillingService.checkout(creditsUsd): Promise<void>` (redirects via `location.assign(url)`), `.reactivateStudio()`, `.openPortal()`, `.reconcile(): Promise<number>`.

- [ ] **Step 1: Failing test** — BillingService calls the right endpoints and redirects:

```typescript
it('checkout posts amount and redirects to the session url', async () => {
  const api = { post: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/x' }) };
  const nav = vi.fn();
  const billing = new BillingService(api as never, nav);
  await billing.checkout(20);
  expect(api.post).toHaveBeenCalledWith('/billing/checkout', { creditsUsd: 20 });
  expect(nav).toHaveBeenCalledWith('https://checkout.stripe.com/x');
});
```

(Constructor takes `(api, navigate = (u) => location.assign(u))` — injectable via DI providers like ApiService pattern from phase 1.)

- [ ] **Step 2: Implement BillingService** (thin: checkout/portal/reconcile passthroughs).
- [ ] **Step 3: Billing tab** — top-up buttons ($10/$20/$50/$100; label shows "+$5 Studio, due $N+5" when no active sub), Manage Studio → portal, "Didn't receive your credits?" → reconcile → refresh ledger+profile, cancel/lapse warnings from `subscription` state (canceled: "Studio ends {date} — library deleted 30 days after"; expired: days-left countdown).
- [ ] **Step 4: Workspace** — `?checkout=success`: poll `profileStore.load()` every 1s up to 6s until balance changes → notice "Credits added — balance $X"; `canceled` → "Checkout canceled". Grace banner when subscription expired & within 30 days. Top-up nudges (topbar/profile menu/402 notice) call `billing.checkout(20)` default or route to Billing tab.
- [ ] **Step 5: Plans page** — copy "Start from $15 — $10 balance + first month of Studio"; chips due 15/25/55/105 (credits 10/20/50/100); estimates from $10.
- [ ] **Step 6:** Tests + build green.

---

### Task 6: Live test-mode E2E + docs

- [ ] **Step 1:** Fresh test account via preview browser → Billing → $15 first purchase → Stripe hosted page → card `4242 4242 4242 4242` (any future expiry, any CVC) → redirected back → balance $10, ledger `topup +10` with stripe_ref, subscriptions row active, Studio badge on.
- [ ] **Step 2:** Later top-up $20 (mode=payment; no extra $5) → balance $30.
- [ ] **Step 3:** Integrity drills: replay the completed event (Stripe dashboard "resend") → webhook_events dedupe → no double credit; SQL-delete the topup row → `POST /billing/reconcile` → row restored, `credited: 1`; decline card `4000 0000 0000 0002` → no session paid → no credit.
- [ ] **Step 4:** Portal: cancel Studio → status canceled + UI warning. Lapse simulation: SQL set `status='expired', current_period_end = now() - 31 days` → grace banner shows 0 days / run purge SQL manually → generations gone, ledger intact. Restore test state.
- [ ] **Step 5:** Account deletion with active sub → Stripe subscription canceled (verify in dashboard) + full wipe.
- [ ] **Step 6:** vansen.md status + CLAUDE.md backend notes updated (phase 2 shipped, test mode). Full vitest + build green.

---

## Self-review notes

- Spec coverage: §3/§4→T3, §5/§6→T4 (+reconcile in T3), §7→T1 cron + T4 mapping + T5 UI, §8→T1, §9→T5, §10→T2, §11→T6. Promo codes = zero-code (T2 note).
- Integrity invariants encoded: only-webhook-writes-topup (T4), stripe_ref UNIQUE (T1), amount cross-check (T4), 200-after-commit with dedupe rollback on failure (T4), reconcile idempotent (T3).
- No commits anywhere. Type names consistent (CheckoutResponse/ReconcileResponse across T3 responses and T5 dtos).
