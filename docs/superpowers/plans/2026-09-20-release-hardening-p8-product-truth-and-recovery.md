# Release Hardening P8 — Product Truth, Retry Fidelity and Account Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A retry re-runs the operation the customer actually performed, a video's first frame stays the first frame, every sentence on the pricing page is true of the code that charges them, someone who forgets their password can get back in, and the app is usable with a keyboard and a screen reader.

**Architecture:** The server stores a versioned snapshot of every normalized request — references by owned identity, masks by object path, persona and style ids as first-class fields — and serves retry and variation as explicit server operations with fresh quotes, so nothing depends on the client reconstructing a request it never fully had. Reference slots become semantically named rather than positional, and adapters omit an aspect ratio in modes where the input frame dictates shape. Sales copy is generated from the catalog and the entitlement table rather than hand-written beside it. Password recovery gets a route, a token handler and anti-enumeration responses.

**Tech Stack:** Angular 22 (standalone, signals, zoneless, OnPush), Supabase Auth, Deno Edge Functions, Postgres.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T12**, **T17** and **T18**, closing **R15**, **R23**, **R24**, **R25** and **R26**, and applying decisions **D1**, **D4** and **D5**. It depends on P2 (the D1 grant fix already landed there), P3 (normalized requests and the capability record) and P7 (the `ConfirmService` dialog primitive). It supplies DTO fields the mobile plan's **MT-03** consumes, and its recovery work pairs with **MT-06**.

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps.
- **No nested if statements.** Guard clauses and early returns only.
- **Angular components always use three files** — `.ts` + `.html` + `.css`. Never inline a template or a style. Prefer stylesheet classes over `style` attributes.
- **Standalone, signals, zoneless, `OnPush`.**
- **Preserve the current visual arrangement.** Accessibility work adds roles, labels and focus handling. It does not restyle the product.
- **Migration numbering:** P1 `0017`, P2 `0018`, P4 `0019`, P5 `0020`, P6 `0021`, P7 `0022`. This plan adds `0023`.
- **Never store a signed URL in a snapshot.** They expire in 7 days; a retry two weeks later must still work.
- **Never expose a raw provider error to a customer.** Map to a safe code and message; keep the original in the job row.
- **A control that cannot do what it says must not be shown.** Disable retry where the operation cannot be reconstructed and explain why, rather than letting it fail.
- **Anti-enumeration:** every password-recovery response is identical whether or not the address exists. Never log a recovery token.
- **Tests:** Angular → `npm test -- --watch=false`. Edge → `cd supabase/functions && deno test --allow-all _shared api job-worker cleanup-worker stripe-webhook appstore-webhook`. SQL → local stack only (`$VANSEN_LOCAL_DB`).
- **Execution baseline:** run the current focused suite after this plan's prerequisites and record actual counts; predicted totals are not acceptance criteria.

---

## The defects in one paragraph

`onRetry` (`workspace-page.ts:666-684`) sends `familyId, op, prompt, settings, batch:1, parentId` and nothing else, so an edit-tool retry omits `maskPngBase64` and fails "requires a mask", a video i2v retry omits its references and fails `bad_reference_count`, and a persona item — stored with `familyId='persona'` — fails `invalid_family` outright. `onVariation` (519-534) sends no `parentId` at all, and on an `edit-*` item it produces a 400 `invalid_op`. The server does stamp style and persona into `settings`, but `sanitizeSettings` strips them coming back in and the server only reads them from top-level fields, so they silently vanish. `toGenerationDto` has no `error` field, so after a reload a cancelled video renders as "Generation failed — Retry" instead of "Cancelled · Refunded". In the composer, `reference-drop.ts:94-103` compacts its slot array, so filling the end frame first moves it to the first-frame position and clearing the first frame promotes the last; Veo, Omni and Runway then send `aspectRatio` unconditionally even in modes where the input frame dictates shape. The pricing page says the on-device editing suite is "free and unlimited on every plan" while `PRO_TOOLS` locks twelve of those tools behind Pro, and Sora — deleted from the catalog and guarded against by a spec — is still advertised in three places. `auth-service.ts` has no `resetPasswordForEmail`, and `app.routes.ts` has no recovery route. `public/` contains no `trends/` directory, so all twelve trend thumbnails 404. `detail-overlay.html` is a bare div with no `role="dialog"`, no focus trap and no focus restore, while its six sibling dialogs all declare one; the library card is a `<figure>` with a click handler and no `tabindex`, and the variation button is an icon with no label.

---

## File Structure

**New:**
- `supabase/migrations/0023_request_snapshots.sql` — `request_snapshots`, `generations.snapshot_id`, `generations.failure_code`.
- `supabase/functions/_shared/request-snapshot.ts` + `_test.ts` — `GenerationRequestSnapshotV1`, `captureSnapshot`, `rehydrate`.
- `supabase/functions/api/services/retry.ts` + `_test.ts` — `planRetry`, `planVariation`, `RetryRefusal`.
- `supabase/functions/api/retry_routes_test.ts`.
- `src/app/core/catalog/entitlements.ts` + `.spec.ts` — one table that both the paywall and the copy read.
- `src/app/shared/a11y/focus-trap.ts` + `.spec.ts`, `src/app/shared/a11y/dialog.directive.ts`.
- `src/app/features/auth/recover-page.{ts,html,css}` + `.spec.ts`, `reset-page.{ts,html,css}` + `.spec.ts`.
- `scripts/check-assets.mjs` — deterministic missing-asset gate.

**Modified:**
- `supabase/functions/api/app.ts`, `_shared/providers/{google-video,google-omni,runway}.ts`.
- `src/app/core/api/dtos.ts`, `src/app/core/generations/generation-store.ts`.
- `src/app/features/workspace/workspace-page.ts`, `library-grid/library-grid.html`, `detail-overlay/*`.
- `src/app/features/workspace/left-panel/reference-drop/reference-drop.ts`, `left-panel/left-panel.ts`.
- `src/app/features/plans/plans-page.ts`, `src/app/features/landing/landing-page.html`, `src/app/shared/site-footer/site-footer.html`, `src/app/features/auth/login-page.html`.
- `src/app/core/auth/auth-service.ts`, `src/app/app.routes.ts`.

---

## Task 1: Request snapshots (T12 → R15, part 1)

**Files:**
- Create: `supabase/migrations/0023_request_snapshots.sql`, `supabase/functions/_shared/request-snapshot.ts` + `_test.ts`
- Modify: `supabase/functions/api/app.ts`

