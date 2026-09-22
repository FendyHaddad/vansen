-- The hosted project's service_role has table privileges from the platform
-- image, but a database built from these migrations alone (npm run
-- db:test:start, npm run stage) leaves service_role with no select/insert/
-- update/delete in schema public, so every gateway read answered not_found.
-- Granting here makes the schema self-sufficient; RLS stays deny-all for
-- anon and authenticated, and service_role bypasses RLS on the hosted
-- project already, so this changes nothing there. The staging seed keeps
-- the same grants for databases reset before this migration existed.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
