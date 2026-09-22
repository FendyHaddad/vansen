# Staging Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, non-production environment where the Angular app runs end-to-end against the open-source Supabase stack, so nothing has to be click-tested against the live project.

**Architecture:** No new infrastructure. `supabase start` already runs the same containers the hosted project runs, from `supabase/config.toml`, with migrations 0001→0030 applied. This plan adds what is missing: a gitignored key file the local Edge runtime reads, a seed script that builds a known-good world, a one-line fix so signed media URLs work in a browser, an `environment.development.ts` pointed at localhost, and one `npm run stage` command.

**Tech Stack:** Node 22 scripts (`node:test`, `spawnSync`, `fetch`), Supabase CLI 2.114.0, `psql`, Deno Edge runtime, Angular 22.

**Spec:** [`docs/superpowers/specs/2026-09-22-staging-environment-design.md`](../specs/2026-09-22-staging-environment-design.md)

---

## How to work this plan

Read this section once before Task 1. Every task assumes it.

**Setup, at the start of every shell:**

```bash
cd /Users/user/IdeaProjects/vansen
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null
```

**Rules that override everything else in this document:**

1. **Never run `git commit`, `git branch`, `git checkout -b`, `git push` or `git stash`.** The repository owner commits personally. Where a step says "stop for review", leave the files as they are and report.
2. **Never write a real key into any file except `supabase/.env.staging`.** That file is gitignored. If `git status` ever lists `supabase/.env.staging`, stop and report before doing anything else.
3. **No nested `if` statements.** Use guard clauses and early returns, as every code block below does.
4. **Do only what the step says.** Do not refactor neighbouring code, rename things, add features or "improve" a file you were told to edit. If something looks wrong outside the step, report it; do not fix it.
5. **When a step says `Expected:` and reality differs, stop.** Do not guess at a fix. Report the command, the full output and which step you were on.
6. **Create files with the exact content shown.** Copy the whole code block. Do not retype, reformat, or shorten comments.
7. **Edit files by finding the exact `Before` text and replacing it with the exact `After` text.** If the `Before` text is not found exactly once, stop and report.

**Running tests:**

| What | Command | Never use |
|---|---|---|
| One Node script test file | `node --test scripts/<name>.test.mjs` | — |
| All script tests | `npm run test:scripts` | — |
| One Deno test file | `cd supabase/functions && deno test --allow-all api/<name>_test.ts` | — |
| All Deno tests | `npm run test:deno` | — |
| Angular unit tests | `npm test` | a bare `npx vitest run` — it falsely fails every TestBed spec |
| Everything | `VANSEN_LOCAL_DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run verify` | — |

**Facts you may rely on (verified 2026-09-22 against CLI 2.114.0):**

- Local API `http://127.0.0.1:54321`; local database `postgresql://postgres:postgres@127.0.0.1:54322/postgres`; Studio `http://127.0.0.1:54323`; local mailbox `http://127.0.0.1:54324`.
- Local publishable (anon) key: `sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`
- Local service-role key: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU`
  Both are the Supabase CLI's fixed development keys. They are public, identical on every machine, and only work against a stack on localhost. They are **not** secrets and may be written into source.
- `fn_apply_fulfillment(p_source, p_txn_id, p_user, p_kind, p_plan, p_credits, p_period_end, p_event_at, p_entitlement)` — positional, in that order. Calling it twice with the same `(p_source, p_txn_id)` is a no-op replay.
- Plan credits: studio 1500, pro 3750. `subscriptions.plan` accepts `'studio'`, `'pro'`, `'owner'`.
- The five video families (`veo`, `omni`, `kling`, `runway`, `seedance`) are `enabled = false` and **no script in this plan may name them**.
- Inside the local Edge runtime, `SUPABASE_URL` is `http://kong:8000`. A browser cannot reach that host. Task 4 exists because of this.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/.env.staging.example` (create) | Names the environment variables staging reads. Values empty or placeholders. |
| `.gitignore` (modify) | Un-ignore the example file, which `supabase/.env.*` currently swallows. |
| `scripts/stage-env.mjs` (create) | Pure: read `.env.staging`, decide which model families staging may enable. |
| `scripts/stage-env.test.mjs` (create) | Tests for the above, including a drift guard against the provider index. |
| `scripts/stage-seed.mjs` (create) | Build the staging world and grant credits on demand. |
| `scripts/stage-seed.test.mjs` (create) | Tests for the SQL and the user plan the seed produces. |
| `supabase/functions/api/app.ts` (modify, 4 small edits) | `browserUrl()` — rewrite signed storage URLs to a browser-reachable origin when configured. |
| `supabase/functions/api/index.ts` (modify, 1 edit) | Read `MEDIA_PUBLIC_ORIGIN` from the environment. |
| `supabase/functions/api/staging_media_origin_test.ts` (create) | Proves the rewrite on and off. |
| `scripts/stage.mjs` (create) | Orchestration: start stack, serve functions, tick worker, run `ng serve`, stop. |
| `scripts/stage.test.mjs` (create) | Tests for the arguments and the worker tick request. |
| `src/environments/environment.development.ts` (modify, whole file) | Point `ng serve` at the local stack instead of production. |
| `package.json` (modify, 2 edits) | `stage`, `stage:seed`, `stage:grant`, `stage:stop`; extend `test:scripts`. |
| Four docs (modify) | Runbook staging section; close review item 21; a line in `CLAUDE.md`. |

---

### Task 1: Key file and its gitignore hole

**Files:**
- Create: `supabase/.env.staging.example`
- Modify: `.gitignore`

**Why the gitignore edit matters.** `.gitignore` contains `supabase/.env.*`. That matches `supabase/.env.staging` (correct — it will hold keys) **and** `supabase/.env.staging.example` (wrong — nobody would ever receive the template). The existing `!.env.example` line is rooted at the top level and does not reach into `supabase/`.

- [ ] **Step 1: Prove the hole exists**

```bash
git check-ignore -v supabase/.env.staging.example
```

Expected: one line ending in `supabase/.env.*	supabase/.env.staging.example`.

- [ ] **Step 2: Edit `.gitignore`**

Before (exactly these four lines exist together):

```gitignore
# Supabase — local state & secrets stay out; config.toml and migrations stay IN
supabase/.env
supabase/.env.*
supabase/.temp/
```

After:

```gitignore
# Supabase — local state & secrets stay out; config.toml and migrations stay IN
supabase/.env
supabase/.env.*
# ...but the staging template carries no values and must be shared.
!supabase/.env.staging.example
supabase/.temp/
```

- [ ] **Step 3: Prove the hole is closed**

```bash
git check-ignore -v supabase/.env.staging.example
```

Expected: one line ending in `!supabase/.env.staging.example	supabase/.env.staging.example` — with `-v`, git shows the negation that now wins (and exits 0 because it matched a rule; that is normal).

- [ ] **Step 4: Create `supabase/.env.staging.example`**

```bash
# Staging (local) environment for the Edge Functions.
#
# Copy to `supabase/.env.staging` and paste your own keys in. That file is
# gitignored and must stay that way: these are the same provider keys the
# hosted project holds in its Edge Function secrets.
#
# Every provider key is optional. A family whose key is missing is seeded
# `enabled = false` by `npm run stage:seed`, so staging refuses that family
# the way the production kill switch does rather than failing mid-request.

# Nano Banana / Nano Banana Pro. Needs a PAID Google tier: the free tier has
# zero image quota and answers 429 to every request.
GOOGLE_AI_API_KEY=

# GPT Image. ALSO powers the moderation gate, which runs before every charge
# and every provider call. Without it nothing can be generated at all, whatever
# the other keys say.
OPENAI_API_KEY=

# FLUX, Seedream, the upscaler, personas and all four AI edit tools.
FAL_API_KEY=

# --- Not provider keys. Leave these three as they are. ---

# Any non-empty string. `job-worker` refuses a request whose `x-worker-secret`
# header does not match, and refuses every request while this is unset.
JOB_WORKER_SECRET=staging-worker-secret

# The api function constructs a Stripe client at module load and needs a
# non-empty string to boot. Checkout cannot complete in staging (no webhook can
# reach a laptop). Do NOT paste a real Stripe key here.
STRIPE_SECRET_KEY=sk_test_staging_unused

# Inside the local Edge runtime SUPABASE_URL is http://kong:8000, which a
# browser cannot reach. Signed media URLs are rewritten to this origin instead.
MEDIA_PUBLIC_ORIGIN=http://127.0.0.1:54321
```

- [ ] **Step 5: Check what git sees**

```bash
git status --porcelain
```

Expected: exactly these two lines (order may differ), and nothing mentioning `.env.staging` without `.example`:

```
 M .gitignore
?? supabase/.env.staging.example
```

- [ ] **Step 6: Stop for review** (leave uncommitted)

**Done when:** `git check-ignore` exits 1 for the example file and the two lines above are the only changes.

---

### Task 2: `stage-env.mjs` — which families staging may enable

**Files:**
- Create: `scripts/stage-env.mjs`
- Create: `scripts/stage-env.test.mjs`

**What later tasks import from this file:** `ENV_PATH`, `EXAMPLE_PATH`, `FAMILY_KEY`, `parseEnvFile(text)`, `familyPlan(env)`, `loadStagingEnv({ readFile, exists })`.

- [ ] **Step 1: Create `scripts/stage-env.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FAMILY_KEY, familyPlan, loadStagingEnv, parseEnvFile } from './stage-env.mjs';

test('parseEnvFile ignores comments, blanks and empty values', () => {
  const parsed = parseEnvFile([
    '# a comment',
    '',
    'FAL_API_KEY=abc123',
    'OPENAI_API_KEY=',
    '  GOOGLE_AI_API_KEY = "spaced"  ',
    'NOT_A_PAIR',
  ].join('\n'));
  assert.deepEqual(parsed, { FAL_API_KEY: 'abc123', GOOGLE_AI_API_KEY: 'spaced' });
});

test('a value containing = keeps everything after the first one', () => {
  assert.equal(parseEnvFile('K=a=b=c').K, 'a=b=c');
});

test('familyPlan enables only the families whose key is present', () => {
  const plan = familyPlan({ FAL_API_KEY: 'k' });
  assert.deepEqual(plan.enabled.sort(), [
    'edit-bg', 'edit-expand', 'edit-fill', 'edit-remove', 'flux', 'persona',
    'seedream', 'upscaler',
  ]);
  assert.deepEqual(plan.disabled.sort(), ['gpt-image', 'nano-banana']);
  assert.equal(plan.moderation, false);
});

test('familyPlan reports moderation separately from any family', () => {
  assert.equal(familyPlan({ OPENAI_API_KEY: 'k' }).moderation, true);
});

test('familyPlan with no keys disables everything', () => {
  const plan = familyPlan({});
  assert.equal(plan.enabled.length, 0);
  assert.equal(plan.disabled.length, Object.keys(FAMILY_KEY).length);
});

test('loadStagingEnv names the example file when the real one is missing', () => {
  assert.throws(
    () => loadStagingEnv({ exists: () => false }),
    /supabase\/\.env\.staging\.example/,
  );
});

// Drift guard. If a family is added to the provider index without a staging
// key mapping, the seed would silently leave it enabled with no key behind it.
test('every image family in the provider index has a staging key', () => {
  const source = readFileSync('supabase/functions/_shared/providers/index.ts', 'utf8');
  const table = source.slice(
    source.indexOf('const BY_FAMILY'),
    source.indexOf('export function adapterFor'),
  );
  const families = [...table.matchAll(/^\s*'?([a-z][a-z-]*)'?:\s*\w+Adapter,/gm)].map((m) => m[1]);
  assert.ok(families.length > 5, 'the BY_FAMILY table did not parse');

  const VIDEO = new Set(['veo', 'omni', 'kling', 'runway', 'seedance']);
  const image = families.filter((f) => !VIDEO.has(f)).sort();
  assert.deepEqual(image, Object.keys(FAMILY_KEY).sort());
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test scripts/stage-env.test.mjs
```

Expected: the output contains `Cannot find module` and `stage-env.mjs`.

- [ ] **Step 3: Create `scripts/stage-env.mjs`**

