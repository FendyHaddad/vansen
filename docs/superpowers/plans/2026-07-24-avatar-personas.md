# Avatar Personas + Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trained FLUX-LoRA likeness personas (upload 5–20 photos → 350-credit training on fal → "me as astronaut" generations) plus a client-only Trends prompt-template gallery.

**Architecture:** New `personas` table + charge/fail RPCs mirror the generation charge/refund pattern. fal's `flux-lora-portrait-trainer` trains (queue API, polled lazily by `GET /personas`); persona generations run through a hidden `persona` model family on `fal-ai/flux-lora` with the persona's trigger word injected server-side before moderation. Trends are a static Angular catalog that prefills the prompt box — no server logic.

**Tech Stack:** Angular 22 signals + Spartan/helm UI, Supabase Edge Functions (Hono/Deno), fal queue API, `npm:fflate` for zip assembly, vitest via `ng test`.

**Spec:** `docs/superpowers/specs/2026-07-24-avatar-persona-design.md`

## Global Constraints

- **NEVER commit, branch, or push. The user makes all commits personally.** End every task by reporting completion and waiting; do not run `git commit`.
- Angular components always use separate `.ts` + `.html` + `.css` files; never inline templates/styles; prefer stylesheet classes over inline `style` attributes.
- Build: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
- Tests: same nvm preamble, then `npx ng test --watch=false`
- Migrations are applied to live project `bnorhcxhvxydkgvcxjad` via MCP `apply_migration` AND saved to `supabase/migrations/` as the record.
- After changing any synced catalog file run `npm run sync-shared`; redeploying `api` must bundle every `_shared/` file including `providers/`.
- Provider keys live only in Edge Function secrets (FAL_API_KEY already set). Never put keys in the repo.
- Fixed prices: persona training 350 credits; persona generation uses the margin formula (`STUDIO_MARGIN = 0.4`) over fal flux-lora cost $0.035 → 6 credits/image. Slots: studio 2 / pro 5 / owner 5.

---

### Task 1: Enums + personas migration

**Files:**
- Modify: `src/app/core/enums.ts` (add `PersonaTraining` ledger type + `PersonaStatus` enum)
- Create: `supabase/migrations/0013_personas.sql`
- Apply via MCP `apply_migration` (project `bnorhcxhvxydkgvcxjad`)

**Interfaces:**
- Produces: `personas` table; RPCs `fn_charge_persona(p_user uuid, p_persona uuid, p_amount int)` (raises `insufficient_balance` / `invalid_persona_status`) and `fn_fail_persona(p_persona uuid, p_error text)`; `models` row `persona`; ledger type `persona_training`; crons `fail_stale_persona_trainings` and extended `purge_lapsed_libraries`.
- Consumes: existing `fn_balances`, `ledger_refund_once` unique index (note-based, `type='refund'`).

- [ ] **Step 1: Add enums to the Angular master**

In `src/app/core/enums.ts`, add to `LedgerType`:

```ts
  PersonaTraining: 'persona_training',
```

and after the `MediaKind` block add:

```ts
export const PersonaStatus = {
  Draft: 'draft',
  Training: 'training',
  Ready: 'ready',
  Failed: 'failed',
} as const;
export type PersonaStatus = (typeof PersonaStatus)[keyof typeof PersonaStatus];
```

- [ ] **Step 2: Run `npm run sync-shared`** so `supabase/functions/_shared/enums.ts` matches. Run tests: `npx ng test --watch=false` (nvm preamble). Expected: PASS (drift guard sees both copies updated).

- [ ] **Step 3: Write `supabase/migrations/0013_personas.sql`**

```sql
-- 0013: avatar personas — trained FLUX LoRA likeness (spec 2026-07-24)

create table public.personas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft','training','ready','failed')),
  photo_paths jsonb not null default '[]',
  lora_url text,
  trigger_word text,
  provider_ref text,
  error text,
  charged_plan integer not null default 0,
  charged_pack integer not null default 0,
  training_started_at timestamptz,
  created_at timestamptz not null default now(),
  trained_at timestamptz
);
create index personas_user_idx on public.personas (user_id, created_at desc);
alter table public.personas enable row level security;

-- Kill switch row (hidden family; studio floor).
insert into public.models (id, enabled, min_plan) values ('persona', true, 'studio');

-- New ledger type for the fixed training fee.
alter table public.ledger_entries drop constraint ledger_entries_type_check;
alter table public.ledger_entries add constraint ledger_entries_type_check
  check (type in ('generate','edit','upscale','refund','pack_purchase','cycle_reset',
                  'pack_expiry','promo','persona_training'));

-- Charge training: plan bucket first, then pack (mirrors fn_charge_and_generate).
create or replace function public.fn_charge_persona(p_user uuid, p_persona uuid, p_amount int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_plan int; v_pack int; v_owner boolean; v_from_plan int; v_from_pack int; v_status text;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select status into v_status from public.personas where id = p_persona and user_id = p_user;
  if v_status is null or v_status not in ('draft','failed') then
    raise exception 'invalid_persona_status' using errcode = 'P0001';
  end if;
  select exists (
    select 1 from public.subscriptions
    where user_id = p_user and plan = 'owner' and status = 'active'
  ) into v_owner;
  select bal.plan_credits, bal.pack_credits into v_plan, v_pack
    from public.fn_balances(p_user) bal;
  if not v_owner and v_plan + v_pack < p_amount then
    raise exception 'insufficient_balance' using errcode = 'P0001';
  end if;
  v_from_plan := case when v_owner then p_amount else least(greatest(v_plan, 0), p_amount) end;
  v_from_pack := p_amount - v_from_plan;
  if v_from_plan > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, 'persona_training', 'plan', -v_from_plan, 'persona', 'Persona training');
  end if;
  if v_from_pack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, family_id, note)
    values (p_user, 'persona_training', 'pack', -v_from_pack, 'persona', 'Persona training');
  end if;
  update public.personas
    set status = 'training', error = null,
        charged_plan = v_from_plan, charged_pack = v_from_pack,
        training_started_at = now()
    where id = p_persona;
end $$;

-- Fail + refund once per bucket (ledger_refund_once covers the notes).
create or replace function public.fn_fail_persona(p_persona uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_status text; v_cp int; v_cpack int;
begin
  select user_id, status, charged_plan, charged_pack into v_user, v_status, v_cp, v_cpack
    from public.personas where id = p_persona;
  if v_status is distinct from 'training' then return; end if;
  update public.personas set status = 'failed', error = p_error where id = p_persona;
  if v_cp > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'plan', v_cp, 'refund:persona:' || p_persona::text || ':plan')
    on conflict do nothing;
  end if;
  if v_cpack > 0 then
    insert into public.ledger_entries (user_id, type, bucket, amount_credits, note)
    values (v_user, 'refund', 'pack', v_cpack, 'refund:persona:' || p_persona::text || ':pack')
    on conflict do nothing;
  end if;
end $$;

revoke execute on function public.fn_charge_persona(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.fn_fail_persona(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_charge_persona(uuid, uuid, int) to service_role;
grant execute on function public.fn_fail_persona(uuid, text) to service_role;

-- Training runs ~2–5 min; sweep anything stuck past 30.
select cron.schedule('fail_stale_persona_trainings', '*/5 * * * *', $$
  select public.fn_fail_persona(p.id, 'timeout')
  from public.personas p
  where p.status = 'training' and p.training_started_at < now() - interval '30 minutes'
$$);

-- Same-name reschedule replaces the job: lapsed purge now also drops personas.
select cron.schedule('purge_lapsed_libraries', '0 3 * * *', $$
  delete from public.generations g
  using public.subscriptions s
  where s.user_id = g.user_id
    and s.status in ('canceled','expired')
    and s.current_period_end < now() - interval '30 days';
  delete from public.personas p
  using public.subscriptions s
  where s.user_id = p.user_id
    and s.status in ('canceled','expired')
    and s.current_period_end < now() - interval '30 days'
$$);
```

- [ ] **Step 4: Apply via MCP** — `apply_migration` with name `personas` and the SQL above. Expected: success.
- [ ] **Step 5: Verify** — `execute_sql`: `select id, enabled, min_plan from models where id = 'persona'; select jobname from cron.job where jobname in ('fail_stale_persona_trainings','purge_lapsed_libraries');` Expected: one `persona` row (enabled, studio) and both cron jobs.
- [ ] **Step 6: Report done. User commits.**

---

### Task 2: Persona pricing constants in the model catalog

**Files:**
- Modify: `src/app/core/catalog/model-families.ts` (after the `UPSCALER` block, ~line 331)
- Test: `src/app/core/catalog/model-families.spec.ts` (append)

