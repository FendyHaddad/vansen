-- Scheduled plan changes (Studio <-> Pro at renewal).
--
-- A change booked for period end lives in a Stripe Subscription Schedule, but the
-- workspace must be able to say "Pro starts Aug 15" without an API round trip on
-- every /profile load. These columns mirror that pending phase: written by
-- POST /billing/change-plan, cleared by the webhook once the swap actually lands
-- (customer.subscription.updated arrives with the new price).
alter table public.subscriptions
add column if not exists pending_plan text check (
  pending_plan is null
  or pending_plan in ('studio', 'pro')
),
add column if not exists pending_at timestamptz;

comment on column public.subscriptions.pending_plan is 'Plan taking effect at pending_at; null when no change is scheduled. Mirror of a Stripe Subscription Schedule phase — Stripe stays the source of truth.';

comment on column public.subscriptions.pending_at is 'When pending_plan takes effect (current period end).';
