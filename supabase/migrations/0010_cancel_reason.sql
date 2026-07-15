-- Why a subscriber canceled, mirrored from the in-app cancel survey.
--
-- The reason also lives on the Stripe subscription's metadata (visible in the
-- Stripe dashboard), but vankode-backoffice reads Vansen's tables directly and
-- never talks to Stripe — so churn analysis needs the reason here too. Written
-- by POST /billing/cancel, kept in sync by the webhook (metadata while a
-- cancellation is pending, null once the subscription is active again).
alter table public.subscriptions
add column if not exists cancel_reason text;

comment on column public.subscriptions.cancel_reason is 'Survey answer from the in-app cancel flow (e.g. too_expensive); null when no cancellation is pending.';