**Interfaces:**
- Produces: `PERSONA_GEN = { id: 'persona', name: 'Persona', providerCost: 0.035 }`, `PERSONA_TRAINING = { creditCost: 350, providerCost: 2.0, minPhotos: 5, maxPhotos: 20 }`, `PERSONA_SLOTS: Record<'studio'|'pro'|'owner', number>`, `personaGenCreditCost(): number` (= 6).
- Consumed by: api gateway (Task 5–7), left panel (Task 9), persona manager (Task 10).

- [ ] **Step 1: Write the failing tests** — append to `model-families.spec.ts`:

```ts
import {
  PERSONA_GEN,
  PERSONA_SLOTS,
  PERSONA_TRAINING,
  personaGenCreditCost,
} from './model-families';

describe('persona pricing', () => {
  it('prices a persona generation with the margin formula', () => {
    // ceil(0.035 / 0.6 * 100) = 6 credits
    expect(personaGenCreditCost()).toBe(6);
    expect(PERSONA_GEN.id).toBe('persona');
  });

  it('fixes training at 350 credits with a positive margin over provider cost', () => {
    expect(PERSONA_TRAINING.creditCost).toBe(350);
    expect(PERSONA_TRAINING.creditCost / 100).toBeGreaterThan(PERSONA_TRAINING.providerCost);
    expect(PERSONA_TRAINING.minPhotos).toBe(5);
    expect(PERSONA_TRAINING.maxPhotos).toBe(20);
  });

  it('grants slots per plan', () => {
    expect(PERSONA_SLOTS.studio).toBe(2);
    expect(PERSONA_SLOTS.pro).toBe(5);
    expect(PERSONA_SLOTS.owner).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL** (`personaGenCreditCost` not exported).
- [ ] **Step 3: Implement** — in `model-families.ts` directly under the `UPSCALER` const:

```ts
/** Hidden persona pipeline — fal flux-lora with the user's trained LoRA weights.
 * Not in the picker; selected implicitly when a persona is active. */
export const PERSONA_GEN = {
  id: 'persona',
  name: 'Persona',
  // fal-ai/flux-lora ≈ $0.035 per ~1MP image (verify on first live bill).
  providerCost: 0.035,
} as const;

/** Persona LoRA training — fixed retail like EDIT_TOOLS (~$2 fal trainer cost). */
export const PERSONA_TRAINING = {
  creditCost: 350,
  providerCost: 2.0,
  minPhotos: 5,
  maxPhotos: 20,
} as const;

/** Concurrent persona slots per plan. */
export const PERSONA_SLOTS: Record<'studio' | 'pro' | 'owner', number> = {
  studio: 2,
  pro: 5,
  owner: 5,
};

export function personaGenCreditCost(): number {
  return Math.ceil((PERSONA_GEN.providerCost / (1 - STUDIO_MARGIN)) * 100);
}
```

- [ ] **Step 4: Run tests, verify PASS.** Then `npm run sync-shared` and re-run tests (drift guard). Expected: PASS.
- [ ] **Step 5: Report done. User commits.**

---

### Task 3: Trend presets catalog

**Files:**
- Create: `src/app/core/catalog/trend-presets.ts`
- Test: `src/app/core/catalog/trend-presets.spec.ts`

**Interfaces:**
- Produces: `TrendPreset { id, name, prompt, thumb, aspectRatio? }`, `TREND_PRESETS: TrendPreset[]` (12), `trendById(id): TrendPreset | null`. Client-only — NOT added to `scripts/sync-shared.mjs`.

- [ ] **Step 1: Write the failing tests** — `trend-presets.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MODEL_FAMILIES } from './model-families';
import { TREND_PRESETS, trendById } from './trend-presets';

const IMAGE_ARS = MODEL_FAMILIES.find((f) => f.id === 'flux')!.capabilities.aspectRatios;

describe('trend presets', () => {
  it('ships 12 unique trends with non-empty prompts and thumbs', () => {
    expect(TREND_PRESETS.length).toBe(12);
    expect(new Set(TREND_PRESETS.map((t) => t.id)).size).toBe(12);
    for (const t of TREND_PRESETS) {
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(t.thumb).toBe(`/trends/${t.id}.webp`);
    }
  });

  it('suggested aspect ratios are valid image ARs', () => {
    for (const t of TREND_PRESETS) {
      if (t.aspectRatio) expect(IMAGE_ARS).toContain(t.aspectRatio);
    }
  });

  it('resolves by id and rejects unknowns', () => {
    expect(trendById('astronaut')?.name).toBe('Astronaut');
    expect(trendById('nope')).toBeNull();
  });
});
```

(If existing catalog specs don't import from `vitest`, match their import style.)

- [ ] **Step 2: Run tests, verify FAIL** (module missing).
- [ ] **Step 3: Implement** — `trend-presets.ts`:

```ts
/**
 * Trend presets — curated persona prompt templates ("trending" gallery).
 * CLIENT-ONLY: picking a trend prefills the editable prompt box; the server
 * never sees a trend id. Templates are persona-neutral — the persona trigger
 * word is injected server-side exactly as for free-form prompts.
 */

export interface TrendPreset {
  id: string;
  name: string;
  /** Prefilled into the prompt box (editable). */
  prompt: string;
  /** Example-output thumbnail (public/trends/<id>.webp served at /trends/). */
  thumb: string;
  /** Suggested aspect ratio applied on pick; user can change it. */
  aspectRatio?: string;
}

const t = (id: string, name: string, prompt: string, aspectRatio?: string): TrendPreset => ({
  id,
  name,
  prompt,
  thumb: `/trends/${id}.webp`,
  aspectRatio,
});

export const TREND_PRESETS: TrendPreset[] = [
  t('90s-yearbook', '90s Yearbook', 'portrait as a 1990s high school yearbook photo, retro laser beam studio backdrop, soft focus, vintage color grade, feathered hairstyle', '3:4'),
  t('action-figure', 'Action Figure', 'as a boxed action figure toy in blister pack packaging, accessories in molded tray, product photography on a toy store shelf', '3:4'),
  t('astronaut', 'Astronaut', 'as an astronaut in a detailed white space suit, helmet under one arm, dramatic lighting inside a space station, Earth visible through the window', '3:4'),
  t('anime-portrait', 'Anime Portrait', 'wholesome hand-painted anime film style portrait, painterly meadow background, gentle warm light, soft wind in the hair', '3:4'),
  t('renaissance', 'Renaissance', 'renaissance oil painting portrait in period noble clothing, chiaroscuro lighting, ornate gilded frame, museum quality', '3:4'),
  t('cyberpunk-street', 'Cyberpunk', 'standing in a neon-lit cyberpunk street at night, holographic signs, rain-slick pavement, cinematic teal and magenta glow', '3:4'),
  t('red-carpet', 'Red Carpet', 'on a red carpet at a film premiere, elegant evening wear, paparazzi camera flashes, glamour photography', '3:4'),
  t('linkedin-headshot', 'Pro Headshot', 'professional corporate headshot, tailored blazer, softbox studio lighting, neutral gray backdrop, confident natural smile', '1:1'),
  t('doll-box', 'Doll Box', 'as a fashion doll inside retail box packaging, pastel pink accents, matching accessories in a molded tray, glossy product shot', '3:4'),
  t('pixel-avatar', 'Pixel Avatar', 'as a 16-bit pixel art game character, sprite style, limited retro palette, simple scenic game background', '1:1'),
  t('movie-poster', 'Movie Poster', 'as the hero on a dramatic action movie poster, bold title typography, explosion backdrop, cinematic teal-orange grade', '3:4'),
  t('medieval-knight', 'Knight', 'as a medieval knight in polished plate armor, castle courtyard at golden hour, epic fantasy lighting', '3:4'),
];

export function trendById(id: string): TrendPreset | null {
  return TREND_PRESETS.find((p) => p.id === id) ?? null;
}
```

- [ ] **Step 4: Run tests, verify PASS.**
- [ ] **Step 5: Report done. User commits.**

---

### Task 4: fal adapter — flux-lora inference + training helpers

**Files:**
- Modify: `supabase/functions/_shared/providers/types.ts` (SubmitCtx)
- Modify: `supabase/functions/_shared/providers/fal.ts`
- Modify: `supabase/functions/_shared/providers/index.ts` (family map)

These are server-only files (not synced), so verification is type-level: `deno check` if available, else careful review + the live smoke in Task 12.

**Interfaces:**
- Produces: `SubmitCtx.loraUrl?: string`; `PERSONA_TRIGGER = 'VNSNPRSN'`; `submitPersonaTraining(zipUrl: string): Promise<string>` (returns providerRef JSON `{statusUrl, responseUrl}`); `type TrainingCheck = {state:'running'} | {state:'failed'; error:string} | {state:'done'; loraUrl:string}`; `checkPersonaTraining(providerRef: string): Promise<TrainingCheck>`; `adapterFor('persona')` → falAdapter.
- Consumed by: api gateway Tasks 6–7.

- [ ] **Step 1: SubmitCtx** — in `types.ts` after `maskPngBase64`:

```ts
  /** fal-hosted LoRA weights URL for persona generations (familyId 'persona'). */
  loraUrl?: string;