```js
#!/usr/bin/env node
/**
 * What staging is allowed to claim it can do.
 *
 * Staging runs with the owner's real provider keys where they are supplied and
 * with nothing where they are not. A family left `enabled = true` with no key
 * behind it fails inside the job worker, after the charge, which looks like a
 * bug rather than a missing key. So the rule is decided here, from the file,
 * and applied by the seed: key present means enabled, key absent means the
 * same kill switch production uses.
 *
 * Video is not represented. `0016_video.sql` inserts those five families
 * disabled and staging has no business turning them on: they need R2 and a
 * Runway key that no local stack has.
 */
import { existsSync, readFileSync } from 'node:fs';

export const ENV_PATH = 'supabase/.env.staging';
export const EXAMPLE_PATH = 'supabase/.env.staging.example';

/** Image family id → the environment variable its provider adapter reads. */
export const FAMILY_KEY = {
  'nano-banana': 'GOOGLE_AI_API_KEY',
  'gpt-image': 'OPENAI_API_KEY',
  flux: 'FAL_API_KEY',
  seedream: 'FAL_API_KEY',
  upscaler: 'FAL_API_KEY',
  persona: 'FAL_API_KEY',
  'edit-remove': 'FAL_API_KEY',
  'edit-fill': 'FAL_API_KEY',
  'edit-expand': 'FAL_API_KEY',
  'edit-bg': 'FAL_API_KEY',
};

/** An empty value means absent: a key someone cleared is not a key. */
export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split < 0) continue;
    const name = trimmed.slice(0, split).trim();
    const value = trimmed.slice(split + 1).trim().replace(/^["']|["']$/g, '');
    if (!value) continue;
    values[name] = value;
  }
  return values;
}

export function familyPlan(env) {
  const enabled = [];
  const disabled = [];
  for (const [family, key] of Object.entries(FAMILY_KEY)) {
    if (env[key]) enabled.push(family);
    if (!env[key]) disabled.push(family);
  }
  return { enabled, disabled, moderation: Boolean(env.OPENAI_API_KEY) };
}

export function loadStagingEnv({ readFile = readFileSync, exists = existsSync } = {}) {
  if (!exists(ENV_PATH)) {
    throw new Error(`${ENV_PATH} is missing. Copy ${EXAMPLE_PATH} to it and paste your keys in.`);
  }
  return parseEnvFile(readFile(ENV_PATH, 'utf8'));
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test scripts/stage-env.test.mjs
```

Expected: `# pass 7` and `# fail 0`.

- [ ] **Step 5: Stop for review** (leave uncommitted)

**Done when:** 7 tests pass and `git status --porcelain` shows the two new files as `??`.

---

### Task 3: `stage-seed.mjs` — build the staging world, grant credits

**Files:**
- Create: `scripts/stage-seed.mjs`
- Create: `scripts/stage-seed.test.mjs`

**Imports from Task 2:** `familyPlan`, `loadStagingEnv`.
**What Task 6 imports from this file:** `API_URL`, `SERVICE_ROLE_KEY`, `STAGING_USERS`. Also exports `serviceRoleGrantsSql()`.

**Two things this script deliberately does.** Credits are granted through `fn_apply_fulfillment` — the same function a real purchase calls — never by inserting ledger rows; and it refuses any database whose host is not local, because pointed at the hosted project it would hand out free credits.

- [ ] **Step 1: Create `scripts/stage-seed.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grantCredits, grantSql, modelsSql, packGrantSql, profileSql, seed, serviceRoleGrantsSql,
  sqlLiteral, STAGING_USERS,
} from './stage-seed.mjs';

test('the three accounts cover free, studio and pro', () => {
  assert.deepEqual(STAGING_USERS.map((u) => u.plan), [null, 'studio', 'pro']);
  assert.deepEqual(STAGING_USERS.map((u) => u.credits), [0, 1500, 3750]);
  assert.ok(STAGING_USERS.every((u) => u.email.endsWith('@staging.vansen')));
});

test('sqlLiteral doubles single quotes', () => {
  assert.equal(sqlLiteral("o'brien"), "'o''brien'");
});

test('a free account is granted nothing', () => {
  assert.equal(grantSql(STAGING_USERS[0], '11111111-1111-1111-1111-111111111111'), null);
});

test('a plan account is granted through fn_apply_fulfillment, not a ledger insert', () => {
  const sql = grantSql(STAGING_USERS[1], '22222222-2222-2222-2222-222222222222');
  assert.match(sql, /select public\.fn_apply_fulfillment\(/);
  assert.match(sql, /'seed:studio@staging\.vansen'/);
  assert.match(sql, /'subscription_grant'/);
  assert.match(sql, /'studio', 1500/);
  assert.doesNotMatch(sql, /insert into public\.ledger_entries/);
});

test('the grant carries an entitlement whose period is in the future', () => {
  const sql = grantSql(STAGING_USERS[2], '33333333-3333-3333-3333-333333333333');
  assert.match(sql, /now\(\) \+ interval '30 days'/);
  assert.match(sql, /'status', 'active'/);
  assert.match(sql, /'plan', 'pro'/);
});

test('modelsSql enables and disables only the families it was given', () => {
  const sql = modelsSql({ enabled: ['flux', 'persona'], disabled: ['gpt-image'] });
  assert.match(sql, /set enabled = true.*where id in \('flux', 'persona'\)/s);
  assert.match(sql, /set enabled = false.*where id in \('gpt-image'\)/s);
});

test('modelsSql never names a video family', () => {
  const sql = modelsSql({ enabled: ['flux'], disabled: ['gpt-image'] });
  for (const video of ['veo', 'omni', 'kling', 'runway', 'seedance']) {
    assert.doesNotMatch(sql, new RegExp(`'${video}'`));
  }
});

test('modelsSql omits an empty side rather than writing where id in ()', () => {
  assert.doesNotMatch(modelsSql({ enabled: [], disabled: ['flux'] }), /true/);
  assert.doesNotMatch(modelsSql({ enabled: ['flux'], disabled: [] }), /false/);
});

test('profileSql confirms the age gate so a seeded account can reach the app', () => {
  const sql = profileSql('44444444-4444-4444-4444-444444444444');
  assert.match(sql, /update public\.profiles/);
  assert.match(sql, /birth_date/);
  assert.match(sql, /age_confirmed_at = now\(\)/);
});

test('serviceRoleGrantsSql grants data access to service_role and nobody else', () => {
  const sql = serviceRoleGrantsSql();
  assert.match(sql, /grant select, insert, update, delete on all tables in schema public to service_role/);
  assert.match(sql, /alter default privileges in schema public grant select, insert, update, delete on tables to service_role/);
  assert.doesNotMatch(sql, /anon|authenticated/);
});

test('packGrantSql writes a pack grant with the id it was given', () => {
  const sql = packGrantSql('55555555-5555-5555-5555-555555555555', 250, 'manual:123');
  assert.match(sql, /'pack_grant'/);
  assert.match(sql, /'manual:123'/);
  assert.match(sql, /null::text, 250/);
});

test('packGrantSql refuses a non-positive amount', () => {
  assert.throws(() => packGrantSql('5555', 0, 'manual:1'), /positive/);
  assert.throws(() => packGrantSql('5555', -5, 'manual:1'), /positive/);
});

test('seed creates a missing user and reuses an existing one', async () => {
  const existing = [{ id: 'aaaa', email: 'free@staging.vansen' }];
  const requests = [];
  const statements = [];
  const request = async (url, init) => {
    requests.push({ url, method: init?.method ?? 'GET' });
    if (init?.method !== 'POST') return { ok: true, json: async () => ({ users: existing }) };
    const email = JSON.parse(init.body).email;
    const created = { id: `id-${email}`, email };
    existing.push(created);
    return { ok: true, json: async () => created };
  };
  const run = (_cmd, args) => {
    statements.push(args[args.indexOf('-c') + 1]);
    return { status: 0 };
  };

  await seed({ env: { FAL_API_KEY: 'k' }, run, request, log: () => {} });

  const posts = requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2, 'only the two missing accounts are created');
  assert.ok(statements.some((s) => s.includes("'seed:studio@staging.vansen'")));
  assert.ok(statements.some((s) => s.includes('set enabled = false')));
  assert.ok(statements.some((s) => s.includes('age_confirmed_at')));
  assert.ok(statements[0].includes('on all tables in schema public to service_role'), 'grants run first');
});

test('seed refuses a non-local database', async () => {
  await assert.rejects(
    () => seed({ env: {}, databaseUrl: 'postgresql://postgres@db.bnorhcxhvxydkgvcxjad.supabase.co:5432/postgres' }),
    /disposable local database/,
  );
});

test('grantCredits fails with a clear message for an unknown account', async () => {
  const request = async () => ({ ok: true, json: async () => ({ users: [] }) });
  await assert.rejects(
    () => grantCredits({ email: 'nobody@staging.vansen', credits: 10, request, run: () => ({ status: 0 }) }),
    /nobody@staging\.vansen/,
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test scripts/stage-seed.test.mjs
```

