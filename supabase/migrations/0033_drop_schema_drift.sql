-- Production had two objects no migration created and no code read: an empty
-- public.admins table and an unset profiles.monthly_budget column, both added
-- by hand early on (migration inventory §2). Drop them so the live schema
-- matches the migrations. `if exists` because a database built from these
-- migrations alone never had them.
drop table if exists public.admins;
alter table public.profiles drop column if exists monthly_budget;