```

- [ ] **Step 2: Inference support in `fal.ts`** — add to `slugFor` (before the final `throw`):

```ts
  if (ctx.familyId === 'persona') return 'fal-ai/flux-lora';
```

Add above `payloadFor`:

```ts
/** Our aspect ratios → fal image_size presets (~1MP each). */
const PERSONA_SIZES: Record<string, string> = {
  '1:1': 'square_hd',
  '3:4': 'portrait_4_3',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '16:9': 'landscape_16_9',
};
```

Add to `payloadFor` (before the generic `const body` block):

```ts
  if (ctx.familyId === 'persona') {
    return {
      prompt: ctx.prompt,
      image_size: PERSONA_SIZES[aspect] ?? 'square_hd',
      loras: [{ path: ctx.loraUrl, scale: 1 }],
      num_images: 1,
      output_format: 'png',
    };
  }
```

- [ ] **Step 3: Training helpers in `fal.ts`** — append at the bottom:

```ts
// --- Persona LoRA training (queue API, polled by GET /personas) -------------

const TRAINER_SLUG = 'fal-ai/flux-lora-portrait-trainer';

/** Fixed trigger phrase baked into every persona's captions; the api gateway
 * prepends it to persona prompts. Stored per-persona for forward-compat. */
export const PERSONA_TRIGGER = 'VNSNPRSN';

