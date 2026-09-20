# Release Hardening P9 — Release Gates, Telemetry and Staged Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release readiness becomes repeatable evidence attached to a revision rather than a recollection: one command runs every check, the deployed state is inventoried and reconciled, every worker and function is deployed and scheduled, alerts fire on the failure modes the earlier plans made detectable, and each paid model family goes live one at a time behind a switch that can turn it off in seconds.

**Architecture:** A single CI workflow pins the toolchain and runs the web suite, the Deno suites, the SQL integration tests, the catalog drift guard and the asset check. A deployment manifest endpoint reports the exact revision, schema version, catalog version and enabled capabilities the running system has, so "is that fix live?" is answerable. Telemetry moves from console logs to durable rows with alerts on unfulfilled purchases, missing media, stale leases, deletion retries and provider budget burn. Rollout is per-family, gated on a smoke and a financial reconciliation for each one.

**Tech Stack:** GitHub Actions, Node 22.23.1 via nvm, Deno 2.9.5, Supabase CLI, Postgres, `pg_cron`.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T19**, closing **R27** and resolving decision **D7**. It depends on every earlier plan: P1 through P8 build the things this plan verifies, deploys and watches. **This is the only plan that changes production.**

**Evidence boundary:** Automated checks, authenticated browser/device qualification, staging rehearsals and production verification are separate records. Every applicable item in source-spec section 8 needs evidence; a passing build, mocked provider or manifest cannot close another category.

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps.
- **No nested if statements.** Guard clauses and early returns only.
- **Migration numbering:** P1 `0017` through P8 `0023`. This plan adds `0024`. Never renumber an applied migration.
- **Never rewrite applied history.** The duplicate `0008_*` prefixes exist on disk; their applied mapping is unverified. Reconcile from read-only history and actual schema. Never rename or rewrite any migration proven applied.
- **No secret in the repository, ever.** Stripe, provider and R2 keys live only in Supabase Edge Function secrets and GitHub Actions secrets. A migration never contains a key.
- **Production changes are the user's call.** Every deploy, secret, cron and flag flip in this plan stops and asks. Do not run them autonomously.
- **A kill switch must be reachable in seconds.** `models.enabled` is a single `update`; never gate a family behind a redeploy.
- **Redeploying `api` must bundle every `_shared/` file including `providers/`.** The same holds for `job-worker` and `cleanup-worker`.
- **Deployment tooling must be verified at execution.** Historical MCP failures do not prove the current tool is broken; use the approved CLI path below and verify its result.
- **Test commands:** Angular → `npm test -- --watch=false`. Deno → `cd supabase/functions && deno test --allow-all _shared api job-worker cleanup-worker stripe-webhook appstore-webhook`. SQL → `$VANSEN_LOCAL_DB` only.

## Review Focus

- SQL is skipped because the local database is missing: Task 1 must return nonzero, even when every other check passes.
- Repository filenames disagree with deployed history: Task 2 retains unknown state and blocks deploy until read-only evidence resolves the mapping.
- A green fake-model suite masks broken Safari/private-window behavior: Task 6 requires real fixtures, weights and device results from P7.
- A worker finishes a job but the client never receives a notification: Task 6 keeps D6 unresolved until backend and mobile MT-04 receipt evidence exists.
- A tested staging revision differs from deployed code/schema/catalog: Tasks 7–8 reconcile the exact artifact and rerun affected evidence before release.

---

## What is missing, in one paragraph

There is no `.github/` directory, so nothing runs on a push: the whole suite is whatever the last person remembered to type. There is no `supabase/config.toml`, so a local stack is hand-assembled and nobody else's matches. Two migrations share the `0008_` prefix (`0008_age_gate.sql` and `0008_credit_plans.sql`), the deployed migration history has never been compared against the repository, and seven more migrations are about to be added by P1 through P8. Nothing reports which revision is running, so after a deploy the only way to know whether a fix is live is to try it. `ApiService.handle` parses every successful response as JSON while `POST /errors` returns 204, and no `fetch` in the client carries an `AbortSignal.timeout`, so a hung request hangs forever and the 408 and 504 copy at `api-service.ts:35` and `:42` is dead code. And `vansen.md` and `CLAUDE.md` both describe video as "code-complete" but those notes do not establish current deployment state. Task 2 must inventory the migration ledger, functions, secrets by name/presence, R2 and enabled families before making a live/unapplied claim.

---

## File Structure

**New:**
- `.github/workflows/ci.yml` — the gate.
- `supabase/config.toml` — a reproducible local stack.
- `.nvmrc`, `supabase/functions/deno.lock` — pinned toolchains.
- `scripts/verify-all.mjs` — one command that runs every check, locally and in CI.
- `scripts/migration-inventory.mjs` — deployed history versus the repository.
- `supabase/migrations/0024_release_telemetry.sql` — `deployment_manifest`, `alerts`, alert queries, crons.
- `supabase/functions/api/routes/manifest.ts` — `GET /manifest`.
- `docs/superpowers/plans/2026-09-20-release-runbook.md` — the deploy, rollout and rollback procedure.
- `docs/superpowers/plans/2026-09-20-release-evidence.md` — the filled-in gate record.

**Modified:**
- `package.json` — `verify`, `test:deno`, `test:sql` scripts.
- `src/app/core/api/api-service.ts` — deadlines, 204, error ids.
- `vansen.md`, `CLAUDE.md`, and the punchlist — reality instead of aspiration.

---

## Task 1: Pin the toolchain and make one command run everything

**Files:**
- Create: `.nvmrc`, `supabase/config.toml`, `scripts/verify-all.mjs`
- Modify: `package.json`

- [ ] **Step 1: Pin Node and Deno**

```bash
cd /Users/user/IdeaProjects/vansen && echo "22.23.1" > .nvmrc && node --version && deno --version | head -1
```

Expected: `v22.23.1` after `nvm use`, and `deno 2.9.5`.