Expected: the output contains `Cannot find module` and `stage-seed.mjs`.

- [ ] **Step 3: Create `scripts/stage-seed.mjs`**

```js
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

/** Credits match PLAN_CREDITS in _shared/model-families.ts. A drift here shows
 * up as a balance that does not match the plan the UI is displaying. */
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
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test scripts/stage-seed.test.mjs
```

Expected: `# pass 15` and `# fail 0`.

- [ ] **Step 5: Make sure the stack is up, then run the seed for real**

```bash
supabase status >/dev/null 2>&1 || npm run db:test:start
cp -n supabase/.env.staging.example supabase/.env.staging
node scripts/stage-seed.mjs
```

Expected: three account lines, then `enabled:  nothing`, then a `disabled:` line naming all ten image families, then the `OPENAI_API_KEY is absent` warning, then the password line. (`cp -n` does not overwrite a `.env.staging` you already filled in.)

- [ ] **Step 6: Prove it in the database**

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -X -c \
  "select u.email, s.plan, s.status from auth.users u
     join public.profiles p on p.id = u.id
     left join public.subscriptions s on s.user_id = u.id
   where u.email like '%@staging.vansen' order by u.email;"
```

Expected: three rows. `free@staging.vansen` with empty plan and status; `pro@…` with `pro | active`; `studio@…` with `studio | active`.

- [ ] **Step 6b: Prove the api's role can read the tables**

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -X -t -A -c \
  "select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
   where grantee = 'service_role' and table_schema = 'public' and table_name = 'profiles';"
```

Expected: `DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE`. (Before this step first ran it read `REFERENCES,TRIGGER,TRUNCATE`, which is why `GET /profile` answered `not_found`.)

- [ ] **Step 7: Prove it is idempotent**

```bash
node scripts/stage-seed.mjs >/dev/null && psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -X -t -c \
  "select count(*) from public.ledger_entries where stripe_ref like 'stripe:seed:%';"
```

Expected: `2` — one grant per plan account, unchanged by the second run.

- [ ] **Step 8: Prove the grant command**

```bash
node scripts/stage-seed.mjs grant free@staging.vansen 500
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -X -t -c \
  "select bucket, amount_credits from public.ledger_entries
   where user_id = (select id from auth.users where email = 'free@staging.vansen');"
```

Expected: `granted 500 credits to free@staging.vansen`, then one row `pack | 500`.

- [ ] **Step 9: Stop for review** (leave uncommitted)

**Done when:** 15 tests pass, the three accounts exist in the local database, and `git status --porcelain` does **not** list `supabase/.env.staging`.

---

### Task 4: Signed media URLs a browser can open — `MEDIA_PUBLIC_ORIGIN`

**Files:**
- Modify: `supabase/functions/api/app.ts` (4 edits, each a find-and-replace)
- Modify: `supabase/functions/api/index.ts` (1 edit)
- Create: `supabase/functions/api/staging_media_origin_test.ts`

**Why.** The API signs storage URLs with `admin.storage.from(...).createSignedUrl(...)`, which builds them on `SUPABASE_URL`. Inside the local Edge runtime that is `http://kong:8000` — a hostname only other Docker containers can resolve. Every thumbnail in staging would be a broken image. In production `SUPABASE_URL` is the public URL and nothing needs rewriting, so the helper does nothing when `MEDIA_PUBLIC_ORIGIN` is unset.

**Where the helper is and is not applied.** It is applied where a signed URL goes to the **browser**: the library/detail DTO (via `signMedia`), the upload preview URL, and the persona thumbnail. It is **not** applied where a signed URL goes to a **provider** (reference images for generation, persona zips): no origin makes a laptop reachable from fal's servers, and those code paths must not change.

- [ ] **Step 1: Create `supabase/functions/api/staging_media_origin_test.ts`**

