# Persona as Saved References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fal LoRA persona with a persona that is 5 saved, guided photos, and generate with it on Google Nano Banana Pro at 4K.

**Architecture:** The hidden `persona` catalog family is repointed from fal `flux-lora` to Google `gemini-3-pro-image`. Its settings are fixed at 4K, PNG and 5 photos, and it keeps its own `models` kill switch and its own price rule (`PERSONA_PREMIUM`). A persona row holds 5 named photo slots that point at moderated uploads. The gateway looks those photos up itself, and the worker sends them to Google as labelled inline image parts. The whole training pipeline goes: the tables, functions, worker path, fal trainer and route. Old personas are deleted.

**Tech Stack:** Angular 22 (signals, separate `.ts`/`.html`/`.css` files), Supabase Postgres migrations plus plpgsql, Deno Edge Functions (Hono), vitest via `ng test`, Deno test, SQL tests via `npm run test:sql`.

**Spec:** `docs/superpowers/specs/2026-09-23-persona-references-design.md`

## Global Constraints

- **Never run `git commit`, and never create branches or worktrees.** The owner commits. Where a TDD step would commit, this plan says "Leave uncommitted".
- No nested `if` statements: use guard clauses and early returns.
- Angular components always use separate `.ts`, `.html` and `.css` files. Prefer stylesheet classes over inline `style`.
- Node commands run through nvm: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && <cmd>`. Every command below written as `npm …` or `npx …` assumes this prefix.
- Web tests: `npx ng test --watch=false --include <spec>`. A bare `npx vitest run` wrongly fails every TestBed spec.
- Deno tests: `cd supabase/functions && deno test --allow-all <file>`.
- SQL tests need the local stack: `npm run db:test:start`, then `VANSEN_LOCAL_DB='postgresql://postgres:postgres@127.0.0.1:54322/postgres' npm run test:sql`, then `npm run db:test:stop`.
- A new migration must be added to the bootstrap manifest: `node scripts/supabase-test-stack.mjs write-manifest`. Otherwise `db:test:start` refuses to start.
- After any change to `src/app/core/catalog/*` or `src/app/core/enums.ts`, run `npm run sync-shared` and `npm run export-catalog`.
- The persona slots are exactly `front`, `left_three_quarter`, `right_three_quarter`, `left_profile`, `right_profile`, in that order.
- The persona model is `gemini-3-pro-image` with `image_size: '4K'`. The price is 46 credits per image while `PERSONA_PREMIUM = 1.0`.
- `NANO_REFERENCE_TOKENS = 560` and `NANO_PRO_THINKING_TOKENS = 2000` at $12/1M. The normal Nano Banana Pro price becomes 27 credits at 1K/2K and 45 at 4K.
- The minimum persona photo size is a 1024 px short edge, on both client and server. The client downscales to a 2048 px long edge as JPEG at quality 0.92.
- Batch size for personas is 1–4. Each image is its own generation and charge.
- The error code for a missing, deleted or draft persona at generation time is `persona_unavailable`.
- Never put provider keys or Stripe keys in the repo.

## Spec deviation (recorded)

The spec says to drop `fn_reserve_persona`. This plan **keeps and rewrites it**
instead. It is already the locked, idempotent slot check that
`caps_concurrency.sh` proves, and the spec asks for exactly that: "take a lock
so that concurrent creates cannot exceed the plan limit". `POST /personas`
switches to calling it. The spec has been updated to match.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/app/core/catalog/model-families.ts` | Pricing: counts references, 560 tokens per photo, Pro thinking allowance, the `PERSONA_GEN` Nano Banana Pro entry, `PERSONA_SLOTS`, `PERSONA_SLOT_ORDER` | modify |
| `src/app/core/catalog/catalog-fingerprint.ts`, `catalog-version.spec.ts` | Catalog version guard | modify |
| `src/app/core/enums.ts` | `PersonaStatus` becomes draft/ready only | modify |
| `supabase/migrations/0032_persona_references.sql` | New persona shape, slot RPCs, deleting the old personas, dropping the training pipeline | create |
| `supabase/tests/personas.sql` | SQL gates for the new shape | create |
| `supabase/tests/deletion.sql`, `dispatch.sql`, `caps_concurrency.sh`, `alerts.sql` | Drop training and LoRA assumptions | modify |
| `supabase/functions/_shared/jobs/training.ts` (+ test) | Training worker | delete |
| `supabase/functions/job-worker/index.ts`, `handler.ts`, `handler_test.ts` | Remove the training tick | modify |
| `supabase/functions/_shared/providers/fal.ts` | Remove the trainer and the `flux-lora` branch | modify |
| `supabase/functions/_shared/providers/index.ts` | `persona` → `googleAdapter` | modify |
| `supabase/functions/_shared/providers/types.ts` | `loraUrl` becomes `personaPhotos` | modify |
| `supabase/functions/_shared/providers/google.ts` | Labelled persona parts, 4K, usage log | modify |
| `supabase/functions/_shared/jobs/payload.ts` (+ test) | Sign the 5 persona photos | modify |
| `supabase/functions/api/personas.ts` | Persona DTO mapping and slot helpers (new, keeps `app.ts` from growing) | create |
| `supabase/functions/api/app.ts` | Persona routes, upload minimum size, generation routing | modify |
| `supabase/functions/api/persona_routes_test.ts` | Route tests | create |
| `supabase/functions/api/persona_generation_test.ts` | Generation plus worker tests | create |
| `supabase/functions/_shared/testing/fakes.ts` | Fake RPCs for the new functions | modify |
| `src/app/core/api/dtos.ts` | `PersonaDto` with slots | modify |
| `src/app/core/personas/persona-store.ts` (+ spec) | Create, set photo, delete; no polling | modify |
| `src/app/core/personas/photo-prep.ts` (+ spec) | Minimum size, 2048 long edge | modify |
| `src/app/features/workspace/persona-manager/*` | Slot UI with guide photos | modify |
| `src/app/features/workspace/persona-picker/*` | Draft/ready labels | modify |
| `src/app/features/workspace/left-panel/*` | Persona chip, price × batch, hidden controls | modify |
| `public/personas/guides/` | Guide images (owner-run script) plus a silhouette fallback | create |
| `scripts/generate-persona-guides.mjs`, `scripts/persona-likeness-test.mjs` | Owner-run scripts | create |
| `src/app/features/legal/*-page.html` | Persona wording | modify |
| `CLAUDE.md`, `vansen.md`, the review doc | Docs | modify |

---

### Task 1: Catalog pricing and the persona family

**Files:**
- Modify: `src/app/core/catalog/model-families.ts` (GenerationInput ~L109, GPT input ~L338, Nano input ~L348–366, nano-banana providerCost ~L485, PERSONA_* ~L751–778)
- Modify: `src/app/core/catalog/model-families.spec.ts`
- Modify: `src/app/core/catalog/catalog-fingerprint.ts`, `src/app/core/catalog/catalog-version.spec.ts`

**Interfaces:**
- Produces:
  - `GenerationInput { hasReference: boolean; referenceCount?: number }`.
  - `referenceCountOf(input: GenerationInput): number`.
  - `PERSONA_GEN = { id: 'persona', name: 'Persona', providerModel: 'gemini-3-pro-image', resolution: '4K', photoCount: 5, premium: 1.0 }`.
  - `personaSettings(aspectRatio: string): GenerationSettings`, which returns `{ version: 'pro', resolution: '4K', aspectRatio }`.
  - `personaGenCreditCost(): number`, which returns 46.
  - `personaProviderCost(): number`, which returns ≈0.2712.
  - `PERSONA_SLOT_ORDER: readonly PersonaSlot[]` and `type PersonaSlot`.
  - `PERSONA_SLOTS` is unchanged. `PERSONA_TRAINING` is removed.

- [ ] **Step 1: Write the failing tests**

In `src/app/core/catalog/model-families.spec.ts`, add:

```ts
describe('persona and reference pricing', () => {
  const nano = () => familyById('nano-banana')!;

  it('prices each reference image, not just whether one is attached', () => {
    const s = { version: 'pro', resolution: '1K', aspectRatio: '1:1' };
    const one = providerCostWithInput(nano(), s, { hasReference: true, referenceCount: 1 });
    const five = providerCostWithInput(nano(), s, { hasReference: true, referenceCount: 5 });
    // 560 tokens per image at $2/1M.
    expect(five - one).toBeCloseTo(4 * 560 * (2 / 1_000_000), 8);
  });

  it('prices every GPT Image reference too', () => {
    const gpt = familyById('gpt-image')!;
    const s = gpt.defaults();
    const one = providerCostWithInput(gpt, s, { hasReference: true, referenceCount: 1 });
    const three = providerCostWithInput(gpt, s, { hasReference: true, referenceCount: 3 });
    expect(three - one).toBeCloseTo(2 * GPT_REFERENCE_TOKENS * (8 / 1_000_000), 8);
  });

  it('treats hasReference without a count as one image', () => {
    expect(referenceCountOf({ hasReference: true })).toBe(1);
    expect(referenceCountOf({ hasReference: false })).toBe(0);
    expect(referenceCountOf({ hasReference: true, referenceCount: 5 })).toBe(5);
  });

  it('bills Nano Banana Pro thinking into its price', () => {
    expect(creditCost(nano(), { version: 'pro', resolution: '1K', aspectRatio: '1:1' })).toBe(27);
    expect(creditCost(nano(), { version: 'pro', resolution: '2K', aspectRatio: '1:1' })).toBe(27);
    expect(creditCost(nano(), { version: 'pro', resolution: '4K', aspectRatio: '1:1' })).toBe(45);
  });

  it('prices a persona image as Nano Banana Pro 4K with its five photos', () => {
    expect(personaProviderCost()).toBeCloseTo(0.2712, 6);
    expect(personaGenCreditCost()).toBe(46);
    expect(personaSettings('3:4')).toEqual({ version: 'pro', resolution: '4K', aspectRatio: '3:4' });
    expect(PERSONA_GEN.providerModel).toBe('gemini-3-pro-image');
  });

  it('names the five slots in capture order', () => {
    expect(PERSONA_SLOT_ORDER).toEqual([
      'front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile',
    ]);
  });
});
```

If the family exposes its default settings under another name than `defaults()`, use the name the neighbouring specs use. Add `GPT_REFERENCE_TOKENS`, `providerCostWithInput`, `referenceCountOf`, `personaGenCreditCost`, `personaProviderCost`, `personaSettings`, `PERSONA_GEN` and `PERSONA_SLOT_ORDER` to that spec's import from `./model-families`. Remove every `PERSONA_TRAINING` reference in the spec, if any.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx ng test --watch=false --include src/app/core/catalog/model-families.spec.ts`
Expected: FAIL. `referenceCountOf`, `personaProviderCost`, `personaSettings` and `PERSONA_SLOT_ORDER` are not exported, and Pro 1K is 23, not 27.

- [ ] **Step 3: Implement**

In `model-families.ts`:

(a) Replace the `GenerationInput` block:

```ts
/** What the customer attached, as far as price is concerned. */
export interface GenerationInput {
  hasReference: boolean;
  /** How many reference images ride along. Absent means one when hasReference. */
  referenceCount?: number;
}

export const NO_INPUT: GenerationInput = { hasReference: false };

/** Every reference image is billed, so the price must know how many there are. */
export function referenceCountOf(input: GenerationInput): number {
  if (!input.hasReference) return 0;
  return input.referenceCount ?? 1;
}
```

(b) Replace `gptInputCost`:

```ts
function gptInputCost(input: GenerationInput): number {
  const prompt = PROMPT_TOKEN_ALLOWANCE * GPT_TEXT_IN_RATE;
  return prompt + referenceCountOf(input) * GPT_REFERENCE_TOKENS * GPT_IMAGE_IN_RATE;
}
```

(c) Replace the Nano reference comment, the constant and `nanoInputCost`:

```ts
/**
 * Gemini bills each input image as 560 tokens at the model's text-input rate
 * ($0.25/1M Lite, $0.50/1M Flash, $2/1M Pro — ai.google.dev pricing,
 * checked 2026-09-23). Every image is billed, so the count matters.
 */