Add the engines field so a mismatch is loud rather than mysterious:

```json
  "engines": { "node": ">=22.23.1 <23" },
```

Generate and commit a Deno lockfile so CI resolves the same dependency versions this machine does:

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno cache --lock=deno.lock --lock-write api/index.ts job-worker/index.ts cleanup-worker/index.ts stripe-webhook/index.ts appstore-webhook/index.ts && ls -la deno.lock
```

- [ ] **Step 2: Write `supabase/config.toml`**

There is none today, so every local stack differs. Create it with the project's actual settings — ports, the `media` bucket, auth providers, and **no secrets**:

```toml
# Local development stack. Mirrors the deployed project's shape so an SQL test
# that passes here means something. Secrets never live in this file; they come
# from the environment.
project_id = "vansen"

[db]
port = 54322
major_version = 15

[storage]
enabled = true
file_size_limit = "50MiB"

[auth]
enabled = true
site_url = "http://localhost:4200"
additional_redirect_urls = ["http://localhost:4200/reset", "http://localhost:4200/app"]
jwt_expiry = 3600
enable_signup = true

[auth.email]
enable_confirmations = true
```

```bash
cd /Users/user/IdeaProjects/vansen && supabase start 2>&1 | tail -15
```

Expected: a running stack printing a DB URL and a service-role key. Export them as `VANSEN_LOCAL_DB`, `VANSEN_LOCAL_URL` and `VANSEN_LOCAL_SERVICE_KEY`, which P2 through P8's SQL tests already expect.

- [ ] **Step 3: Write `scripts/verify-all.mjs`**

```js
#!/usr/bin/env node
// Automated release checks, in the order that fails fastest first.
// Browser/device, commercial and operational evidence is recorded in Task 6.
//
// Before this, "did we run the tests?" was answered from memory. Each check
// below corresponds to a defect class an earlier plan closed; a green run is
// the evidence that they are all still closed.
import { spawnSync } from 'node:child_process';

const CHECKS = [
  { name: 'web unit tests',      cmd: 'npm', args: ['test', '--', '--watch=false'] },
  { name: 'web production build', cmd: 'npx', args: ['ng', 'build', '--configuration', 'production'] },
  { name: 'deno type check',     cmd: 'deno', args: ['check', 'api/index.ts', 'api/app.ts', 'job-worker/index.ts', 'cleanup-worker/index.ts', 'stripe-webhook/index.ts', 'appstore-webhook/index.ts'], cwd: 'supabase/functions' },
  { name: 'deno tests',          cmd: 'deno', args: ['test', '--allow-all', '_shared', 'api', 'job-worker', 'cleanup-worker', 'stripe-webhook', 'appstore-webhook'], cwd: 'supabase/functions' },
  { name: 'shared catalog drift', cmd: 'node', args: ['scripts/sync-shared.mjs', '--check'] },
  { name: 'trend assets',        cmd: 'node', args: ['scripts/check-assets.mjs'] },
  { name: 'migration inventory', cmd: 'node', args: ['scripts/migration-inventory.mjs'] },
  { name: 'sql integration',     cmd: 'node', args: ['scripts/run-sql-tests.mjs'], skipWithout: 'VANSEN_LOCAL_DB' },
];

const results = [];
for (const check of CHECKS) {
  if (check.skipWithout && !process.env[check.skipWithout]) {
    results.push({ name: check.name, status: 'SKIPPED', note: `${check.skipWithout} not set` });
    continue;
  }
  const started = Date.now();
  const out = spawnSync(check.cmd, check.args, { cwd: check.cwd, stdio: 'inherit', shell: false });
  results.push({
    name: check.name,
    status: out.status === 0 ? 'PASS' : 'FAIL',
    seconds: Math.round((Date.now() - started) / 1000),
  });
  // Keep going: one failure should not hide the other seven.
}

console.log('\n─── verify-all ───');
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.name} ${r.note ?? `${r.seconds}s`}`);

const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIPPED');
if (skipped.length) console.log(`\n${skipped.length} check(s) skipped — a skipped check is not a passed check.`);
process.exit(failed.length || skipped.length ? 1 : 0);
```

`scripts/run-sql-tests.mjs` runs every file in `supabase/tests/*.sql` against `$VANSEN_LOCAL_DB` with `ON_ERROR_STOP=1`, then every `*.sh` concurrency harness, and reports each by name.

- [ ] **Step 4: Add the scripts**

```json
  "verify": "node scripts/verify-all.mjs",
  "test:deno": "cd supabase/functions && deno test --allow-all _shared api job-worker cleanup-worker stripe-webhook appstore-webhook",
  "test:sql": "node scripts/run-sql-tests.mjs",
  "check:assets": "node scripts/check-assets.mjs",
  "check:migrations": "node scripts/migration-inventory.mjs"
```

- [ ] **Step 5: Run it**

```bash
cd /Users/user/IdeaProjects/vansen && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm run verify
```

Expected: every line `PASS`, no `SKIPPED`. Add a retained Node test in `scripts/verify-all.test.mjs` using injected command results: all PASS exits 0; a failed child, missing SQL environment, spawn error, or signal-terminated child exits nonzero. Observe RED for missing SQL against the previous exit expression, then GREEN after the change. A skipped SQL check blocks the automated gate; Task 6 evidence is still required after all automated checks pass. User commits.

---

## Task 2: Reconcile the deployed migration history

**Files:**
- Create: `scripts/migration-inventory.mjs`, `docs/superpowers/specs/2026-09-20-migration-inventory.md`

**The hazard.** Two files share the `0008_` prefix, seven new migrations arrive from P1 through P8, and nobody has compared the deployed history to the repository. Applying `0017` to a database that already has something called `0017` — or renaming a file Postgres has already recorded — corrupts the ledger of what ran. The fix is to **record reality**, never to rewrite it.

- [ ] **Step 1: Read the deployed history**

