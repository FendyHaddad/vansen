-- 0008: age gate (18+). birth_date null = not yet gated; existing users are
-- gated on next login. No trigger change. Under-18 accounts are deleted by the
-- api, so no minor rows are retained.
alter table public.profiles
add column birth_date date;

alter table public.profiles
add column age_confirmed_at timestamptz;
