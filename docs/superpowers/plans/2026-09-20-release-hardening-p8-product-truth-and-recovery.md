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
- **Baseline after P7:** record the exact vitest and deno counts before starting.

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
    referencePaths: string[];
    maskPath: string | null;
    personaId: string | null;
    styleId: string | null;
    trendId: string | null;
    mode: VideoMode | null;
    parentId: string | null;
    catalogVersion: string;
  }
  export function captureSnapshot(input: NormalizedRequest): GenerationRequestSnapshotV1;
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
  add column if not exists snapshot_id uuid references public.request_snapshots on delete set null,
  -- A safe, stable code the client can render. jobs.error keeps the raw
  -- provider text, which must never reach a customer.
  add column if not exists failure_code text;

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
  referencePaths: [],
  maskPath: null,
  personaId: null,
  styleId: null,
  trendId: null,
  mode: null,
  parentId: null,
  catalogVersion: 'cat-v1',
};

Deno.test('a snapshot carries its version', () => {
  assertEquals(captureSnapshot(base).version, SNAPSHOT_VERSION);
});

Deno.test('R15: a mask is recorded by object path, not by data URI', () => {
  const snap = captureSnapshot({ ...base, op: 'edit', familyId: 'edit-fill', maskPath: 'u/masks/1.png' });
  assertEquals(snap.maskPath, 'u/masks/1.png');
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
    referencePaths: ['u/ref.png'],
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

In `POST /generations`, insert the snapshot in the same reservation the generation is created by (P5's `fn_reserve_generation` takes `p_items`; add `snapshotId` to each item). A snapshot written in a separate statement whose error is ignored is the defect P5 just removed; do not reintroduce it.

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
      maskPath: null, personaId: null, styleId: null, trendId: null, mode: null,
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
    op: 'edit', familyId: 'edit-fill', maskPath: 'u/masks/1.png',
    referenceUploadIds: ['up-1'],
  });
  const app = createApp(deps);

  const res = await app.request('/api/generations/g1/retry', { method: 'POST', headers: AUTH });

  assertEquals(res.status, 200, await res.text());
  const item = (db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!
    .args.p_items as Record<string, unknown>[])[0];
  const payload = item.payload as Record<string, unknown>;
  assert(payload.maskPngBase64 || payload.maskPath, 'the mask must be restored');
});