This is a read-only prerequisite, not a production change. Reuse or refresh P1 Task 6's dated inventory before finalizing migration filenames. Also inventory current function revisions, worker/cron state, enabled model families, R2 bucket/CORS and required secrets by name/presence only. Historical September 6 rollout notes are hypotheses until verified.

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_PROD_DB_READONLY" -c "select version, name, statements is not null as has_body from supabase_migrations.schema_migrations order by version;"
```

If no read-only production connection string exists, ask the user for one, or have them run the query and paste the output. **Do not connect to project `bnorhcxhvxydkgvcxjad` with a write credential for this.**

- [ ] **Step 2: Write the inventory script**

```js
#!/usr/bin/env node
// Checks repository migration filename collisions only.
// Deployed reconciliation is the separate read-only inventory below.
//
// Two files already share the 0008_ prefix and seven more migrations are
// arriving. Renaming an applied migration would break the very ledger that
// says what ran; this script records the mismatch instead and fails CI on a
// NEW one.
import { readdirSync } from 'node:fs';

const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();

const byPrefix = new Map();
for (const file of files) {
  const prefix = file.slice(0, 4);
  byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
}

// Known repository collision only; this does not prove either file ran.
// The read-only inventory records the mapping to actual deployed history.
const ACCEPTED_DUPLICATES = new Set(['0008']);

const duplicates = [...byPrefix.entries()].filter(([, list]) => list.length > 1);
const unexpected = duplicates.filter(([prefix]) => !ACCEPTED_DUPLICATES.has(prefix));

for (const [prefix, list] of duplicates) {
  const tag = ACCEPTED_DUPLICATES.has(prefix) ? 'known' : 'NEW';
  console.log(`${tag} duplicate prefix ${prefix}: ${list.join(', ')}`);
}

console.log(`${files.length} migration files, ${duplicates.length} duplicate prefix group(s)`);
process.exit(unexpected.length ? 1 : 0);
```

- [ ] **Step 3: Record the inventory**

Create `docs/superpowers/specs/2026-09-20-migration-inventory.md` with a row per migration: repository filename/hash, recorded deployed version/name, applied state (`confirmed applied`, `confirmed absent`, or `unknown`), observation time, schema/body evidence and proposed action. A `has_body` flag alone cannot map two same-prefix files: compare the stored statements and resulting schema without dumping secrets. Do not claim either `0008_*` file ran until that mapping is evidenced. Treat `0016` the same way. Check proposed `0017`–`0024` versions for collisions before creating/applying them; update all cross-plan references if unallocated versions must change. Preserve proven applied history.

The script above only detects repository collisions; its green result is not deployed-history reconciliation. Attach the read-only query and schema comparison to the inventory. Missing access remains `unknown` and blocks deployment, rather than being filled with expected answers. Reuse the P1 inventory and perform this read-only step early, before any new migration or local baseline is finalized.

- [ ] **Step 4: Test both bootstrap paths**

An empty database must reach the same schema as an upgraded one, or a fresh environment diverges silently.

```bash
cd /Users/user/IdeaProjects/vansen && supabase db reset 2>&1 | tail -5 && psql "$VANSEN_LOCAL_DB" -t -A -c "select count(*) from information_schema.tables where table_schema='public';"
```

Then restore a **production-shaped snapshot containing synthetic data only** — never real customer data — apply `0017` through `0024`, and diff the two schemas:

```bash
cd /Users/user/IdeaProjects/vansen && supabase db diff --schema public > /private/tmp/claude-502/-Users-user-IdeaProjects-vansen/ae60d9aa-cb0e-417e-8ae9-e8ce2870119f/scratchpad/schema-diff.txt && wc -l /private/tmp/claude-502/-Users-user-IdeaProjects-vansen/ae60d9aa-cb0e-417e-8ae9-e8ce2870119f/scratchpad/schema-diff.txt
```

Expected: an empty diff. Any difference is a migration that is not idempotent across the two paths; fix it before going further.

- [ ] **Step 5: Run the check**

```bash
cd /Users/user/IdeaProjects/vansen && npm run check:migrations
```

Expected: `known duplicate prefix 0008`, exit 0 for the repository filename check. Separately require the deployed mapping and clean/upgrade schema evidence above; the script's exit code does not prove either. User commits.

---

## Task 3: The deployment manifest

**Files:**
- Create: `supabase/functions/api/routes/manifest.ts` + `_test.ts`
- Modify: `supabase/migrations/0024_release_telemetry.sql`, `supabase/functions/api/app.ts`

**Interfaces:**
- Produces: `GET /manifest` → `{ gitRevision, schemaVersion, catalogVersion, quoteVersion, workerVersion, capabilities, deployedAt }`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/api/manifest_test.ts`:

```ts
import { assert, assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

Deno.test('the manifest reports what is actually running', async () => {
  const deps = testDeps({ gitRevision: 'abc1234' });
  const db = deps.admin as unknown as FakeDb;
  db.tables.models = [
    { id: 'flux', enabled: true, min_plan: 'studio' },
    { id: 'kling', enabled: false, min_plan: 'pro' },
  ];
  const app = createApp(deps);

  const body = await (await app.request('/api/manifest')).json();

  assertEquals(body.gitRevision, 'abc1234');
  assert(typeof body.catalogVersion === 'string' && body.catalogVersion.length > 0);
  assert(typeof body.schemaVersion === 'string');
  assertEquals(body.capabilities.flux, true);
  assertEquals(body.capabilities.kling, false, 'a disabled family must report disabled');
});

Deno.test('the manifest is public — it is how you check a deploy landed', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const res = await app.request('/api/manifest');
  assertEquals(res.status, 200);
});

Deno.test('the manifest leaks no secret', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const text = await (await app.request('/api/manifest')).text();
  for (const needle of ['sk_', 'service_role', 'SUPABASE_SERVICE', 'whsec_', 'key']) {
    assert(!text.toLowerCase().includes(needle.toLowerCase()), `manifest leaked "${needle}": ${text}`);
  }
});
```

