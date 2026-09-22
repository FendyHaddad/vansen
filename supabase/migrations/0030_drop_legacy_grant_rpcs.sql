-- fn_cycle_reset and fn_grant_pack were the pre-P2 grant writers. P2 replaced
-- both with fn_apply_fulfillment (0018); no Edge Function, migration or test
-- has called them since, and the deployed api/stripe-webhook/appstore-webhook
-- versions (v59/v26/v16, 2026-09-22) are built from that source. Keeping them
-- executable by service_role left a second, un-deduplicated way to write the
-- ledger. Dropping them closes it.
drop function if exists public.fn_cycle_reset(uuid, int);
drop function if exists public.fn_grant_pack(uuid, int, text);
