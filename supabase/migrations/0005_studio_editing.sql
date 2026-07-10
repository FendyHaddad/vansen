-- Phase 3b Studio editing panel (applied 2026-07-09 via MCP execute_sql)
-- Kill-switch rows for the four fixed-price AI edit tools. Local edits saved
-- through POST /edits/save reuse the generations table (family_id 'studio',
-- price 0) — no schema change needed.
insert into
  public.models (id, enabled)
values
  ('edit-remove', true),
  ('edit-fill', true),
  ('edit-expand', true),
  ('edit-bg', true) on conflict (id) do nothing;