- [ ] **Step 2: Run to verify it fails, then implement it**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/manifest_test.ts
```

Expected: FAIL — the route does not exist.

```ts
/**
 * What is actually running here.
 *
 * After a deploy the only way to tell whether a fix was live was to try it and
 * infer. This answers directly, and the rollout gates in the runbook check it
 * before and after every step.
 */
app.get('/manifest', async (c) => {
  const { data: models } = await admin.from('models').select('id,enabled');
  const capabilities = Object.fromEntries((models ?? []).map((m) => [m.id, m.enabled === true]));
  const { data: schema } = await admin.rpc('fn_schema_version');
  return c.json({
    gitRevision: Deno.env.get('GIT_REVISION') ?? 'unknown',
    schemaVersion: schema ?? 'unknown',
    catalogVersion: CATALOG_VERSION,
    quoteVersion: QUOTE_VERSION,
    workerVersion: Deno.env.get('WORKER_VERSION') ?? 'unknown',
    capabilities,
    deployedAt: Deno.env.get('DEPLOYED_AT') ?? null,
  });
});
```

`fn_schema_version` returns the highest applied migration version, added in Task 4's migration. `GIT_REVISION` and `DEPLOYED_AT` are set as function secrets at deploy time by the runbook.

- [ ] **Step 3: Run**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/manifest_test.ts
```

Expected: `3 passed | 0 failed`. User commits.

---

## Task 4: Telemetry and alerts

**Files:**
- Create: `supabase/migrations/0024_release_telemetry.sql`
- Modify: `src/app/core/api/api-service.ts` + `.spec.ts`

**The alerts correspond one-for-one to what the earlier plans made detectable.** Each is a query over a table an earlier plan created; none of them could have been written before.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0024_release_telemetry.sql`:

```sql
-- 0024: alerts for the failure modes P1-P8 made visible.
--
-- Each query below is a defect class that used to be silent. Money taken and
-- not fulfilled (P2). A generation marked done with no retrievable media (P4).
-- A job whose worker died holding it (P5). An object queued for deletion that
-- keeps failing (P6). Provider spend running away (P5).
-- (written 2026-09-20; apply AFTER 0023_request_snapshots.sql)

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  severity text not null check (severity in ('info', 'warn', 'critical')),
  detail jsonb not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (kind, first_seen_at)
);
alter table public.alerts enable row level security;

create or replace function public.fn_schema_version()
returns text language sql security definer set search_path = public as $$
  select coalesce(max(version), 'unknown')
    from supabase_migrations.schema_migrations;
$$;

/** Raise or refresh one alert. Repeats update last_seen_at rather than piling
 * up rows, so a persistent problem reads as one ongoing incident. */
create or replace function public.fn_raise_alert(
  p_kind text, p_severity text, p_detail jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare v_open uuid;
begin
  select id into v_open from public.alerts
    where kind = p_kind and resolved_at is null
    order by first_seen_at desc limit 1;
  if v_open is not null then
    update public.alerts set last_seen_at = now(), detail = p_detail where id = v_open;
    return;
  end if;
  insert into public.alerts (kind, severity, detail) values (p_kind, p_severity, p_detail);
end $$;

/** Auto-resolve: an alert whose condition has not recurred for an hour closes
 * itself, so the list shows what is wrong NOW. */
create or replace function public.fn_resolve_stale_alerts()
returns void language sql security definer set search_path = public as $$
  update public.alerts set resolved_at = now()
   where resolved_at is null and last_seen_at < now() - interval '1 hour';
$$;

create or replace function public.fn_check_alerts()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int; v_found jsonb := '[]'::jsonb;
begin
  -- 1. Money taken, entitlement not granted. The single worst outcome in the
  --    product: the customer paid and got nothing.
  select count(*) into v_n from public.fn_paid_unfulfilled();
  if v_n > 0 then
    perform public.fn_raise_alert('paid_unfulfilled', 'critical', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('paid_unfulfilled'::text);
  end if;

  -- 2. Marked done with nothing to show. The customer was charged and the
  --    library shows a broken tile.
  select count(*) into v_n from public.generations
   where status = 'done' and coalesce(media_path, '') = ''
     and created_at > now() - interval '7 days';
  if v_n > 0 then
    perform public.fn_raise_alert('done_without_media', 'critical', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('done_without_media'::text);
  end if;

  -- 3. A job nobody is working on. Its lease expired repeatedly, which means
  --    the worker keeps dying on it.
  select count(*) into v_n from public.jobs
   where attempts >= 5 and error is null
     and state in ('ready', 'submitted', 'leased');
  if v_n > 0 then
    perform public.fn_raise_alert('jobs_stuck', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('jobs_stuck'::text);
  end if;

  -- 4. Bytes we promised to delete and have not. This is a legal exposure,
  --    not a performance problem.
  select count(*) into v_n from public.deletion_outbox
   where attempts >= 5 or created_at < now() - interval '24 hours';
  if v_n > 0 then
    perform public.fn_raise_alert('deletion_stuck', 'critical', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('deletion_stuck'::text);
  end if;

  -- 5. Provider spend. Video is expensive enough that a loop costs real money
  --    within an hour.
  select coalesce(sum(cost_usd), 0) into v_n from public.provider_expenses
   where charged_at > now() - interval '1 hour';
  if v_n > 50 then
    perform public.fn_raise_alert('provider_burn', 'warn', jsonb_build_object('usd_last_hour', v_n));
    v_found := v_found || to_jsonb('provider_burn'::text);
  end if;

  -- 6. A moderation strike surge, which usually means the gate broke open.
  select count(*) into v_n from public.moderation_events
   where created_at > now() - interval '1 hour';
  if v_n > 100 then
    perform public.fn_raise_alert('moderation_surge', 'warn', jsonb_build_object('count', v_n));
    v_found := v_found || to_jsonb('moderation_surge'::text);
  end if;

  perform public.fn_resolve_stale_alerts();
  return v_found;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'check_alerts';
select cron.schedule('check_alerts', '*/5 * * * *', $$ select public.fn_check_alerts(); $$);

revoke execute on function public.fn_schema_version() from public, anon, authenticated;
revoke execute on function public.fn_raise_alert(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fn_check_alerts() from public, anon, authenticated;
revoke execute on function public.fn_resolve_stale_alerts() from public, anon, authenticated;
grant execute on function public.fn_schema_version() to service_role;
grant execute on function public.fn_raise_alert(text, text, jsonb) to service_role;
grant execute on function public.fn_check_alerts() to service_role;
grant execute on function public.fn_resolve_stale_alerts() to service_role;
```

Write `supabase/tests/alerts.sql` proving each condition raises its alert, a repeat refreshes rather than duplicates, and a condition that stops recurring resolves after an hour.

- [ ] **Step 2: Write the failing client deadline spec**

Append to `src/app/core/api/api-service.spec.ts`:

```ts
describe('R27: request deadlines and empty responses', () => {
  it('a 204 resolves rather than failing to parse', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as never;
    await expect(makeApi('tok').post('/errors', { message: 'x' })).resolves.toBeUndefined();
  });

  it('every request carries a deadline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as never;
    await makeApi('tok').get('/generations');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('a timeout surfaces as the 408 copy that already exists', async () => {
    // api-service.ts:35 and :42 have carried timeout copy since launch with
    // nothing able to reach it.
    globalThis.fetch = vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted', 'TimeoutError'),
    ) as never;
    await expect(makeApi('tok').get('/generations')).rejects.toThrow(/taking too long|timed out/i);
  });

  it('an upload gets a longer deadline than a read', async () => {
    // A 40 MB reference upload on a phone connection is not a hung request.
    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });

  it('a server error id is preserved for support', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'x', message: 'y', errorId: 'err_123' } }), { status: 500 }),
    ) as never;
    await expect(makeApi('tok').get('/generations')).rejects.toMatchObject({ errorId: 'err_123' });
  });
});
```

- [ ] **Step 3: Run to verify it fails, then fix `ApiService`**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/core/api/api-service.spec.ts
```

