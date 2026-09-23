-- Owner decision 2026-09-23: the four AI edit tools are Pro, following the web
-- edit panel, which already locks them behind Pro. `models.min_plan` is the one
-- source of truth: the gateway's modelGate refuses a Studio caller with 403
-- pro_required before moderation and before any charge, and /catalog serves it
-- as `flat.editTools[].plan`.
update public.models set min_plan = 'pro'
where id in ('edit-remove', 'edit-fill', 'edit-expand', 'edit-bg');