Deno.test('R15: retrying a video i2v carries its REFERENCES', async () => {
  const deps = testDeps({ adapterFor: () => fakeAdapter().adapter });
  const db = deps.admin as unknown as FakeDb;
  db.tables.uploads = [
    { id: 'up-1', user_id: TEST_USER, object_path: 'u/ref1.png', content_type: 'image/png' },
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
  seed(db, { family_id: 'edit-fill', op: 'edit', status: 'failed' }, { op: 'edit', familyId: 'edit-fill', maskPath: 'u/m.png' });
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

`planRetry` rehydrates, resolves every upload id to a live object path, re-quotes through P3's `quote()`, and returns either a submission or a refusal. `planVariation` does the same but forces `op='generate'`, sets `parentId`, and refuses for `op='edit'` and `op='upscale'`.

- [ ] **Step 3: Add the safe failure code to the DTO**

In `_shared` and `dtos.ts`:

```ts
export interface GenerationDto {
  // ...
  /** A safe, stable reason the client can render. The raw provider text stays
   * in jobs.error and never reaches a customer. */
  failureCode?: 'cancelled' | 'moderation' | 'provider_error' | 'timeout' | 'store_failed';
  failureMessage?: string;
}
```

`toGenerationDto` reads `generations.failure_code`. P4's `fn_settle_job` writes it. A cancelled video then renders as "Cancelled · Refunded" after a reload, because the state lives on the server rather than in a client-side patch that a reload discards.

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
    const next = [...this.slotsSig()];
    next[index] = slot;
    this.slotsSig.set(next);
    this.changed.emit(next);          // nulls preserved
  }

  clear(index: number): void {
    const next = [...this.slotsSig()];
    next[index] = null;
    this.slotsSig.set(next);
    this.changed.emit(next);
  }

  /** Every required position for this mode is filled. */
  complete(): boolean {
    return requiredSlots(this.mode()).every((i) => this.slotsSig()[i] != null);
  }

  /** The provider array, in provider order. A sparse array is a bug, not a
   * shorter list. */
  serialize(): string[] {
    if (!this.complete()) throw new Error('reference slots incomplete');
    return requiredSlots(this.mode()).map((i) => this.slotsSig()[i]!.path);
  }
```

Update `left-panel.ts:455` (`refSlots().map(s => s.path)`) to call `serialize()`, and gate the Generate button on `complete()`.

- [ ] **Step 3: Write the failing adapter tests**

Create `supabase/functions/_shared/providers/aspect_omission_test.ts`:

```ts
import { assert, assertEquals } from 'jsr:@std/assert';
import { captureFetch } from './testing/capture.ts';
import { googleVideoAdapter } from './google-video.ts';
import { googleOmniAdapter } from './google-omni.ts';
import { runwayAdapter } from './runway.ts';

const FRAME_MODES = ['i2v', 'keyframes'] as const;
const ADAPTERS = [
  { name: 'veo', adapter: googleVideoAdapter },
  { name: 'omni', adapter: googleOmniAdapter },
  { name: 'runway', adapter: runwayAdapter },
];

for (const { name, adapter } of ADAPTERS) {
  for (const mode of FRAME_MODES) {
    Deno.test(`R25: ${name} sends no aspectRatio in ${mode}`, async () => {
      const capture = captureFetch();
      await adapter.submit({
        familyId: name, op: 'generate', prompt: 'a cat', mode,
        settings: { aspectRatio: '16:9', durationS: 5 },
        referenceUrls: ['https://x/first.png', 'https://x/last.png'],
        safetyId: 'sha',
      } as never).catch(() => undefined);

      const body = JSON.stringify(capture.lastBody());
      // The input frame dictates the shape. Sending a stale, hidden aspect
      // (the composer hides the control in these modes) either distorts the
      // output or makes the provider reject the request.
      assert(!body.includes('aspectRatio'), `${name}/${mode} leaked aspectRatio: ${body}`);
      assert(!body.includes('aspect_ratio'), `${name}/${mode} leaked aspect_ratio: ${body}`);
      assert(!body.includes('ratio'), `${name}/${mode} leaked ratio: ${body}`);
    });
  }

  Deno.test(`${name} DOES send aspectRatio for t2v`, async () => {
    const capture = captureFetch();
    await adapter.submit({
      familyId: name, op: 'generate', prompt: 'a cat', mode: 't2v',
      settings: { aspectRatio: '16:9', durationS: 5 }, safetyId: 'sha',
    } as never).catch(() => undefined);
    assert(JSON.stringify(capture.lastBody()).includes('16:9'));
  });
}
```

- [ ] **Step 4: Run to verify it fails, then fix the three adapters**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/aspect_omission_test.ts
```

Expected: FAIL — all six frame-mode tests fail; Kling and Seedance already gate this at `fal.ts:47`.

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

## Task 4: Make the sales copy true (T17 → R23, D1, D4)

**Files:**
- Create: `src/app/core/catalog/entitlements.ts` + `.spec.ts`
- Modify: `src/app/features/plans/plans-page.ts` + `.html`, `src/app/features/landing/landing-page.{ts,html}`, `src/app/shared/site-footer/site-footer.html`, `src/app/features/auth/login-page.html`, `src/app/features/studio/right-panel/right-panel.ts`

**The contradiction being removed.** `PRO_TOOLS` (`right-panel.ts:72-85`) locks twelve on-device tools behind `proLocked`, while `plans-page.ts:118` sells "Full on-device editing suite, free and unlimited" as a **Studio** perk and the FAQ at line 168 names "cut out, bokeh, upscale" as free on every plan. Both cannot be true. One table decides, and both the paywall and the copy read it.

- [ ] **Step 1: Write the failing entitlement spec**

Create `src/app/core/catalog/entitlements.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ENTITLEMENTS, toolsFor, requiredPlanFor } from './entitlements';
import { PRO_TOOLS, STUDIO_TOOLS } from '../../features/studio/right-panel/right-panel';

describe('ENTITLEMENTS is the single source of truth', () => {
  it('every tool the right panel offers has an entitlement', () => {
    for (const tool of [...STUDIO_TOOLS, ...PRO_TOOLS]) {
      expect(requiredPlanFor(tool.id), tool.id).toBeDefined();
    }
  });

  it('R23: the tools the panel locks are exactly the tools the table calls Pro', () => {
    // The pricing page sold these as free on every plan while the panel
    // locked them. Whichever way that is decided, the two must agree.
    expect(PRO_TOOLS.map((t) => t.id).sort()).toEqual(toolsFor('pro').sort());
  });

  it('no tool is listed in both tiers', () => {
    const overlap = toolsFor('studio').filter((id) => toolsFor('pro').includes(id));
    expect(overlap).toEqual([]);
  });

  it('every entitlement names a tool that exists', () => {
    const known = new Set([...STUDIO_TOOLS, ...PRO_TOOLS].map((t) => t.id));
    for (const id of Object.keys(ENTITLEMENTS)) expect(known.has(id), id).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then write the table**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/core/catalog/entitlements.spec.ts
```

Expected: FAIL — module not found.

```ts
/**
 * Which plan each on-device tool needs.
 *
 * Before this table, the right panel's PRO_TOOLS list and the pricing page's
 * prose were written independently and disagreed: the page sold twelve locked
 * tools as "free and unlimited on every plan". A customer could buy Studio on
 * that sentence and find Cut Out locked.
 *
 * The paywall and the copy both read this. Changing an entitlement changes
 * both, and the spec above fails if they drift apart again.
 */
export type ToolPlan = 'free' | 'studio' | 'pro';

export const ENTITLEMENTS: Record<string, ToolPlan> = {
  // Studio: rotate/flip/straighten, filters, crop, heal.
  crop: 'studio', rotate: 'studio', flip: 'studio', straighten: 'studio',
  filters: 'studio', heal: 'studio', dehaze: 'studio', smooth: 'studio',
  // Pro: the ONNX engines and the heavier pure ops.
  select: 'pro', upscale: 'pro', aisharpen: 'pro', bgremove: 'pro', bokeh: 'pro',
  enhance: 'pro', levels: 'pro', clone: 'pro', retouch: 'pro', perspective: 'pro',
  liquify: 'pro', erase: 'pro',
};
```

- [ ] **Step 3: Generate the copy from the table and the catalog**

In `plans-page.ts`, replace every hand-written tool and model list:

```ts
  /** Named from the entitlement table, so the page cannot claim a tool is
   * included on a plan that locks it. */
  readonly studioToolNames = computed(() => toolLabels(toolsFor('studio')));
  readonly proToolNames = computed(() => toolLabels(toolsFor('pro')));

  /** Named from the ENABLED catalog, so a removed model cannot stay on sale.
   * Sora was advertised in three places after being deleted from the catalog
   * and from the models table. */
  readonly videoFamilyNames = computed(() =>
    VIDEO_FAMILIES.filter((f) => this.availability.enabled(f.id)).map((f) => f.name),
  );
```

- [ ] **Step 4: Remove Sora everywhere and prove it stays gone**

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn -i "sora" src/app | grep -v model-families.spec.ts
```

Three hits to fix: `plans-page.ts:134`, `login-page.html:14`, `site-footer.html:29`. Each becomes a binding over `videoFamilyNames()`. Then add the guard as a spec, not just a grep:

```ts
it('R23: no copy advertises a model that is not in the catalog', () => {
  const advertised = [...studioToolNames(), ...videoFamilyNames()];
  for (const name of advertised) {
    expect(familyByName(name) ?? toolByLabel(name), `"${name}" is advertised but does not exist`).toBeTruthy();
  }
});
```

```bash
cd /Users/user/IdeaProjects/vansen && ! grep -rn -i "sora" src/app --exclude="model-families.spec.ts" && echo "SORA GONE"
```

Expected: `SORA GONE`.

- [ ] **Step 5: Align the promo copy with the grant (D1)**

P2 already made `cycleGrant` return the **full** `PLAN_CREDITS[plan]` for launch-coupon invoices, matching `vansen.md` §5. Verify the copy now matches the code, rather than assuming it:

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "full credit grant\|1,500\|3,750\|1,000\|3,125" src/app/features/plans src/app/features/landing
```

Every number on the page must appear in `PLAN_CREDITS` or be computed from it. Replace literals with bindings:

```html
<p class="promo-note">
  First 60 days at the promotional price, with the full
  {{ planCredits().toLocaleString() }}-credit monthly grant.
</p>
```

Add a spec asserting the rendered grant equals `PLAN_CREDITS[plan]` for both tiers.

- [ ] **Step 6: Say "effective cost per credit", not "20% less"**

The review is specific: a job's credit charge does not vary by plan; Pro buys credits more cheaply. Find and correct every instance:

```bash
cd /Users/user/IdeaProjects/vansen && grep -rn "20% less\|20% lower\|cost 20%" src/app
```

Each becomes: *"Pro credits cost about 20% less per dollar, so the same job costs you less."*

- [ ] **Step 7: Record decision D4 (locale)**

`vansen.md` promises English and Malay; the web app has no `@angular/localize` and no i18n config. Present both options to the user and record the answer in `docs/superpowers/specs/2026-09-20-launch-locales.md`:

- **English-only launch** — update `vansen.md` §254 and §285 and the store listings to say English only. No code change. Recommended if Malay is not a launch-blocking market.
- **Fund the locale work** — add `@angular/localize`, extract every string, add a language selector that persists, localize number, date and currency formatting, and check text expansion in every panel. This is substantial and does not fit inside this plan; it becomes its own.

Do not proceed to Task 5 until the decision is recorded. If English-only is chosen, update `vansen.md` in this task.

- [ ] **Step 8: Run everything**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false
```

Expected: all green. User commits.

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

## Task 6: Password and confirmation recovery (T18 → R24)

**Files:**
- Create: `src/app/features/auth/recover-page.{ts,html,css}` + `.spec.ts`, `reset-page.{ts,html,css}` + `.spec.ts`
- Modify: `src/app/core/auth/auth-service.ts`, `src/app/app.routes.ts`, `login-page.html`

**Interfaces:**
- Produces:
  ```ts
  // AuthService
  requestPasswordReset(email: string): Promise<void>;   // always resolves
  resendConfirmation(email: string): Promise<void>;     // always resolves
  completePasswordReset(newPassword: string): Promise<void>;
  ```
- Routes: `/recover` (request a link), `/reset` (the callback, consumes the token).

- [ ] **Step 1: Write the failing auth spec**

Append to `src/app/core/auth/auth-service.spec.ts`:

```ts
describe('R24: password recovery', () => {
  it('sends a reset email for a known address', async () => {
    const spy = vi.fn().mockResolvedValue({ error: null });
    mockAuth.resetPasswordForEmail = spy;
    await service.requestPasswordReset('a@b.com');
    expect(spy).toHaveBeenCalledWith('a@b.com', expect.objectContaining({
      redirectTo: expect.stringContaining('/reset'),
    }));
  });

  it('R24: resolves identically for an unknown address', async () => {
    // Different behaviour for known and unknown addresses turns the reset
    // form into a way to test whether someone has an account here.
    mockAuth.resetPasswordForEmail = vi.fn().mockResolvedValue({
      error: { message: 'User not found' },
    });
    await expect(service.requestPasswordReset('nobody@b.com')).resolves.toBeUndefined();
  });

  it('R24: resolves identically when rate-limited', async () => {
    mockAuth.resetPasswordForEmail = vi.fn().mockResolvedValue({
      error: { message: 'For security purposes, you can only request this after 60 seconds' },
    });
    await expect(service.requestPasswordReset('a@b.com')).resolves.toBeUndefined();
  });

  it('R24: never logs the recovery token', async () => {
    const errorSpy = vi.spyOn(console, 'error');
    const logSpy = vi.spyOn(console, 'log');
    mockAuth.resetPasswordForEmail = vi.fn().mockResolvedValue({
      error: { message: 'failed for token=secret-token-value' },
    });
    await service.requestPasswordReset('a@b.com');
    for (const spy of [errorSpy, logSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('secret-token-value');
      }
    }
  });

  it('completing a reset requires a recovery session', async () => {
    mockAuth.getSession = () => Promise.resolve({ data: { session: null } });
    await expect(service.completePasswordReset('newpassword123')).rejects.toThrow(/link/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then add the methods**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/core/auth/auth-service.spec.ts
```

Expected: FAIL — the methods do not exist.

```ts
  /** Requests a reset link. Resolves the same way whatever happened, because
   * a form that answers differently for a known address is an account
   * enumeration tool. Errors go to the console with the message redacted —
   * a recovery token must never reach a log. */
  async requestPasswordReset(email: string): Promise<void> {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/reset`,
    });
    if (error) console.error('reset_request_failed', redactToken(error.message));
  }

  async resendConfirmation(email: string): Promise<void> {
    const { error } = await supabase.auth.resend({ type: 'signup', email });
    if (error) console.error('resend_failed', redactToken(error.message));
  }

  /** Sets the new password. The recovery link created a short-lived session;
   * without it there is nothing to update. */
  async completePasswordReset(password: string): Promise<void> {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error('That reset link has expired. Request a new one.');
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(error.message);
  }
```

```ts
/** Strips anything that looks like a token before it reaches a log. */
function redactToken(message: string): string {
  return message.replace(/(token|code|otp)=[^\s&]+/gi, '$1=[redacted]');
}
```

- [ ] **Step 3: Write the failing page specs**

`recover-page.spec.ts` asserts: submitting shows the same confirmation for any address, the button is disabled while in flight, an invalid address is rejected client-side before any request, and a second submit within the cooldown is prevented locally with a countdown.

`reset-page.spec.ts` asserts: arriving with no recovery session shows "expired link" and a link to request another, a password shorter than the minimum is rejected with the rule stated, a successful reset routes to the app, and a failed update shows the error without exposing the token.

- [ ] **Step 4: Run to verify they fail, then build both pages**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false src/app/features/auth
```

Expected: FAIL — components do not exist.

Build each as three files — `.ts` + `.html` + `.css` — standalone, signals, `OnPush`, styled with classes only. The confirmation copy must be identical in every case:

```html
<p class="confirm-note">
  If an account exists for that address, a reset link is on its way. Check your
  inbox and your spam folder.
</p>
```

- [ ] **Step 5: Wire the routes and the entry point**

In `app.routes.ts`, add `/recover` and `/reset`. Neither takes the auth guard: `/recover` is for someone who cannot sign in, and `/reset` runs under a recovery session that is not a normal one.

In `login-page.html`, add the link that does not exist today:

```html
<a class="text-link" routerLink="/recover">Forgot your password?</a>
```

- [ ] **Step 6: Verify the four link states by hand**

The review's acceptance criterion names four cases that a unit test cannot cover. Run each against the local stack and record the result in `docs/superpowers/plans/2026-09-20-recovery-verification-log.md`:

| Case | Expected |
|---|---|
| Valid link, same device | Password updates, lands signed in |
| Expired link | "That reset link has expired" plus a way to request another |
| Reused link | Same as expired; the old password still works until a successful reset |
| Wrong device or browser | Works, or fails with a clear instruction; never a blank page |
| Unknown address | Identical confirmation, no hint that the account is absent |
| Rapid repeat requests | Local cooldown with a countdown; the server's limit never surfaces as an error |

- [ ] **Step 7: Run everything**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build 2>&1 | tail -10
```

Expected: all green, build succeeds. User commits.

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