Expected: FAIL — the 204 test throws a JSON parse error and no signal is attached.

```ts
/** A read that has not answered in 30 seconds is not going to. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** An upload of a large reference on a slow connection legitimately takes
 * longer; failing it at 30 seconds would break a working flow. */
export const UPLOAD_TIMEOUT_MS = 120_000;
```

```ts
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
```

```ts
    // 204 is a successful empty response. Parsing it as JSON threw, and the
    // only current caller swallowed the rejection — so a working error report
    // looked like a failure to anyone reading the console.
    if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
```

Give the gateway an `errorId` on every 5xx (`crypto.randomUUID().slice(0, 8)`), log it beside the real error, and return it to the client. A customer can then quote eight characters instead of describing a symptom.

- [ ] **Step 4: Run both suites**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0024_release_telemetry.sql && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/alerts.sql
```

Expected: all green. User commits.

---

## Task 5: The CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# Every release gate, on every push. Before this, the suite ran when someone
# remembered to run it.
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm test -- --watch=false
      - run: npx ng build --configuration production
      - run: node scripts/check-assets.mjs
      - run: node scripts/sync-shared.mjs --check   # catalog drift, both directions
      - run: node scripts/migration-inventory.mjs

  edge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v1
        with:
          deno-version: "2.9.5"
      - name: Type check every function
        working-directory: supabase/functions
        run: deno check api/index.ts api/app.ts job-worker/index.ts cleanup-worker/index.ts stripe-webhook/index.ts appstore-webhook/index.ts
      - name: Test every function
        working-directory: supabase/functions
        run: deno test --allow-all --lock=deno.lock _shared api job-worker cleanup-worker stripe-webhook appstore-webhook

  database:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: supabase/postgres:15.8.1.040
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - name: Apply every migration in order
        env:
          VANSEN_LOCAL_DB: postgres://postgres:postgres@localhost:5432/postgres
        run: |
          for f in supabase/migrations/*.sql; do
            echo "── $f"
            psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f "$f"
          done
      - name: SQL integration tests
        env:
          VANSEN_LOCAL_DB: postgres://postgres:postgres@localhost:5432/postgres
        run: node scripts/run-sql-tests.mjs
      - name: Concurrency harnesses
        env:
          VANSEN_LOCAL_DB: postgres://postgres:postgres@localhost:5432/postgres
        run: |
          # Run each three times: a race that passes once has proven nothing.
          for i in 1 2 3; do
            ./supabase/tests/billing_concurrency.sh
            ./supabase/tests/caps_concurrency.sh
            ./supabase/tests/settlement_concurrency.sh
          done
```

**Database prerequisites are part of the gate.** Use the local Supabase baseline verified in Task 2, with its auth/storage schemas, roles, `pg_cron` and `pg_net`; a bare Postgres container is not equivalent. Before adopting the database-job example above, prove the chosen image/bootstrap provides that baseline and record its pinned setup. Fail setup if required schemas/extensions are absent. Do not edit historical migrations or skip schedules to make CI green. Any new scheduling prerequisite belongs in an unapplied additive migration; exercise the schedules on staging and verify expected production cron names and recent successful runs after deployment.

- [ ] **Step 2: Verify the workflow runs green**

Push is the user's action, not yours. Ask them to push and report, or run the equivalent locally:

```bash
cd /Users/user/IdeaProjects/vansen && npm run verify
```

Expected: every check `PASS`. Fix anything CI catches that the local run did not, then re-run. User commits.

---

## Task 6: Qualify the complete release scope (source-spec Gates A–D)