```ts
// Staging runs the api inside the local Edge runtime, where SUPABASE_URL is
// http://kong:8000 — a host a browser cannot resolve. MEDIA_PUBLIC_ORIGIN
// rewrites the signed URLs the browser receives. Unset, nothing changes.
import { assertEquals } from "jsr:@std/assert";
import { createApp } from "./app.ts";
import { FakeDb, TEST_USER, testDeps } from "./testing/fakes.ts";

const AUTH = { authorization: "Bearer test-token" };

function oneFinishedImage() {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.generations = [{
    id: "g1",
    user_id: TEST_USER,
    kind: "image",
    family_id: "flux",
    family_name: "FLUX",
    op: "generate",
    prompt: "a cat",
    settings: {},
    price_credits: 40,
    status: "done",
    media_path: "u/1.png",
    thumb_path: "u/1.thumb.jpg",
    storage_backend: "supabase",
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  }];
  for (const path of ["u/1.png", "u/1.thumb.jpg"]) {
    db.storage.objects.set(`media/${path}`, {
      bytes: new Uint8Array([1]),
      contentType: "image/png",
    });
  }
  return deps;
}

Deno.test("staging: a configured origin replaces the host of signed media URLs", async () => {
  const deps = oneFinishedImage();
  deps.env.mediaPublicOrigin = "http://127.0.0.1:54321";
  const app = createApp(deps);

  const res = await app.request("/api/generations?limit=10", { headers: AUTH });
  const body = await res.json();

  assertEquals(body.items[0].thumbUrl, "http://127.0.0.1:54321/media/u/1.thumb.jpg?token=signed");
});

Deno.test("production: with no origin configured the signed URL is untouched", async () => {
  const deps = oneFinishedImage();
  const app = createApp(deps);

  const res = await app.request("/api/generations?limit=10", { headers: AUTH });
  const body = await res.json();

  assertEquals(body.items[0].thumbUrl, "https://fake.storage/media/u/1.thumb.jpg?token=signed");
});
```

- [ ] **Step 2: Run it and watch the first test fail**

```bash
cd supabase/functions && deno test --allow-all api/staging_media_origin_test.ts; cd ../..
```

Expected: 1 passed, 1 failed. The failing one is `staging: a configured origin…`, and its message shows the actual value `https://fake.storage/…`. (If it reports a type error about `mediaPublicOrigin` instead, that is also expected — continue.)

- [ ] **Step 3: Edit `supabase/functions/api/app.ts` — the `ApiEnv` interface**

Before:

```ts
  releaseFlags: ReleaseFlags;
  release: ReleaseIdentity;
}
```

After:

```ts
  releaseFlags: ReleaseFlags;
  release: ReleaseIdentity;
  /** Staging only. Inside the local Edge runtime SUPABASE_URL is
   * http://kong:8000, which a browser cannot resolve; signed storage URLs for
   * the browser are rewritten to this origin. Unset in production. */
  mediaPublicOrigin?: string;
}
```

- [ ] **Step 4: Edit `app.ts` — add the helper at the top of `createApp`**

Before:

```ts
  const APP_ORIGINS = deps.env.appOrigins;
  const PLAN_PRICE_IDS = deps.env.planPriceIds;
```

After:

```ts
  const APP_ORIGINS = deps.env.appOrigins;
  const PLAN_PRICE_IDS = deps.env.planPriceIds;

  /** A signed storage URL the browser can open. Only applied to URLs meant
   * for the browser: a provider needs the URL as storage signed it, and no
   * origin makes a laptop reachable from a provider anyway. */
  function browserUrl(signed: string): string {
    const origin = deps.env.mediaPublicOrigin;
    if (!origin) return signed;
    if (!signed) return signed;
    const parsed = new URL(signed);
    return `${origin}${parsed.pathname}${parsed.search}`;
  }
```

- [ ] **Step 5: Edit `app.ts` — `signMedia` stores and returns the browser URL**

Before:

```ts
    if (!data?.signedUrl) return "";
    if (signedUrlMemo.size > 5000) signedUrlMemo.clear();
    signedUrlMemo.set(path, {
      url: data.signedUrl,
      expiresAt: Date.now() + SIGN_TTL_S * 1000,
    });
    return data.signedUrl;
```

After:

```ts
    if (!data?.signedUrl) return "";
    const url = browserUrl(data.signedUrl);
    if (signedUrlMemo.size > 5000) signedUrlMemo.clear();
    signedUrlMemo.set(path, {
      url,
      expiresAt: Date.now() + SIGN_TTL_S * 1000,
    });
    return url;
```

- [ ] **Step 6: Edit `app.ts` — the upload preview URL**

Before:

```ts
    const { data: signed } = await admin.storage.from("uploads")
      .createSignedUrl(path, 600);
    return c.json({ uploadId: path, url: signed?.signedUrl ?? "" });
```

After:

```ts
    const { data: signed } = await admin.storage.from("uploads")
      .createSignedUrl(path, 600);
    return c.json({ uploadId: path, url: browserUrl(signed?.signedUrl ?? "") });
```

- [ ] **Step 7: Edit `app.ts` — the persona thumbnail**

Before:

```ts
      const { data } = await admin.storage.from("uploads").createSignedUrl(
        photos[0],
        3600,
      );
      thumbUrl = data?.signedUrl ?? "";
```

After:

```ts
      const { data } = await admin.storage.from("uploads").createSignedUrl(
        photos[0],
        3600,
      );
      thumbUrl = browserUrl(data?.signedUrl ?? "");
```

- [ ] **Step 8: Edit `supabase/functions/api/index.ts` — read the variable**

Before:

```ts
    releaseFlags: releaseFlagsFromEnv((k) => Deno.env.get(k)),
    release,
  },
```

After:

```ts
    releaseFlags: releaseFlagsFromEnv((k) => Deno.env.get(k)),
    release,
    mediaPublicOrigin: Deno.env.get("MEDIA_PUBLIC_ORIGIN") || undefined,
  },
```

- [ ] **Step 9: Run the new test file**

```bash
cd supabase/functions && deno test --allow-all api/staging_media_origin_test.ts; cd ../..
```

Expected: `ok | 2 passed | 0 failed`.

- [ ] **Step 10: Run every Deno test — nothing else may change**

```bash
npm run test:deno
```

Expected: `ok | 570 passed | 0 failed` (568 before this task, plus the 2 new ones). Any other number: stop and report.

- [ ] **Step 11: Stop for review** (leave uncommitted)

**Done when:** 570 Deno tests pass and `git diff --stat supabase/functions/api/` shows exactly two files changed, `app.ts` and `index.ts`.

---

### Task 5: Point `ng serve` at the local stack

**Files:**
- Modify: `src/environments/environment.development.ts` (replace the whole file)