**Interfaces:**
- Consumes: `normalizeGenerationRequest` and `quote` from P3, `uploads` registry from P1.
- Produces:
  ```ts
  export const SNAPSHOT_VERSION = 1;
  export interface GenerationRequestSnapshotV1 {
    version: 1;
    op: GenerationOp;
    familyId: string;
    prompt: string;
    settings: GenerationSettings;
    /** Owned identities, never signed URLs — those expire in 7 days. */
    referenceUploadIds: string[];
    referenceSlots: { first: string | null; last: string | null; references: string[] };
    maskUploadId: string | null;
    personaId: string | null;
    styleId: string | null;
    trendId: string | null;
    mode: VideoMode | null;
    parentId: string | null;
    catalogVersion: string;
    quoteVersion: number;
  }
  export function captureSnapshot(input: Omit<GenerationRequestSnapshotV1, 'version'>): GenerationRequestSnapshotV1;
  export function rehydrate(snapshot: GenerationRequestSnapshotV1): RehydrateResult;
  ```

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0023_request_snapshots.sql`:

```sql
-- 0023: what the customer actually asked for.
--
-- Retry reconstructed a request from the fields the client happened to still
-- hold: familyId, op, prompt, settings, parentId. Everything else was gone.
-- A mask retry failed "requires a mask". A video i2v retry failed
-- "bad_reference_count". A persona item retried as familyId='persona' and
-- failed "invalid_family". Style and persona were stamped into settings on the
-- way out and stripped by sanitizeSettings on the way back in.
--
-- The request is now recorded once, in full, by owned identity rather than by
-- signed URL — so a retry two weeks later still resolves.
-- (written 2026-09-20; apply AFTER 0022_thumbnails.sql)

create table public.request_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  version int not null,
  body jsonb not null,
  created_at timestamptz not null default now()
);
create index request_snapshots_user_idx on public.request_snapshots (user_id, created_at desc);
alter table public.request_snapshots enable row level security;

alter table public.generations
  add column if not exists snapshot_id uuid references public.request_snapshots on delete set null;
-- failure_code/failure_message are owned and written by P4/0019, not added here.

-- Existing rows have no snapshot; retry must refuse them with an explanation
-- rather than fail at the provider. `snapshot_id is null` is that signal.
```

- [ ] **Step 2: Write the failing snapshot test**

Create `supabase/functions/_shared/request_snapshot_test.ts`:

```ts
import { assertEquals, assert } from 'jsr:@std/assert';
import { SNAPSHOT_VERSION, captureSnapshot, rehydrate } from './request-snapshot.ts';

const base = {
  op: 'generate' as const,
  familyId: 'flux',
  prompt: 'a cat',
  settings: { aspectRatio: '1:1', resolution: '1MP' },
  referenceUploadIds: [],
  referenceSlots: { first: null, last: null, references: [] },
  maskUploadId: null,
  personaId: null,
  styleId: null,
  trendId: null,
  mode: null,
  parentId: null,
  catalogVersion: 'cat-v1', quoteVersion: 1,
};

Deno.test('a snapshot carries its version', () => {
  assertEquals(captureSnapshot(base).version, SNAPSHOT_VERSION);
});

Deno.test('R15: a mask is recorded by object path, not by data URI', () => {
  const snap = captureSnapshot({ ...base, op: 'edit', familyId: 'edit-fill', maskUploadId: 'u/masks/1.png' });
  assertEquals(snap.maskUploadId, 'u/masks/1.png');
  assert(!JSON.stringify(snap).includes('data:'), 'a megabyte data URI must not live in the snapshot');
});

Deno.test('R15: references are recorded by upload id', () => {
  const snap = captureSnapshot({ ...base, referenceUploadIds: ['up-1', 'up-2'] });
  assertEquals(snap.referenceUploadIds, ['up-1', 'up-2']);
});

Deno.test('R15: NO signed url survives into a snapshot', () => {
  // Signed URLs expire in 7 days. A snapshot holding one is a retry that
  // works this week and fails next week for no visible reason.
  const snap = captureSnapshot({
    ...base,
    referenceSlots: { first: 'up-1', last: null, references: [] },
    // deno-lint-ignore no-explicit-any
    referenceUrls: ['https://x.supabase.co/object/sign/media/u/ref.png?token=abc'] as any,
  });
  const json = JSON.stringify(snap);
  assert(!json.includes('token='), json);
  assert(!json.includes('/sign/'), json);
});

Deno.test('R15: persona and style are first-class, not smuggled through settings', () => {
  const snap = captureSnapshot({ ...base, personaId: 'p-1', styleId: 'cinematic', trendId: '90s-yearbook' });
  assertEquals(snap.personaId, 'p-1');
  assertEquals(snap.styleId, 'cinematic');
  assertEquals(snap.trendId, '90s-yearbook');
});

Deno.test('R15: a persona generation records the real family, not "persona"', () => {
  // Items were stored with familyId='persona', so a retry sent that as the
  // model family and got invalid_family.
  const snap = captureSnapshot({ ...base, familyId: 'flux', personaId: 'p-1' });
  assertEquals(snap.familyId, 'flux');
  assertEquals(snap.personaId, 'p-1');
});

Deno.test('a video keyframe snapshot keeps slot ORDER', () => {
  const snap = captureSnapshot({
    ...base, familyId: 'kling', mode: 'keyframes',
    referenceUploadIds: ['first-frame', 'last-frame'],
  });
  assertEquals(snap.referenceUploadIds, ['first-frame', 'last-frame']);
});

Deno.test('rehydrate refuses a version it does not understand', () => {
  const result = rehydrate({ ...captureSnapshot(base), version: 99 } as never);
  assertEquals(result.ok, false);
  assertEquals(result.reason, 'unsupported_version');
});

Deno.test('rehydrate refuses a snapshot from a superseded catalog', () => {
  // A price or a provider model changed. Replaying the old request at the new
  // price is a surprise charge; replaying at the old price is a loss.
  const result = rehydrate({ ...captureSnapshot(base), catalogVersion: 'cat-v0' }, 'cat-v1');
  assertEquals(result.ok, false);
  assertEquals(result.reason, 'catalog_changed');
});

Deno.test('a round trip through JSON changes nothing', () => {
  const snap = captureSnapshot({ ...base, referenceUploadIds: ['a'], personaId: 'p' });
  assertEquals(JSON.parse(JSON.stringify(snap)), snap);
});
```

- [ ] **Step 3: Run to verify it fails, then write the module**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/request_snapshot_test.ts
```

Expected: FAIL — module not found. Then write `_shared/request-snapshot.ts` with `captureSnapshot` explicitly listing every field it copies (never a spread of the whole request — that is how a signed URL gets in) and `rehydrate` returning a tagged result:

```ts
export type RehydrateResult =
  | { ok: true; request: GenerationRequestSnapshotV1 }
  | { ok: false; reason: 'unsupported_version' | 'catalog_changed' | 'missing_reference' | 'missing_mask' };
```

- [ ] **Step 4: Write the snapshot on every submission**

In `0023`, replace `fn_reserve_generation` with its P5 body plus a required server-validated snapshot in `p_payload.snapshot`. Keep the same RPC signature and replay-first behavior. After replay/cap validation and BEFORE creating generation rows, insert the snapshot and capture its generated ID; then attach that ID to every returned generation in this same transaction:

```sql
insert into public.request_snapshots(user_id,version,body)
values (p_user,1,p_payload->'snapshot') returning id into v_snapshot_id;
-- After collecting the generation IDs from fn_charge_and_generate:
update public.generations set snapshot_id = v_snapshot_id
where user_id = p_user and id = any(v_generation_ids);
```

Declare `v_snapshot_id uuid` and `v_generation_ids uuid[]`. Reject missing/invalid version, quoteVersion and owned references before charging. The snapshot, charge, generation, jobs, expenses and submission result either all commit or all roll back. Never accept a client-provided snapshotId. Add `supabase/tests/request_snapshots.sql`: injected snapshot failure yields no charge/job; same-key replay adds no snapshot; batch shares one immutable snapshot. Mask objects use P1's registry with an explicit `mask` purpose added by `0023`, checked moderation/ownership and P6 cleanup registration; never persist a raw mask path or signed URL.

- [ ] **Step 5: Run the suites**

```bash
cd /Users/user/IdeaProjects/vansen && psql "$VANSEN_LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/0023_request_snapshots.sql && cd supabase/functions && deno test --allow-all _shared api
```

Expected: all green. User commits.

---

## Task 2: Server-side retry and variation (T12 → R15, part 2)

**Files:**
- Create: `supabase/functions/api/services/retry.ts` + `_test.ts`, `supabase/functions/api/retry_routes_test.ts`
- Modify: `supabase/functions/api/app.ts`, `src/app/core/api/dtos.ts`, `src/app/core/generations/generation-store.ts`, `src/app/features/workspace/workspace-page.ts`, `library-grid.html`

**Interfaces:**
- Produces:
  ```
  POST /generations/:id/retry      → { items, credits }   | 409 { code, message }
  POST /generations/:id/variation  → { items, credits }   | 409 { code, message }
  GET  /generations/:id/retryable  → { retry: boolean; variation: boolean; reason?: string }
  ```

- [ ] **Step 1: Write the failing route test**

Create `supabase/functions/api/retry_routes_test.ts`:

```ts
import { assertEquals, assert } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, fakeAdapter, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };

function seed(db: FakeDb, over: Record<string, unknown> = {}, snapshot: Record<string, unknown> = {}) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [
    { id: 'flux', enabled: true, min_plan: 'studio' },
    { id: 'edit-fill', enabled: true, min_plan: 'studio' },
    { id: 'kling', enabled: true, min_plan: 'pro' },
  ];
  db.tables.request_snapshots = [{
    id: 'snap-1', user_id: TEST_USER, version: 1,
    body: {
      version: 1, op: 'generate', familyId: 'flux', prompt: 'a cat',
      settings: { aspectRatio: '1:1' }, referenceUploadIds: [], referencePaths: [],
      maskUploadId: null, personaId: null, styleId: null, trendId: null, mode: null,
      parentId: null, catalogVersion: 'cat-v1',
      ...snapshot,
    },
  }];
  db.tables.generations = [{
    id: 'g1', user_id: TEST_USER, kind: 'image', family_id: 'flux', op: 'generate',
    prompt: 'a cat', settings: {}, price_credits: 40, status: 'failed',
    snapshot_id: 'snap-1', media_path: null, ...over,
  }];
  db.rpcHandlers.fn_reserve_generation = (args) => ({
    replay: false,
    items: (args.p_items as Record<string, unknown>[]).map((i, n) => ({
      id: `new${n}`, user_id: TEST_USER, family_id: i.familyId, op: i.op,
      prompt: i.prompt, settings: i.settings, status: 'pending', price_credits: 40,
      parent_id: i.parentId ?? null, media_path: null, kind: 'image',
      family_name: i.familyName,
    })),
    credits: { plan: 1000, pack: 0 },
  });
}

Deno.test('R15: retrying a failed image re-runs the same request', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db);
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 200);
  const call = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!;
  const item = (call.args.p_items as Record<string, unknown>[])[0];
  assertEquals(item.prompt, 'a cat');
  assertEquals(item.familyId, 'flux');
});

Deno.test('R15: retrying an edit carries the MASK', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { family_id: 'edit-fill', op: 'edit' }, {
    op: 'edit', familyId: 'edit-fill', maskUploadId: 'u/masks/1.png',
    referenceUploadIds: ['up-1'],
  });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 200, await res.text());
  const item = (db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_items as Record<string, unknown>[])[0];
  const payload = item.payload as Record<string, unknown>;
  assert(payload.maskPngBase64 || payload.maskUploadId, 'the mask must be restored');
});

Deno.test('R15: retrying a video i2v carries its REFERENCES', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  db.tables.uploads = [
    { id: 'up-1', user_id: TEST_USER, path: 'u/ref1.png', mime: 'image/png', purpose: 'reference', bytes: 100, width: 1, height: 1, moderation: 'allowed' },
  ];
  seed(db, { family_id: 'kling', kind: 'video' }, {
    familyId: 'kling', mode: 'i2v', referenceUploadIds: ['up-1'],
  });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 200, await res.text());
});

Deno.test('R15: retrying a persona generation keeps the persona and the real family', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  db.tables.personas = [{ id: 'p-1', user_id: TEST_USER, status: 'ready', lora_url: 'https://x/l.safetensors' }];
  seed(db, { family_id: 'persona' }, { familyId: 'flux', personaId: 'p-1' });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 200, await res.text());
  const item = (db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_items as Record<string, unknown>[])[0];
  assertEquals(item.familyId, 'flux', 'never re-send the pseudo-family "persona"');
});

Deno.test('R15: a retry gets a FRESH quote, not the old price', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { price_credits: 9999 });
  const app = createApp(deps);
  await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });
  const item = (db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_items as Record<string, unknown>[])[0];
  assert(item.priceCredits !== 9999, 'the price must be re-quoted from the catalog');
});

Deno.test('R15: a retry is a NEW idempotent submission, not a replay of the old one', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db);
  const app = createApp(deps);
  await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });
  const key = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!.args.p_key;
  assert(key, 'a retry still gets its own idempotency key');
});

Deno.test('R15: a generation with no snapshot refuses with an explanation', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { snapshot_id: null });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 409);
  const err = (await res.json()).error;
  assertEquals(err.code, 'not_retryable');
  assert(err.message.length > 10, 'tell the customer why, do not just fail');
});

Deno.test('R15: a retry whose reference was deleted refuses instead of failing at the provider', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  db.tables.uploads = [];
  seed(db, { family_id: 'kling', kind: 'video' }, {
    familyId: 'kling', mode: 'i2v', referenceUploadIds: ['gone'],
  });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'reference_unavailable');
});

Deno.test('R15: a variation carries parentId', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { status: 'done' });
  const app = createApp(deps);

  await app.request('/api/generations/g1/variation', { method: 'POST', headers: AUTH });

  const item = (db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_items as Record<string, unknown>[])[0];
  assertEquals(item.parentId, 'g1', 'a variation without a parent breaks the version chain');
});

Deno.test('R15: variation of an edit item refuses rather than producing invalid_op', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { family_id: 'edit-fill', op: 'edit', status: 'done' }, { op: 'edit', familyId: 'edit-fill' });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/variation', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 409);
  assertEquals((await res.json()).error.code, 'not_variable');
});

Deno.test('R15: the retryable probe tells the client what to enable', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { family_id: 'edit-fill', op: 'edit', status: 'failed' }, { op: 'edit', familyId: 'edit-fill', maskUploadId: 'u/m.png' });
  const app = createApp(deps);
  const body = await (await app.request('/api/generations/g1/retryable', { headers: AUTH })).json();
  assertEquals(body.retry, true);
  assertEquals(body.variation, false);
});

Deno.test('R15: a stranger cannot retry someone else\'s generation', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  seed(db, { user_id: 'someone-else' });
  const app = createApp(deps);
  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });
  assertEquals(res.status, 404);
});
```

