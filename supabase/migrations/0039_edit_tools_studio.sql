-- Owner decision 2026-09-24: the four AI edit tools are open to every paying
-- tier. Both plans already pay per use in credits, so the plan gate only kept
-- Studio customers from spending them. Reverses 0034; `models.min_plan` stays
-- the one source of truth for the gateway's modelGate and /catalog's
-- `flat.editTools[].plan`.
update public.models set min_plan = 'studio'
where id in ('edit-remove', 'edit-fill', 'edit-expand', 'edit-bg');
