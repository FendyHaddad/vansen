#!/usr/bin/env node
/**
 * Rebuild the staging world, or grant credits to one staging account.
 *
 *   node scripts/stage-seed.mjs                       rebuild everything
 *   node scripts/stage-seed.mjs grant <email> <n>     n credits, as a pack
 *
 * Staging shares one set of containers with the SQL gates, and `npm run verify`
 * runs `supabase db reset`, which empties the database. That reset is the whole
 * value of the gate, so staging does not get to prevent it: staging data is
 * disposable and this script puts it back.
 *
 * Two rules it keeps rather than trusts:
 *   - The target must be local. This INSERTs and UPDATEs; pointed at the hosted
 *     project it would hand out free credits and rewrite the kill switches.
 *   - Credits are granted through fn_apply_fulfillment, never by inserting
 *     ledger rows. The seed exercises the same path a real purchase takes, and
 *     the function's own replay guard is what makes a second run harmless.
 */
import { spawnSync } from 'node:child_process';
import { familyPlan, loadStagingEnv } from './stage-env.mjs';

export const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const API_URL = 'http://127.0.0.1:54321';

/** The CLI's fixed local development key. Public by design, identical on every
 * machine, valid only against a stack on localhost. It is not a secret. */
export const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Credits match PLAN_CREDITS in _shared/plan-pricing.ts (barrelled through
 * model-families.ts). A drift here shows up as a balance that does not
 * match the plan the UI is displaying. */
export const STAGING_USERS = [
  { email: 'free@staging.vansen', password: 'staging-pass', plan: null, credits: 0 },
  { email: 'studio@staging.vansen', password: 'staging-pass', plan: 'studio', credits: 1500 },
  { email: 'pro@staging.vansen', password: 'staging-pass', plan: 'pro', credits: 3750 },
];

export function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function assertLocal(databaseUrl, command) {
  const address = new URL(databaseUrl);
  if (LOCAL_HOSTS.has(address.hostname)) return;
  throw new Error(`${command} requires a disposable local database`);
}

/** Null for an account that has never paid: a free user with credits would
 * hide every paywall staging exists to check. */
export function grantSql(user, userId) {
  if (!user.plan) return null;
  return `select public.fn_apply_fulfillment(
  'stripe',
  ${sqlLiteral(`seed:${user.email}`)},
  ${sqlLiteral(userId)}::uuid,
  'subscription_grant',
  ${sqlLiteral(user.plan)}, ${user.credits},
  now() + interval '30 days',
  now(),
  jsonb_build_object(
    'plan', ${sqlLiteral(user.plan)},
    'status', 'active',
    'current_period_end', (now() + interval '30 days')::text
  )
);`;
}

/** A top-up, written the way a Stripe top-up writes it. The caller supplies the
 * business transaction id, so the same id twice is absorbed as a replay. */
export function packGrantSql(userId, credits, txnId) {
  if (!(credits > 0)) throw new Error('credits must be a positive number');
  return `select public.fn_apply_fulfillment(
  'stripe', ${sqlLiteral(txnId)}, ${sqlLiteral(userId)}::uuid,
  'pack_grant', null::text, ${credits}, null::timestamptz, now()
);`;
}

/** Only the ids it is handed, so the five video families keep the disabled
 * state 0016_video.sql gave them. */
export function modelsSql({ enabled, disabled }) {
  const statements = [];
  const list = (ids) => ids.map(sqlLiteral).join(', ');
  if (enabled.length) {
    statements.push(`update public.models set enabled = true, updated_at = now()
  where id in (${list(enabled)});`);
  }
  if (disabled.length) {
    statements.push(`update public.models set enabled = false, updated_at = now()
  where id in (${list(disabled)});`);
  }
  return statements.join('\n');
}

/** A null birth_date sends the account through the 18+ gate on next login,
 * which is correct for a real signup and pure friction for a seeded one.
 * Re-test the gate with:
 *   update public.profiles set birth_date = null, age_confirmed_at = null;
 */
export function profileSql(userId) {
  return `update public.profiles
  set birth_date = date '1990-01-01', age_confirmed_at = now()
  where id = ${sqlLiteral(userId)}::uuid;`;
}

/**
 * The api reads and writes every table as service_role. The hosted project
 * was granted that when it was created; a database rebuilt from the
 * migrations alone has not been (found 2026-09-22: the local default ACL
 * leaves service_role with truncate/references/trigger only), so every route
 * answers "permission denied" dressed up as not_found. Idempotent, and
 * scoped to service_role so anon and authenticated stay deny-all.
 */
export function serviceRoleGrantsSql() {
  return `grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;`;
}

function adminHeaders() {
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };
}

async function listUsers(request) {
  const response = await request(`${API_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: adminHeaders(),
  });
  if (!response.ok) throw new Error('could not list users — is the local stack running?');
  const body = await response.json();
  return body.users ?? [];
}

async function createUser(request, user) {
  const response = await request(`${API_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password, email_confirm: true }),
  });
  if (!response.ok) throw new Error(`could not create ${user.email}`);
  return response.json();
}

function psql(run, databaseUrl, sql, failure) {
  const result = run('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], {
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw new Error('could not start psql — is it installed?');
  if (result.status !== 0) throw new Error(failure);
}

export async function seed({
  env = null,
  databaseUrl = LOCAL_DB,
  run = spawnSync,
  request = fetch,
  log = console.log,
} = {}) {
  assertLocal(databaseUrl, 'stage:seed');
  const values = env ?? loadStagingEnv();
  const plan = familyPlan(values);
  const execute = (sql) => psql(run, databaseUrl, sql, 'stage:seed failed while writing to the database');

  // First, so the api can read what the rest of this script writes.
  execute(serviceRoleGrantsSql());

  const existing = new Map((await listUsers(request)).map((u) => [u.email, u.id]));
  for (const user of STAGING_USERS) {
    const known = existing.get(user.email);
    const id = known ?? (await createUser(request, user)).id;
    execute(profileSql(id));
    const grant = grantSql(user, id);
    if (grant) execute(grant);
    log(`  ${user.email}  ${user.plan ?? 'free'}  ${user.credits} credits`);
  }

  execute(modelsSql(plan));

  log('');
  log(plan.enabled.length ? `enabled:  ${plan.enabled.join(', ')}` : 'enabled:  nothing');
  log(plan.disabled.length ? `disabled: ${plan.disabled.join(', ')} (no key)` : 'disabled: nothing');
  if (!plan.moderation) {
    log('');
    log('OPENAI_API_KEY is absent: the moderation gate runs before every charge,');
    log('so every generation will be refused with moderation_unavailable.');
  }
  if (plan.enabled.length) {
    log('');
    log('These families call real providers with your real keys. Generation costs real money.');
  }
  log('');
  log('Password for all three accounts: staging-pass');
}

export async function grantCredits({
  email,
  credits,
  databaseUrl = LOCAL_DB,
  run = spawnSync,
  request = fetch,
  log = console.log,
  now = () => Date.now(),
} = {}) {
  assertLocal(databaseUrl, 'stage:grant');
  const users = await listUsers(request);
  const user = users.find((u) => u.email === email);
  if (!user) throw new Error(`no account ${email} — run npm run stage:seed first`);

  psql(run, databaseUrl, packGrantSql(user.id, credits, `manual:${now()}`), 'stage:grant failed');
  log(`granted ${credits} credits to ${email}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, email, amount] = process.argv.slice(2);
  const task = command === 'grant'
    ? grantCredits({ email, credits: Number(amount) })
    : seed();
  task.catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
