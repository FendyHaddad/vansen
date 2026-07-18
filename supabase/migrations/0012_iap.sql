-- 0012: iOS IAP (Lane B). Ledger dedupe reuses stripe_ref with an 'iap:' prefix
-- (transaction_id is the stripe_ref analogue); webhook_events doubles as the
-- per-transaction grant marker ('iaptx:<transactionId>') so appstore-webhook and
-- POST /iap/verify dedupe against each other.

-- Subscription rows sold through the App Store carry the original transaction id
-- so notifications without an appAccountToken can still find their user.
alter table public.subscriptions
  add column iap_original_transaction_id text unique;

-- Refund claw-back: one negative pack entry per refunded transaction.
create or replace function public.fn_iap_clawback(p_user uuid, p_credits int, p_ref text)
returns void language sql security definer set search_path = public as $$
  insert into public.ledger_entries (user_id, type, bucket, amount_credits, note, stripe_ref)
  values (p_user, 'refund', 'pack', -p_credits, 'IAP refund claw-back', p_ref)
  on conflict (stripe_ref) do nothing;
$$;

revoke execute on function public.fn_iap_clawback(uuid, int, text) from public, anon, authenticated;
grant execute on function public.fn_iap_clawback(uuid, int, text) to service_role;