export async function submitPersonaTraining(zipUrl: string): Promise<string> {
  const res = await fetch(`${FAL_BASE}/${TRAINER_SLUG}`, {
    method: 'POST',
    headers: await auth(),
    body: JSON.stringify({
      images_data_url: zipUrl,
      trigger_phrase: PERSONA_TRIGGER,
      steps: 1000,
      subject_crop: true,
    }),
  });
  if (!res.ok) throw new Error(`fal training submit ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify({ statusUrl: data.status_url, responseUrl: data.response_url });
}

export type TrainingCheck =
  | { state: 'running' }
  | { state: 'failed'; error: string }
  | { state: 'done'; loraUrl: string };

export async function checkPersonaTraining(providerRef: string): Promise<TrainingCheck> {
  const ref = JSON.parse(providerRef) as { statusUrl?: string; responseUrl?: string };
  if (!ref.statusUrl?.startsWith(FAL_BASE) || !ref.responseUrl?.startsWith(FAL_BASE)) {
    return { state: 'failed', error: 'fal ref missing queue urls' };
  }
  const statusRes = await fetch(ref.statusUrl, { headers: { Authorization: `Key ${key()}` } });
  if (!statusRes.ok) return { state: 'failed', error: `fal status ${statusRes.status}` };
  const status = await statusRes.json();
  if (status.status !== 'COMPLETED') {
    if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') return { state: 'running' };
    return { state: 'failed', error: `fal status ${status.status}` };
  }
  const resultRes = await fetch(ref.responseUrl, { headers: { Authorization: `Key ${key()}` } });
  if (!resultRes.ok) {
    return { state: 'failed', error: `fal result ${resultRes.status}` };
  }
  const result = await resultRes.json();
  const loraUrl = result.diffusers_lora_file?.url;
  if (!loraUrl) return { state: 'failed', error: 'fal training result had no lora file' };
  return { state: 'done', loraUrl };
}
```

- [ ] **Step 4: Family map** — in `providers/index.ts` add to `BY_FAMILY`:

```ts
  persona: falAdapter,
```

- [ ] **Step 5: Report done. User commits.**

---

### Task 5: API — persona CRUD (`POST/GET/DELETE /personas`)

**Files:**
- Modify: `supabase/functions/api/index.ts` (new endpoints after `/uploads`, ~line 1259)

**Interfaces:**
- Consumes: `PERSONA_SLOTS`, `PERSONA_TRAINING` from `./_shared/model-families.ts`; `checkPersonaTraining` from `./_shared/providers/fal.ts`; existing `activePlan`, `fail`, `logError`.
- Produces REST contract (mirrored client-side in Task 8):
  - `GET /personas` → `{ items: PersonaDto[], slots: { used: number, max: number } }`
  - `POST /personas` body `{ name: string, attested: true }` → `{ item: PersonaDto }`
  - `DELETE /personas/:id` → `{ ok: true }`
  - `PersonaDto = { id, name, status, photoCount, thumbUrl, error, createdAt, trainedAt }`

- [ ] **Step 1: Imports** — extend the existing `./_shared/model-families.ts` import with `PERSONA_GEN, PERSONA_SLOTS, PERSONA_TRAINING, personaGenCreditCost`, and add:

```ts
import { PERSONA_TRIGGER, checkPersonaTraining, submitPersonaTraining } from './_shared/providers/fal.ts';
import { zipSync } from 'npm:fflate@0.8.2';
```

(`submitPersonaTraining`/`zipSync`/`PERSONA_TRIGGER` are used in Task 6; adding imports once here keeps the diff simple.)

- [ ] **Step 2: DTO helper + endpoints** — insert after the `/uploads` route:

```ts
async function toPersonaDto(row: Record<string, unknown>) {
  const photos = (row.photo_paths as string[]) ?? [];
  let thumbUrl = '';
  if (photos[0]) {
    const { data } = await admin.storage.from('uploads').createSignedUrl(photos[0], 3600);
    thumbUrl = data?.signedUrl ?? '';
  }
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    photoCount: photos.length,
    thumbUrl,
    error: row.error,
    createdAt: row.created_at,
    trainedAt: row.trained_at,
  };
}

/** List personas; lazily settle any in-flight trainings (same pattern as GET /jobs). */
app.get('/personas', async (c) => {
  const userId = c.get('userId');
  const { data: rows } = await admin
    .from('personas')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  let changed = false;
  for (const row of rows ?? []) {
    if (row.status !== 'training' || !row.provider_ref) continue;
    try {
      const check = await checkPersonaTraining(row.provider_ref);
      if (check.state === 'done') {
        await admin
          .from('personas')
          .update({ status: 'ready', lora_url: check.loraUrl, trained_at: new Date().toISOString() })
          .eq('id', row.id);
        changed = true;
      } else if (check.state === 'failed') {
        await admin.rpc('fn_fail_persona', { p_persona: row.id, p_error: check.error });
        changed = true;
      }
    } catch (e) {
      logError(c, 'persona_check_failed', e);
    }
  }
  const { data: fresh } = changed
    ? await admin.from('personas').select('*').eq('user_id', userId).order('created_at', { ascending: false })
    : { data: rows };

  const plan = await activePlan(userId);
  const max = plan ? PERSONA_SLOTS[plan] : 0;
  const items = await Promise.all((fresh ?? []).map(toPersonaDto));
  return c.json({ items, slots: { used: items.length, max } });
});

app.post('/personas', async (c) => {
  const userId = c.get('userId');
  if (await isSuspended(userId)) {
    return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
  }
  const plan = await activePlan(userId);
  if (!plan) return fail(c, 403, 'studio_required', 'Personas require an active subscription.');
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === 'string'
    ? body.name.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
    : '';
  if (!name || name.length > 40) {
    return fail(c, 400, 'invalid_payload', 'name required (max 40 chars)');
  }
  if (body?.attested !== true) {
    return fail(c, 400, 'invalid_payload', 'Consent attestation is required');
  }
  const { count } = await admin
    .from('personas')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if ((count ?? 0) >= PERSONA_SLOTS[plan]) {
    return fail(c, 403, 'slot_limit', `Your plan allows ${PERSONA_SLOTS[plan]} personas`);
  }
  const { data: row, error } = await admin
    .from('personas')
    .insert({ user_id: userId, name })
    .select('*')
    .single();
  if (error || !row) return fail(c, 400, 'create_failed', 'Could not create the persona');
  return c.json({ item: await toPersonaDto(row) });
});

app.delete('/personas/:id', async (c) => {
  const userId = c.get('userId');
  const { data: rows, error } = await admin
    .from('personas')
    .delete()
    .eq('id', c.req.param('id'))
    .eq('user_id', userId)
    .select('id, photo_paths');
  if (error) return fail(c, 400, 'delete_failed', error.message);
  const row = rows?.[0];
  if (!row) return fail(c, 404, 'not_found', 'Persona not found');
  const paths = [...((row.photo_paths as string[]) ?? []), `persona-zips/${userId}/${row.id}.zip`];
  await admin.storage.from('uploads').remove(paths); // best-effort cleanup
  return c.json({ ok: true });
});
```

- [ ] **Step 3: Report done. User commits.** (Endpoint behavior verified by live smoke in Task 12 — no Deno endpoint harness exists.)

---

### Task 6: API — training endpoint (`POST /personas/:id/train`)

**Files:**
- Modify: `supabase/functions/api/index.ts` (after `DELETE /personas/:id`)

**Interfaces:**
- Consumes: `fn_charge_persona`, `fn_fail_persona` RPCs (Task 1), `submitPersonaTraining`/`PERSONA_TRIGGER` (Task 4), `zipSync` (imported Task 5), `PERSONA_TRAINING` limits.
- Produces: `POST /personas/:id/train` body `{ photoUploadIds: string[] }` → `{ item: PersonaDto, credits: CreditsDto }`. Errors: `studio_required` 403, `invalid_payload` 400, `insufficient_credits` 402, `train_failed` 400/502.

- [ ] **Step 1: Implement the endpoint**

```ts
/** Charge 350 credits, zip the moderated photos, submit fal LoRA training. */
app.post('/personas/:id/train', async (c) => {
  const userId = c.get('userId');
  const personaId = c.req.param('id');
  if (await isSuspended(userId)) {
    return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
  }
  if (!(await activePlan(userId))) {
    return fail(c, 403, 'studio_required', 'Personas require an active subscription.');
  }
  const body = await c.req.json().catch(() => null);
  const photoIds = Array.isArray(body?.photoUploadIds)
    ? (body.photoUploadIds as unknown[]).filter(
        (p): p is string => typeof p === 'string' && p.startsWith(`${userId}/`),
      )
    : [];
  if (
    photoIds.length < PERSONA_TRAINING.minPhotos ||
    photoIds.length > PERSONA_TRAINING.maxPhotos ||
    new Set(photoIds).size !== photoIds.length
  ) {
    return fail(
      c, 400, 'invalid_payload',
      `Between ${PERSONA_TRAINING.minPhotos} and ${PERSONA_TRAINING.maxPhotos} unique photos required`,
    );
  }

  // Fetch every photo BEFORE charging — a bad reference must not cost credits.
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < photoIds.length; i++) {
    const { data: blob, error } = await admin.storage.from('uploads').download(photoIds[i]);
    if (error || !blob) return fail(c, 400, 'invalid_payload', 'A photo could not be read');
    files[`photo_${String(i + 1).padStart(2, '0')}.jpg`] = new Uint8Array(await blob.arrayBuffer());
  }

  const { error: chargeErr } = await admin.rpc('fn_charge_persona', {
    p_user: userId,
    p_persona: personaId,
    p_amount: PERSONA_TRAINING.creditCost,
  });
  if (chargeErr) {
    if (chargeErr.message.includes('insufficient_balance')) {
      return fail(c, 402, 'insufficient_credits', 'Not enough credits for training');
    }
    if (chargeErr.message.includes('invalid_persona_status')) {
      return fail(c, 400, 'train_failed', 'Persona not found or already training');
    }
    logError(c, 'persona_charge_failed', new Error(chargeErr.message));
    return fail(c, 400, 'charge_failed', 'Charge could not be completed');
  }

  try {
    const zip = zipSync(files, { level: 0 }); // JPEGs don't compress
    const zipPath = `persona-zips/${userId}/${personaId}.zip`;
    const { error: upErr } = await admin.storage.from('uploads').upload(zipPath, zip, {
      contentType: 'application/zip',
      upsert: true,
    });
    if (upErr) throw new Error(`zip upload: ${upErr.message}`);
    const { data: signed } = await admin.storage.from('uploads').createSignedUrl(zipPath, 3600);
    if (!signed?.signedUrl) throw new Error('zip sign failed');
    const providerRef = await submitPersonaTraining(signed.signedUrl);
    await admin
      .from('personas')
      .update({ provider_ref: providerRef, photo_paths: photoIds, trigger_word: PERSONA_TRIGGER })
      .eq('id', personaId);
  } catch (e) {
    logError(c, 'persona_train_submit_failed', e);
    await admin.rpc('fn_fail_persona', { p_persona: personaId, p_error: String(e).slice(0, 500) });
    return fail(c, 502, 'train_failed', 'Training could not be started — credits refunded');
  }

  const { data: row } = await admin.from('personas').select('*').eq('id', personaId).single();
  return c.json({ item: await toPersonaDto(row!), credits: await creditsOf(userId) });
});
```

- [ ] **Step 2: Report done. User commits.**

---

### Task 7: API — persona generations (`personaId` on `POST /generations`)

**Files:**
- Modify: `supabase/functions/api/index.ts` — `POST /generations` handler (~lines 642–824)

**Interfaces:**
- Consumes: `PERSONA_GEN`, `personaGenCreditCost` (Task 2), `SubmitCtx.loraUrl` (Task 4).
- Produces: request body accepts `personaId?: string`; effective prompt = `"<trigger_word>, " + styled prompt`; `settings.persona = personaId` persisted; family `persona` (kill-switch row from Task 1 applies via existing `modelGate`).

- [ ] **Step 1: Parse + validate persona** — after the `styleId` line (~652) add:

```ts
  const personaId = typeof body.personaId === 'string' && body.personaId ? body.personaId : null;
```

After the suspension + subscription gates (below the `activePlan` check, ~680), add:

```ts
  // Persona: owned + ready, generate-op only. Routes to the hidden flux-lora family.
  let persona: { lora_url: string; trigger_word: string } | null = null;
  if (personaId) {
    if (op !== GenerationOp.Generate) {
      return fail(c, 400, 'invalid_op', 'Personas support generate only');
    }
    const { data } = await admin
      .from('personas')
      .select('status, lora_url, trigger_word')
      .eq('id', personaId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!data || data.status !== 'ready' || !data.lora_url) {
      return fail(c, 400, 'persona_not_ready', 'Persona not found or not ready');
    }
    persona = { lora_url: data.lora_url, trigger_word: data.trigger_word ?? '' };
  }
```

- [ ] **Step 2: Family resolution** — change the `if (op === GenerationOp.Upscale)` chain to insert a persona branch:

```ts
  if (op === GenerationOp.Upscale) {
    // ... existing upscaler block unchanged
  } else if (persona) {
    familyId = PERSONA_GEN.id;
    familyName = PERSONA_GEN.name;
    kind = MediaKind.Image;
    unitCredits = personaGenCreditCost();
  } else {
    // ... existing editTool / family block unchanged
  }
```

- [ ] **Step 3: Trigger injection + settings** — replace the single `const effectivePrompt = applyStyle(prompt, styleId);` line with:

```ts
  // Boosted prompt is what moderation and the provider see; the stored prompt
  // stays the user's text. Persona trigger word leads so the LoRA locks on.
  const styled = applyStyle(prompt, styleId);
  const effectivePrompt = persona ? `${persona.trigger_word}, ${styled}` : styled;
```

(Note: `persona` must be resolved before this line — place the Step 1 persona block accordingly, before the moderation gate.) Next to `if (styleId) settings.style = styleId;` add:

```ts
  if (personaId && persona) settings.persona = personaId;
```

`settings.persona` needs a type home: in `model-families.ts` `GenerationSettings`, add below `style`:

```ts
  /** Persona id used for this generation. Set server-side; likeness pipeline. */
  persona?: string;
```

(then `npm run sync-shared` + run tests for drift.)

- [ ] **Step 4: Pass the LoRA to the adapter** — in the submit loop, extend the `adapter.submit({...})` call:

```ts
        loraUrl: persona?.lora_url,
```

- [ ] **Step 5: Run `npx ng test --watch=false`** (drift guard + catalog tests). Expected: PASS. Report done. User commits.

---

### Task 8: Client — DTOs, prefs, PersonaStore

**Files:**
- Modify: `src/app/core/api/dtos.ts`
- Modify: `src/app/core/preferences/preferences-service.ts` (Prefs + DEFAULTS)
- Modify: `supabase/functions/api/index.ts` `PREF_CHECKS` (~line 132)
- Create: `src/app/core/personas/persona-store.ts`
- Test: `src/app/core/personas/persona-store.spec.ts`

**Interfaces:**
- Produces:
  - `PersonaDto { id: string; name: string; status: PersonaStatus; photoCount: number; thumbUrl: string; error: string | null; createdAt: string; trainedAt: string | null }`
  - `PersonasResponse { items: PersonaDto[]; slots: { used: number; max: number } }`
  - `CreateGenerationRequest.personaId?: string`
  - `Prefs.defaultPersona: string` (`''` = none)
  - `PersonaStore`: `items`, `slots`, `loaded` signals; `load()`, `create(name)`, `train(id, photoUploadIds)`, `remove(id)`, `readyById(id)`, auto-polling every 10 s while any persona is `training`.

- [ ] **Step 1: DTOs** — in `dtos.ts` import `PersonaStatus` from `../enums` and add:

```ts
export interface PersonaDto {
  id: string;
  name: string;
  status: PersonaStatus;
  photoCount: number;
  /** Signed URL of the first photo (1h) — picker/manager thumbnail. */
  thumbUrl: string;
  error: string | null;
  createdAt: string;
  trainedAt: string | null;
}

export interface PersonasResponse {
  items: PersonaDto[];
  slots: { used: number; max: number };
}

export interface CreatePersonaRequest {
  name: string;
  /** "This is me, or someone who gave me permission." Required true. */
  attested: boolean;
}

export interface TrainPersonaRequest {
  photoUploadIds: string[];
}

export interface TrainPersonaResponse {
  item: PersonaDto;
  credits: CreditsDto;
}
```

and to `CreateGenerationRequest`:

```ts
  /** Persona id — server validates ownership/readiness and injects the trigger. */
  personaId?: string;
```

- [ ] **Step 2: Prefs** — in `preferences-service.ts` add to `Prefs`:

```ts
  /** Persona id preselected in the left panel ('' = none). */
  defaultPersona: string;
```

and `defaultPersona: ''` to `DEFAULTS`. In `api/index.ts` `PREF_CHECKS` add:

```ts
  ['defaultPersona', (v) => typeof v === 'string' && v.length <= 40],
```

- [ ] **Step 3: Write the failing store test** — `persona-store.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { PersonaStore } from './persona-store';
import { ApiService } from '../api/api-service';
import { PersonasResponse } from '../api/dtos';

const READY = {
  id: 'p1', name: 'Me', status: 'ready', photoCount: 6,
  thumbUrl: '', error: null, createdAt: '2026-07-24', trainedAt: '2026-07-24',
};

describe('PersonaStore', () => {
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let store: PersonaStore;

  beforeEach(() => {
    api = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    store = TestBed.inject(PersonaStore);
  });

  it('loads items and slots', async () => {
    api.get.mockResolvedValue({ items: [READY], slots: { used: 1, max: 2 } } satisfies PersonasResponse);
    await store.load();
    expect(store.items().length).toBe(1);
    expect(store.slots().max).toBe(2);
  });

  it('readyById returns only ready personas', async () => {
    api.get.mockResolvedValue({
      items: [READY, { ...READY, id: 'p2', status: 'training' }],
      slots: { used: 2, max: 2 },
    });
    await store.load();
    expect(store.readyById('p1')?.id).toBe('p1');
    expect(store.readyById('p2')).toBeUndefined();
  });

  it('remove drops the item locally', async () => {
    api.get.mockResolvedValue({ items: [READY], slots: { used: 1, max: 2 } });
    api.delete.mockResolvedValue({ ok: true });
    await store.load();
    await store.remove('p1');
    expect(store.items().length).toBe(0);
  });
});
```

(Match mocking idiom of existing store specs, e.g. `generation-store.spec.ts` — adjust `vi`/`jasmine` usage to whatever they use.)

- [ ] **Step 4: Run test, verify FAIL.**
- [ ] **Step 5: Implement `persona-store.ts`:**

```ts
import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import {
  CreatePersonaRequest,
  PersonaDto,
  PersonasResponse,
  TrainPersonaResponse,
} from '../api/dtos';
import { PersonaStatus } from '../enums';
import { LedgerService } from '../ledger/ledger-service';

const POLL_MS = 10_000;

/** API-backed persona list. GET /personas settles in-flight trainings server-side,
 * so polling is just re-loading while anything is 'training'. */
@Injectable({ providedIn: 'root' })
export class PersonaStore {
  private readonly api = inject(ApiService);
  private readonly ledger = inject(LedgerService);

  private readonly itemsSig = signal<PersonaDto[]>([]);
  private readonly slotsSig = signal<{ used: number; max: number }>({ used: 0, max: 0 });
  private readonly loadedSig = signal(false);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly items = this.itemsSig.asReadonly();
  readonly slots = this.slotsSig.asReadonly();
  readonly loaded = this.loadedSig.asReadonly();

  readonly ready = () => this.itemsSig().filter((p) => p.status === PersonaStatus.Ready);

  readyById(id: string): PersonaDto | undefined {
    return this.itemsSig().find((p) => p.id === id && p.status === PersonaStatus.Ready);
  }

  async load(): Promise<void> {
    const res = await this.api.get<PersonasResponse>('/personas');
    this.itemsSig.set(res.items);
    this.slotsSig.set(res.slots);
    this.loadedSig.set(true);
    this.syncPolling();
  }

  async create(request: CreatePersonaRequest): Promise<PersonaDto> {
    const res = await this.api.post<{ item: PersonaDto }>('/personas', request);
    this.itemsSig.update((list) => [res.item, ...list]);
    this.slotsSig.update((s) => ({ ...s, used: s.used + 1 }));
    return res.item;
  }

  async train(id: string, photoUploadIds: string[]): Promise<PersonaDto> {
    const res = await this.api.post<TrainPersonaResponse>(`/personas/${id}/train`, {
      photoUploadIds,
    });
    this.itemsSig.update((list) => list.map((p) => (p.id === id ? res.item : p)));
    this.ledger.setCredits(res.credits);
    this.syncPolling();
    return res.item;
  }

  async remove(id: string): Promise<void> {
    await this.api.delete(`/personas/${id}`);
    this.itemsSig.update((list) => list.filter((p) => p.id !== id));
    this.slotsSig.update((s) => ({ ...s, used: Math.max(0, s.used - 1) }));
  }

  reset(): void {
    this.itemsSig.set([]);
    this.slotsSig.set({ used: 0, max: 0 });
    this.loadedSig.set(false);
    this.syncPolling();
  }

  /** Poll while any persona is training; stop when none are. */
  private syncPolling(): void {
    const training = this.itemsSig().some((p) => p.status === PersonaStatus.Training);
    if (training && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.load(), POLL_MS);
    } else if (!training && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
```

- [ ] **Step 6: Run tests, verify PASS.** Report done. User commits.

---

### Task 9: Client — persona picker + left panel + workspace wiring

**Files:**
- Create: `src/app/features/workspace/persona-picker/persona-picker.ts` + `.html` + `.css`
- Modify: `src/app/features/workspace/left-panel/left-panel.ts` (+ `.html`)
- Modify: `src/app/features/workspace/workspace-page.ts` (generate handler: pass `personaId`)
- Test: `src/app/features/workspace/persona-picker/persona-picker.spec.ts`

**Interfaces:**
- Consumes: `PersonaStore` (Task 8), `ProfileStore.studioActive`, `personaGenCreditCost` (Task 2).
- Produces: `PersonaPicker` component — inputs `selected: string | null`; outputs `changed(string | null)`, `manageRequested()`. `GenerateRequest.personaId: string | null` (left-panel). Left panel behavior: persona selected → model section shows a locked "Persona — FLUX likeness" chip, version/resolution/quality/reference hidden, price = 6 × batch.

- [ ] **Step 1: Persona picker component** — model it exactly on `style-picker` (same `og` classes, `HlmDropdownMenu`). `persona-picker.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideLock, lucideUserRound } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { PersonaStore } from '../../../core/personas/persona-store';
import { ProfileStore } from '../../../core/profile/profile-store';
import { PersonaStatus } from '../../../core/enums';
import { Hint } from '../../../shared/hint/hint';

@Component({
  selector: 'app-persona-picker',
  templateUrl: './persona-picker.html',
  styleUrl: './persona-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, Hint, ...HlmDropdownMenuImports],
  providers: [provideIcons({ lucideChevronDown, lucideLock, lucideUserRound })],
})
export class PersonaPicker {
  private readonly store = inject(PersonaStore);
  private readonly profile = inject(ProfileStore);

  readonly selected = input<string | null>(null);
  readonly changed = output<string | null>();
  readonly manageRequested = output<void>();

  readonly locked = computed(() => !this.profile.studioActive());
  readonly personas = this.store.items;
  readonly statuses = PersonaStatus;

  readonly current = computed(() => {
    const id = this.selected();
    return id ? this.store.readyById(id) ?? null : null;
  });

  select(id: string | null): void {
    this.changed.emit(id);
  }

  manage(): void {
    this.manageRequested.emit();
  }
}
```

`persona-picker.html`:

```html
<div class="og">
  <span class="og-label">
    Persona
    <app-hint
      text="Your trained likeness. Generations run on the FLUX likeness pipeline — model choice is fixed while a persona is active."
    >
      <span class="og-info">ⓘ</span>
    </app-hint>
  </span>
  @if (locked()) {
    <button type="button" class="og-trigger persona-locked" (click)="manage()">
      <ng-icon name="lucideLock" size="13" />
      <span class="og-trigger-label">Studio feature</span>
    </button>
  } @else {
    <button type="button" class="og-trigger" [hlmDropdownMenuTrigger]="personaMenu" align="end">
      @if (current(); as persona) {
        <img [src]="persona.thumbUrl" [alt]="persona.name" class="persona-trigger-thumb" />
        <span class="og-trigger-label">{{ persona.name }}</span>
      } @else {
        <ng-icon name="lucideUserRound" size="14" class="persona-trigger-none" />
        <span class="og-trigger-label">None</span>
      }
      <ng-icon name="lucideChevronDown" size="13" class="og-chevron" />
    </button>
    <ng-template #personaMenu>
      <div hlmDropdownMenu class="persona-menu">
        <button type="button" hlmDropdownMenuItem class="persona-row"
          [class.persona-row-active]="!selected()" (triggered)="select(null)">
          <span class="persona-row-blank"><ng-icon name="lucideUserRound" size="16" /></span>
          <span class="persona-row-name">None</span>
        </button>
        @for (persona of personas(); track persona.id) {
          <button type="button" hlmDropdownMenuItem class="persona-row"
            [class.persona-row-active]="selected() === persona.id"
            [disabled]="persona.status !== statuses.Ready"
            (triggered)="select(persona.id)">
            @if (persona.thumbUrl) {
              <img [src]="persona.thumbUrl" [alt]="persona.name" class="persona-row-thumb" />
            } @else {
              <span class="persona-row-blank"><ng-icon name="lucideUserRound" size="16" /></span>
            }
            <span class="persona-row-name">{{ persona.name }}</span>
            @if (persona.status === statuses.Training) {
              <span class="persona-row-status">Training…</span>
            } @else if (persona.status === statuses.Failed) {
              <span class="persona-row-status persona-row-failed">Failed</span>
            } @else if (persona.status === statuses.Draft) {
              <span class="persona-row-status">Draft</span>
            }
          </button>
        }
        <button type="button" hlmDropdownMenuItem class="persona-row persona-row-manage" (triggered)="manage()">
          <span class="persona-row-name">Manage personas…</span>
        </button>
      </div>
    </ng-template>
  }
</div>
```

`persona-picker.css` — mirror `style-picker.css` conventions:

```css
.persona-trigger-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: cover;
}
.persona-trigger-none { opacity: 0.6; }
.persona-locked { opacity: 0.7; }
.persona-menu { min-width: 220px; padding: 4px; }
.persona-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.persona-row-thumb {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  object-fit: cover;
}
.persona-row-blank {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.persona-row-name { flex: 1; text-align: left; }
.persona-row-status { font-size: 11px; opacity: 0.65; }
.persona-row-failed { color: var(--destructive, #e5484d); }
.persona-row-active { background: color-mix(in srgb, currentColor 10%, transparent); }
.persona-row-manage { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
```

(Adjust class/color idioms to match `style-picker.css` exactly when reading it.)

- [ ] **Step 2: Left panel** — in `left-panel.ts`:
  - Add imports: `PersonaPicker`, `PersonaStore`, `personaGenCreditCost`, `PersonaStatus`.
  - Add to `GenerateRequest`: `personaId: string | null;`
  - Add signal + prefs restore in the constructor (after the style restore):

```ts
  readonly persona = signal<string | null>(null);
```

```ts
    this.persona.set(prefs.defaultPersona || null);
    void this.personaStore.load().then(() => {
      if (this.persona() && !this.personaStore.readyById(this.persona()!)) this.persona.set(null);
    });
```

  - Inject: `private readonly personaStore = inject(PersonaStore);`
  - Add methods + adjust price:

```ts
  readonly personaActive = computed(() => this.mode() === 'image' && !!this.persona());

  setPersona(id: string | null): void {
    this.persona.set(id);
    void this.prefsService.update({ defaultPersona: id ?? '' });
  }
```

  - Change `unitCredits`:

```ts
  readonly unitCredits = computed(() =>
    this.personaActive() ? personaGenCreditCost() : creditCost(this.family(), this.settings()),
  );
```

  - In `generate()`, add `personaId: this.personaActive() ? this.persona() : null,` to the emitted object.
- [ ] **Step 3: Left panel template** — in `left-panel.html`, insert `<app-persona-picker [selected]="persona()" (changed)="setPersona($event)" (manageRequested)="managePersonasRequested.emit()" />` directly after the `<app-style-picker … />` element (add `readonly managePersonasRequested = output<void>();` to the class). Wrap the model/family selector section, the version/resolution/quality option groups, and the reference-image field each in `@if (!personaActive()) { … }`, and add the locked chip in the model section's `@else` branch:

```html
  @else {
    <div class="og">
      <span class="og-label">Model</span>
      <div class="persona-pipeline-chip">
        <ng-icon name="lucideLock" size="13" />
        <span>Persona — FLUX likeness</span>
        <app-hint text="Persona images render on the FLUX LoRA pipeline your persona was trained for. Clear the persona to pick a model.">
          <span class="og-info">ⓘ</span>
        </app-hint>
      </div>
    </div>
  }
```

with `.persona-pipeline-chip { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.8; }` in `left-panel.css`. Keep aspect-ratio and batch groups visible (flux-lora supports all five ARs).
- [ ] **Step 4: Workspace wiring** — in `workspace-page.ts`, find the `generateRequested` handler that builds the `CreateGenerationRequest` and add `personaId: request.personaId ?? undefined,`. The server ignores `familyId` when `personaId` is present, so the existing `familyId: request.family.id` line stays. Wire `(managePersonasRequested)` to open the manager dialog (Task 10 — until then, a no-op method `openPersonaManager(): void {}`).
- [ ] **Step 5: Component test** — `persona-picker.spec.ts`: mount with mocked `PersonaStore` (`items` signal with one ready + one training persona) and `ProfileStore` (`studioActive` computed):
  - locked when `studioActive` false (renders `.persona-locked`);
  - lists personas with training row disabled;
  - `changed` emits id on select and null on None. Follow the mounting idiom of the existing `style-picker`/left-panel spec.
- [ ] **Step 6: Run `npx ng test --watch=false` + build.** Expected: PASS. Report done. User commits.

---

### Task 10: Client — persona manager dialog + photo prep

**Files:**
- Create: `src/app/core/personas/photo-prep.ts`
- Create: `src/app/features/workspace/persona-manager/persona-manager.ts` + `.html` + `.css`
- Modify: `src/app/features/workspace/workspace-page.ts` + `.html` (host the dialog)
- Test: `src/app/core/personas/photo-prep.spec.ts`

**Interfaces:**
- Consumes: `PersonaStore`, `ApiService.postForm` + `UploadResponse` (existing `/uploads`), `PERSONA_TRAINING`, `LedgerService.totalCredits()`.
- Produces: `prepPhoto(file: File): Promise<Blob>` (≤1536px JPEG 0.92); `PersonaManager` component with input `open: boolean`, output `closed()`.

- [ ] **Step 1: photo-prep test:**

```ts
import { prepPhoto } from './photo-prep';

describe('prepPhoto', () => {
  it('downscales to at most 1536px on the long edge and encodes JPEG', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 2000;
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    const out = await prepPhoto(new File([blob], 'x.png', { type: 'image/png' }));
    expect(out.type).toBe('image/jpeg');
    const bmp = await createImageBitmap(out);
    expect(Math.max(bmp.width, bmp.height)).toBeLessThanOrEqual(1536);
  });
});
```

- [ ] **Step 2: Run, verify FAIL. Implement `photo-prep.ts`:**

```ts
/** Downscale a persona photo before upload: the trainer needs ≤1MP faces, and
 * small JPEGs keep the training zip within edge-function memory limits. */
export async function prepPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.92),
  );
  if (!blob) throw new Error('photo encode failed');
  return blob;
}
```

- [ ] **Step 3: Run, verify PASS.**
- [ ] **Step 4: Persona manager component.** Overlay dialog following the `credit-packs-dialog` component's open/close pattern (read it first and mirror its backdrop/panel classes). States: **list** (default) and **create wizard**. `persona-manager.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle, lucidePlus, lucideTrash2, lucideUserRound, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { PersonaStore } from '../../../core/personas/persona-store';
import { prepPhoto } from '../../../core/personas/photo-prep';
import { ApiService } from '../../../core/api/api-service';
import { UploadResponse } from '../../../core/api/dtos';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { PERSONA_TRAINING } from '../../../core/catalog/model-families';
import { PersonaStatus } from '../../../core/enums';

interface WizardPhoto {
  uploadId: string;
  url: string;
}

@Component({
  selector: 'app-persona-manager',
  templateUrl: './persona-manager.html',
  styleUrl: './persona-manager.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmButton],
  providers: [
    provideIcons({ lucideLoaderCircle, lucidePlus, lucideTrash2, lucideUserRound, lucideX }),
  ],
})
export class PersonaManager {
  private readonly store = inject(PersonaStore);
  private readonly api = inject(ApiService);
  private readonly ledger = inject(LedgerService);
  private readonly profile = inject(ProfileStore);

  readonly open = input.required<boolean>();
  readonly closed = output<void>();

  readonly personas = this.store.items;
  readonly slots = this.store.slots;
  readonly statuses = PersonaStatus;
  readonly training = PERSONA_TRAINING;

  // Wizard state
  readonly creating = signal(false);
  readonly name = signal('');
  readonly attested = signal(false);
  readonly photos = signal<WizardPhoto[]>([]);
  readonly uploading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  readonly slotsFull = computed(() => this.slots().used >= this.slots().max);
  readonly canAfford = computed(
    () => this.profile.isOwner() || this.ledger.totalCredits() >= PERSONA_TRAINING.creditCost,
  );
  readonly canTrain = computed(
    () =>
      this.name().trim().length > 0 &&
      this.attested() &&
      this.photos().length >= PERSONA_TRAINING.minPhotos &&
      this.photos().length <= PERSONA_TRAINING.maxPhotos &&
      this.canAfford() &&
      !this.busy(),
  );

  startCreate(): void {
    this.creating.set(true);
    this.error.set('');
  }

  cancelCreate(): void {
    this.creating.set(false);
    this.name.set('');
    this.attested.set(false);
    this.photos.set([]);
    this.error.set('');
  }

  async onPhotosPicked(event: Event): Promise<void> {
    const inputEl = event.target as HTMLInputElement;
    const files = Array.from(inputEl.files ?? []);
    inputEl.value = '';
    if (files.length === 0) return;
    this.error.set('');
    this.uploading.set(true);
    try {
      for (const file of files.slice(0, PERSONA_TRAINING.maxPhotos - this.photos().length)) {
        const prepped = await prepPhoto(file);
        const form = new FormData();
        form.append('file', prepped, 'photo.jpg');
        const res = await this.api.postForm<UploadResponse>('/uploads', form);
        this.photos.update((list) => [...list, { uploadId: res.uploadId, url: res.url }]);
      }
    } catch (e) {
      this.error.set(
        (e as { code?: string })?.code === 'content_policy'
          ? 'A photo violates our content policy and was rejected.'
          : 'A photo failed to upload — try again.',
      );
    } finally {
      this.uploading.set(false);
    }
  }

  removePhoto(uploadId: string): void {
    this.photos.update((list) => list.filter((p) => p.uploadId !== uploadId));
  }

  async trainNow(): Promise<void> {
    if (!this.canTrain()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const persona = await this.store.create({ name: this.name().trim(), attested: true });
      await this.store.train(persona.id, this.photos().map((p) => p.uploadId));
      this.cancelCreate();
    } catch (e) {
      const code = (e as { code?: string })?.code;
      this.error.set(
        code === 'insufficient_credits'
          ? 'Not enough credits for training.'
          : code === 'slot_limit'
            ? 'All persona slots are in use.'
            : 'Training could not be started — you were not charged.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  async retry(id: string): Promise<void> {
    // Retry = new charged run on the same photos the persona already holds — the
    // server rejects if it has none; simplest retry path is delete + recreate.
    await this.remove(id);
    this.startCreate();
  }

  async remove(id: string): Promise<void> {
    if (!confirm('Delete this persona? Its trained likeness is removed and the slot freed.')) return;
    await this.store.remove(id);
  }

  close(): void {
    this.closed.emit();
  }
}
```

`persona-manager.html` (structure — adapt shell classes to `credit-packs-dialog`):

```html
@if (open()) {
  <div class="pm-backdrop" (click)="close()"></div>
  <div class="pm-panel" role="dialog" aria-label="My personas">
    <header class="pm-head">
      <h3>My personas</h3>
      <span class="pm-slots">{{ slots().used }} of {{ slots().max }} slots used</span>
      <button type="button" class="pm-close" (click)="close()"><ng-icon name="lucideX" size="16" /></button>
    </header>

    @if (!creating()) {
      <ul class="pm-list">
        @for (persona of personas(); track persona.id) {
          <li class="pm-row">
            @if (persona.thumbUrl) {
              <img [src]="persona.thumbUrl" [alt]="persona.name" class="pm-thumb" />
            } @else {
              <span class="pm-thumb pm-thumb-blank"><ng-icon name="lucideUserRound" size="18" /></span>
            }
            <div class="pm-meta">
              <span class="pm-name">{{ persona.name }}</span>
              @switch (persona.status) {
                @case (statuses.Training) {
                  <span class="pm-status pm-training">
                    <ng-icon name="lucideLoaderCircle" size="12" class="pm-spin" /> Training — about 5 min
                  </span>
                }
                @case (statuses.Ready) { <span class="pm-status pm-ready">Ready</span> }
                @case (statuses.Failed) {
                  <span class="pm-status pm-failed">Failed — credits refunded</span>
                }
                @default { <span class="pm-status">Draft</span> }
              }
            </div>
            @if (persona.status === statuses.Failed) {
              <button hlmBtn variant="ghost" size="sm" type="button" (click)="retry(persona.id)">Retry</button>
            }
            <button hlmBtn variant="ghost" size="sm" type="button" (click)="remove(persona.id)">
              <ng-icon name="lucideTrash2" size="14" />
            </button>
          </li>
        } @empty {
          <li class="pm-empty">No personas yet — train one from a few photos of yourself.</li>
        }
      </ul>
      <button hlmBtn type="button" class="pm-new" [disabled]="slotsFull()" (click)="startCreate()">
        <ng-icon name="lucidePlus" size="14" /> New persona
      </button>
      @if (slotsFull()) { <p class="pm-hint">All slots used — delete a persona to free one.</p> }
    } @else {
      <div class="pm-wizard">
        <label class="pm-field">
          <span>Name</span>
          <input type="text" maxlength="40" [value]="name()" (input)="name.set($any($event.target).value)" placeholder="Me" />
        </label>

        <label class="pm-attest">
          <input type="checkbox" [checked]="attested()" (change)="attested.set($any($event.target).checked)" />
          <span>This is me, or someone who gave me permission to use their photos.</span>
        </label>

        <div class="pm-photos">
          <p class="pm-guide">
            {{ training.minPhotos }}–{{ training.maxPhotos }} photos of one person: clear face,
            varied angles and lighting, no sunglasses, no other people.
          </p>
          <div class="pm-grid">
            @for (photo of photos(); track photo.uploadId) {
              <div class="pm-cell">
                <img [src]="photo.url" alt="Persona photo" />
                <button type="button" class="pm-cell-x" (click)="removePhoto(photo.uploadId)">
                  <ng-icon name="lucideX" size="12" />
                </button>
              </div>
            }
            @if (photos().length < training.maxPhotos) {
              <label class="pm-cell pm-add">
                @if (uploading()) { <ng-icon name="lucideLoaderCircle" size="16" class="pm-spin" /> }
                @else { <ng-icon name="lucidePlus" size="16" /> }
                <input type="file" accept="image/png,image/jpeg,image/webp" multiple (change)="onPhotosPicked($event)" hidden />
              </label>
            }
          </div>
          <span class="pm-count">{{ photos().length }} / {{ training.maxPhotos }}</span>
        </div>

        @if (error()) { <p class="pm-error">{{ error() }}</p> }
        @if (!canAfford()) { <p class="pm-error">Training costs {{ training.creditCost }} credits — top up first.</p> }

        <footer class="pm-actions">
          <button hlmBtn variant="ghost" type="button" (click)="cancelCreate()">Cancel</button>
          <button hlmBtn type="button" [disabled]="!canTrain()" (click)="trainNow()">
            @if (busy()) { <ng-icon name="lucideLoaderCircle" size="14" class="pm-spin" /> }
            Train — {{ training.creditCost }} credits
          </button>
        </footer>
      </div>
    }
  </div>
}
```

`persona-manager.css` — fixed overlay (`.pm-backdrop` full-viewport translucent; `.pm-panel` centered card, max-width 520px, scrollable), 4-column `.pm-grid` of square cells, `.pm-spin { animation: pm-rot 1s linear infinite; } @keyframes pm-rot { to { transform: rotate(360deg); } }`, status colors matching the app's muted/success/destructive tokens. Mirror `credit-packs-dialog.css` for backdrop/panel specifics.

- [ ] **Step 5: Host in workspace** — `workspace-page.ts`: add `readonly personaManagerOpen = signal(false);`, `openPersonaManager()` sets it true (replacing the Task 9 stub) and calls `PersonaStore.load()`; template: `<app-persona-manager [open]="personaManagerOpen()" (closed)="personaManagerOpen.set(false)" />`.
- [ ] **Step 6: Run tests + build.** Expected: PASS. Report done. User commits.

---

### Task 11: Client — trends gallery

**Files:**
- Create: `src/app/features/workspace/trend-gallery/trend-gallery.ts` + `.html` + `.css`
- Modify: `src/app/features/workspace/left-panel/left-panel.ts` (+ `.html`)
- Test: `src/app/features/workspace/trend-gallery/trend-gallery.spec.ts`

**Interfaces:**
- Consumes: `TREND_PRESETS` (Task 3).
- Produces: `TrendGallery` — output `picked(TrendPreset)`. Left panel applies: prompt prefill (with overwrite confirm), suggested AR.

- [ ] **Step 1: Component** — `trend-gallery.ts`:

```ts
import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideFlame } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { TREND_PRESETS, TrendPreset } from '../../../core/catalog/trend-presets';
import { Hint } from '../../../shared/hint/hint';

@Component({
  selector: 'app-trend-gallery',
  templateUrl: './trend-gallery.html',
  styleUrl: './trend-gallery.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, Hint, ...HlmDropdownMenuImports],
  providers: [provideIcons({ lucideChevronDown, lucideFlame })],
})
export class TrendGallery {
  readonly picked = output<TrendPreset>();
  readonly trends = TREND_PRESETS;

  pick(trend: TrendPreset): void {
    this.picked.emit(trend);
  }
}
```

`trend-gallery.html` (style-picker visual language, flat 3-column grid, no categories):

```html
<div class="og">
  <span class="og-label">
    Trends
    <app-hint text="Popular persona looks. Picking one fills the prompt — edit anything before you generate.">
      <span class="og-info">ⓘ</span>
    </app-hint>
  </span>
  <button type="button" class="og-trigger" [hlmDropdownMenuTrigger]="trendMenu" align="end">
    <ng-icon name="lucideFlame" size="14" class="trend-trigger-icon" />
    <span class="og-trigger-label">Browse</span>
    <ng-icon name="lucideChevronDown" size="13" class="og-chevron" />
  </button>
  <ng-template #trendMenu>
    <div hlmDropdownMenu class="trend-menu">
      <div class="trend-grid">
        @for (trend of trends; track trend.id) {
          <button type="button" hlmDropdownMenuItem class="trend-tile" (triggered)="pick(trend)">
            <img [src]="trend.thumb" [alt]="trend.name" loading="lazy" />
            <span class="trend-tile-name">{{ trend.name }}</span>
          </button>
        }
      </div>
    </div>
  </ng-template>
</div>
```

`trend-gallery.css` — mirror `style-picker.css` grid/tile rules (3 columns, thumb aspect 3:4, name label under thumb).

- [ ] **Step 2: Left panel integration** — render `<app-trend-gallery (picked)="applyTrend($event)" />` directly below the persona picker, inside the image-mode block. In `left-panel.ts` (add `import { TrendPreset } from '../../../core/catalog/trend-presets';` and `TrendGallery` to the component imports):

```ts
  applyTrend(trend: TrendPreset): void {
    const current = this.prompt().trim();
    if (current && current !== trend.prompt) {
      if (!confirm('Replace your current prompt with this trend?')) return;
    }
    this.prompt.set(trend.prompt);
    if (trend.aspectRatio && this.family().capabilities.aspectRatios.includes(trend.aspectRatio)) {
      this.settings.update((s) => ({ ...s, aspectRatio: trend.aspectRatio! }));
    }
  }
```

(no persona requirement to browse; trends work with or without a persona selected — the gallery is simply most useful with one. This deliberately loosens the spec's "prompts to pick a persona first": the prompt template is harmless without a persona, and gating browsing adds friction. If strict gating is wanted, wrap `pick` emission with a `personaActive` input check.)
- [ ] **Step 3: Component test** — `trend-gallery.spec.ts`: renders 12 tiles; clicking a tile emits the preset. Left-panel behavior (`applyTrend` replaces prompt + sets AR; keeps AR when family lacks it) as a left-panel spec addition if a left-panel spec exists — otherwise cover `applyTrend` via the trend-gallery spec host.
- [ ] **Step 4: Run tests + build. Expected: PASS.** Until thumbs land (Task 12), tiles show alt text on broken images — acceptable per spec rollout.
- [ ] **Step 5: Report done. User commits.**

---

### Task 12: Deploy, live smoke, trend thumbnails

**Files:**
- Create: `scripts/gen-trend-thumbs.mjs`
- Create: `public/trends/*.webp` (12 files)

- [ ] **Step 1: Sync + deploy** — `npm run sync-shared`; run full tests + build (nvm preamble). Deploy `api` via MCP `deploy_edge_function`, bundling `index.ts` + **every** `_shared/` file including `providers/` (fal.ts changed) and the updated `enums.ts`/`model-families.ts`/`style-presets.ts`.
- [ ] **Step 2: Live smoke (user in the loop — costs ~$2.30 real):**
  1. `GET /api/health` → ok.
  2. In the app (owner account): open persona manager → create "Me" with 6 photos → training chip appears; ledger shows −350 `persona_training`.
  3. ~5 min later personas list flips Ready (thumb + picker selectable).
  4. Select persona → model section locks to "Persona — FLUX likeness", price shows 6 credits → generate "portrait as an astronaut…" (use the Astronaut trend tile) → image lands in library with likeness; `settings.persona` set on the row; ledger −6 `generate` with family `persona`.
  5. Failure path: `execute_sql` — temporarily `update models set enabled=false where id='persona';` → generate returns `model_disabled`; re-enable.
  6. Refund path: confirm a deliberately bad training (e.g. 5 copies of a 1×1 pixel image) fails and refunds 350 (check `ledger_entries` for `refund:persona:...`), persona shows Failed + Retry.
- [ ] **Step 3: Trend thumbnails** — `scripts/gen-trend-thumbs.mjs`, mirroring `gen-style-thumbs.mjs` (same OpenAI endpoint and env var), base subject prepended so every tile shows a person:

```js
// One-off: renders each trend template with a generic subject via GPT Image and
// writes PNGs to a temp dir. Usage: OPENAI_API_KEY=... node scripts/gen-trend-thumbs.mjs <outDir>
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node scripts/gen-trend-thumbs.mjs <outDir>');
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY not set');
mkdirSync(outDir, { recursive: true });

const { TREND_PRESETS } = await import('../src/app/core/catalog/trend-presets.ts');

const SUBJECT = 'a friendly man in his early 30s with short dark hair';

for (const trend of TREND_PRESETS) {
  const out = join(outDir, `${trend.id}.png`);
  if (existsSync(out)) {
    console.log(`skip ${trend.id}.png (exists)`);
    continue;
  }
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: `${SUBJECT}, ${trend.prompt}`,
      size: '1024x1024',
      quality: 'low',
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`${trend.id}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${trend.id}: no image in response`);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`generated ${trend.id}.png`);
}
```

Run it (needs the user's OPENAI_API_KEY), then post-process exactly as the style thumbs were (downscale ~160px, webp ~q80 — e.g. `for f in <outDir>/*.png; do cwebp -q 80 -resize 160 0 "$f" -o "public/trends/$(basename "${f%.png}").webp"; done`), and drop the 12 `.webp` files into `public/trends/`.
- [ ] **Step 4: Final build + tests. Report done. User commits everything remaining.**

---

## Self-Review Notes

- Spec coverage: data model + RPCs (T1), pricing/slots (T2), trends catalog (T3), fal training + flux-lora (T4), CRUD/gates/slots (T5), train/charge/zip/refund (T6), generation + trigger injection + settings.persona (T7), DTOs/prefs/store/polling (T8), picker + model lock + prefs reset (T9), manager wizard/attestation/retry/delete (T10), gallery + prefill + AR (T11), deploy/smoke/thumbs (T12). Purge-cron and stale-sweep live in T1. Kill switch verified in T12.
- Deviation from spec (deliberate, noted inline): trend browsing is not hard-gated on a selected persona; templates are harmless standalone.
- `GET /jobs`-style lazy polling means no new cron beyond the stale sweep.