**Why this is a fix, not just a feature.** `angular.json` gives the `development` build configuration a `fileReplacements` entry swapping `environment.ts` for `environment.development.ts`, and `ng serve` defaults to `development`. That file currently holds the production URL, so **`ng serve` today reads and writes the live project.** `ng build` uses `environment.ts` and is not touched by this task.

- [ ] **Step 1: Confirm which file ships**

```bash
grep -c "bnorhcxhvxydkgvcxjad" src/environments/environment.ts
```

Expected: `2`. Do **not** edit `environment.ts`.

- [ ] **Step 2: Replace the whole of `src/environments/environment.development.ts` with:**

```ts
// Staging: the local Supabase stack from `supabase/config.toml`, brought up by
// `npm run stage`. `ng serve` uses this file (angular.json → development →
// fileReplacements); `ng build` uses environment.ts and still points at
// production.
//
// Until 2026-09-22 this file named the hosted project, so every `ng serve`
// session wrote to live data. See
// docs/superpowers/specs/2026-09-22-staging-environment-design.md.
//
// The key below is the Supabase CLI's fixed local development key. It is
// public by design and only valid against a stack on this machine.
export const environment = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
  apiBaseUrl: 'http://127.0.0.1:54321/functions/v1/api',
  // Nothing runs on a schedule locally, so staging must not promise that work
  // finishes after the last client closes. `npm run stage` ticks the job
  // worker only for as long as it is running.
  releaseCapabilities: {
    backgroundCompletion: false,
    completionNotifications: false,
  },
};
```

- [ ] **Step 3: Prove the production build is unaffected**

```bash
npx ng build --configuration production >/dev/null 2>&1 && grep -rl "bnorhcxhvxydkgvcxjad" dist/ | wc -l
```

Expected: a number greater than `0` — the production bundle still names the production project.

- [ ] **Step 4: Prove the unit tests still pass**

```bash
npm test
```

Expected: the summary line contains `579 passed`.

- [ ] **Step 5: Stop for review** (leave uncommitted)

**Done when:** `git diff --stat src/` shows only `environment.development.ts`, the production build contains the production ref, and 579 tests pass.

---

### Task 6: `stage.mjs` — one command

**Files:**
- Create: `scripts/stage.mjs`
- Create: `scripts/stage.test.mjs`
- Modify: `package.json` (2 edits)

**Imports:** `ENV_PATH`, `familyPlan`, `loadStagingEnv` (Task 2); `API_URL`, `SERVICE_ROLE_KEY`, `STAGING_USERS` (Task 3).

**What it does and does not do.** It serves the five functions with `--no-verify-jwt` (the same flag `scripts/deploy-backend.mjs` deploys them with) and POSTs `job-worker` every 15 seconds, because nothing else calls it locally and a fal-queued generation would otherwise sit `pending` forever. It does **not** call `cleanup-worker`: that deletes things, the SQL gates already cover it, and it would destroy the library the developer just seeded.

- [ ] **Step 1: Create `scripts/stage.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveArgs, stopChild, tickRequest, WORKER_INTERVAL_MS } from './stage.mjs';

test('functions are served with the staging env file and no jwt check', () => {
  assert.deepEqual(serveArgs(), [
    'functions', 'serve', '--no-verify-jwt', '--env-file', 'supabase/.env.staging',
  ]);
});

test('the worker tick carries the secret the worker demands', () => {
  const { url, init } = tickRequest({ JOB_WORKER_SECRET: 'shh' });
  assert.equal(url, 'http://127.0.0.1:54321/functions/v1/job-worker');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-worker-secret'], 'shh');
});

test('a missing worker secret is refused rather than sent as undefined', () => {
  assert.throws(() => tickRequest({}), /JOB_WORKER_SECRET/);
});

test('the tick interval is well under the 10 minute stale-job sweep', () => {
  assert.ok(WORKER_INTERVAL_MS > 0 && WORKER_INTERVAL_MS <= 30_000);
});

test('stopChild asks the whole group politely first and resolves once the child exits', async () => {
  const signals = [];
  const fake = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    handlers: {},
    once(event, fn) { this.handlers[event] = fn; },
  };
  const signal = (child, name) => {
    signals.push([child.pid, name]);
    fake.exitCode = 0;
    fake.handlers.exit();
  };
  await stopChild(fake, signal);
  assert.deepEqual(signals, [[4242, 'SIGINT']]);
});

test('stopChild does not wait on a child that is already gone', async () => {
  await stopChild({ exitCode: 1, signalCode: null });
  await stopChild({ exitCode: null, signalCode: 'SIGTERM' });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test scripts/stage.test.mjs
```

Expected: the output contains `Cannot find module` and `stage.mjs`.

- [ ] **Step 3: Create `scripts/stage.mjs`**