**Files:** Create `docs/superpowers/plans/2026-09-20-release-evidence.md` and `docs/superpowers/plans/2026-09-20-release-runbook.md`; consume `docs/verification/editor-tool-results.md`, P2 billing, P4 settlement, P5 offline-completion and P6 deletion rehearsal logs, plus the mobile companion's evidence.

**Inputs:** Exact web/backend revision, schema/catalog/worker versions, staging environment, synthetic user fixtures for free/Studio/Pro/owner/suspended/lapsed states, and an explicit account/provider spending scope for paid smokes. Browser authentication, device access and spending authorization are obtained at execution, not assumed by this document.

- [ ] **Step 1: Make a traceable gate record before qualification**

Use these columns for **each checkbox** in source-spec section 8: gate/item, revision/artifact, environment/platform/provider, procedure, expected result, observed result, evidence link, date, status (`PASS`, `FAIL`, `BLOCKED`, or `DEFERRED`), and approved scope limitation. Also link R01–R28 closure evidence and D1–D7 outcomes. No empty cell or unchecked item means PASS. DEFERRED requires the affected capability to be unavailable and its claims removed; shared money/ownership/job blockers cannot be deferred while paid generation remains exposed.

- [ ] **Step 2: Close Gate A against an isolated staging deployment**

After Task 2 proves clean-bootstrap/upgrade equivalence, deploy the candidate to isolated staging using Task 7's mechanics and test secrets. Run route and real-transaction regressions for R01/R02/R04–R11/R28; verify direct authenticated table reads and service-only RPC denial. Rehearse offline completion, duplicate submission/event delivery, unavailable moderation, foreign references, cancel-versus-success, retryable provider errors, deletion retries and lapse retention. Reconcile all charges/refunds and recorded provider expenses. Record the actual staging revision/schema/functions/workers and expected cron runs.

Staging mechanics do not authorize a production deployment. Gate A's production-manifest item stays pending until Task 7 verifies it. No general availability follows merely from staging PASS.

- [ ] **Step 3: Close Gate B with authenticated browser and device evidence**

| Check | Required proof |
|---|---|
| Fresh checkout/dependencies | Lockfile install, pinned toolchain, all automated checks and build on the candidate revision |
| User roles | Free, Studio, Pro, owner, suspended and lapsed accounts show/enforce the correct server entitlements |
| Local tools | P7 Tasks 5–6 results for every exposed tool on Chrome, Safari and a representative lower-memory device, including private-window/offline/fallback/export behavior |
| Main workflows | Actual generation, edit, import, export and delete; failure, cancellation, refund and retry; upload-as-reference for every enabled image family |
| Authentication/isolation | Signup, verification, login, recovery, expiry and A→B account changes; logout through workspace, settings, onboarding and account deletion with delayed responses active |
| Commercial truth | Studio/Pro tools, full D1 promotional grants, cost units and post-checkout return state agree with server truth |
| Accessibility/assets/language | Desktop/mobile widths, keyboard and screen-reader library/detail/editor flows; no missing assets; persisted language choice if en/ms is retained, otherwise approved English-only scope |
| Persona and paid edit tools | Authorized real smoke for each exposed training/edit capability; truthful retry, media and financial outcomes |

Builds and fake tensor outputs cannot replace these rows. For a later change, identify affected rows and rerun them against the final release artifact. Record any unavailable login/browser/device as BLOCKED.

- [ ] **Step 4: Track Gate C and preserve decision D6**

Link the mobile repository's MT-01…MT-09 and Gate C evidence; do not mark mobile ready from backend tests. A web-only rollout explicitly excludes mobile readiness. D6 means **completion notifications**, not worker leases: P4's outbox, P5's offline lifecycle and mobile MT-04's actual client receipt must pass before notification claims return on either platform. Include background/closed-client delivery, permission denied, duplicate delivery and retry after a send failure. If those prerequisites are unavailable, leave “We'll notify you” hidden; independently verified background completion may say “You can leave this page and return to check the result.”

- [ ] **Step 5: Rehearse Gate D before any public enablement**

| Check | Required evidence |
|---|---|
| Provider contract | Current official documentation plus a budgeted smoke for every enabled version/mode, including account access; reconcile provider bill, reserved cost and customer quote |
| Billing configuration | Verify Stripe live products/prices/coupons/webhooks and applicable Apple/Play production setup; test-mode success is recorded separately |
| Deployment inventory | Dashboard/history checks for migrations (including `0016`), functions, cron execution, R2 bucket/CORS/limits, auth redirects and required secret names/presence; never record secret values |
| Policy/retention | Owner review of Terms/Privacy/AUP and D2 retention; record review status and any blocking decision, without asserting legal compliance from tests |
| Alerts/support | Inject unfulfilled purchase, missing media, stale lease, deletion retry and budget failures; confirm alert delivery to its configured destination and traceable request/purchase/job IDs |
| Restore/recovery | Rehearse backup restore using synthetic staging data, and disable-new-submissions/continue-settling rollback; record both successful recovery and any forward-only migration limitation |
| Cohort rollout | Record enabled families/platforms, cohort, observed fulfillment/cost/error metrics and the decision to expand or disable |

Production-only checks are performed under Task 7's approval steps and remain pending until then. Missing credentials or unapproved spend cannot become an inferred pass.

- [ ] **Step 6: Enforce the qualification decision**

Before Task 7 enables any family, require all applicable staging/browser/device gates for that family plus shared backend gates to pass. Keep production flags disabled while production-only verification is pending; use only the explicitly approved test account/cohort for production smoke. Broader rollout requires all applicable production checks to pass. A failure blocks or disables the affected capability and preserves evidence for correction. Record the final decision and remaining platform exclusions; user commits.

---

## Task 7: Deploy, and stage the rollout

**Files:**
- Create: `docs/superpowers/plans/2026-09-20-release-runbook.md`