const NANO_REFERENCE_TOKENS = 560;
const NANO_TEXT_IN_RATE: Record<string, number> = {
  fast: 0.25 / 1_000_000,
  standard: 0.5 / 1_000_000,
  pro: 2 / 1_000_000,
};

/**
 * Nano Banana Pro always thinks before it draws, and Google bills the thought
 * tokens at $12/1M. The real count varies per request; 2,000 is a provisional
 * allowance until the `google_usage` log lines give a measured figure.
 */
export const NANO_PRO_THINKING_TOKENS = 2_000;
const NANO_THINKING_RATE = 12 / 1_000_000;

function nanoInputCost(input: GenerationInput, s: GenerationSettings): number {
  const rate = NANO_TEXT_IN_RATE[s.version ?? 'standard'] ?? NANO_TEXT_IN_RATE['standard'];
  const tokens = PROMPT_TOKEN_ALLOWANCE + referenceCountOf(input) * NANO_REFERENCE_TOKENS;
  return tokens * rate;
}
```

(d) In the `nano-banana` family, replace the Pro line of `providerCost`:

```ts
      if (s.version === 'pro') {
        const output = s.resolution === '4K' ? 0.24 : 0.134;
        return output + NANO_PRO_THINKING_TOKENS * NANO_THINKING_RATE;
      }
```

(e) Replace everything from `/** Hidden persona pipeline` through the end of `personaGenCreditCost()` with:

```ts
/**
 * Hidden persona family — Google Nano Banana Pro at its highest settings,
 * with the persona's five photos as references. Not in the picker; selected
 * implicitly when a persona is active. One entry, so the persona model can be
 * swapped without touching Nano Banana's own prices or kill switch.
 */
export const PERSONA_GEN = {
  id: 'persona',
  name: 'Persona',
  providerModel: 'gemini-3-pro-image',
  resolution: '4K',
  photoCount: 5,
  /** Multiplier on the margin price. Raised only if the likeness test earns it. */
  premium: 1.0,
} as const;

/** The five guided capture angles, in the order they are sent to the model. */
export const PERSONA_SLOT_ORDER = [
  'front',
  'left_three_quarter',
  'right_three_quarter',
  'left_profile',
  'right_profile',
] as const;
export type PersonaSlot = (typeof PERSONA_SLOT_ORDER)[number];

/** Concurrent persona slots per plan. */
export const PERSONA_SLOTS: Record<'studio' | 'pro' | 'owner', number> = {
  studio: 2,
  pro: 5,
  owner: 5,
};

/** The fixed settings a persona image is rendered and priced at. */
export function personaSettings(aspectRatio: string): GenerationSettings {
  return { version: 'pro', resolution: PERSONA_GEN.resolution, aspectRatio };
}

function nanoFamily(): ModelFamily {
  const family = MODEL_FAMILIES.find((f) => f.id === 'nano-banana');
  if (!family) throw new Error('nano-banana family missing from the catalog');
  return family;
}

/** Our provider cost for one persona image: output, thinking, five photos, prompt. */
export function personaProviderCost(): number {
  const input: GenerationInput = { hasReference: true, referenceCount: PERSONA_GEN.photoCount };
  return providerCostWithInput(nanoFamily(), personaSettings('1:1'), input);
}

export function personaGenCreditCost(): number {
  return Math.ceil(
    (personaProviderCost() / (1 - STUDIO_MARGIN)) * 100 * PERSONA_GEN.premium,
  );
}
```

`providerCostWithInput` is declared lower in the file as a function declaration, so it is hoisted and safe to call here. Delete `PERSONA_TRAINING`.

(f) Bump `CATALOG_VERSION` to `'2026-09-23.2'`. Use `'2026-09-23.1'` only if FLUX Dev removal has not been deployed yet; check the file first. Keep it strictly greater than the current value.

- [ ] **Step 4: Update the fingerprint**

Run: `npx ng test --watch=false --include src/app/core/catalog/catalog-version.spec.ts`
Expected: FAIL, printing the received fingerprint. Paste it into `recordedCatalogFingerprint` in `catalog-fingerprint.ts`, and set the literal version in `catalog-version.spec.ts` to the new `CATALOG_VERSION`.

- [ ] **Step 5: Sync and export**

Run: `npm run sync-shared && npm run export-catalog`
Expected: `synced …model-families.ts` and `catalog 2026-09-23.x written`.

- [ ] **Step 6: Run the catalog specs and confirm they pass**

Run: `npx ng test --watch=false --include 'src/app/core/catalog/**/*.spec.ts'`
Expected: PASS. If existing Nano Pro price assertions elsewhere expect 23 or 41, update them to 27 or 45. Those are the intended changes.

- [ ] **Step 7: Leave uncommitted.**

---

### Task 2: Migration — new persona shape, slot RPCs, removing the old pipeline

**Files:**
- Create: `supabase/migrations/0032_persona_references.sql`
- Create: `supabase/tests/personas.sql`
- Modify: `supabase/tests/bootstrap-manifest.json` (regenerated)
- Modify: `supabase/tests/deletion.sql` (seed_persona and cases 4 and 10), `supabase/tests/dispatch.sql` (cases 10–11), `supabase/tests/caps_concurrency.sh` (cleanup lines and persona slots), `supabase/tests/alerts.sql` (only if it seeds `training_jobs`; the `trainings_stuck` assertion at L98 stays true)

**Interfaces:**
- Produces:
  - `personas.photos jsonb`, an object with the five slot keys, each a path or null.
  - `personas.consent_attested_at timestamptz not null`.
  - `personas.status in ('draft','ready')`.
  - `fn_reserve_persona(p_user uuid, p_key uuid, p_hash text, p_name text) returns jsonb {personaId}`: counts only draft and ready personas that are not deleted, and stamps consent.
  - `fn_set_persona_photo(p_user uuid, p_persona uuid, p_slot text, p_path text) returns jsonb {status, replaced}`: sets one slot, queues the replaced photo, and recomputes the status.
  - `fn_track_persona_objects`, `fn_reap_persona` and `fn_delete_persona` read `photos`, and never create `provider_artifact_deletions` rows.

- [ ] **Step 1: Write the failing SQL test** `supabase/tests/personas.sql`

```sql
-- Persona as saved references: five named slots, consent recorded, slots
-- counted under a lock, replaced photos deleted, and no provider artifact.
-- LOCAL DATABASE ONLY. See supabase/tests/upload_ownership.sql for the recipe.
begin;

create or replace function pg_temp.seed_user(p_user uuid, p_plan text)
returns void language plpgsql as $$
begin
  insert into auth.users (id, email) values (p_user, p_user::text || '@example.com') on conflict do nothing;
  insert into public.profiles (id, birth_date) values (p_user, '1990-01-01') on conflict do nothing;
  insert into public.subscriptions (user_id, plan, status, current_period_end)
  values (p_user, p_plan, 'active', now() + interval '30 days')
  on conflict (user_id) do update set plan = p_plan, status = 'active';
end $$;

create or replace function pg_temp.seed_upload(p_user uuid, p_n int)
returns text language plpgsql as $$
declare v_path text := p_user::text || '/' || lpad(p_n::text, 8, '0') || '-0000-4000-8000-000000000000.jpg';
begin
  insert into public.uploads (user_id, path, purpose, mime, bytes, width, height, moderation)
  values (p_user, v_path, 'persona-photo', 'image/jpeg', 1000, 1536, 2048, 'allowed');
  perform public.fn_register_object(p_user, 'supabase', 'uploads', v_path, 'persona-photo');
  update public.storage_objects set state = 'live' where path = v_path;
  return v_path;
end $$;

-- 1. A new persona is a draft with consent recorded and five empty slots.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_id uuid;
begin
  perform pg_temp.seed_user(v_user, 'studio');
  v_id := (public.fn_reserve_persona(v_user, gen_random_uuid(), 'h1', 'Me')->>'personaId')::uuid;
  assert (select status from public.personas where id = v_id) = 'draft';
  assert (select consent_attested_at from public.personas where id = v_id) is not null;
  assert (select photos from public.personas where id = v_id) = jsonb_build_object(
    'front', null, 'left_three_quarter', null, 'right_three_quarter', null,
    'left_profile', null, 'right_profile', null);
end $$;

-- 2. Only the five slot keys are accepted.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_id uuid; v_failed boolean := false;
begin
  select id into v_id from public.personas where user_id = v_user limit 1;
  begin
    update public.personas set photos = photos || '{"back": null}'::jsonb where id = v_id;
  exception when check_violation then v_failed := true;
  end;
  assert v_failed, 'an unknown slot key must be rejected';
end $$;

-- 3. Filling all five slots makes it ready; replacing one queues the old photo.
do $$
declare
  v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_id uuid; v_old text; v_new text;
  v_slot text; v_i int := 0; v_out jsonb;
begin
  select id into v_id from public.personas where user_id = v_user limit 1;
  foreach v_slot in array array['front','left_three_quarter','right_three_quarter','left_profile','right_profile'] loop
    v_i := v_i + 1;
    v_out := public.fn_set_persona_photo(v_user, v_id, v_slot, pg_temp.seed_upload(v_user, v_i));
  end loop;
  assert v_out->>'status' = 'ready';
  assert (select status from public.personas where id = v_id) = 'ready';

  v_old := (select photos->>'front' from public.personas where id = v_id);
  v_new := pg_temp.seed_upload(v_user, 99);
  v_out := public.fn_set_persona_photo(v_user, v_id, 'front', v_new);
  assert (v_out->>'replaced')::boolean;
  assert (select photos->>'front' from public.personas where id = v_id) = v_new;
  assert exists (
    select 1 from public.deletion_outbox d join public.storage_objects o on o.id = d.object_id
     where o.path = v_old and d.reason = 'persona_photo_replaced' and d.completed_at is null),
    'the replaced photo must be queued for deletion';
end $$;

-- 4. A photo that is not the caller's allowed persona-photo upload is refused.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_id uuid; v_failed boolean := false;
begin
  select id into v_id from public.personas where user_id = v_user limit 1;
  begin
    perform public.fn_set_persona_photo(v_user, v_id, 'front', 'someone-else/x.jpg');
  exception when others then v_failed := sqlerrm like '%invalid_photo%';
  end;
  assert v_failed, 'a foreign or unmoderated path must raise invalid_photo';
end $$;

-- 5. Slots are counted for draft and ready only; the plan limit holds.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_failed boolean := false;
begin
  perform public.fn_reserve_persona(v_user, gen_random_uuid(), 'h2', 'Second');
  begin
    perform public.fn_reserve_persona(v_user, gen_random_uuid(), 'h3', 'Third');
  exception when others then v_failed := sqlerrm like '%slot_limit%';
  end;
  assert v_failed, 'studio allows two personas';
end $$;

-- 6. Deleting a persona queues its photos and records no provider artifact.
do $$
declare v_user uuid := 'aaaa3333-0000-4000-8000-000000000001'; v_id uuid;
begin
  select id into v_id from public.personas where user_id = v_user and status = 'ready';
  perform public.fn_delete_persona(v_user, v_id);
  assert not exists (select 1 from public.personas where id = v_id);
  assert (select count(*) from public.deletion_outbox
           where reason = 'persona_deleted' and completed_at is null) = 5;
  assert not exists (select 1 from public.provider_artifact_deletions where user_id = v_user);
end $$;

-- 7. The training pipeline is gone.
do $$
begin
  assert to_regclass('public.training_jobs') is null;
  assert not exists (select 1 from pg_proc where proname in
    ('fn_reserve_training','fn_settle_training','fn_claim_training_jobs','fn_charge_persona','fn_fail_persona'));
  assert not exists (select 1 from cron.job where jobname = 'reconcile_stale_trainings');
  assert to_regclass('public.training_provider_expenses') is not null, 'money records stay';