```js
#!/usr/bin/env node
/**
 * Bring staging up: the Supabase containers, the five Edge Functions, a job
 * worker tick, and `ng serve` against all of it.
 *
 *   node scripts/stage.mjs         start everything, Ctrl-C to stop
 *   node scripts/stage.mjs stop    also stop the containers
 *
 * Everything this starts dies with it. The worker tick is a timer in this
 * process, not a cron job, so a forgotten staging session cannot keep calling
 * providers after the terminal is closed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { API_URL, SERVICE_ROLE_KEY, STAGING_USERS } from './stage-seed.mjs';
import { ENV_PATH, familyPlan, loadStagingEnv } from './stage-env.mjs';

export const WORKER_INTERVAL_MS = 15_000;

export function serveArgs() {
  return ['functions', 'serve', '--no-verify-jwt', '--env-file', ENV_PATH];
}

export function tickRequest(env) {
  const secret = env.JOB_WORKER_SECRET;
  if (!secret) throw new Error(`JOB_WORKER_SECRET is missing from ${ENV_PATH}`);
  return {
    url: `${API_URL}/functions/v1/job-worker`,
    init: {
      method: 'POST',
      headers: {
        'x-worker-secret': secret,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    },
  };
}

function stackRunning() {
  return spawnSync('supabase', ['status'], { encoding: 'utf8' }).status === 0;
}

export const STOP_GRACE_MS = 10_000;

/** Signals the child's whole process group. Both `supabase` and `npx` are
 * wrappers that fork the real binary; a signal to the wrapper alone leaves
 * that grandchild running, reparented to launchd, after we are gone. The
 * children are spawned `detached` so each has a group of its own to signal. */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone; nothing left to signal.
  }
}

/** Asks a child to stop the way Ctrl-C would, waits for it, and only after
 * ten seconds of silence kills it outright. Resolves at once for a child
 * that has already exited, so shutdown never hangs on a corpse. */
export function stopChild(child, signal = signalGroup) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => signal(child, 'SIGKILL'), STOP_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    signal(child, 'SIGINT');
  });
}

export function stop({ run = spawnSync, log = console.log } = {}) {
  run('supabase', ['stop'], { stdio: 'inherit' });
  log('staging stopped.');
}

async function start() {
  const env = loadStagingEnv();
  const plan = familyPlan(env);
  const tick = tickRequest(env);

  if (!stackRunning()) {
    console.log('starting the Supabase stack...');
    const started = spawnSync('supabase', ['start'], { stdio: 'inherit' });
    if (started.status !== 0) throw new Error('could not start the stack (is Docker running?)');
  }

  // detached: each child leads its own process group, which is what stopChild
  // signals. The terminal is still shared through stdio: 'inherit'.
  const children = [
    spawn('supabase', serveArgs(), { stdio: 'inherit', detached: true }),
    spawn('npx', ['ng', 'serve'], { stdio: 'inherit', detached: true }),
  ];

  const ticker = setInterval(() => {
    fetch(tick.url, tick.init).catch(() => {});
  }, WORKER_INTERVAL_MS);

  // One exit path. Ctrl-C, a kill, or either child dying on its own all end
  // with every child gone before this process is, so nothing is orphaned.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    // Not `.map(stopChild)`: map would pass the index as stopChild's signal.
    await Promise.all(children.map((child) => stopChild(child)));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  for (const child of children) child.once('exit', shutdown);

  console.log('');
  console.log('staging is up:');
  console.log('  app       http://localhost:4200');
  console.log('  studio    http://127.0.0.1:54323');
  console.log('  mail      http://127.0.0.1:54324');
  console.log(`  families  ${plan.enabled.join(', ') || 'none (no provider keys)'}`);
  console.log(`  sign in   ${STAGING_USERS[1].email} / staging-pass`);
  console.log('');
  console.log('Ctrl-C stops the functions and the dev server. The containers keep');
  console.log('running; `npm run stage:stop` stops those too.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const task = process.argv[2] === 'stop' ? async () => stop() : start;
  task().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test scripts/stage.test.mjs
```

Expected: `# pass 6` and `# fail 0`.

- [ ] **Step 5: Edit `package.json` — add the four commands**

Before:

```json
    "db:test:start": "node scripts/supabase-test-stack.mjs start",
    "db:test:stop": "node scripts/supabase-test-stack.mjs stop"
  },
```

After:

```json
    "db:test:start": "node scripts/supabase-test-stack.mjs start",
    "db:test:stop": "node scripts/supabase-test-stack.mjs stop",
    "stage": "node scripts/stage.mjs",
    "stage:seed": "node scripts/stage-seed.mjs",
    "stage:grant": "node scripts/stage-seed.mjs grant",
    "stage:stop": "node scripts/stage.mjs stop"
  },
```

- [ ] **Step 6: Edit `package.json` — put the new tests under the gate**

Before (one line):

```json
    "test:scripts": "node --test scripts/deploy-backend.test.mjs scripts/catalog-check.test.mjs scripts/run-sql-tests.test.mjs scripts/verify-all.test.mjs scripts/migration-inventory.test.mjs scripts/storage-inventory.test.mjs scripts/supabase-test-stack.test.mjs",
```

After (one line):

```json
    "test:scripts": "node --test scripts/deploy-backend.test.mjs scripts/catalog-check.test.mjs scripts/run-sql-tests.test.mjs scripts/verify-all.test.mjs scripts/migration-inventory.test.mjs scripts/storage-inventory.test.mjs scripts/supabase-test-stack.test.mjs scripts/stage-env.test.mjs scripts/stage-seed.test.mjs scripts/stage.test.mjs",
```

- [ ] **Step 7: Prove `package.json` is still valid and the gate sees the tests**

```bash
node -e "require('./package.json')" && npm run test:scripts 2>&1 | tail -8
```

Expected: no error from the first command; the summary shows `# fail 0` and a `# pass` count 28 higher than before this plan (7 + 15 + 6).

- [ ] **Step 8: Run staging end to end**

```bash
npm run stage:seed && npm run stage
```

Expected in the terminal: the seed summary, then Supabase's `functions serve` banner listing all five functions, then Angular's `Local: http://localhost:4200/`, then the `staging is up:` block.

Then in a browser at `http://localhost:4200`:
1. Sign in as `studio@staging.vansen` / `staging-pass`. Expected: the app opens without an age-gate prompt.
2. Open the library, settings and billing pages. Expected: they render; the credit balance reads 1500; the Subscription tab's Stripe panel may show an error state (expected — see the spec, §5).
3. If `supabase/.env.staging` has `FAL_API_KEY` **and** `OPENAI_API_KEY`: generate one FLUX image from a text prompt. Expected: it completes within about a minute and **its thumbnail renders** (this proves Task 4).
4. If it has no keys: click Generate. Expected: a "temporarily unavailable"-style refusal, not an error page.

Press Ctrl-C when done, then confirm nothing survived:

```bash
sleep 12; pgrep -fl "supabase functions serve"; pgrep -fl "ng serve"; echo "stragglers above, if any"
```

Expected: only the `stragglers above, if any` line — both `pgrep`s print nothing.

- [ ] **Step 9: Stop for review** (leave uncommitted)

**Done when:** `npm run test:scripts` passes with the three new files, and the browser checks above behaved as expected. Report which of the four browser checks you could run.

---

### Task 7: Documentation

**Files:**
- Modify: `docs/superpowers/plans/2026-09-20-release-runbook.md`
- Modify: `docs/superpowers/punchlist.md`
- Modify: `docs/superpowers/plans/post-implementation-review.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Runbook — insert a staging section before "## 8. Rollback"**

Find this line in `docs/superpowers/plans/2026-09-20-release-runbook.md`:

```markdown
## 8. Rollback
```

Insert the following **immediately above it**, followed by one blank line:

```markdown
## 7b. Staging (local)