**Every step here changes production and is the user's decision.** Present each, wait for a yes, then run it. Never batch them.

- [ ] **Step 1: Write the runbook**

Create `docs/superpowers/plans/2026-09-20-release-runbook.md` with the ordered procedure below, each step carrying its command, its verification and its rollback.

**Order matters, and this is why:** migrations before functions, because a function calling a missing RPC fails every request; functions before crons, because a cron driving a missing function logs errors every minute; crons before flags, because a family enabled with no worker behind it takes money and produces nothing.

- [ ] **Step 2: Apply the migrations**

```bash
cd /Users/user/IdeaProjects/vansen && for f in supabase/migrations/001[789]_*.sql supabase/migrations/002[01234]_*.sql; do echo "── $f"; done
```

Expected: exactly eight files, `0017` through `0024`, in order. Apply them **one at a time**, verifying after each. After all eight:

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_PROD_DB" -t -A -c "select max(version) from supabase_migrations.schema_migrations;"
```

Expected: `0024`.

**Rollback:** these migrations are additive — new tables, new columns, new functions. The one destructive change is `ledger_entries.user_id` becoming nullable with `on delete set null` (P6). Rolling that back after an account deletion has run would orphan rows with no owner, so it is a forward-only change. Say so in the runbook.

- [ ] **Step 3: Set the secrets**

Ask the user to set each, one at a time, in the Supabase dashboard or via the CLI. **Never print a secret value; never write one to a file in the repository.**

| Secret | Needed by | Plan |
|---|---|---|
| `GIT_REVISION`, `DEPLOYED_AT`, `WORKER_VERSION` | the manifest | P9 |
| `RUNWAY_API_KEY` | Runway video | P3 |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | video storage | P4 |

Then the database settings the crons read:

```sql
alter database postgres set app.job_worker_url = 'https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/job-worker';
alter database postgres set app.cleanup_worker_url = 'https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/cleanup-worker';
alter database postgres set app.service_role_key = '<set by the user, never printed>';
```

- [ ] **Step 4: Create the R2 bucket and its CORS policy**

The bucket does not exist yet. The user creates it and applies a CORS policy allowing `GET` and `HEAD` from the production origin only — not `*`, which would let any site stream our video egress.

Verify with a signed URL fetched from the production origin and from an unrelated one; the second must be refused.

- [ ] **Step 5: Deploy the functions**

The MCP deploy tool is broken for `api`; use the CLI.

```bash
cd /Users/user/IdeaProjects/vansen && supabase functions deploy api --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad
```

```bash
cd /Users/user/IdeaProjects/vansen && supabase functions deploy job-worker --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad && supabase functions deploy cleanup-worker --no-verify-jwt --project-ref bnorhcxhvxydkgvcxjad
```

Also redeploy `stripe-webhook` and `appstore-webhook`, which P2 rewrote.

**Verify every deploy bundled `_shared/providers/`:**

```bash
curl -s https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/manifest | head -40
```

Expected: the `gitRevision` you just deployed and `schemaVersion` `0024`. If the revision is stale, the deploy did not land; do not proceed.

- [ ] **Step 6: Verify the crons**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_PROD_DB" -c "select jobname, schedule, active from cron.job order by jobname;"
```

Expected, all active: `check_alerts`, `drive_cleanup_worker`, `drive_job_worker`, `fail_stale_persona_trainings`, `purge_lapsed_libraries`, `release_expired_leases`, and the stale-job sweeps. A missing name means a migration's guarded `do` block skipped its schedule; add it manually and record that.

- [ ] **Step 7: Run the backfills**

```bash
cd /Users/user/IdeaProjects/vansen && node scripts/backfill-thumbnails.mjs --limit 100 --dry-run
```

Review the output, then run for real in batches. Then the read-only reconciliations:

```bash
cd /Users/user/IdeaProjects/vansen && node scripts/storage-inventory.mjs && node scripts/billing-reconcile.mjs
```

Expected: zero orphans, zero leaks, zero unfulfilled purchases. **Any non-zero result stops the rollout.** These scripts report; they never delete.

- [ ] **Step 8: Stage the family rollout**

Task 6's applicable shared, browser/device and staging checks must pass before enabling a family for its approved production smoke. Keep the release limited to that account/cohort until its production checks and reconciliation pass. A disabled tool or platform is explicitly excluded from readiness and sales claims.

Every paid family starts disabled:

```sql
update public.models set enabled = false where id not in ('flux');
```

Then, **one family at a time**, in this order — cheapest and most-exercised first, so a mistake is cheap:

1. `flux` (image, fal) — already live
2. `google` / Nano Banana (image, inline)
3. `openai` / GPT Image (image, inline) — P3 rewrote this adapter, so watch it
4. `upscaler`, then the four `edit-*` tools
5. `persona`
6. `kling`, `seedance` (video, fal)
7. `veo`, `omni` (video, Google — no cancel support)
8. `runway` (video, direct)

For each family, before enabling:

- [ ] Its row in the capability record (P3 Task 1) is filled in from a real smoke, not from documentation.
- [ ] `deno test` passes for its adapter.

After enabling:

- [ ] Run one paid generation end to end. Confirm the charge, the media, the credit balance and the ledger row.
- [ ] Run one deliberate failure. Confirm exactly one refund and a truthful failure message.
- [ ] For video: run one cancel. Confirm the outcome matches the family's actual capability — Veo and Omni cannot cancel, and must say so rather than pretending.
- [ ] `node scripts/billing-reconcile.mjs` reports zero discrepancies.
- [ ] `select * from public.alerts where resolved_at is null;` is empty.

Record each family's result in the evidence document. **Do not enable the next family until the current one has all six ticks.**

- [ ] **Step 9: Rehearse the rollback**

A rollback nobody has tried is a hope. On the local stack, rehearse and record:

| Step | Expected |
|---|---|
| Disable one family mid-flight | New submissions refused; queued jobs still settle and refund correctly |
| Disable all submissions (`models.enabled = false` everywhere) | Existing work drains to completion; no new charges |
| Redeploy the previous `api` revision | Queued jobs still settle; no column referenced by a queued job is dropped |
| Re-enable | No duplicate charge, no duplicate grant, no double refund |

The rule to write down: **disable new submissions first, let existing work settle, and never drop a column while a queued job depends on it.**

- [ ] **Step 10: Confirm D7 from the dashboard**

`vansen.md` and `CLAUDE.md` both claim video is code-complete. Confirm from the running system, not from the documents:

```bash
curl -s https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/manifest | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log(Object.entries(m.capabilities).map(([k,v])=>`${v?'ON ':'off'} ${k}`).join('\n'))})"
```

Record the exact output as one part of D7, alongside the deployed revision, migration ledger/schema mapping, worker/cron execution, required secret presence, R2 configuration and each enabled family's smoke evidence from Tasks 2/6/7. A capability boolean does not establish that a migration, storage backend or provider works. Record any unknown fact as unknown and keep the affected capability unavailable. User commits.

---

## Task 8: Make the documents tell the truth

**Files:**
- Modify: `vansen.md`, `CLAUDE.md`, the punchlist, `README.md`
- Create: `docs/superpowers/plans/2026-09-20-release-evidence.md`

- [ ] **Step 1: Write the evidence record**

Create `docs/superpowers/plans/2026-09-20-release-evidence.md`: the tested revision SHA, the date, the `npm run verify` output, the CI run link, every SQL and concurrency result, Task 6's complete Gate A–D evidence matrix, the reconciliation outputs, each family's rollout record, and the rollback/restore rehearsal table. This document is what "release ready" means from now on.

- [ ] **Step 2: Replace the aspirational claims**

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "code-complete\|code complete\|Rollout pending\|not yet live" vansen.md CLAUDE.md docs/superpowers/plans/*punchlist* 2>/dev/null | head -20
```

Each hit becomes a statement about what is actually true at the tested revision, with a link into the evidence document. `CLAUDE.md`'s video paragraph — "Rollout pending as of 2026-09-06: migration `0016_video.sql` not yet applied, secrets not set, R2 bucket + CORS not created, `api` not redeployed" — is replaced by what Task 7 actually achieved, family by family.

- [ ] **Step 3: Record decisions D1 through D7**

Add a decisions table to `vansen.md` with each decision, the answer, the date and where it is enforced:

| Decision | Answer | Enforced by |
|---|---|---|
| D1 launch grant | Full plan credits on launch-coupon invoices | P2 Task 4; `stripe-webhook` tests |
| D2 retention | (from P6 Task 1) | `0021`; `supabase/tests/deletion.sql` |
| D3 background-completion promise | Enabled only after deployed offline-completion proof | P5 Task 5; `job-worker`; P9 Task 6 |
| D4 locales | (from P8 Task 4 Step 7) | `vansen.md`; store listings |
| D5 library video references | Uploads only for the first release | P8 Task 3; composer copy |
| D6 completion notifications | Evidence-gated on both platforms; unresolved until backend delivery and client receipt pass | P4 Task 6 + P5 Task 5 + mobile MT-04; P9 Task 6 |
| D7 video live state | (from Task 2 inventory and Task 7 Step 10) | Dashboard/history, manifest, cron/storage and per-family smoke evidence |

- [ ] **Step 4: Document the release process in the README**

A short section: how to run the local stack, how to run `npm run verify`, where the runbook is, and how to disable a family in an emergency — the single `update public.models set enabled = false where id = '<family>';` that anyone on call needs at three in the morning.

- [ ] **Step 5: Final verification**

```bash
cd /Users/user/IdeaProjects/vansen && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npm run verify
```

Expected: every check `PASS`, none skipped. User commits.

---

## Exit criteria for P9

- [ ] `npm run verify` runs every automated check and passes with nothing skipped; Task 6 separately closes each applicable manual/runtime release gate.
- [ ] CI runs the web suite, the production build, all Deno suites, every migration, every SQL test and each concurrency harness three times, on every push.
- [ ] The deployed migration history is inventoried, the duplicate `0008_` prefix is recorded as known and untouched, and an empty-database bootstrap produces the same schema as an upgrade.
- [ ] `GET /manifest` reports the running revision, schema version, catalog version and per-family capabilities, and leaks no secret.
- [ ] Alerts exist and fire for unfulfilled purchases, media-less completions, stuck jobs, stuck deletions, provider burn and moderation surges.
- [ ] Every client request carries a deadline, a 204 resolves, and a 5xx returns a quotable error id.
- [ ] All eight migrations are applied, all five functions deployed, all secrets set, the R2 bucket created with an origin-scoped CORS policy, and every expected cron job active by name.
- [ ] Each paid family was enabled one at a time, each with a smoke, a deliberate failure, a cancel where applicable, and a clean reconciliation recorded in the evidence document.
- [ ] Task 6's complete Gate A/B/D matrix has evidence for the release revision, including role-based browser checks, real local tools/devices, accessibility, policy review, alert delivery and backup restore. Gate C is linked separately or mobile is explicitly outside release scope.
- [ ] D6 retains its notification meaning and remains unresolved until P4/P5 plus mobile MT-04 delivery/receipt pass; no unsupported notification claim is restored.
- [ ] The rollback rehearsal is recorded, including that new submissions are disabled first and no column is dropped while queued jobs depend on it.
- [ ] `vansen.md`, `CLAUDE.md` and the punchlist describe the tested revision, and D1 through D7 are recorded with where each is enforced.

**This is the last web/backend plan.** The release-readiness review's section 8 is complete only when every applicable gate has dated evidence for the release revision. CI or a manifest alone cannot establish readiness. Gate C stays with the mobile companion; a web-only release must explicitly exclude mobile and retain the D6 notification restriction until its prerequisites pass.