end $$;

rollback;
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run db:test:start && VANSEN_LOCAL_DB='postgresql://postgres:postgres@127.0.0.1:54322/postgres' npm run test:sql; npm run db:test:stop`
Expected: `personas.sql` FAILS (`fn_set_persona_photo` does not exist).

- [ ] **Step 3: Write the migration** `supabase/migrations/0032_persona_references.sql`

```sql
-- 0032: persona as saved references (spec 2026-09-23-persona-references-design).
--
-- A persona is five guided photos, sent to Nano Banana Pro at generation time.
-- Nothing is trained and no provider keeps a file for us, so the LoRA pipeline
-- goes: its tables, functions and cron. Pre-launch personas are deleted.

-- ------------------------------------------------ 1. old personas go first
-- Their photos and training ZIPs are queued through the existing lifecycle
-- while the old functions and columns still exist.
do $$
declare r record;
begin
  update public.training_jobs set state = 'done' where state <> 'done';
  for r in select id, user_id from public.personas loop
    perform public.fn_delete_persona(r.user_id, r.id);
  end loop;
end $$;

-- LoRA files at fal from pre-launch test personas: nothing will chase them, so
-- say so instead of keeping every closure open forever.
update public.provider_artifact_deletions
   set status = 'unsupported',
       last_error = 'pre-launch test data: LoRA pipeline retired'
 where status in ('requested','processing','failed');

-- ------------------------------------------------ 2. the training pipeline
select cron.unschedule(jobid) from cron.job where jobname = 'reconcile_stale_trainings';

drop function if exists public.fn_reserve_training(uuid, uuid, uuid, text, jsonb);
drop function if exists public.fn_settle_training(uuid, uuid, text, text, text);
drop function if exists public.fn_claim_training_jobs(int);
drop function if exists public.fn_release_training_job(uuid, uuid, text, timestamptz, text);
drop function if exists public.fn_begin_training_submit(uuid, uuid);
drop function if exists public.fn_record_training_ref(uuid, uuid, text);
drop function if exists public.fn_charge_persona(uuid, uuid, int);
drop function if exists public.fn_fail_persona(uuid, text);

-- Money records stay; they just stop pointing at a table that is gone.
alter table public.training_provider_expenses
  drop constraint if exists training_provider_expenses_job_id_fkey;
drop trigger if exists refuse_closed_account on public.training_jobs;
drop table public.training_jobs;

delete from public.dispatch_limits
 where key in ('persona_training_credits','persona_training_usd','persona_min_photos','persona_max_photos');

-- ------------------------------------------------ 3. the new persona shape
alter table public.personas
  drop column photo_paths,
  drop column lora_url,
  drop column trigger_word,
  drop column provider_ref,
  drop column error,
  drop column charged_plan,
  drop column charged_pack,
  drop column training_started_at,
  drop column trained_at;

alter table public.personas
  add column photos jsonb not null default jsonb_build_object(
    'front', null, 'left_three_quarter', null, 'right_three_quarter', null,
    'left_profile', null, 'right_profile', null),
  add column consent_attested_at timestamptz not null default now();

alter table public.personas alter column consent_attested_at drop default;

alter table public.personas drop constraint if exists personas_status_check;
alter table public.personas add constraint personas_status_check
  check (status in ('draft','ready'));

-- Exactly the five slot keys; each value a path or null. A CHECK cannot hold
-- a subquery, so the shape lives in an immutable helper.
create or replace function public.fn_persona_photos_valid(p jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'object'
     and (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p) k)
         = array['front','left_profile','left_three_quarter','right_profile','right_three_quarter']
     and not exists (
       select 1 from jsonb_each(p) e
        where jsonb_typeof(e.value) not in ('string','null'));
$$;

alter table public.personas add constraint personas_photos_shape
  check (public.fn_persona_photos_valid(photos));
```

Continue the migration:

```sql
-- ------------------------------------------------ 4. slots and photos