- [ ] **Step 1a: Complete operation-specific retry/variation coverage**

Extend the existing `seed` fixture with complete P1 upload rows, and test successful retries for upscale, persona, image-reference, mask-edit, i2v, keyframes and parent-video extend/edit. Assert reserved payload preserves each input and uses current quote; no direct provider call is expected after P5. Test persona and i2v variation refusals:

```ts
for (const snapshot of [{ personaId: 'p1' }, { familyId: 'kling', mode: 'i2v' }]) {
  Deno.test('variation refuses unsupported context ' + JSON.stringify(snapshot), async () => {
    const deps = testDeps();
    const db = deps.admin as unknown as FakeDb;
    seed(db, { status: 'done' }, snapshot);
    const res = await createApp(deps).request('/api/generations/g1/variation', {
      method: 'POST', headers: AUTH,
    });
    assertEquals(res.status, 409);
    assertEquals((await res.json()).error.code, 'not_variable');
    assertEquals(db.rpcCalls.filter((r) => r.name === 'fn_reserve_generation').length, 0);
  });
}
```

- [ ] **Step 2: Run to verify it fails, then write `services/retry.ts`**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/retry_routes_test.ts
```

Expected: FAIL — the routes do not exist.

```ts
// Retry and variation as server operations.
//
// The client used to rebuild the request from what it still had in memory,
// which was never the whole request. The server holds the snapshot, so it
// rebuilds it — and where it genuinely cannot, it says so with a code the UI
// can render instead of letting the provider reject it.
export type RetryRefusal =
  | 'not_retryable'          // no snapshot (pre-0023 row)
  | 'not_variable'           // the op has no meaningful variation
  | 'reference_unavailable'  // an upload or mask was deleted
  | 'family_disabled'        // kill switch is off for this family
  | 'catalog_changed'        // price or provider model moved
  | 'plan_required';         // entitlement lapsed since the original run

export const REFUSAL_MESSAGE: Record<RetryRefusal, string> = {
  not_retryable: 'This item was made before retry could capture what you asked for. Run it again from the composer.',
  not_variable: 'Variations only apply to generated images. Re-run this edit from the canvas instead.',
  reference_unavailable: 'The reference image this used is no longer available.',
  family_disabled: 'That model is temporarily unavailable.',
  catalog_changed: 'This model has changed since that run. Start a new one to see the current price.',
  plan_required: 'Your plan no longer includes this model.',
};
```

`planRetry` rehydrates, resolves every upload id to a live object path, re-quotes through P3's `quote()`, and returns either a submission or a refusal. `planVariation` does the same but forces `op='generate'`, sets `parentId`, and refuses edit/upscale, persona and all video/i2v/keyframe/parent-video sources with `not_variable`. Retry retains those operations, including their masks/personas/ordered slots/parent-video context, and requires a newly accepted quote when pricing changed.

- [ ] **Step 3: Add the safe failure code to the DTO**

In `_shared` and `dtos.ts`:

```ts
export interface GenerationDto {
  // ...
  /** A safe, stable reason the client can render. The raw provider text stays
   * in jobs.error and never reaches a customer. */
  failure?: {
    code: 'cancelled' | 'moderation' | 'provider_error' | 'timeout' | 'store_failed' | 'generation_failed';
    message: string;
    cancelled: boolean;
  };
}
```

`toGenerationDto` maps P4's persisted failure_code/failure_message to the nested `failure` object and sets cancelled only when code is cancelled. Modify `src/app/core/generations/generation-store.ts` so job polling and list reload preserve it, and `src/app/features/workspace/library-grid/library-grid.html` so cancelled and failed render separately. Add a reload test after real cancellation: status failed + failure.cancelled=true remains “Cancelled · Refunded”, while provider failure stays “Generation failed”. Raw provider text never reaches this DTO. P4's `fn_settle_job` writes both columns. A cancelled video then renders as "Cancelled · Refunded" after a reload, because the state lives on the server rather than in a client-side patch that a reload discards.

- [ ] **Step 4: Point the client at the new routes**

In `GenerationStore`:

```ts
  /** The server rebuilds the request from its snapshot; the client no longer
   * guesses at fields it never had. */
  async retry(id: string): Promise<GenerationDto[]> {
    const response = await this.api.post<CreateGenerationResponse>(
      `/generations/${id}/retry`, {}, { idempotencyKey: crypto.randomUUID() },
    );
    this.itemsSig.update((list) => [...response.items, ...list]);
    this.ledger.setCredits(response.credits);
    return response.items;
  }
```

Delete the body of `onRetry` and `onVariation` in `workspace-page.ts` and have them call these. Render a 409's message as a notification rather than a generic failure.

- [ ] **Step 5: Disable controls that cannot work**

Fetch `retryable` when the detail overlay opens, and drive the buttons from it:

```html
<button
  type="button"
  class="action-btn"
  [disabled]="!retryable().retry"
  [attr.aria-label]="retryable().retry ? 'Retry this generation' : retryable().reason"
  [title]="retryable().reason ?? 'Retry'"
  (click)="retry()"
>
```

A disabled button with a reason is honest. A button that always fails is not.

- [ ] **Step 6: Run both suites**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all _shared api
```

Expected: all green. User commits.

---

## Task 3: Semantic reference slots and aspect omission (T12 → R25)

**Files:**
- Modify: `src/app/features/workspace/left-panel/reference-drop/reference-drop.ts` + `.html` + `.spec.ts`, `left-panel/left-panel.ts`, `supabase/functions/_shared/providers/{google-video,google-omni,runway}.ts`

- [ ] **Step 1: Write the failing slot spec**

Append to `src/app/features/workspace/left-panel/reference-drop/reference-drop.spec.ts`:

```ts
function slot(path: string): RefSlot { return { path, url: 'blob:test' }; }
function makeHost({ mode }: { mode: VideoMode }) {
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { postForm: vi.fn() } }] });
  const fixture = TestBed.createComponent(ReferenceDrop);
  let latest: (RefSlot | null)[] = mode === 'keyframes' ? [null, null] : [];
  fixture.componentRef.setInput('mode', mode);
  fixture.componentRef.setInput('slots', latest);
  fixture.componentInstance.slotsChanged.subscribe((slots) => {
    latest = slots;
    fixture.componentRef.setInput('slots', slots);
    fixture.detectChanges();
  });
  fixture.detectChanges();
  const component = fixture.componentInstance;
  return {
    place: (index: number, value: RefSlot) => component.place(index, value),
    clear: (index: number) => component.clear(index),
    complete: () => component.complete(),
    serialize: () => component.serialize(),
    emitted: () => latest,
  };
}

describe('R25: slots keep their meaning', () => {
  it('filling the END frame first leaves the first frame empty', () => {
    const host = makeHost({ mode: 'keyframes' });
    host.place(1, slot('last.png'));
    expect(host.emitted()[0]).toBeNull();
    expect(host.emitted()[1]?.path).toBe('last.png');
  });

  it('clearing the first frame does NOT promote the last frame', () => {
    const host = makeHost({ mode: 'keyframes' });
    host.place(0, slot('first.png'));
    host.place(1, slot('last.png'));
    host.clear(0);
    expect(host.emitted()[0]).toBeNull();
    expect(host.emitted()[1]?.path).toBe('last.png');
  });

  it('replacing the last frame leaves the first alone', () => {
    const host = makeHost({ mode: 'keyframes' });
    host.place(0, slot('first.png'));
    host.place(1, slot('last.png'));
    host.place(1, slot('other.png'));
    expect(host.emitted()[0]?.path).toBe('first.png');
    expect(host.emitted()[1]?.path).toBe('other.png');
  });

  it('two uploads resolving out of order keep their slots', () => {
    const host = makeHost({ mode: 'keyframes' });
    // The second drop finishes uploading first.
    host.place(1, slot('last.png'));
    host.place(0, slot('first.png'));
    expect(host.emitted()[0]?.path).toBe('first.png');
    expect(host.emitted()[1]?.path).toBe('last.png');
  });

  it('keyframes mode with only the last frame filled is INCOMPLETE', () => {
    const host = makeHost({ mode: 'keyframes' });
    host.place(1, slot('last.png'));
    expect(host.complete()).toBe(false);
  });

  it('i2v needs exactly one reference', () => {
    const host = makeHost({ mode: 'i2v' });
    expect(host.complete()).toBe(false);
    host.place(0, slot('a.png'));
    expect(host.complete()).toBe(true);
  });

  it('serialization drops nulls only at the very end', () => {
    // The provider order is positional: refs[0] is the first frame,
    // refs[1] the last. A sparse array must be refused, never compacted.
    const host = makeHost({ mode: 'keyframes' });
    host.place(1, slot('last.png'));
    expect(() => host.serialize()).toThrow(/incomplete/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then fix the component**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/features/workspace/left-panel/reference-drop/reference-drop.spec.ts
```

Expected: FAIL — `place` and `clear` compact the array.

```ts
  /** Slots are positions, not a list. keyframes = [first, last] on every
   * adapter, so compacting the array silently promoted the end frame to the
   * start — the video then began where it was meant to end. */
  place(index: number, slot: RefSlot): void {
    const next = [...this.slots()];
    next[index] = slot;
    this.slotsChanged.emit(next);          // nulls preserved
  }

  clear(index: number): void {
    const next = [...this.slots()];
    next[index] = null;
    this.slotsChanged.emit(next);
  }

  /** Every required position for this mode is filled. */
  complete(): boolean {
    const rule = referenceRule(this.mode());
    const slots = this.slots();
    if (slots.length < rule.min || slots.length > rule.max) return false;
    return Array.from({ length: slots.length }, (_, i) => slots[i] != null).every(Boolean);
  }

  /** The provider array, in provider order. A sparse array is a bug, not a
   * shorter list. */
  serialize(): string[] {
    if (!this.complete()) throw new Error('reference slots incomplete');
    return this.slots().map((slot) => slot!.path);
  }
```

Change `ReferenceDrop.slots` and `slotsChanged` to `(RefSlot | null)[]` inputs/outputs, initialize keyframe slots as `[null,null]` in the parent, and import `RefSlot`, `VideoMode`, TestBed, vi and ApiService in the tests. Preserve actual `slotsChanged` output and `slots` input names.

Update `left-panel.ts:455` (`refSlots().map(s => s.path)`) to call `serialize()`, and gate the Generate button on `complete()`.

- [ ] **Step 3: Write the failing adapter tests**

Create `supabase/functions/_shared/providers/aspect_omission_test.ts`:

```ts
import { assert, assertEquals } from 'jsr:@std/assert';
import { captureFetch } from './testing/capture.ts';
import { googleVideoAdapter } from './google-video.ts';
import { googleOmniAdapter } from './google-omni.ts';
import { runwayAdapter } from './runway.ts';
import { falAdapter } from './fal.ts';
import { familyById } from '../model-families.ts';

const ADAPTERS = [
  { name: 'veo', adapter: googleVideoAdapter },
  { name: 'omni', adapter: googleOmniAdapter },
  { name: 'runway', adapter: runwayAdapter },
  { name: 'kling', adapter: falAdapter },
  { name: 'seedance', adapter: falAdapter },
];
for (const key of ['GOOGLE_AI_API_KEY','RUNWAY_API_KEY','FAL_API_KEY']) Deno.env.set(key,'test-key');
for (const { name, adapter } of ADAPTERS) {
  const modes = familyById(name)!.capabilities.modes ?? [];
  for (const mode of modes.filter((m) => ['t2v','i2v','keyframes'].includes(m))) {
    Deno.test(`R25: ${name} aspect contract for ${mode}`, async () => {
      const capture = captureFetch((call) => {
        if (call.method !== 'POST') return new Response(new Uint8Array([1,2,3]), {headers:{'content-type':'image/png'}});
        return new Response(JSON.stringify({
          name:'operations/test', id:'task-test',
          status_url:'https://queue.fal.run/fal-ai/test/requests/one/status',
          response_url:'https://queue.fal.run/fal-ai/test/requests/one',
        }), {status:200,headers:{'content-type':'application/json'}});
      });
      try {
        await adapter.submit({
          familyId:name, op:'generate', prompt:'a cat', mode,
          settings:{aspectRatio:'16:9',resolution:'720p',durationS:5},
          referenceUrls:mode === 'keyframes' ? ['https://x/first.png','https://x/last.png'] : ['https://x/first.png'],
          safetyId:'sha',
        });
        const sent = capture.calls.find((call) => call.method === 'POST' && call.jsonBody);
        assert(sent?.jsonBody, 'adapter must send a provider request');
        const body = JSON.stringify(sent.jsonBody);
        const hasAspect = /"(aspectRatio|aspect_ratio|ratio)"/.test(body);
        assertEquals(hasAspect, mode === 't2v', name + '/' + mode);
      } finally { capture.restore(); }
    });
  }
}
```