The open-source Supabase stack from `supabase/config.toml`, on the developer's
machine. Design: `specs/2026-09-22-staging-environment-design.md`; plan:
`plans/2026-09-22-staging-environment.md`.

    cp supabase/.env.staging.example supabase/.env.staging   # once, paste keys
    npm run stage:seed                                        # build the world
    npm run stage                                             # functions + ng serve
    npm run stage:grant studio@staging.vansen 500             # credits, no webhook
    npm run stage:stop                                        # stop the containers

Accounts: `free@` / `studio@` / `pro@staging.vansen`, password `staging-pass`.

`npm run verify` runs `supabase db reset` against the same containers and
empties them. That is intended: staging data is disposable, and `stage:seed`
restores it in about five seconds.

What staging does **not** prove: no Stripe or Apple purchase completes (no
webhook can reach a laptop); only text-to-image works (providers cannot fetch
input images from a laptop); the Subscription tab's Stripe panel errors; nothing
runs on a schedule except the job-worker tick `npm run stage` owns. This section
never replaces the deployment procedure in §§1–7.

```

- [ ] **Step 2: Punchlist — close the item**

In `docs/superpowers/punchlist.md`:

Before:

```markdown
- **Owner-requested revamps (last in order)** — self-hosted Supabase staging (cloud
  org is taken by production and `algawth`), clean-code revamp for AI-free
  maintenance, public website redesign, left toolbar redesign. Detail in the
  review's consolidated list, items 21–24.
```

After:

```markdown
- **Owner-requested revamps (last in order)** — ~~self-hosted Supabase staging~~
  (BUILT 2026-09-22 as a local stack, `npm run stage`; see
  `plans/2026-09-22-staging-environment.md`), clean-code revamp for AI-free
  maintenance, public website redesign, left toolbar redesign. Detail in the
  review's consolidated list, items 21–24.
```

- [ ] **Step 3: Review — close item 21 and its status row**

In `docs/superpowers/plans/post-implementation-review.md`, two edits.

First, before (the start of one long line):

```markdown
21. **Staging environment (owner request).** Supabase Cloud cannot host it:
```

After (prefix only; leave the rest of the line as it is):

```markdown
21. ~~**Staging environment (owner request).**~~ **BUILT 2026-09-22** as a local stack, scoped by the owner to schema + API + UI — `npm run stage`, plan `2026-09-22-staging-environment.md`. Original ask, for the record: Supabase Cloud cannot host it:
```

Second, before:

```markdown
| 21–24 | Staging, clean-code, website, toolbar | **Deferred by owner** (next decision). |
```

After:

```markdown
| 21 | Staging | **Built 2026-09-22**, local only, uncommitted — `npm run stage`. |
| 22–24 | Clean-code, website, toolbar | **Deferred by owner** (next decision). |
```

- [ ] **Step 4: `CLAUDE.md` — one bullet under `## Release`**

Before:

```markdown
- Local stack: `npm run db:test:start` / `npm run db:test:stop`. Start refuses a
  Supabase CLI other than the pinned 2.114.0, or a migration whose hash is not in
  `supabase/tests/bootstrap-manifest.json`.
```

After:

```markdown
- Local stack: `npm run db:test:start` / `npm run db:test:stop`. Start refuses a
  Supabase CLI other than the pinned 2.114.0, or a migration whose hash is not in
  `supabase/tests/bootstrap-manifest.json`.
- Staging: `npm run stage` (same local stack + `functions serve` + `ng serve`),
  seeded by `npm run stage:seed`, keys in gitignored `supabase/.env.staging`.
  `ng serve` points at localhost, not production. Text-to-image only; no purchase
  completes. Design: `docs/superpowers/specs/2026-09-22-staging-environment-design.md`.
```

- [ ] **Step 5: Run the full gate**

```bash
VANSEN_LOCAL_DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run verify 2>&1 | tail -15; echo "exit=${PIPESTATUS[0]}"
```

Expected: every check line reads `PASS`, and the final `exit=0` (printed by the `echo`, not by `verify`).

- [ ] **Step 6: Prove staging survives the gate**

```bash
npm run stage:seed
```

Expected: the three account lines and the family summary print again — `verify`'s reset emptied them and the seed put them back.

- [ ] **Step 7: Stop for review** (leave uncommitted)

**Done when:** `EXIT=0`, the seed runs clean afterwards, and `git status --porcelain` lists no `supabase/.env.staging`.

---

## Verification checklist

From the spec's acceptance section. Staging is done when all hold:

- [ ] `npm run stage:seed` completes and prints which families are enabled.
- [ ] `npm run stage` opens the app at `localhost:4200`.
- [ ] `studio@staging.vansen` signs in; library, settings and billing render with 1500 credits.
- [ ] With `FAL_API_KEY` and `OPENAI_API_KEY` present, one text-to-image generation completes and its thumbnail renders.
- [ ] With no key present, Generate returns the kill-switch refusal, not an error.
- [ ] `npm run verify` exits 0, and `npm run stage:seed` restores the world afterwards.
- [ ] `git status` never shows `supabase/.env.staging`.

## Post-review fixes (2026-09-22)

The code blocks above are the pre-fix version; the whole-tree review applied these on top:

- A. Spec §3.4 `stage:stop` row corrected to say it stops the containers, not the functions/worker (`docs/superpowers/specs/2026-09-22-staging-environment-design.md`).
- B. `scripts/stage.mjs` hardened: `signalGroup` only swallows `ESRCH`; `stopChild`'s forced-kill timer now also resolves the promise; `shutdown` propagates a child's exit code via `process.exit(code)`; `stop()` throws on a failed `supabase stop`; `start()` guards on missing `STRIPE_SECRET_KEY`/`MEDIA_PUBLIC_ORIGIN`. Tests added in `scripts/stage.test.mjs`.
- C. `scripts/stage-seed.mjs`'s `psql()` now checks `result.error` before `result.status`, matching `scripts/run-sql-tests.mjs`. Test added in `scripts/stage-seed.test.mjs`.
- D. `supabase/functions/api/app.ts`'s `browserUrl` strips a trailing slash from `MEDIA_PUBLIC_ORIGIN` before concatenating.
- E. `supabase/functions/api/app.ts`'s `imageParentUrl` got a two-line comment above its `signStored` call noting the browser-URL boundary in staging.
- F. Docs updated: `CLAUDE.md` and the release runbook's §7b now say `MEDIA_PUBLIC_ORIGIN` must never be set on the hosted project; the runbook's per-family checklist gained a staging note that video posters break until `browserUrl` covers R2 URLs; the spec's §7 acceptance sentence now names `psql` as a prerequisite.