/** Slot capacity under the same lock as the money. Consent is recorded here. */
create or replace function public.fn_reserve_persona(
  p_user uuid, p_key uuid, p_hash text, p_name text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_existing public.submissions%rowtype;
  v_plan text; v_slots numeric; v_live int; v_persona uuid; v_result jsonb;
begin
  if p_key is null then
    raise exception 'idempotency_key_required' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select * into v_existing from public.submissions
   where user_id = p_user and idempotency_key = p_key;
  if found and v_existing.body_hash <> p_hash then
    raise exception 'idempotency_conflict' using errcode = 'P0001';
  end if;
  if found then
    return v_existing.result;
  end if;

  select plan into v_plan from public.subscriptions
   where user_id = p_user and status = 'active';
  if v_plan is null then
    raise exception 'subscription_required' using errcode = 'P0001';
  end if;
  v_slots := public.fn_dispatch_limit('persona_slots:' || v_plan, 0);

  select count(*) into v_live from public.personas
   where user_id = p_user and deleted_at is null and status in ('draft','ready');
  if v_live >= v_slots then
    raise exception 'slot_limit' using errcode = 'P0001';
  end if;

  insert into public.personas (user_id, name, consent_attested_at)
  values (p_user, p_name, now())
  returning id into v_persona;

  v_result := jsonb_build_object('personaId', v_persona);
  insert into public.submissions (user_id, idempotency_key, body_hash, result)
  values (p_user, p_key, p_hash, v_result);
  return v_result;
end $$;

/**
 * Put one moderated photo in one slot. The photo it replaces is queued for
 * deletion in the same transaction; the status is ready exactly when every
 * slot is filled.
 */
create or replace function public.fn_set_persona_photo(
  p_user uuid, p_persona uuid, p_slot text, p_path text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_photos jsonb; v_old text; v_ids uuid[] := '{}'; v_status text;
begin
  if p_slot not in ('front','left_three_quarter','right_three_quarter','left_profile','right_profile') then
    raise exception 'invalid_slot' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.uploads
     where path = p_path and user_id = p_user
       and purpose = 'persona-photo' and moderation = 'allowed'
  ) then
    raise exception 'invalid_photo' using errcode = 'P0001';
  end if;

  select photos into v_photos from public.personas
   where id = p_persona and user_id = p_user and deleted_at is null
   for update;
  if v_photos is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_old := v_photos->>p_slot;
  v_photos := jsonb_set(v_photos, array[p_slot], to_jsonb(p_path));
  v_status := case
    when exists (select 1 from jsonb_each(v_photos) e where jsonb_typeof(e.value) = 'null')
    then 'draft' else 'ready' end;
  update public.personas set photos = v_photos, status = v_status where id = p_persona;

  if v_old is not null and v_old <> p_path then
    v_ids := v_ids || public.fn_register_object(p_user, 'supabase', 'uploads', v_old, 'persona-photo');
    perform public.fn_enqueue_deletions(to_jsonb(v_ids), 'persona_photo_replaced', now());
  end if;

  return jsonb_build_object('status', v_status,
    'replaced', v_old is not null and v_old <> p_path);
end $$;

-- ------------------------------------------------ 5. deletion, new shape

/** A persona's objects are its photos. Nothing is held by a provider. */
create or replace function public.fn_track_persona_objects(p_persona uuid)
returns uuid[] language plpgsql security definer set search_path = public as $$
declare p record; v_path text; v_ids uuid[] := '{}';
begin
  select id, user_id, photos into p from public.personas where id = p_persona;
  if p is null then return v_ids; end if;
  for v_path in select value from jsonb_each_text(p.photos) where value is not null loop
    v_ids := v_ids || public.fn_register_object(
      p.user_id, 'supabase', 'uploads', v_path, 'persona-photo');
  end loop;
  return v_ids;
end $$;

create or replace function public.fn_reap_persona(p_persona uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ids uuid[]; v_queued int;
begin
  if not exists (select 1 from public.personas where id = p_persona) then
    return jsonb_build_object('status', 'gone', 'objects', 0);
  end if;
  v_ids := public.fn_track_persona_objects(p_persona);
  v_queued := public.fn_enqueue_deletions(to_jsonb(v_ids), p_reason, now());
  delete from public.personas where id = p_persona;
  return jsonb_build_object('status', 'queued', 'objects', v_queued);
end $$;

create or replace function public.fn_delete_persona(p_user uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.personas
   where id = p_id and user_id = p_user for update;
  if v_id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  update public.personas set deleted_at = now() where id = p_id and deleted_at is null;
  return public.fn_reap_persona(p_id, 'persona_deleted');
end $$;
```

Next, add the three functions that referenced `training_jobs`, re-created
without it. For each one, **copy the current body verbatim** from the file
named, then delete only the lines shown:

1. `fn_request_account_deletion(uuid, jsonb)`: copy from
   `supabase/migrations/0021_durable_deletion.sql` (the `create or replace
   function public.fn_request_account_deletion(` block, ~L698–740) and delete:

   ```sql
     update public.training_jobs
        set cancel_requested_at = coalesce(cancel_requested_at, now()), next_run_at = now()
      where user_id = p_user and state <> 'done';
   ```

2. `fn_advance_account_deletion(uuid)`: copy from `0021_durable_deletion.sql`
   (~L758–845) and replace:

   ```sql
     select count(*) into v_jobs from (
       select 1 from public.jobs where user_id = r.user_id and state <> 'done'
       union all
       select 1 from public.training_jobs where user_id = r.user_id and state <> 'done'
     ) q;
   ```

   with:

   ```sql
     select count(*) into v_jobs from public.jobs
      where user_id = r.user_id and state <> 'done';
   ```

3. `fn_check_alerts()`: copy the latest body from
   `supabase/migrations/0026_review_recovery.sql` (L53–141) and delete block 4
   (from `-- 4. Training that stalled the same way.` through its `end if;`).
   Keep `training_provider_expenses` in block 7. Keep `'trainings_stuck'` in
   `fn_resolve_checked_alerts`: old alert rows must still be able to resolve.

Finish the migration with grants:

```sql
revoke all on function public.fn_set_persona_photo(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.fn_persona_photos_valid(jsonb) from public, anon, authenticated;
grant execute on function public.fn_set_persona_photo(uuid, uuid, text, text) to service_role;
grant execute on function public.fn_persona_photos_valid(jsonb) to service_role;
```

(`fn_reserve_persona`, `fn_track_persona_objects`, `fn_reap_persona`,
`fn_delete_persona`, `fn_request_account_deletion`,
`fn_advance_account_deletion` and `fn_check_alerts` keep the grants they
already have, because `create or replace` preserves them.)

- [ ] **Step 4: Regenerate the manifest**

Run: `node scripts/supabase-test-stack.mjs write-manifest`
Expected: `bootstrap-manifest.json` gains `0032_persona_references.sql`.

- [ ] **Step 5: Update the existing SQL tests**

- `supabase/tests/deletion.sql`:
  - Replace `pg_temp.seed_persona` (L43–49) with:

    ```sql
    create or replace function pg_temp.seed_persona(p_user uuid, p_id uuid)
    returns void language sql as $$
      insert into public.personas (id, user_id, name, status, photos, consent_attested_at)
      values (p_id, p_user, 'Ada', 'draft',
              jsonb_build_object(
                'front', p_user::text || '/photo-1.jpg',
                'left_three_quarter', p_user::text || '/photo-2.jpg',
                'right_three_quarter', null, 'left_profile', null, 'right_profile', null),
              now());
    $$;
    ```

  - Case 4 (L121–146): retitle it "A persona's photos are queued, and nothing is held elsewhere". Call `seed_persona(v_user, v_persona)`. Change the count to `= 2` with message `'two photos, no ZIP'`. Replace the `provider_artifact_deletions … = 'requested'` assertion with `assert not exists (select 1 from public.provider_artifact_deletions where user_id = v_user);`.
  - Case 10 (L305 onward): this is the only test of the generic "a provider still holds a copy" blocker, so keep every artifact assertion. Call `seed_persona(v_user, v_persona)`, and on the next line insert the artifact row that the LoRA used to create:

    ```sql
      insert into public.provider_artifact_deletions (user_id, provider, artifact_ref, status)
      values (v_user, 'fal', 'https://fal.example/lora/ten.safetensors', 'requested');
    ```

    Change the message `'a provider-hosted LoRA is unresolved work…'` to `'a provider-hosted artifact is unresolved work, not a completed deletion'`. Leave the rest of the case unchanged.
- `supabase/tests/dispatch.sql`: delete case 11 (training). In case 10, keep the slot assertions; they still hold.
- `supabase/tests/caps_concurrency.sh`: delete the two cleanup lines for `training_provider_expenses` and `training_jobs` (L17–18). Keep `training_provider_expenses` cleanup only if the table still has rows seeded by this script; it does not, so both go.
- `supabase/tests/alerts.sql`: search for `training_jobs`. If the test seeds that table, delete those inserts. The `trainings_stuck` negative assertion stays.

- [ ] **Step 6: Run the SQL gates and confirm they pass**

Run: `npm run db:test:start && VANSEN_LOCAL_DB='postgresql://postgres:postgres@127.0.0.1:54322/postgres' npm run test:sql; npm run db:test:stop`
Expected: every SQL file PASSES, including `personas.sql` and `caps_concurrency.sh`.

- [ ] **Step 7: Leave uncommitted.**

---

### Task 3: Remove the training pipeline from the worker and fal adapter

**Files:**
- Delete: `supabase/functions/_shared/jobs/training.ts`, `supabase/functions/_shared/jobs/training_test.ts`
- Modify: `supabase/functions/job-worker/index.ts` (remove the `training:` deps and the fal import), `supabase/functions/job-worker/handler.ts` (remove the training claim loop, `runOneTraining`, `trainings` from `TickSummary` and from the `WorkerDeps` type), `supabase/functions/job-worker/handler_test.ts` (remove `training()`, the `trainings` rows and the training assertions)
- Modify: `supabase/functions/_shared/providers/fal.ts` (delete everything from `// --- Persona LoRA training` to the end of `checkPersonaTraining`, the `if (ctx.familyId === 'persona') return 'fal-ai/flux-lora';` line, and the `loras:` branch at ~L96–103)
- Modify: `supabase/functions/_shared/providers/index.ts`: `persona: googleAdapter,`
- Modify: `supabase/functions/_shared/providers/types.ts`: replace the `loraUrl` field with:

```ts
  /** Persona generations: the five photos in slot order, each signed for this run. */
  personaPhotos?: { slot: string; url: string }[];
```

**Interfaces:**
- Produces: `SubmitCtx.personaPhotos`. `adapterFor('persona') === googleAdapter`.

- [ ] **Step 1: Write the failing test**

In `supabase/functions/job-worker/handler_test.ts`, replace the test named `'an authenticated tick claims jobs, trainings and notifications'` with:

```ts
Deno.test('an authenticated tick claims jobs and notifications, and no trainings', async () => {
  const { admin, rec } = stub({ jobs: [], notifications: [] });
  const worker = createWorker(deps(admin));
  const res = await worker(authed());
  assertEquals(res.status, 200);
  const names = rec.rpcCalls.map((c) => c.name);
  assertEquals(names.includes('fn_claim_jobs'), true);
  assertEquals(names.includes('fn_claim_training_jobs'), false);
});
```

Use the file's existing `deps` and `authed` helpers. If they are named differently, use the names the neighbouring tests use. Delete the tests `'training advances with no client request in sight'` and the training half of the failure-isolation test.

Add to `supabase/functions/_shared/providers/fal_image_test.ts`, or a new `supabase/functions/_shared/providers/index_test.ts`:

```ts
import { assertStrictEquals } from 'jsr:@std/assert';
import { adapterFor } from './index.ts';
import { googleAdapter } from './google.ts';

Deno.test('persona generations go to Google', () => {
  assertStrictEquals(adapterFor('persona'), googleAdapter);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd supabase/functions && deno test --allow-all job-worker/handler_test.ts _shared/providers/index_test.ts`
Expected: FAIL (`fn_claim_training_jobs` is still called; persona maps to fal).

- [ ] **Step 3: Implement the removals listed under Files.** Also delete `import { checkPersonaTraining, submitPersonaTraining } …` from `job-worker/index.ts`.

- [ ] **Step 4: Type-check and run the tests**

Run: `cd supabase/functions && deno check job-worker/index.ts api/index.ts && deno test --allow-all job-worker _shared/providers`
Expected: PASS. `api/app.ts` still imports `PERSONA_TRIGGER`; Task 4 removes it. If `deno check api/index.ts` fails only on that import, continue to Task 4.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 4: Persona API routes and upload minimum size

**Files:**
- Create: `supabase/functions/api/personas.ts`
- Modify: `supabase/functions/api/app.ts` (imports L22–35; `toPersonaDto` and the persona routes L3606–3870; the upload route L3461)
- Modify: `supabase/functions/_shared/testing/fakes.ts` (fake `fn_reserve_persona`, `fn_set_persona_photo`; fix `fn_delete_persona` to stop creating artifact rows)
- Create: `supabase/functions/api/persona_routes_test.ts`
- Modify: `supabase/functions/api/dispatch_routes_test.ts` (delete the two persona tests at L173 and L201), `supabase/functions/api/deletion_routes_test.ts` (the persona test at L225 now asserts no `provider_artifact_deletions` row)

**Interfaces:**
- Consumes: `PERSONA_SLOT_ORDER`, `PersonaSlot`, `PERSONA_SLOTS` (Task 1); `fn_reserve_persona`, `fn_set_persona_photo`, `fn_delete_persona` (Task 2).
- Produces:
  - `GET /personas` → `{ items: PersonaDto[], slots: { used, max } }`.
  - `POST /personas {name, attested}` → `{ item }`.
  - `PUT /personas/:id/photos/:slot {uploadId}` → `{ item }`.
  - `DELETE /personas/:id` → 202.
  - The server-side `PersonaDto` is `{ id, name, status: 'draft'|'ready', photos: { slot: PersonaSlot; url: string | null }[], thumbUrl: string, createdAt: string }`.
  - `PERSONA_MIN_EDGE = 1024` (exported from `personas.ts`).

- [ ] **Step 1: Write the failing tests** `supabase/functions/api/persona_routes_test.ts`

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';

const AUTH = { authorization: 'Bearer test-token' };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };
const PERSONA = 'pppppppp-0000-4000-8000-000000000001';

function setup(plan = 'studio') {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  db.tables.subscriptions = [{
    user_id: TEST_USER, plan, status: 'active', current_period_end: '2099-01-01T00:00:00Z',
  }];
  return { app: createApp(deps), db };
}

function emptyPhotos() {
  return {
    front: null, left_three_quarter: null, right_three_quarter: null,
    left_profile: null, right_profile: null,
  };
}

function seedUpload(db: FakeDb, n: number, over: Record<string, unknown> = {}): string {
  const path = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}.jpg`;
  db.tables.uploads ??= [];
  db.tables.uploads.push({
    id: `u${n}`, user_id: TEST_USER, path, purpose: 'persona-photo',
    mime: 'image/jpeg', width: 1536, height: 2048, moderation: 'allowed', ...over,
  });
  return path;
}

Deno.test('POST /personas creates a draft through the locked reservation', async () => {
  const { app, db } = setup();
  const res = await app.request('/api/personas', {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ name: 'Me', attested: true }),
  });
  assertEquals(res.status, 200);
  assertEquals(db.rpcCalls.some((c) => c.name === 'fn_reserve_persona'), true);
  const body = await res.json();
  assertEquals(body.item.status, 'draft');
  assertEquals(body.item.photos.map((p: { slot: string }) => p.slot), [
    'front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile',
  ]);
});

Deno.test('POST /personas without consent is refused', async () => {
  const { app } = setup();
  const res = await app.request('/api/personas', {
    method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ name: 'Me', attested: false }),
  });
  assertEquals(res.status, 400);
});

Deno.test('PUT a slot stores the photo and reports readiness', async () => {
  const { app, db } = setup();
  db.tables.personas = [{
    id: PERSONA, user_id: TEST_USER, name: 'Me', status: 'draft',
    photos: emptyPhotos(), consent_attested_at: '2026-09-23T00:00:00Z',
    created_at: '2026-09-23T00:00:00Z', deleted_at: null,
  }];
  const path = seedUpload(db, 1);
  const res = await app.request(`/api/personas/${PERSONA}/photos/front`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: path }),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.item.photos[0].slot, 'front');
  assertEquals(typeof body.item.photos[0].url, 'string');
});

Deno.test('PUT an unknown slot is a 400', async () => {
  const { app } = setup();
  const res = await app.request(`/api/personas/${PERSONA}/photos/back`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: 'x' }),
  });
  assertEquals(res.status, 400);
});

Deno.test('PUT a photo under 1024px on its short edge is refused', async () => {
  const { app, db } = setup();
  db.tables.personas = [{
    id: PERSONA, user_id: TEST_USER, name: 'Me', status: 'draft', photos: emptyPhotos(),
    consent_attested_at: '2026-09-23T00:00:00Z', created_at: '2026-09-23T00:00:00Z', deleted_at: null,
  }];
  const path = seedUpload(db, 2, { width: 900, height: 1600 });
  const res = await app.request(`/api/personas/${PERSONA}/photos/front`, {
    method: 'PUT', headers: JSON_AUTH, body: JSON.stringify({ uploadId: path }),
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).code, 'photo_too_small');
});

Deno.test('the training route is gone', async () => {
  const { app } = setup();
  const res = await app.request(`/api/personas/${PERSONA}/train`, {
    method: 'POST', headers: JSON_AUTH, body: '{}',
  });
  assertEquals(res.status, 404);
});
```

Check how `fail()` shapes errors (`{ code, message }` or `{ error: { code } }`) by reading `fail` in `app.ts`, and assert the matching field.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd supabase/functions && deno test --allow-all api/persona_routes_test.ts`
Expected: FAIL (the DTO has no `photos`, and there is no PUT route).

- [ ] **Step 3: Add the fakes** in `supabase/functions/_shared/testing/fakes.ts`, next to `fn_delete_persona`:

```ts
  db.rpcHandlers.fn_reserve_persona = (args, self) => {
    self.tables.personas ??= [];
    const id = `pppppppp-0000-4000-8000-${String(self.tables.personas.length + 1).padStart(12, '0')}`;
    self.tables.personas.push({
      id, user_id: args.p_user, name: args.p_name, status: 'draft',
      photos: {
        front: null, left_three_quarter: null, right_three_quarter: null,
        left_profile: null, right_profile: null,
      },
      consent_attested_at: self.now().toISOString(),
      created_at: self.now().toISOString(), deleted_at: null,
    });
    return { personaId: id };
  };
  db.rpcHandlers.fn_set_persona_photo = (args, self) => {
    const row = (self.tables.personas ?? []).find((r) =>
      r.id === args.p_persona && r.user_id === args.p_user && !r.deleted_at
    );
    if (!row) throw new Error('not_found');
    const photos = { ...(row.photos as Record<string, string | null>) };
    const old = photos[String(args.p_slot)];
    photos[String(args.p_slot)] = String(args.p_path);
    row.photos = photos;
    row.status = Object.values(photos).every((p) => p) ? 'ready' : 'draft';
    return { status: row.status, replaced: !!old && old !== args.p_path };
  };
```

In the existing fake `fn_delete_persona`, delete the `training_jobs` loop and the whole `provider_artifact_deletions` block, so it only tombstones and calls `reap`.

- [ ] **Step 4: Create** `supabase/functions/api/personas.ts`

```ts
// Persona helpers for the api gateway: the slot vocabulary and the DTO.
// A persona is five guided photos; see
// docs/superpowers/specs/2026-09-23-persona-references-design.md.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { PERSONA_SLOT_ORDER, type PersonaSlot } from '../_shared/model-families.ts';

/** Minimum short edge for a persona photo, in pixels. The client enforces it too. */
export const PERSONA_MIN_EDGE = 1024;

export function isPersonaSlot(value: string): value is PersonaSlot {
  return (PERSONA_SLOT_ORDER as readonly string[]).includes(value);
}

export interface PersonaPhotoDto {
  slot: PersonaSlot;
  url: string | null;
}

export interface PersonaDto {
  id: string;
  name: string;
  status: 'draft' | 'ready';
  photos: PersonaPhotoDto[];
  thumbUrl: string;
  createdAt: string;
}

/** The persona's photo paths in slot order; null for an empty slot. */
export function personaPhotoPaths(row: Record<string, unknown>): (string | null)[] {
  const photos = (row.photos ?? {}) as Record<string, string | null>;
  return PERSONA_SLOT_ORDER.map((slot) => photos[slot] ?? null);
}

export async function toPersonaDto(
  admin: SupabaseClient,
  browserUrl: (url: string) => string,
  row: Record<string, unknown>,
): Promise<PersonaDto> {
  const paths = personaPhotoPaths(row);
  const photos: PersonaPhotoDto[] = [];
  for (let i = 0; i < PERSONA_SLOT_ORDER.length; i++) {
    const path = paths[i];
    if (!path) {
      photos.push({ slot: PERSONA_SLOT_ORDER[i], url: null });
      continue;
    }
    const { data } = await admin.storage.from('uploads').createSignedUrl(path, 3600);
    photos.push({ slot: PERSONA_SLOT_ORDER[i], url: browserUrl(data?.signedUrl ?? '') });
  }
  return {
    id: String(row.id),
    name: String(row.name),
    status: row.status === 'ready' ? 'ready' : 'draft',
    photos,
    thumbUrl: photos[0].url ?? '',
    createdAt: String(row.created_at),
  };
}
```

- [ ] **Step 5: Rewrite the routes in `app.ts`**

- Imports: remove `PERSONA_TRAINING`, `PERSONA_TRIGGER` (L34) and `zipSync` (L35). Add `import { isPersonaSlot, PERSONA_MIN_EDGE, toPersonaDto } from "./personas.ts";`.
- Delete the local `toPersonaDto` (L3606–3626). Every call becomes `toPersonaDto(admin, browserUrl, row)`.
- `GET /personas`: `used` counts only `draft` and `ready`:

```ts
    const items = await Promise.all(
      (fresh ?? []).map((row) => toPersonaDto(admin, browserUrl, row)),
    );
    const used = items.filter((p) => p.status === "draft" || p.status === "ready").length;
    return c.json({ items, slots: { used, max } });
```

- `POST /personas`: keep the suspension, plan, name and attestation checks. Replace the count query and the insert with:

```ts
    const { data: reserved, error: reserveErr } = await admin.rpc("fn_reserve_persona", {
      p_user: userId,
      p_key: readIdempotencyKey(c) ?? crypto.randomUUID(),
      p_hash: await bodyHash({ name }),
      p_name: name,
    });
    if (reserveErr?.message?.includes("slot_limit")) {
      return fail(c, 403, "slot_limit", `Your plan allows ${PERSONA_SLOTS[plan]} personas`);
    }
    if (reserveErr || !reserved?.personaId) {
      logError(c, "persona_create_failed", reserveErr ?? new Error("no persona"));
      return fail(c, 503, "create_failed", "Could not create the persona");
    }
    const { data: row } = await admin.from("personas").select("*")
      .eq("id", reserved.personaId).single();
    await admin.from("personas").update({ client: clientOf(c) }).eq("id", reserved.personaId);
    return c.json({ item: await toPersonaDto(admin, browserUrl, row!) });
```

- Delete `POST /personas/:id/train` completely (L3724 to the end of that handler, ~L3870).
- Add, after `DELETE /personas/:id`:

```ts
  /** Put one moderated photo in one slot; the replaced photo is queued for deletion. */
  app.put("/personas/:id/photos/:slot", async (c) => {
    const userId = c.get("userId");
    const personaId = c.req.param("id");
    const slot = c.req.param("slot");
    if (!isPersonaSlot(slot)) {
      return fail(c, 400, "invalid_slot", "Unknown photo slot");
    }
    if (await isSuspended(userId)) {
      return fail(c, 429, "account_suspended", "Account suspended — contact support to appeal.");
    }
    const body = await c.req.json().catch(() => null);
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : "";
    const owned = await resolveOwnedUpload(admin, userId, uploadId, "persona-photo");
    if (typeof owned === "string") return referenceFailure(c, owned);
    if (Math.min(owned.width, owned.height) < PERSONA_MIN_EDGE) {
      return fail(c, 400, "photo_too_small",
        `Use a sharper photo — at least ${PERSONA_MIN_EDGE}px on its short edge.`);
    }
    const { error } = await admin.rpc("fn_set_persona_photo", {
      p_user: userId, p_persona: personaId, p_slot: slot, p_path: owned.path,
    });
    if (error?.message?.includes("not_found")) {
      return fail(c, 404, "not_found", "Persona not found");
    }
    if (error) {
      logError(c, "persona_photo_failed", error);
      return fail(c, 503, "persona_photo_failed", "Could not save the photo — try again.");
    }
    const { data: row } = await admin.from("personas").select("*").eq("id", personaId).single();
    return c.json({ item: await toPersonaDto(admin, browserUrl, row!) });
  });
```

- Upload route (~L3452): after the 50 MP check, add:

```ts
    const purposeField = form?.get("purpose");
    const tooSmallForPersona = purposeField === "persona-photo" &&
      Math.min(dims.width, dims.height) < PERSONA_MIN_EDGE;
    if (tooSmallForPersona) {
      return fail(c, 400, "photo_too_small",
        `Use a sharper photo — at least ${PERSONA_MIN_EDGE}px on its short edge.`);
    }
```

- Fix `deletion_routes_test.ts` L225: rename the test to `'deleting a persona queues its photos and records no provider artifact'`. Seed `photos: { front: \`${TEST_USER}/photo-1.png\`, left_three_quarter: null, right_three_quarter: null, left_profile: null, right_profile: null }` instead of `photo_paths`/`lora_url`, and replace the two artifact assertions with `assertEquals((db.tables.provider_artifact_deletions ?? []).length, 0);`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `cd supabase/functions && deno check api/index.ts && deno test --allow-all api/persona_routes_test.ts api/deletion_routes_test.ts api/dispatch_routes_test.ts`
Expected: PASS.

- [ ] **Step 7: Leave uncommitted.**

---

### Task 5: Generating with a persona — gateway, worker and Google adapter

**Files:**
- Modify: `supabase/functions/api/app.ts` (persona branch L2250–2300, `priceRequest` call ~L2503, `providerCostUsd` L2760, the retry `expressible` check L2102)
- Modify: `supabase/functions/_shared/jobs/payload.ts` (replace `personaLora`)
- Modify: `supabase/functions/_shared/providers/google.ts`
- Create: `supabase/functions/api/persona_generation_test.ts`
- Modify: `supabase/functions/_shared/jobs/payload_test.ts` (persona cases, if any use `lora_url`)

**Interfaces:**
- Consumes:
  - From Task 1: `PERSONA_GEN`, `personaSettings`, `personaGenCreditCost`, `personaProviderCost`, `PERSONA_SLOT_ORDER`.
  - From Task 3: `SubmitCtx.personaPhotos`.
  - From Task 4: `personaPhotoPaths(row)`.
- Produces:
  - `personaPrompt(userPrompt: string): string`, exported from `api/personas.ts`.
  - The Google adapter logs `{"event":"google_usage", model, imageSize, usage}`.

- [ ] **Step 1: Write the failing tests** `supabase/functions/api/persona_generation_test.ts`

```ts
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import { runWorkerTick } from './_shared/testing/worker.ts';
import { personaGenCreditCost } from './_shared/model-families.ts';

const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
const PERSONA = 'pppppppp-0000-4000-8000-000000000001';
const SLOTS = ['front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile'];

async function seed(db: FakeDb, status = 'ready') {
  db.tables.subscriptions = [{
    user_id: TEST_USER, plan: 'studio', status: 'active', current_period_end: '2099-01-01T00:00:00Z',
  }];
  db.tables.models = [
    { id: 'persona', enabled: true, min_plan: 'studio' },
    { id: 'nano-banana', enabled: true, min_plan: 'studio' },
  ];
  const photos: Record<string, string> = {};
  db.tables.uploads = [];
  for (let i = 0; i < SLOTS.length; i++) {
    const path = `${TEST_USER}/aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}.jpg`;
    photos[SLOTS[i]] = path;
    db.tables.uploads.push({
      id: `u${i}`, user_id: TEST_USER, path, purpose: 'persona-photo',
      mime: 'image/jpeg', width: 1536, height: 2048, moderation: 'allowed',
    });
    await db.storage.from('uploads').upload(path, new Uint8Array([1]), { contentType: 'image/jpeg' });
  }
  db.tables.personas = [{
    id: PERSONA, user_id: TEST_USER, name: 'Me', status, photos,
    consent_attested_at: '2026-09-23T00:00:00Z', created_at: '2026-09-23T00:00:00Z', deleted_at: null,
  }];
}

async function submit(db: FakeDb, deps: ReturnType<typeof testDeps>, batch = 1) {
  const app = createApp(deps);
  return await app.request('/api/generations', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      op: 'generate', familyId: 'nano-banana', personaId: PERSONA, prompt: 'on a beach',
      batch, settings: { aspectRatio: '3:4', version: 'fast', resolution: '1K' },
    }),
  });
}

Deno.test('a persona generation is Nano Banana Pro 4K with five labelled photos', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  await seed(db);

  const res = await submit(db, deps);
  assertEquals(res.status, 202);

  const reserve = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!;
  const item = (reserve.args.p_items as Record<string, unknown>[])[0];
  assertEquals(item.familyId, 'persona');
  assertEquals(item.priceCredits, personaGenCreditCost());
  assertEquals(item.prompt, 'on a beach', 'the stored prompt is the customer\'s own');

  await runWorkerTick(db, { adapterFor: () => provider.adapter });
  const sent = provider.submits[0];
  assertEquals(sent.normalized!.providerModel, 'gemini-3-pro-image');
  assertEquals(sent.normalized!.providerSettings.image_size, '4K');
  assertEquals(sent.normalized!.providerSettings.aspect_ratio, '3:4');
  assertEquals(sent.personaPhotos!.map((p) => p.slot), SLOTS);
  assertStringIncludes(sent.prompt, 'Images 1–5 are the same person');
  assertStringIncludes(sent.prompt, 'on a beach');
});

Deno.test('a batch of four is four persona charges', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  const res = await submit(db, deps, 4);
  assertEquals(res.status, 202);
  const reserve = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation')!;
  assertEquals((reserve.args.p_items as unknown[]).length, 4);
});

Deno.test('a draft persona is refused as persona_unavailable', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db, 'draft');
  const res = await submit(db, deps);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).code, 'persona_unavailable');
});

Deno.test('the persona kill switch refuses persona runs only', async () => {
  const deps = testDeps();
  const db = deps.admin as unknown as FakeDb;
  await seed(db);
  db.tables.models = [
    { id: 'persona', enabled: false, min_plan: 'studio' },
    { id: 'nano-banana', enabled: true, min_plan: 'studio' },
  ];
  const res = await submit(db, deps);
  assertEquals(res.status >= 400, true);
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_reserve_generation'), false);
});
```

Adjust `(await res.json()).code` to `fail()`'s actual shape, as in Task 4.

Add to `supabase/functions/_shared/providers/google_test.ts` (create it if it is missing, following the `captureFetch` pattern in `fal_image_test.ts`):

```ts
Deno.test('google: persona photos are sent labelled, in slot order, before the prompt', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const png = btoa('img');
  const cap = captureFetch((url) => {
    if (url.includes(':generateContent')) {
      return Response.json({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }],
        usageMetadata: { promptTokenCount: 3600, thoughtsTokenCount: 1500, candidatesTokenCount: 2000 },
      });
    }
    return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } });
  });
  await googleAdapter.submit({
    familyId: 'persona', op: 'generate', prompt: 'wrapped prompt', settings: {}, safetyId: 's',
    normalized: {
      quoteVersion: 1, catalogVersion: 'x', familyId: 'persona', op: 'generate',
      providerModel: 'gemini-3-pro-image',
      providerSettings: { image_size: '4K', aspect_ratio: '3:4' },
      settings: {}, hasReference: true, hasMask: false,
    },
    personaPhotos: [
      { slot: 'front', url: 'https://x/1' }, { slot: 'left_three_quarter', url: 'https://x/2' },
      { slot: 'right_three_quarter', url: 'https://x/3' }, { slot: 'left_profile', url: 'https://x/4' },
      { slot: 'right_profile', url: 'https://x/5' },
    ],
  });
  cap.restore();
  const body = cap.calls.find((c) => c.url.includes(':generateContent'))!.jsonBody!;
  const parts = (body.contents as { parts: Record<string, unknown>[] }[])[0].parts;
  assertEquals(parts.length, 11, '5 × (label + image) + prompt');
  assertEquals(parts[0].text, 'Image 1: front');
  assertEquals('inline_data' in parts[1], true);
  assertEquals(parts[10].text, 'wrapped prompt');
});
```

If `captureFetch`'s handler signature differs, match the one in `fal_image_test.ts`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd supabase/functions && deno test --allow-all api/persona_generation_test.ts _shared/providers/google_test.ts`
Expected: FAIL (the persona still routes to the old path; there is no `personaPhotos`).

- [ ] **Step 3: Add `personaPrompt`** to `supabase/functions/api/personas.ts`:

```ts
/** The identity instruction Google's docs recommend: say what each image is. */
export function personaPrompt(userPrompt: string): string {
  return 'Images 1–5 are the same person (front, left three-quarter, right three-quarter, ' +
    'left profile, right profile). Keep their face and identity exactly. ' + userPrompt;
}
```

- [ ] **Step 4: Rewrite the gateway persona branch** in `app.ts` (L2250–2300). Replace the `persona` lookup and `effectivePrompt` with:

```ts
    // Persona: owned + ready, generate-op only. Rendered as Nano Banana Pro 4K
    // with the persona's five photos; the server resolves them, never the client.
    let persona: { paths: string[] } | null = null;
    if (personaId) {
      if (op !== GenerationOp.Generate) {
        return fail(c, 400, "invalid_op", "Personas support generate only");
      }
      const { data } = await admin.from("personas")
        .select("status, photos")
        .eq("id", personaId).eq("user_id", userId).is("deleted_at", null)
        .maybeSingle();
      const paths = data ? personaPhotoPaths(data) : [];
      const complete = data?.status === "ready" && paths.every((p) => !!p);
      if (!complete) {
        return fail(c, 400, "persona_unavailable", "That persona is missing or unfinished.");
      }
      persona = { paths: paths as string[] };
      settings = personaSettings(String(settings.aspectRatio ?? "1:1"));
    }

    const effectivePrompt = persona ? personaPrompt(styled) : styled;
```

If `settings` is declared `const`, change it to `let`. If it is built later, apply `personaSettings` at the point where `settings` is final for image families, before `validateSettings` runs.

In the family selection, replace the `else if (persona)` block with:

```ts
    } else if (persona) {
      familyId = PERSONA_GEN.id;
      familyName = PERSONA_GEN.name;
      kind = MediaKind.Image;
      quoteFamily = familyById("nano-banana");
      unitCredits = personaGenCreditCost();
```

Where `priceRequest` is called (~L2503), pass the photo count and keep the persona price:

```ts
    const priced = quoteFamily
      ? priceRequest(c, quoteFamily, op, settings, {
        hasReference: !!referenceUrl || !!persona,
        referenceCount: persona ? persona.paths.length : (referenceUrl ? 1 : 0),
        hasMask: typeof body.maskPngBase64 === "string" ||
          (typeof body.maskUploadId === "string" && !!body.maskUploadId),
      })
      : null;
    if (priced instanceof Response) return priced;
    const normalized = priced?.normalized;
    if (priced && !persona) unitCredits = priced.credits;
```

If `priceRequest`'s input type does not accept `referenceCount`, widen it to `GenerationInput & { hasMask: boolean }` where it is declared.

`normalized.familyId` will be `'nano-banana'`. The payload's `familyId` stays `'persona'`, so `adapterFor('persona')` (Google) runs it. The model gate must check `persona`, not `nano-banana`. Find where `modelGate(familyId)` is called for a new generation and confirm it runs after `familyId = PERSONA_GEN.id`. The kill-switch test proves it.

In `providerCostUsd` (L2760): `if (familyId === PERSONA_GEN.id) return personaProviderCost();`.

Update imports: add `personaSettings` and `personaProviderCost` from `./_shared/model-families.ts`, and `personaPhotoPaths` and `personaPrompt` from `./personas.ts`.

- [ ] **Step 5: Worker payload** — in `_shared/jobs/payload.ts`, replace `personaLora` and its call:

```ts
  const photos = await personaPhotos(deps, job.user_id, payload);
  if (photos.length > 0) ctx.personaPhotos = photos;
```

```ts
const PERSONA_SLOTS_IN_ORDER = [
  'front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile',
] as const;

/** The persona's five photos, signed for this run, in the order the prompt names them. */
async function personaPhotos(
  deps: PayloadDeps,
  userId: string,
  payload: StoredPayload,
): Promise<{ slot: string; url: string }[]> {
  if (!payload.personaId) return [];
  const { data, error } = await deps.admin
    .from('personas')
    .select('status,photos')
    .eq('id', payload.personaId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`persona_lookup_failed: ${error.message}`);
  if (!data || data.status !== 'ready') throw new Error('persona_unavailable');
  const photos = (data.photos ?? {}) as Record<string, string | null>;
  const signed: { slot: string; url: string }[] = [];
  for (const slot of PERSONA_SLOTS_IN_ORDER) {
    const path = photos[slot];
    if (!path) throw new Error('persona_unavailable');
    signed.push({ slot, url: await signUpload(deps, userId, path) });
  }
  return signed;
}
```

Use `PERSONA_SLOT_ORDER` from `../model-families.ts` instead of the local constant if that import already exists in `payload.ts`. `signUpload` must accept a `persona-photo` upload. Read `signUpload` in `payload.ts`: if it resolves with purpose `'reference'`, add an optional `purpose` parameter defaulting to `'reference'` and pass `'persona-photo'` here.

- [ ] **Step 6: Google adapter** — in `google.ts`, rewrite `referenceInline` to take a URL and return the part or null, and build the parts list as:

```ts
    const parts: unknown[] = [];
    for (const [i, photo] of (ctx.personaPhotos ?? []).entries()) {
      const inline = await referenceInline(photo.url);
      if (!inline) throw new Error(`google: persona photo ${photo.slot} unavailable`);
      parts.push({ text: `Image ${i + 1}: ${photo.slot.replaceAll('_', ' ')}` });
      parts.push(inline);
    }
    const ref = await referenceInline(ctx.referenceUrl);
    if (ref) parts.push(ref);
    parts.push({ text: ctx.prompt });
```

The label for `left_three_quarter` then reads "Image 2: left three quarter". The test asserts only `'Image 1: front'`. Keep the prompt last so it follows its images; Google's docs place instructions after the images they refer to.

After `const data = await res.json();`, add:

```ts
    console.log(JSON.stringify({
      event: 'google_usage', model, imageSize: n.providerSettings.image_size ?? null,
      usage: data.usageMetadata ?? null,
    }));
```

**PNG output.** Open https://ai.google.dev/api/generate-content and find `ImageConfig`.
- If it documents an output MIME field (for example `outputMimeType` or `imageOutputOptions.mimeType`), add it for persona requests with the value `image/png`, and add an assertion for it to the google test.
- If there is no such field, change nothing, and write "Gemini API has no output format field; PNG is Google's default inline format" in the spec's section 3, under "Worker and adapter".

- [ ] **Step 7: The retry expressibility check** (L2102) already accepts `PERSONA_GEN.id`. The snapshot keeps `body.familyId` (`nano-banana`) and `personaId`, so a retry re-enters the persona branch and gets `persona_unavailable` when the persona is gone. Add to `api/retry_routes_test.ts` a test that retries a persona generation whose persona row was deleted, and asserts 400 `persona_unavailable`. Use that file's existing seeding helpers.

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `cd supabase/functions && deno check api/index.ts job-worker/index.ts && deno test --allow-all api _shared job-worker`
Expected: PASS. Fix any remaining `lora_url` or `persona_not_ready` references the compiler or tests surface; `grep -rn "lora_url\|persona_not_ready\|loraUrl" supabase/functions --include=*.ts | grep -v node_modules` must print nothing.

- [ ] **Step 9: Leave uncommitted.**

---

### Task 6: Client — persona store, photo prep, manager, picker, composer

**Files:**
- Modify: `src/app/core/enums.ts` (`PersonaStatus` = `Draft`, `Ready`), then `npm run sync-shared`
- Modify: `src/app/core/api/dtos.ts` (`PersonaDto`; remove `TrainPersonaResponse`)
- Modify: `src/app/core/personas/persona-store.ts`, `persona-store.spec.ts`
- Modify: `src/app/core/personas/photo-prep.ts`, `photo-prep.spec.ts`
- Modify: `src/app/features/workspace/persona-manager/persona-manager.{ts,html,css}`
- Modify: `src/app/features/workspace/persona-picker/persona-picker.{html,ts}`, `persona-picker.spec.ts`
- Modify: `src/app/features/workspace/left-panel/left-panel.{ts,html}`, `left-panel.spec.ts`
- Create: `public/personas/guides/silhouette.svg`

**Interfaces:**
- Consumes: the Task 4 API shapes; `PERSONA_SLOT_ORDER`, `PersonaSlot` and `personaGenCreditCost` from Task 1.
- Produces:
  - `PersonaStore.create({name, attested}): Promise<PersonaDto>`.
  - `PersonaStore.setPhoto(id: string, slot: PersonaSlot, uploadId: string): Promise<PersonaDto>`.
  - `PersonaStore.remove(id)`.
  - `prepPhoto(file): Promise<Blob>`, which throws `PhotoTooSmallError` when the short edge is under 1024 px.

- [ ] **Step 1: Write the failing specs**

`src/app/core/personas/photo-prep.spec.ts`, add:

```ts
import { fitWithin, isTooSmall, PERSONA_MAX_EDGE, PERSONA_MIN_EDGE } from './photo-prep';

describe('persona photo sizing', () => {
  it('keeps detail up to 2048px on the long edge', () => {
    expect(PERSONA_MAX_EDGE).toBe(2048);
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(1200, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('rejects a photo under 1024px on its short edge', () => {
    expect(PERSONA_MIN_EDGE).toBe(1024);
    expect(isTooSmall(1000, 3000)).toBe(true);
    expect(isTooSmall(1024, 1024)).toBe(false);
  });
});
```

Update any existing assertion in that spec that expects 1536 as the default edge.

`src/app/core/personas/persona-store.spec.ts`: replace the train and polling specs with:

```ts
  it('setPhoto PUTs the slot and replaces the persona in the list', async () => {
    api.get.mockResolvedValue({ items: [draft], slots: { used: 1, max: 2 } });
    await store.load();
    api.put.mockResolvedValue({ item: { ...draft, status: 'ready' } });
    await store.setPhoto(draft.id, 'front', 'u/1.jpg');
    expect(api.put).toHaveBeenCalledWith(`/personas/${draft.id}/photos/front`, { uploadId: 'u/1.jpg' });
    expect(store.items()[0].status).toBe('ready');
  });
```

Define `draft` as a `PersonaDto`: status `'draft'` and five `{slot, url: null}` photos. Check `ApiService` for a `put` method. If it has none, add one following the pattern of `post` (same headers and error mapping), and mock it in the spec.

`src/app/features/workspace/left-panel/left-panel.spec.ts`: add a spec that, with a ready persona selected in image mode:
- renders the chip text `Persona · Nano Banana Pro · 4K`;
- renders no `Resolution` option group;
- sets `unitCredits()` to `personaGenCreditCost()` and `priceCredits()` to `4 * personaGenCreditCost()` after `setAxis('batch', '4')` (or the file's batch setter).

Follow how the existing persona spec in that file selects a persona.

- [ ] **Step 2: Run the specs and confirm they fail**

Run: `npx ng test --watch=false --include 'src/app/core/personas/*.spec.ts' --include src/app/features/workspace/left-panel/left-panel.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `photo-prep.ts`**

```ts
export const PERSONA_MAX_EDGE = 2048;
export const PERSONA_MIN_EDGE = 1024;
const JPEG_QUALITY = 0.92;

export class PhotoTooSmallError extends Error {
  constructor() {
    super('photo_too_small');
  }
}

/** Target dimensions fitting inside maxEdge, never upscaling. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = PERSONA_MAX_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function isTooSmall(width: number, height: number): boolean {
  return Math.min(width, height) < PERSONA_MIN_EDGE;
}

/** Keep a sharp photo sharp: refuse small ones, cap big ones at 2048px, JPEG 0.92. */
export async function prepPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  if (isTooSmall(bitmap.width, bitmap.height)) {
    bitmap.close();
    throw new PhotoTooSmallError();
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (!blob) throw new Error('photo encode failed');
  return blob;
}
```

- [ ] **Step 4: Implement the DTOs and the store**

`dtos.ts`:

```ts
export interface PersonaPhotoDto {
  slot: PersonaSlot;
  /** Signed URL (1h), or null for an empty slot. */
  url: string | null;
}

export interface PersonaDto {
  id: string;
  name: string;
  status: PersonaStatus;
  photos: PersonaPhotoDto[];
  /** The front photo's signed URL, or ''. */
  thumbUrl: string;
  createdAt: string;
}
```

Import `PersonaSlot` from `../catalog/model-families`. Delete `TrainPersonaResponse`.

`persona-store.ts`: delete `train`, `POLL_MS`, `pollTimer`, `syncPolling` and the `LedgerService` injection. Add:

```ts
  async setPhoto(id: string, slot: PersonaSlot, uploadId: string): Promise<PersonaDto> {
    const res = await this.api.put<{ item: PersonaDto }>(`/personas/${id}/photos/${slot}`, { uploadId });
    this.itemsSig.update((list) => list.map((p) => (p.id === id ? res.item : p)));
    return res.item;
  }
```

Update the class comment to: "API-backed persona list. A persona is ready as soon as its five slots are filled; nothing trains, so nothing polls."

- [ ] **Step 5: Implement the manager**

`persona-manager.ts`: remove `PERSONA_TRAINING`, `LedgerService`, `ProfileStore`, `canAfford`, `canTrain`, `trainNow`, `retry`, `photos`/`WizardPhoto`, `onPhotosPicked` and `removePhoto`. Add:

```ts
  readonly slotOrder = PERSONA_SLOT_ORDER;
  readonly slotLabels: Record<PersonaSlot, string> = {
    front: 'Front',
    left_three_quarter: 'Left ¾',
    right_three_quarter: 'Right ¾',
    left_profile: 'Left profile',
    right_profile: 'Right profile',
  };
  /** The persona being built or edited, or null on the list view. */
  readonly editingId = signal<string | null>(null);
  readonly editing = computed(() => this.personas().find((p) => p.id === this.editingId()) ?? null);
  /** Slot with an upload in flight. */
  readonly uploadingSlot = signal<PersonaSlot | null>(null);
  readonly canCreate = computed(
    () => this.name().trim().length > 0 && this.attested() && !this.busy(),
  );

  guideUrl(slot: PersonaSlot): string {
    return `/personas/guides/${slot}.jpg`;
  }

  onGuideMissing(event: Event): void {
    (event.target as HTMLImageElement).src = '/personas/guides/silhouette.svg';
  }

  async createPersona(): Promise<void> {
    if (!this.canCreate()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const persona = await this.store.create({ name: this.name().trim(), attested: true });
      this.creating.set(false);
      this.editingId.set(persona.id);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      this.error.set(code === 'slot_limit' ? 'All persona slots are in use.' : 'Could not create the persona.');
    } finally {
      this.busy.set(false);
    }
  }

  edit(id: string): void {
    this.editingId.set(id);
    this.error.set('');
  }

  backToList(): void {
    this.editingId.set(null);
    this.error.set('');
  }

  async onSlotPicked(slot: PersonaSlot, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const persona = this.editing();
    if (!file || !persona) return;
    this.error.set('');
    this.uploadingSlot.set(slot);
    try {
      const prepped = await prepPhoto(file);
      const form = new FormData();
      form.append('file', prepped, 'photo.jpg');
      form.append('purpose', 'persona-photo');
      const res = await this.api.postForm<UploadResponse>('/uploads', form);
      await this.store.setPhoto(persona.id, slot, res.uploadId);
    } catch (e) {
      this.error.set(this.uploadMessage(e));
    } finally {
      this.uploadingSlot.set(null);
    }
  }

  private uploadMessage(e: unknown): string {
    if (e instanceof PhotoTooSmallError) return 'Use a sharper, higher-resolution photo (at least 1024px).';
    const code = (e as { code?: string })?.code;
    if (code === 'photo_too_small') return 'Use a sharper, higher-resolution photo (at least 1024px).';
    if (code === 'content_policy') return 'That photo violates our content policy and was rejected.';
    return 'The photo failed to upload — try again.';
  }
```

`cancelCreate()` resets `name`, `attested`, `error` and `creating`. `close()` blocks while `busy()`, `uploadingSlot()` or `itemBusy()` is set. The `remove()` confirm text becomes `'Delete this persona? Its photos are removed and the slot freed.'`. Import `PERSONA_SLOT_ORDER`, `PersonaSlot`, `prepPhoto` and `PhotoTooSmallError`.

`persona-manager.html`: keep the backdrop, dialog, close button, title and slot count. There are three views:

1. **List** (`!creating() && !editing()`). Each row shows the thumb, the name, and `Ready` or `Draft · {{ filledCount(persona) }}/5 photos`. An **Edit** button calls `edit(persona.id)`, and the delete button stays. There is no Retry. The empty state reads: "No personas yet — add five photos of yourself from different angles." Below the list is the **New persona** button, as today.
2. **Create** (`creating()`): the name field, the consent checkbox (same text), Cancel, and a **Continue** button that calls `createPersona()` and is disabled unless `canCreate()`.
3. **Slots** (`editing(); as persona`): a 5-cell `.pm-slots` grid, one cell per slot:

```html
      <div class="pm-slots">
        @for (slot of slotOrder; track slot; let i = $index) {
          <label class="pm-slot" [class.pm-slot-filled]="!!persona.photos[i].url">
            @if (persona.photos[i].url; as url) {
              <img [src]="url" [alt]="slotLabels[slot]" class="pm-slot-img"/>
            } @else {
              <img [src]="guideUrl(slot)" [alt]="'Example: ' + slotLabels[slot]" class="pm-slot-img pm-slot-guide" (error)="onGuideMissing($event)"/>
            }
            @if (uploadingSlot() === slot) {
              <span class="pm-slot-busy"><ng-icon name="lucideLoaderCircle" size="16" class="pm-spin"/></span>
            }
            <span class="pm-slot-label">{{ slotLabels[slot] }}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" class="pm-file-input"
                   [disabled]="uploadingSlot() !== null"
                   (change)="onSlotPicked(slot, $event)"/>
          </label>
        }
      </div>
      <p class="pm-guide">Sharp photos, good light, one person, no sunglasses. Tap a slot to add or replace it.</p>
      @if (persona.status === statuses.Ready) {
        <p class="pm-ready">Ready — choose it in the composer.</p>
      }
      <footer class="pm-actions">
        <button hlmBtn variant="ghost" type="button" (click)="backToList()">Done</button>
      </footer>
```

Add `filledCount(p: PersonaDto): number { return p.photos.filter((x) => !!x.url).length; }` to the component.

`persona-manager.css`: delete the `.pm-grid`, `.pm-cell*`, `.pm-add*` and `.pm-count` rules. Add:

```css
.pm-slots {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.pm-slot {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}

.pm-slot-img {
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.pm-slot-guide {
  opacity: 0.45;
  filter: grayscale(1);
}

.pm-slot-filled .pm-slot-img {
  border-color: var(--primary);
}

.pm-slot-label {
  font-size: 11px;
  color: var(--muted-foreground);
  text-align: center;
}

.pm-slot-busy {
  position: absolute;
  inset: 0 0 18px 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--background) 60%, transparent);
  border-radius: 8px;
}

.pm-ready {
  font-size: 12px;
  color: var(--primary);
}
```

Use the CSS variable names the existing `persona-manager.css` already uses for border, primary, muted and background. If they differ from the ones above, substitute them.

`public/personas/guides/silhouette.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 120"><rect width="90" height="120" fill="#e5e5e5"/><circle cx="45" cy="44" r="20" fill="#bdbdbd"/><path d="M12 120c2-26 16-40 33-40s31 14 33 40z" fill="#bdbdbd"/></svg>
```

- [ ] **Step 6: Implement the picker and the composer**

- `persona-picker.html`: the status labels become `Draft` only. Delete the `Training…` and `Failed` branches. The hint text becomes: "Your saved likeness. Persona images render on Nano Banana Pro at 4K from your five photos — model choice is fixed while a persona is active."
- `left-panel.html`: replace the chip text `Persona — FLUX likeness` with `Persona · Nano Banana Pro · 4K`, and the hint with: "Persona images always render on Nano Banana Pro at 4K using your five photos. Clear the persona to pick a model." Also hide the **Quality** option group while `personaActive()`, wrapping it in `@if (!personaActive())` if it is not already inside the Resolution block.
- `left-panel.ts`: fix the `personaId` comment to "Persona id, null = none. The server renders it on Nano Banana Pro 4K with the persona's photos." `unitCredits` keeps `personaGenCreditCost()`. Rewrite the comment in `setPersona` to: "A persona supplies its own five references; a lingering composer reference would be dropped."
- `persona-picker.spec.ts`: replace the `TRAINING` fixture with a `DRAFT` one, and change `photoCount`/`trainedAt`/`error` fields to the new DTO shape.

- [ ] **Step 7: Run the specs and confirm they pass**

Run: `npm run sync-shared && npx ng test --watch=false`
Expected: all web specs PASS. `grep -rn "PERSONA_TRAINING\|trainedAt\|TrainPersonaResponse\|PersonaStatus.Training\|PersonaStatus.Failed" src/app` prints nothing.

- [ ] **Step 8: Check it in the browser**

Start the staging preview (`preview_start` with the `stage` launch config), sign in as the seeded Studio account, and open **My personas**. Check that:
- the five slots show silhouettes;
- creating a persona and filling a slot with a ≥1024 px photo shows it;
- a smaller photo shows the resolution error;
- with all five filled, the persona reads Ready, and in the composer the chip reads `Persona · Nano Banana Pro · 4K`, the resolution control is hidden, and the price shows 46 × batch.

Take a screenshot for the owner.

- [ ] **Step 9: Leave uncommitted.**

---

### Task 7: Owner-run scripts — guide photos and the likeness test

**Files:**
- Create: `scripts/generate-persona-guides.mjs`
- Create: `scripts/persona-likeness-test.mjs`
- Create: `scripts/persona-scripts.test.mjs`
- Modify: `package.json` (`test:scripts` list; two `persona:*` scripts)

**Interfaces:**
- Produces:
  - `buildGeminiRequest({ prompt, images: {label, mime, base64}[], imageSize, aspectRatio })`, which returns the JSON body.
  - `GUIDE_PROMPTS: Record<PersonaSlot, string>`.
  - `LIKENESS_PROMPT`.
  - `npm run persona:guides` and `npm run persona:likeness -- <photos-dir>`.

- [ ] **Step 1: Write the failing test** `scripts/persona-scripts.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiRequest, GUIDE_PROMPTS } from './generate-persona-guides.mjs';
import { likenessRequests } from './persona-likeness-test.mjs';

test('guide prompts cover the five slots, one fictional adult', () => {
  assert.deepEqual(Object.keys(GUIDE_PROMPTS), [
    'front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile',
  ]);
  for (const p of Object.values(GUIDE_PROMPTS)) assert.match(p, /fictional adult/);
});

test('a gemini request puts labelled images before the prompt', () => {
  const body = buildGeminiRequest({
    prompt: 'go', imageSize: '4K', aspectRatio: '3:4',
    images: [{ label: 'Image 1: front', mime: 'image/jpeg', base64: 'AA' }],
  });
  const parts = body.contents[0].parts;
  assert.equal(parts[0].text, 'Image 1: front');
  assert.equal(parts[1].inline_data.mime_type, 'image/jpeg');
  assert.equal(parts[2].text, 'go');
  assert.deepEqual(body.generationConfig.imageConfig, { image_size: '4K', aspect_ratio: '3:4' });
});

test('the likeness test sends 5 photos to the persona arm and 1 to the normal arm', () => {
  const photos = ['a', 'b', 'c', 'd', 'e'].map((b) => ({ mime: 'image/jpeg', base64: b }));
  const { persona, normal } = likenessRequests(photos);
  const count = (body) => body.contents[0].parts.filter((p) => p.inline_data).length;
  assert.equal(count(persona), 5);
  assert.equal(count(normal), 1);
  assert.match(persona.contents[0].parts.at(-1).text, /same person/);
  assert.doesNotMatch(normal.contents[0].parts.at(-1).text, /same person/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test scripts/persona-scripts.test.mjs`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** `scripts/generate-persona-guides.mjs`

```js
#!/usr/bin/env node
// Owner-run, once: draws the fictional person shown in the five empty persona
// slots. Costs under $1 at 1K. Needs GOOGLE_AI_API_KEY in the environment.
// Output: public/personas/guides/{slot}.jpg (commit them afterwards).
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MODEL = 'gemini-3-pro-image';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PERSON = 'a fictional adult woman in her thirties, shoulder-length dark hair, ' +
  'neutral grey t-shirt, plain light-grey studio background, soft even lighting, ' +
  'natural skin texture, photorealistic';

export const GUIDE_PROMPTS = {
  front: `Head-and-shoulders photo of ${PERSON}, facing the camera directly.`,
  left_three_quarter: `Head-and-shoulders photo of ${PERSON}, head turned 45 degrees to her left.`,
  right_three_quarter: `Head-and-shoulders photo of ${PERSON}, head turned 45 degrees to her right.`,
  left_profile: `Head-and-shoulders photo of ${PERSON}, full left profile, 90 degrees.`,
  right_profile: `Head-and-shoulders photo of ${PERSON}, full right profile, 90 degrees.`,
};

export function buildGeminiRequest({ prompt, images, imageSize, aspectRatio }) {
  const parts = [];
  for (const image of images) {
    parts.push({ text: image.label });
    parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
  }
  parts.push({ text: prompt });
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { image_size: imageSize, aspect_ratio: aspectRatio },
    },
  };
}

export async function callGemini(body) {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error('GOOGLE_AI_API_KEY is not set');
  const res = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData ?? p.inline_data);
  const inline = part?.inlineData ?? part?.inline_data;
  if (!inline?.data) throw new Error('gemini returned no image');
  console.log(JSON.stringify({ event: 'google_usage', usage: data.usageMetadata ?? null }));
  return { mime: inline.mimeType ?? inline.mime_type, base64: inline.data };
}

async function main() {
  const out = 'public/personas/guides';
  await mkdir(out, { recursive: true });
  const front = await callGemini(buildGeminiRequest({
    prompt: GUIDE_PROMPTS.front, images: [], imageSize: '1K', aspectRatio: '3:4',
  }));
  await writeFile(`${out}/front.jpg`, Buffer.from(front.base64, 'base64'));
  for (const [slot, prompt] of Object.entries(GUIDE_PROMPTS)) {
    if (slot === 'front') continue;
    const image = await callGemini(buildGeminiRequest({
      prompt: `Same person as the reference image. ${prompt}`,
      images: [{ label: 'Reference: the same person, front', ...front }],
      imageSize: '1K', aspectRatio: '3:4',
    }));
    await writeFile(`${out}/${slot}.jpg`, Buffer.from(image.base64, 'base64'));
    console.log(`wrote ${slot}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
```

Amended 2026-09-23 (final review): Gemini returns JPEG, so the guides are written as `{slot}.jpg` and the script throws, naming the mime, if the returned type is not `image/jpeg`. The likeness script names its outputs from the returned mime (`.jpg` / `.png`).

- [ ] **Step 4: Implement** `scripts/persona-likeness-test.mjs`

```js
#!/usr/bin/env node
// Owner-run: does the persona setup beat normal use? Same prompt, both 4K.
//   persona: five slot photos + the identity instruction
//   normal:  the front photo alone + the plain prompt
// Costs about $0.52. Needs GOOGLE_AI_API_KEY. Usage:
//   npm run persona:likeness -- <dir with front.jpg left_three_quarter.jpg
//                                right_three_quarter.jpg left_profile.jpg right_profile.jpg>
// Writes <dir>/likeness-persona.png and <dir>/likeness-normal.png. Compare them
// by eye; a clear gain sets PERSONA_GEN.premium in model-families.ts.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildGeminiRequest, callGemini } from './generate-persona-guides.mjs';

const SLOTS = ['front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile'];
export const LIKENESS_PROMPT =
  'A candid photo of this person reading a book in a sunlit café, natural expression.';
const IDENTITY = 'Images 1–5 are the same person (front, left three-quarter, right three-quarter, ' +
  'left profile, right profile). Keep their face and identity exactly. ';

export function likenessRequests(photos) {
  const persona = buildGeminiRequest({
    prompt: IDENTITY + LIKENESS_PROMPT,
    images: photos.map((p, i) => ({ label: `Image ${i + 1}: ${SLOTS[i].replaceAll('_', ' ')}`, ...p })),
    imageSize: '4K', aspectRatio: '3:4',
  });
  const normal = buildGeminiRequest({
    prompt: LIKENESS_PROMPT,
    images: [{ label: 'Reference photo', ...photos[0] }],
    imageSize: '4K', aspectRatio: '3:4',
  });
  return { persona, normal };
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: npm run persona:likeness -- <photos-dir>');
  const photos = [];
  for (const slot of SLOTS) {
    const bytes = await readFile(`${dir}/${slot}.jpg`);
    photos.push({ mime: 'image/jpeg', base64: bytes.toString('base64') });
  }
  const { persona, normal } = likenessRequests(photos);
  const a = await callGemini(persona);
  await writeFile(`${dir}/likeness-persona.png`, Buffer.from(a.base64, 'base64'));
  const b = await callGemini(normal);
  await writeFile(`${dir}/likeness-normal.png`, Buffer.from(b.base64, 'base64'));
  console.log('wrote likeness-persona.png and likeness-normal.png');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
```

- [ ] **Step 5: Wire up `package.json`**

- Append ` scripts/persona-scripts.test.mjs` to the `test:scripts` list.
- Add `"persona:guides": "node scripts/generate-persona-guides.mjs"` and `"persona:likeness": "node scripts/persona-likeness-test.mjs"`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `node --test scripts/persona-scripts.test.mjs && npm run test:scripts`
Expected: PASS. **Do not run** `persona:guides` or `persona:likeness`: they spend real money and are owner-run.

- [ ] **Step 7: Leave uncommitted.**

---

### Task 8: Legal copy, docs, and the full gate run

**Files:**
- Modify: `src/app/features/legal/privacy-page.html`, `terms-page.html`, `acceptable-use-page.html`
- Modify: `CLAUDE.md` (the persona sentence in the Studio expansion bullet), `vansen.md` (the personas paragraph ~L348), `docs/superpowers/plans/post-implementation-review.md` (the checklist item), `docs/superpowers/specs/2026-09-23-persona-references-design.md` (the spec deviation)

- [ ] **Step 1: Privacy page.** In the section that covers Content (~L50) and processors (~L132), add a **Personas** paragraph in the page's existing markup style:

> Personas. If you create a persona, you give us five photos of a face. We keep them until you delete the persona or your account, then delete them. When you generate with a persona, the photos are sent to Google only to create the images you asked for.

Do **not** claim that Google never trains on the data. The spec requires that claim to be checked against Google's paid-tier API terms before it is published; add it only once the owner confirms.

- [ ] **Step 2: Terms and Acceptable use.** Add, next to the impersonation clause (`acceptable-use-page.html` ~L62–65) and in the terms' user-content section:

> A persona may only be of you, or of an adult who has given you permission. Never create a persona of a minor, and never use one to impersonate or deceive anyone.

- [ ] **Step 3: `CLAUDE.md` and `vansen.md`.** Replace the persona description, "Personas = trained FLUX LoRA on fal (5–20 photos, fixed 350 cr, …) … hidden `persona` family routes generation through fal flux-lora with trigger word injected server-side", with:

> Personas = five guided photos (front, left/right ¾, left/right profile; ≥1024px short edge), free to create, Studio 2 / Pro 5 slots, consent recorded. Hidden `persona` family = Google Nano Banana Pro (`gemini-3-pro-image`) at 4K with the five photos as labelled references and an identity instruction, 46 credits per image (`PERSONA_GEN.premium` 1.0 until the owner's likeness test). No training, no provider-held artifact. Spec: `docs/superpowers/specs/2026-09-23-persona-references-design.md`.

Also in `CLAUDE.md`: update the Nano Banana note to say reference images are priced per image (560 tokens) and that Pro carries a provisional 2,000-token thinking allowance.

- [ ] **Step 4: Review checklist.** In `post-implementation-review.md`, change the persona item to state that it is implemented and awaiting deploy, and that the two owner-run scripts are pending:

> - [ ] **Persona as saved references.** Implemented (plan `2026-09-23-persona-references.md`), not yet deployed. After deploy: run `npm run persona:guides` (< $1) and `npm run persona:likeness -- <dir>` (~$0.52), then set `PERSONA_GEN.premium`.

- [ ] **Step 5: Run every gate**

Run:

```bash
npm run db:test:start && VANSEN_LOCAL_DB='postgresql://postgres:postgres@127.0.0.1:54322/postgres' npm run verify; npm run db:test:stop
```

Expected: every row in the `─── verify-all ───` table is `PASS`, and the exit code is 0. If `web unit tests` or `deno tests` fail, read the failure, fix it in the task that owns the file, and re-run.

- [ ] **Step 6: Final sweep**

```bash
grep -rn -i "lora\|flux-lora\|persona_training_credits\|photo_paths\|trigger_word\|/train\b" src supabase/functions scripts --include=*.ts --include=*.html --include=*.mjs | grep -v node_modules
```

Expected: only historical mentions: comments explaining the retirement, and the `persona_training` ledger type in `enums.ts`, which stays for old ledger rows.

- [ ] **Step 7: Leave uncommitted.** Report to the owner: what changed; that the deploy is `./deploy.sh` then `supabase db push --linked` immediately after, once they commit and a pre-check of `select count(*) from public.jobs j join public.generations g on g.id = j.generation_id where g.family_id = 'persona' and j.state <> 'done'` returns 0 (order and reason: `2026-09-20-release-runbook.md` §1, 0032 note); and that the two owner-run scripts are pending.