- [ ] **Step 4: Run to verify it fails, then fix the four adapters covering five families**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/aspect_omission_test.ts
```

Expected: existing correct fal cases stay GREEN; the currently leaking Google/Runway frame-mode cases are RED. Unsupported modes are excluded using the catalog, not submitted and swallowed as a false pass.

In each of `google-video.ts:47`, `google-omni.ts:33` and `runway.ts:49`, replace the unconditional field with a capability-driven one:

```ts
// The frame decides the shape in these modes; the composer hides the control
// (left-panel.ts:263-266) but the value was still being transmitted.
const FRAME_DRIVEN_MODES = new Set(['i2v', 'keyframes']);

const payload = {
  prompt,
  ...(FRAME_DRIVEN_MODES.has(ctx.mode ?? 't2v') ? {} : { aspectRatio }),
  // ...
};
```

Put `FRAME_DRIVEN_MODES` in `_shared/video-rules.ts` so all five families read one definition.

- [ ] **Step 5: Record decision D5 in the composer**

`vansen.md` records the "From library" picker as deliberately cut. Say so where a customer would look for it:

```html
<p class="hint">Upload an image to use as a reference. Picking from your library is coming later.</p>
```

- [ ] **Step 6: Run both suites**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && cd supabase/functions && deno test --allow-all _shared
```

Expected: all green. User commits.

---

## Task 4: Make every sales surface match entitlements (D1, D4)

**Files:** Create `src/app/core/catalog/entitlements.ts` and `.spec.ts`, `public-capabilities.ts` and `.spec.ts`; modify `features/studio/right-panel/right-panel.{ts,html}`, `features/plans/plans-page.{ts,html}`, `features/landing/landing-page.{ts,html}`, `shared/site-footer/site-footer.{ts,html}`, `features/auth/login-page.html`, `supabase/functions/api/app.ts` and public route tests.

- [ ] **Step 1: Extract the ACTUAL tool definitions and write exhaustive tests**

Move current `LOCAL_TOOLS` and `PRO_TOOLS` with labels/icons unchanged into the catalog module. Do not import unexported UI constants or invent `STUDIO_TOOLS`. Include `mask` as a contextual tool even though it has no standalone panel button. Use `StudioTool` for exhaustiveness:

```ts
import type { StudioTool } from '../../features/studio/studio-tool';
export type ToolPlan = 'studio' | 'pro';
export const ENTITLEMENTS = {
  crop: 'studio', adjust: 'studio', filters: 'studio', sharpen: 'studio',
  smooth: 'studio', heal: 'studio', dehaze: 'studio', portraitsmooth: 'studio',
  mask: 'studio',
  select: 'pro', upscale: 'pro', aisharpen: 'pro', bgremove: 'pro',
  bokeh: 'pro', enhance: 'pro', levels: 'pro', clone: 'pro', retouch: 'pro',
  perspective: 'pro', liquify: 'pro', erase: 'pro',
} as const satisfies Record<StudioTool, ToolPlan>;
export const requiredPlanFor = (id: StudioTool): ToolPlan => ENTITLEMENTS[id];
export const toolsFor = (plan: ToolPlan): StudioTool[] =>
  (Object.keys(ENTITLEMENTS) as StudioTool[]).filter((id) => ENTITLEMENTS[id] === plan);
export const toolLabels = (ids: StudioTool[]): string[] =>
  ids.map((id) => [...LOCAL_TOOLS, ...PRO_TOOLS].find((t) => t.id === id)?.label ?? 'Mask');
```

```ts
it('panel paywalls agree with the same entitlement table as pricing', () => {
  expect(PRO_TOOLS.map((t) => t.id).sort()).toEqual(toolsFor('pro').sort());
  expect([...LOCAL_TOOLS.map((t) => t.id), 'mask'].sort()).toEqual(toolsFor('studio').sort());
  expect(requiredPlanFor('adjust')).toBe('studio');
  expect(requiredPlanFor('bgremove')).toBe('pro');
});
```

These tiers preserve current gating; changing the product entitlement is a separate decision. Pro's copy includes Studio plus Pro tools, whereas toolsFor('pro') returns only the additional tier.

- [ ] **Step 2: Supply public capability data without authentication**

Create `PublicCapabilities` with `enabledFamilyIds:string[]`, `backgroundCompletion:boolean`, `completionNotifications:boolean`, `catalogVersion:string`. Add public read-only `GET /capabilities` before the auth middleware, exposing only this whitelist (no secrets/entitlements/user data). It reads server-owned release flags. The Angular service loads anonymously, validates known family IDs and defaults all unverified promises off on error. Public pricing/landing/footer/login can use it without sign-in. P9 enables flags only after evidence passes; P5 pending-video copy consumes the same service.

- [ ] **Step 3: Render all tool/model/promo lists from shared truth**

Replace lists in pricing, landing, footer, login AND right-panel `PLAN_PITCH`. Use catalog IDs and labels directly, without undefined familyByName/toolByLabel helpers. Never advertise Sora or disabled families. Render full D1 grants from PLAN_CREDITS and prices from the catalog. Explain “same credits per job; lower dollar cost per credit on Pro”; calculate any percentage from the actual prices/grants rather than hardcoding a conflicting 20% claim. Public-page tests render every surface with logged-out, enabled, disabled and unavailable capability responses.

```ts
const studioCost = PLAN_PRICE_USD.studio / PLAN_CREDITS.studio;
const proCost = PLAN_PRICE_USD.pro / PLAN_CREDITS.pro;
const savingPercent = Math.round((1 - proCost / studioCost) * 100);
```

For both plans assert rendered launch grants match P2's full-grant discounted invoice behavior. Search `src/app` for old Sora, unlimited-suite and 20%-lower literals and update each affected surface, including landing and in-app pitch.

- [ ] **Step 4: Record D4 before locale-dependent release work**

Record the user's English-only versus funded en/ms launch decision in `docs/superpowers/specs/2026-09-20-launch-locales.md`. English-only updates vansen.md/listings honestly. Funded localization requires a separate explicit scope for extraction, preference, formatting and truncation tests. This existing product decision remains unresolved until chosen; don't infer it from this audit repair.

- [ ] **Step 5: Verify**

Run `npm test -- --watch=false`, focused Deno public-capability tests and production build. Compare anonymous public pages and signed-in paywalls at desktop/mobile widths. Preserve established visual composition. User commits.

---

## Task 5: Accessibility and missing assets (T17 → R26)

**Files:**
- Create: `src/app/shared/a11y/focus-trap.ts` + `.spec.ts`, `src/app/shared/a11y/dialog.directive.ts`, `scripts/check-assets.mjs`
- Modify: `detail-overlay.{ts,html}`, `library-grid.html` + `.ts`

- [ ] **Step 1: Write the failing overlay spec**

Append to `src/app/features/workspace/detail-overlay/detail-overlay.spec.ts`:

```ts
describe('R26: the detail overlay is a real dialog', () => {
  it('declares a dialog role and is modal', () => {
    const el = fixture.nativeElement.querySelector('.panel');
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
  });

  it('is labelled by its own content, not by nothing', () => {
    const el = fixture.nativeElement.querySelector('.panel');
    const labelledBy = el.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(fixture.nativeElement.querySelector(`#${labelledBy}`)).toBeTruthy();
  });

  it('moves focus into the dialog when it opens', () => {
    expect(fixture.nativeElement.contains(document.activeElement)).toBe(true);
  });

  it('keeps Tab inside the dialog', () => {
    const focusables = fixture.nativeElement.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusables[focusables.length - 1] as HTMLElement).focus();
    fixture.nativeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(fixture.nativeElement.contains(document.activeElement)).toBe(true);
  });

  it('restores focus to the opener on close', () => {
    // Otherwise a keyboard user is dropped at the top of the document and has
    // to tab all the way back to where they were.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    component.open();
    component.close();
    expect(document.activeElement).toBe(opener);
  });

  it('Escape closes it', () => {
    const spy = vi.fn();
    component.closed.subscribe(spy);
    fixture.nativeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails, then build the primitive**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/features/workspace/detail-overlay/detail-overlay.spec.ts
```

Expected: FAIL — `role` is null.

Write `src/app/shared/a11y/focus-trap.ts` (a pure function over an element, unit-testable without a component) and `dialog.directive.ts` applying `role`, `aria-modal`, `aria-labelledby`, the trap, Escape and focus restore. Six sibling dialogs already declare `role="dialog" aria-modal="true"` by hand — migrate them to the directive too, so there is one implementation rather than seven.

```bash
cd /Users/user/IdeaProjects/vansen && grep -rln 'role="dialog"' src/app
```

Each file in that list adopts the directive.

- [ ] **Step 3: Make library cards keyboard-operable**

`library-grid.html:63-67` is a `<figure>` with `(click)` and no `tabindex`, `role` or keydown, so a keyboard user cannot open any item.

```html
<figure
  class="gen-card"
  role="button"
  tabindex="0"
  [attr.aria-label]="cardLabel(item)"
  [class.card-selected]="selectMode() && isSelected(item.id)"
  (click)="onCardClick(item)"
  (keydown.enter)="onCardClick(item)"
  (keydown.space)="$event.preventDefault(); onCardClick(item)"
>
```

```ts
  /** A screen reader reads this instead of "image". The prompt is the only
   * thing that distinguishes one tile from the next. */
  cardLabel(item: GenerationDto): string {
    const kind = item.kind === 'video' ? 'Video' : 'Image';
    const status = item.status === 'done' ? '' : `, ${item.status}`;
    return `${kind}: ${item.prompt.slice(0, 80)}${status}`;
  }
```

And the variation button at `library-grid.html:173-179`, whose Download, Delete and Edit siblings all have labels:

```html
<button type="button" class="card-action" aria-label="Make a variation" (click)="variation.emit(item)">
```

Add a spec that scans the rendered grid and fails on any interactive element with no accessible name:

```ts
it('R26: every interactive element in the grid has an accessible name', () => {
  const nodes = fixture.nativeElement.querySelectorAll('button, [role="button"]');
  for (const node of nodes) {
    const name = node.getAttribute('aria-label') || node.textContent?.trim();
    expect(name, node.outerHTML.slice(0, 120)).toBeTruthy();
  }
});
```

- [ ] **Step 4: Announce async state changes**

A generation finishing changes the grid with no announcement. Add a polite live region in the workspace template:

```html
<p class="sr-only" role="status" aria-live="polite">{{ liveMessage() }}</p>
```

`liveMessage()` reports completions, failures and refunds in plain words. Style `.sr-only` in the component stylesheet, never with an inline style.

- [ ] **Step 5: Fix the trend assets**

All twelve trend presets bind `/trends/${id}.webp` and `public/` has no `trends/` directory, so every thumbnail 404s and the gallery renders as broken images.

```bash
cd /Users/user/IdeaProjects/vansen && ls public/ && grep -c "^  t(" src/app/core/catalog/trend-presets.ts
```

Expected: `logos styles favicon.ico` and `12`.

`vansen.md` already records `scripts/gen-trend-thumbs.mjs` at roughly $0.50 of OpenAI spend as the intended source. Two paths, and the user decides:

- **Generate the twelve thumbnails** with that script, review each one, and commit them to `public/trends/`. The images are our own outputs, so there is no licensing question.
- **Hide the gallery** behind a capability flag until the assets exist, so nothing broken ships.

Either way, add the deterministic gate `scripts/check-assets.mjs`:

```js
#!/usr/bin/env node
// Every asset path referenced by the catalog must exist on disk. A 404'd
// thumbnail is invisible in a unit test and obvious to a customer.
import { existsSync } from 'node:fs';
import { TREND_PRESETS } from '../src/app/core/catalog/trend-presets.ts';

const missing = TREND_PRESETS
  .map((p) => ({ id: p.id, file: `public${p.thumb}` }))
  .filter((p) => !existsSync(p.file));

for (const m of missing) console.error(`MISSING ${m.file} (trend ${m.id})`);
console.log(`${TREND_PRESETS.length - missing.length}/${TREND_PRESETS.length} trend assets present`);
process.exit(missing.length ? 1 : 0);
```

Add a visual fallback regardless, so a missing asset degrades to a labelled tile rather than a broken-image icon:

```html
<img [src]="preset.thumb" [alt]="preset.name" (error)="markMissing(preset.id)" />
@if (missing().has(preset.id)) {
  <span class="trend-fallback">{{ preset.name }}</span>
}
```

P9 wires `check-assets.mjs` into CI.

- [ ] **Step 6: Run everything and build**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && node scripts/check-assets.mjs; export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build 2>&1 | tail -10
```

Expected: specs green, the asset check reporting honestly, build succeeds. User commits.

---

## Task 6: Password recovery and confirmation resend

**Files:** Create `src/app/features/auth/recover-page.{ts,html,css}`, `reset-page.{ts,html,css}`, `confirm-page.{ts,html,css}` and each page's `.spec.ts`; modify `core/auth/auth-service.ts`, `auth-service.spec.ts`, `app.routes.ts`, `login-page.html`. Document exact Supabase email/redirect/rate-limit configuration in the P9 runbook.

**Interfaces:**
- `requestPasswordReset(email):Promise<void>`, `resendConfirmation(email):Promise<void>`: same generic success for known/unknown addresses.
- `completePasswordReset(password):Promise<void>`: requires a validated PASSWORD_RECOVERY flow for the intended identity, not merely any signed-in session.
- Public routes `/recover`, `/reset`, `/confirm`; login links both “Forgot password?” and “Resend confirmation”.
- Recovery page methods `email.set(value)`, `submit():Promise<void>`, `pending()`, `sent()`; reset exposes `password.set(value)`, `submit()`, `error()`; confirmation page follows the recovery form contract.

- [ ] **Step 1: Add service tests through the existing P7 auth mock seam**

Use TestBed.inject(AuthService) in each test and add spies to the same mocked Supabase auth object from P7; do not reference undeclared `service/mockAuth`. Test resetPasswordForEmail receives the fixed allowed `/reset` origin, resend receives `{type:'signup',email,options:{emailRedirectTo:...}}`, and known/unknown/rate-limited requests show the same safe response. Network/configuration failures use a generic retry state and never echo vendor token text. No recovery token/code goes to logs, analytics or persistence.

Test completion with no session, ordinary signed-in session without recovery intent, valid PASSWORD_RECOVERY event, expiry, used code, and A signed in while opening B's recovery link. Only the validated recovery identity can update the password; P7 invalidates A's user state first.

- [ ] **Step 2: Implement the auth methods and restricted recovery state**

Use Supabase's supported recovery callback/PKCE flow for the installed client. Parse/exchange the recovery code through that API, wait for verification, then clear sensitive URL parameters with replaceState. Track a short-lived recovery state scoped to the verified user/session and invalidate it on success, expiry, sign-out, navigation cancellation or another identity. A normal getSession result cannot create recovery permission.

```ts
async completePasswordReset(password: string): Promise<void> {
  const recovery = this.recoveryState();
  if (!recovery || recovery.expiresAt <= Date.now()) throw new Error('That reset link has expired. Request a new one.');
  const { data, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || data.session?.user.id !== recovery.userId) throw new Error('Open a valid reset link to continue.');
  if (password.length < 8) throw new Error('Use at least 8 characters.');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new Error('The password could not be updated. Request a fresh link and try again.');
  this.recoveryState.set(null);
}
```

Define `recoveryState` as a signal of `{userId:string;expiresAt:number}|null`, initialized only by the verified callback. Use a configured public origin allowlist for redirects, not arbitrary query parameters or an unvalidated return URL. No backend reset endpoint is needed when calling Supabase Auth directly; its server enforces the email rate limit.

- [ ] **Step 3: Write executable page tests before building each page**

Create standalone TestBed fixtures with stubbed AuthService methods and Router. This pattern supplies all helpers explicitly:

```ts
it('recover shows generic confirmation and prevents duplicate submission', async () => {
  let finish!: () => void;
  const auth = { requestPasswordReset: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) };
  TestBed.configureTestingModule({ providers: [
    { provide: AuthService, useValue: auth }, provideRouter([]),
  ] });
  const fixture = TestBed.createComponent(RecoverPage);
  const page = fixture.componentInstance;
  page.email.set('person@example.com');
  const pending = page.submit();
  expect(page.pending()).toBe(true);
  await page.submit();
  expect(auth.requestPasswordReset).toHaveBeenCalledTimes(1);
  finish();
  await pending;
  fixture.detectChanges();
  expect(page.sent()).toBe(true);
  expect(fixture.nativeElement.textContent).toContain('If an account exists');
});
```

Import TestBed, vi/expect/it, AuthService, RecoverPage and provideRouter in that file. Duplicate this explicit fixture setup for ConfirmPage with resendConfirmation. ResetPage tests stub completePasswordReset: reject short password without calling it, display safe expired-link error, successful update navigates to the app, rejected update remains retryable. Add DOM assertions for input labels, busy disable, generic confirmation and request-another-link controls.

- [ ] **Step 4: Implement and route all three pages**

Each component is standalone/signals/OnPush with separate HTML/CSS, labels and live-region feedback. submit uses guard clauses for pending/cooldown/invalid input, awaits its auth method in try/finally and always clears pending. Local cooldown is convenience; do not present it as a server-side abuse limit. Reset does not route to the app until password update succeeds; back/cancel invalidates recovery state.

Configure exact local/staging/production callback URLs, email templates, sender and Supabase server-side recovery/resend rate limits. Test direct API rapid repeats to prove bypassing the UI still meets the configured limit. Keep secrets/tokenized URLs out of evidence.

- [ ] **Step 5: Verify real recovery links and account transitions**

Record in `docs/superpowers/plans/2026-09-20-recovery-verification-log.md`: valid same-device link, expired/reused link, different browser/device, unknown address, rapid repeats bypassing local cooldown, confirmation resend/resumption, signed-in A opening B's link, and cancel/back navigation. A reused link never changes the password; an already successful reset's old password must no longer work. Local mailbox tests precede real staging delivery in P9.

- [ ] **Step 6: Verify GREEN**

```bash
npm test -- --watch=false
npx ng build
```

Run focused auth/page tests first, then the suite. Complete staging delivery, redirect and rate-limit proof in P9 before release. User commits.

---

## Exit criteria for P8

- [ ] Retry works for every exposed operation: image, edit with a mask, upscale, video i2v and keyframes, and persona. Each re-runs the same intended inputs with a new submission identity and a fresh quote.
- [ ] Variation carries `parentId` and refuses, with an explanation, where it cannot mean what the control says.
- [ ] A generation with no snapshot, or whose reference was deleted, refuses with a message a customer can act on rather than failing at the provider.
- [ ] A cancelled video still reads "Cancelled · Refunded" after a reload.
- [ ] No raw provider error text reaches a customer.
- [ ] Filling the end frame first, clearing the first frame, replacing the last, and two uploads resolving out of order all keep their slot roles.
- [ ] No family sends an aspect ratio in `i2v` or `keyframes`, proven by an adapter test across all five video families.
- [ ] Public pricing, the landing page, the footer, the login page, the in-app pitch and the actual entitlement table agree, enforced by a spec rather than a grep.
- [ ] No copy advertises Sora or any model absent from the enabled catalog.
- [ ] The advertised promotional grant equals what `cycleGrant` actually grants for both tiers.
- [ ] The launch locale decision is recorded and `vansen.md` matches it.
- [ ] Every dialog declares a role, traps focus and restores it; library cards open from the keyboard; every interactive element has an accessible name.
- [ ] `scripts/check-assets.mjs` exits zero, or the trend gallery is hidden behind a flag.
- [ ] A customer who forgets their password can recover it, and the reset form reveals nothing about which addresses have accounts.

**Known carry-forward:** CI, the deployment manifest, telemetry, staged rollout and the production runs of the thumbnail backfill and the trend-thumbnail generator are P9. If the user chose to fund Malay localization at Task 4 Step 7, that becomes its own plan.
