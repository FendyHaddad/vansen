# Personas on Mobile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every persona rule (slot order and labels, minimum short edge, byte cap, name length, slots per plan, aspect ratios, batch) is served in `flat.persona` of `GET /catalog`. The phone uses those rules to create, fill and delete personas and to generate with them.

**Architecture:**
- Shared constants move into `model-families.ts`, which the gateway, the web and `buildCatalog()` all import.
- A Deno guard test pins `PERSONA_SLOTS` to the SQL `dispatch_limits` seed.
- Mobile parses `flat.persona` into `PersonaCatalog`. It adds a persona data layer (`PersonaRepo`, `personasProvider`), photo prep, a `/personas` list, a `/personas/:id` slot editor, and a persona chip in the composer that sends `personaId` the way the web does.

**Tech Stack:**
- Backend: Deno + Hono on Supabase Edge (`supabase/functions/api`).
- Web: Angular 22 + vitest via `ng test`.
- Mobile: Flutter, Riverpod 2.6, go_router 14, image_picker 1.1 (already a dependency), dio 5.8.

**Spec:** `docs/superpowers/specs/2026-09-23-mobile-personas-design.md`.

## Global Constraints

**Git and scope**
- The owner authorized commits for this work, but **implementers never run `git commit`, `git branch`, `git checkout -b`, `git stash`, `git reset` or `git worktree`**. Tasks end at a green test run. The controller commits after reviews, and it creates the worktrees listed under "Parallel groups".
- Deployment is not a task. The controller runs it after review (see "Deploy").
- Never put Stripe or provider keys in either repo. Never edit any `CLAUDE.md`.

**Repos and commands**
- Backend and web repo: `/Users/user/IdeaProjects/vansen`. Mobile repo: `/Users/user/StudioProjects/vansen-mobile`. Mobile paths below are relative to the mobile repo.
- Node via nvm, before any `npm`/`npx`: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null`. Commands below write this as `NVM;`.
- Flutter binary: `/opt/homebrew/share/flutter/bin/flutter`, written below as `FLUTTER`. Always pass `--no-pub` (`FLUTTER test --no-pub`, `FLUTTER analyze --no-pub`). Never run `pub get`, and add no dependencies.
- Web tests: `npm test -- --watch=false`. One spec: `npm test -- --watch=false --include <path>`. A bare `npx vitest run` falsely fails TestBed specs; never use it.
- Deno tests: `cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all <file>`. `api/_shared` is a symlink to `../_shared`.

**Code rules**
- Both repos: no nested `if` statements; use guard clauses and early returns. Functions do one thing.
- Mobile only:
  - TDD.
  - No comments in Dart code (lib and test).
  - i18n keys in `lib/i18n/*.json` are at most 3 words.
  - `Log.error` for unexpected failures (5xx), never for ordinary refusals.
  - Small files.
  - `flutter analyze` treats infos and warnings as fatal, so keep imports clean.
- Web: Angular components keep separate `.ts` / `.html` / `.css` files. No new component is created in this plan.

**Persona rules (from the spec)**
- The server defines every persona rule and the app renders it. Mobile never hard-codes a persona number, label or ratio. The one exception is the gateway's own default of `'1:1'` when the catalog lists no ratio.
- Copy taken verbatim from the web:
  - Consent: "This is me, or someone who gave me permission to use their photos."
  - Tip: "Sharp photos, good light, one person, no sunglasses. Tap a slot to add or replace it."
  - Ready: "Ready — choose it in the composer."
  - Disabled: "Personas are temporarily unavailable."
- The photo-too-small copy is "Use a sharper photo — at least {minEdge} px on the short side.", where `{minEdge}` comes from the catalog.
- Picker: `image_picker` with `maxWidth: 2048, maxHeight: 2048, imageQuality: 92`, from the camera or the gallery.
- iOS: `NSCameraUsageDescription` = "Take persona photos with the camera." Android needs no new permission.

---

## Gateway JSON shapes mobile reads (quoted from `supabase/functions/api/app.ts` and `personas.ts`)

```jsonc
// GET /personas → { "items": [PersonaDto], "slots": { "used": 1, "max": 2 } }   (no active plan → "max": 0)
// PersonaDto (toPersonaDto):
{ "id": "…", "name": "Me", "status": "draft" | "ready",
  "photos": [ { "slot": "front", "url": "https://…" } ],   // always five, PERSONA_SLOT_ORDER; url null = empty slot,
                                                            // url "" = filled but signing failed
  "thumbUrl": "https://…" | "",                             // the front photo; "" when that slot is empty
  "createdAt": "2026-09-23T00:00:00Z" }

// POST /personas { "name": "Me", "attested": true } → { "item": PersonaDto }
//   403 studio_required | 403 slot_limit | 400 invalid_payload (name 1–40 after trim, attested must be true)
//   409 idempotency_conflict | 503 create_failed | 429 account_suspended | 404 not_found (replayed key, row gone)
// POST /uploads  multipart: file + purpose=persona-photo → { "uploadId": "<userId>/<uuid>.jpg", "url": "https://…" }
//   400 photo_too_large (> 2.5 MB) | 400 photo_too_small (short edge < 1024) | 400 upload_failed | 400 upload_too_large
//   content_policy / moderation_unavailable from the moderation gate
// PUT /personas/:id/photos/:slot { "uploadId": "…" } → { "item": PersonaDto }
//   400 invalid_slot | 400 photo_too_small | 403/404 invalid_reference (the message says which photo problem)
//   404 not_found (persona gone) | 409 photo_unavailable | 503 persona_photo_failed | 429 account_suspended
// DELETE /personas/:id → 202 { deletion status } | 404 not_found | 503 delete_failed
// POST /generations with "personaId":
//   op must be "generate" (400 invalid_op); no referenceUploadId / parentId (400 invalid_reference);
//   settings are replaced server-side by personaSettings(settings.aspectRatio ?? "1:1") = Nano Banana pro 4K,
//   an unrenderable ratio → 400 invalid_settings; 400 persona_unavailable (missing, draft, or not all five photos);
//   503 persona_lookup_failed; 503 model_disabled when models.enabled is false for 'persona'.
//   familyId is ignored for a persona run. The web sends its current composer family and settings.
```

**How the web submits a persona run** (`left-panel.ts` `generate()` → `workspace-page.ts` `onGenerate()`):
- `familyId` is the composer's current family. `op` is `generate` (`referenceRoutingFor` never makes a persona run an edit).
- `settings` is the composer's full settings, `batch` is 1–4, and `personaId` is the chosen persona. `style` and `trendId` go as usual.
- There is no `referenceUploadId` and no `parentId`, because `imageRef` is null while a persona is active.
- The gateway keeps only `settings.aspectRatio`.

Mobile mirrors this in Task 8:
- `familyId` is the composer's current family, and `op` is `generate`.
- `settings` is `{aspectRatio, batch}`: mobile's normal path already puts `batch` inside `settings`, and the gateway keeps only `aspectRatio`.
- `batch`, `catalogVersion` and `personaId` go as well. There is no reference.

`flat.persona` after Task 1:

```jsonc
"persona": {
  "creditsPerImage": 46, "enabled": false,
  "photoSlots": [ { "id": "front", "label": "Front" }, { "id": "left_three_quarter", "label": "Left ¾" },
                  { "id": "right_three_quarter", "label": "Right ¾" }, { "id": "left_profile", "label": "Left profile" },
                  { "id": "right_profile", "label": "Right profile" } ],
  "minEdge": 1024, "maxBytes": 2621440, "maxNameLength": 40,
  "planSlots": { "studio": 2, "pro": 5, "owner": 5 },
  "aspectRatios": ["1:1", "3:4", "4:3", "16:9", "9:16"],
  "batch": { "min": 1, "max": 4 }
}
```

---

## File Structure

**Backend + web (`/Users/user/IdeaProjects/vansen`)**

| File | Task | Responsibility |
|---|---|---|
| `src/app/core/catalog/model-families.ts` | 1 | `PERSONA_SLOT_LABELS`, `PERSONA_MIN_EDGE`, `PERSONA_MAX_BYTES`, `PERSONA_NAME_MAX`, `personaAspectRatios()` |
| `src/app/core/catalog/build-catalog.ts` | 1 | `CatalogPersona`, `personaEntry()` |
| `supabase/functions/_shared/{model-families,build-catalog}.ts` (generated) | 1 | Deno copies |
| `supabase/functions/api/persona_catalog_test.ts` (create) | 1 | Values equal the enforcing constants; `planSlots` equals the SQL seed |
| `supabase/functions/api/personas.ts`, `app.ts` | 1 | Import the shared constants instead of defining them |
| `src/app/core/personas/photo-prep.ts` + `.spec.ts` | 1 | Imports `PERSONA_MIN_EDGE` |
| `src/app/features/workspace/persona-manager/persona-manager.{ts,html,spec.ts}` | 1 | Labels, name cap and messages from the shared constants |
| `scripts/catalog-mobile.test.mjs` | 1 | Asserts the bundled catalog carries the rules |
| `docs/superpowers/plans/post-implementation-review.md` | 10 | Persona item notes mobile |

**Mobile (`/Users/user/StudioProjects/vansen-mobile`)**

| File | Task | Responsibility |
|---|---|---|
| `lib/data/catalog/persona_catalog.dart` (create) | 2 | `PersonaSlotInfo`, `PersonaCatalog` |
| `lib/data/catalog/{catalog_flat,catalog}.dart` | 2 | `CatalogFlat.persona` is a `PersonaCatalog` |
| `assets/catalog/catalog.json` (regenerated) | 2 | Bundled catalog with the rules |
| `test/helpers/catalog_fixture.dart` | 2 | Full `flat.persona`, `personaEnabled` |
| `lib/data/personas/{persona_dto,persona_repo,personas_controller}.dart` (create) | 3 | DTOs, REST calls, `personasProvider` |
| `lib/core/api/api_error.dart`, `lib/i18n/{en,ms}.json` | 3 | Persona error codes and every new string |
| `test/helpers/{fakes,i18n,router_harness}.dart` | 3 | Fake failures and responses, English strings, GoRouter harness |
| `lib/features/personas/photo_prep.dart` (create) | 4 | Picker, size and byte checks, refusal copy |
| `lib/features/personas/{personas_screen,persona_row,new_persona_sheet}.dart` (create) | 5 | List, create, delete, upgrade prompt |
| `lib/features/personas/{persona_detail_screen,persona_slot_tile,guide_image,photo_source_sheet}.dart` (create) | 6 | Slot editor |
| `lib/features/workspace/{composer_state,generate_controller,generate_gate,composer,settings_sheet,workspace_screen}.dart`, `lib/features/workspace/persona_sheet.dart` (create), `lib/data/repositories/generation_repo.dart` | 7, 8 | Persona chip, sheet, price, submit, notice |
| `lib/core/router/app_router.dart`, `lib/features/settings/settings_screen.dart`, `ios/Runner/Info.plist` | 9 | Routes, Settings entry, camera permission |

---

## Parallel groups

Each task's **Files** list is exact. Two tasks run in separate git worktrees only when those lists are disjoint. The controller creates and merges the worktrees, and implementers never do.

| Group | Tasks | Runs | Why |
|---|---|---|---|
| A | 1 (vansen) ∥ 3 (mobile) | concurrently | Different repos. Task 3 needs no catalog field. |
| B | 2 | after 1; concurrent with 3 | `npm run catalog:mobile` must include Task 1's fields. Its files are disjoint from Task 3's. |
| C | 4 ∥ 5 ∥ 7 | after 2 and 3 | They need `PersonaCatalog` (2) and the data layer, strings and helpers (3). Their files are disjoint: `photo_prep.dart`; `personas_screen`/`persona_row`/`new_persona_sheet`; the workspace files and `generation_repo`. |
| D | 6 | after 4 | Uses `photo_prep.dart`. Its files are disjoint from 5 and 7, so it may overlap with them. |
| E | 8 | after 7 | Same workspace files as 7. |
| F | 9 | after 5, 6 and 8 | Routes the screens; edits `settings_screen.dart` and `app_router.dart`. |
| G | 10 | last | Every gate on the merged trees. |

Sequential by file: Task 3 alone edits `test/helpers/fakes.dart`, `lib/i18n/*.json` and `lib/core/api/api_error.dart`. Task 2 alone edits `test/helpers/catalog_fixture.dart`. Tasks 7 and 8 both edit `composer.dart`, `generate_controller.dart` and `composer_state.dart`, so 8 follows 7.

---

## Task 1: `flat.persona` rules from shared constants; SQL seed guard; web reads them

**Files:**
- Modify:
  - `src/app/core/catalog/model-families.ts`: add after `PERSONA_SLOTS` (lines 794–799), and add `personaAspectRatios` after `personaGenCreditCost` (lines 818–822).
  - `src/app/core/catalog/build-catalog.ts`: the import block (lines 7–21), the `Catalog` interface (lines 83–94), and `buildCatalog` (`flat.persona`, line 241).
  - `supabase/functions/api/personas.ts`: delete lines 8–9.
  - `supabase/functions/api/app.ts`:
    - imports (lines 12–43)
    - delete line 161 (`const PERSONA_MAX_BYTES`)
    - the batch check (`batch > 4`, ~line 2251)
    - the `photo_too_large` message (~line 3512)
    - the name check (~line 3712)
  - `src/app/core/personas/photo-prep.ts`: line 2.
  - `src/app/core/personas/photo-prep.spec.ts`: line 2.
  - `src/app/features/workspace/persona-manager/persona-manager.ts`
  - `src/app/features/workspace/persona-manager/persona-manager.html`: the `maxlength="40"` input.
  - `src/app/features/workspace/persona-manager/persona-manager.spec.ts`: append one test.
  - `scripts/catalog-mobile.test.mjs`: the first test.
- Generated: `supabase/functions/_shared/model-families.ts`, `supabase/functions/_shared/build-catalog.ts` (via `npm run sync-shared`).
- Create: `supabase/functions/api/persona_catalog_test.ts`

**Interfaces:**
- Consumes (existing): `PERSONA_GEN`, `PERSONA_SLOT_ORDER`, `PersonaSlot`, `PERSONA_SLOTS`, `personaSettings(ar)`, `personaGenCreditCost()`, `resolutionsFor()`, `nanoFamily()` (private), `IMAGE_BATCH_MAX` (`build-catalog.ts`), `validateSettings` (`api/services/request-validation.ts`).
- Produces (`model-families.ts`):
  - `PERSONA_SLOT_LABELS: Record<PersonaSlot, string>`
  - `PERSONA_MIN_EDGE = 1024`, `PERSONA_MAX_BYTES = 2.5 * 1024 * 1024` (2621440), `PERSONA_NAME_MAX = 40`
  - `personaAspectRatios(): string[]`
- Produces (`build-catalog.ts`): `interface CatalogPersona { creditsPerImage; enabled; photoSlots: {id: PersonaSlot; label: string}[]; minEdge; maxBytes; maxNameLength; planSlots: Record<'studio'|'pro'|'owner', number>; aspectRatios: string[]; batch: {min; max} }`. `Catalog.flat.persona: CatalogPersona`.

- [ ] **Step 1: Write the failing Deno test**

Create `supabase/functions/api/persona_catalog_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { buildCatalog, IMAGE_BATCH_MAX } from './_shared/build-catalog.ts';
import {
  familyById,
  PERSONA_MAX_BYTES,
  PERSONA_MIN_EDGE,
  PERSONA_NAME_MAX,
  PERSONA_SLOT_LABELS,
  PERSONA_SLOT_ORDER,
  PERSONA_SLOTS,
  personaGenCreditCost,
  personaSettings,
} from './_shared/model-families.ts';
import { validateSettings } from './services/request-validation.ts';

const PERSONA = buildCatalog([{ id: 'persona', enabled: true, min_plan: 'studio' }]).flat.persona;
const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const SEED_FILE = '0020_durable_dispatch.sql';

async function migrationTexts(): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for await (const entry of Deno.readDir(MIGRATIONS)) {
    if (!entry.name.endsWith('.sql')) continue;
    texts.set(entry.name, await Deno.readTextFile(new URL(entry.name, MIGRATIONS)));
  }
  return texts;
}

Deno.test('flat.persona carries the constants the gateway enforces', () => {
  assertEquals(PERSONA.creditsPerImage, personaGenCreditCost());
  assertEquals(PERSONA.enabled, true);
  assertEquals(PERSONA.photoSlots, PERSONA_SLOT_ORDER.map((id) => ({ id, label: PERSONA_SLOT_LABELS[id] })));
  assertEquals(PERSONA.minEdge, PERSONA_MIN_EDGE);
  assertEquals(PERSONA.maxBytes, PERSONA_MAX_BYTES);
  assertEquals(PERSONA.maxNameLength, PERSONA_NAME_MAX);
  assertEquals(PERSONA.planSlots, PERSONA_SLOTS);
  assertEquals(PERSONA.batch, { min: 1, max: IMAGE_BATCH_MAX });
});

Deno.test('flat.persona publishes the values the spec names', () => {
  assertEquals(PERSONA.photoSlots.map((s) => s.label), ['Front', 'Left ¾', 'Right ¾', 'Left profile', 'Right profile']);
  assertEquals([PERSONA.minEdge, PERSONA.maxBytes, PERSONA.maxNameLength], [1024, 2621440, 40]);
  assertEquals(PERSONA.planSlots, { studio: 2, pro: 5, owner: 5 });
  assertEquals(PERSONA.aspectRatios, ['1:1', '3:4', '4:3', '16:9', '9:16']);
});

Deno.test('a listed ratio passes the gateway persona check; an unlisted Nano Banana ratio fails it', () => {
  const nano = familyById('nano-banana');
  if (!nano) throw new Error('nano-banana missing');
  for (const ratio of nano.capabilities.aspectRatios) {
    const accepted = validateSettings(nano, personaSettings(ratio)) === null;
    assertEquals(PERSONA.aspectRatios.includes(ratio), accepted, ratio);
  }
});

Deno.test('planSlots equals the persona_slots seed in dispatch_limits', async () => {
  const texts = await migrationTexts();
  const seed = texts.get(SEED_FILE) ?? '';
  const seeded = Object.fromEntries(
    [...seed.matchAll(/\('persona_slots:(\w+)',\s*(\d+)\)/g)].map((m) => [m[1], Number(m[2])]),
  );
  assertEquals(seeded, PERSONA.planSlots);
  const laterWrites = [...texts]
    .filter(([name, sql]) => name !== SEED_FILE && /persona_slots:(studio|pro|owner)/.test(sql))
    .map(([name]) => name);
  assertEquals(laterWrites, [], 'a later migration writes persona_slots: extend this guard to read it');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/persona_catalog_test.ts`
Expected: FAIL. The type check reports that `PERSONA_MAX_BYTES`, `PERSONA_MIN_EDGE`, `PERSONA_NAME_MAX` and `PERSONA_SLOT_LABELS` are not exported by `./_shared/model-families.ts`.

- [ ] **Step 3: Add the shared constants**

In `src/app/core/catalog/model-families.ts`, directly after the `PERSONA_SLOTS` block (it ends `owner: 5,\n};`), insert:

```ts
/** What each capture slot is called on screen, in every client. */
export const PERSONA_SLOT_LABELS: Record<PersonaSlot, string> = {
  front: 'Front',
  left_three_quarter: 'Left ¾',
  right_three_quarter: 'Right ¾',
  left_profile: 'Left profile',
  right_profile: 'Right profile',
};

/** Minimum short edge of a persona photo, in pixels. Clients check it first; the gateway re-checks. */
export const PERSONA_MIN_EDGE = 1024;

/** Largest persona photo the gateway accepts, in bytes (2.5 MB). */
export const PERSONA_MAX_BYTES = 2.5 * 1024 * 1024;

/** Longest persona name the gateway accepts, after trimming. */
export const PERSONA_NAME_MAX = 40;
```

Directly after `personaGenCreditCost()` (the function ending `PERSONA_GEN.premium,\n  );\n}`), insert:

```ts
/**
 * The ratios a persona request passes the gateway's check with: Nano Banana's
 * ratios where its Pro version renders at the persona resolution.
 */
export function personaAspectRatios(): string[] {
  const nano = nanoFamily();
  return nano.capabilities.aspectRatios.filter((ratio) =>
    resolutionsFor(nano, ratio, 'pro').some((option) => option.value === PERSONA_GEN.resolution)
  );
}
```

- [ ] **Step 4: Publish them in `buildCatalog()`**

In `src/app/core/catalog/build-catalog.ts`, replace the first import block with:

```ts
import {
  AUDIO_OPTIONS,
  CATALOG_VERSION,
  creditCost,
  defaultSettings,
  EDIT_TOOLS,
  MODEL_FAMILIES,
  PERSONA_GEN,
  PERSONA_MAX_BYTES,
  PERSONA_MIN_EDGE,
  PERSONA_NAME_MAX,
  PERSONA_SLOT_LABELS,
  PERSONA_SLOT_ORDER,
  PERSONA_SLOTS,
  personaAspectRatios,
  personaGenCreditCost,
  qualitiesFor,
  referenceRule,
  resolutionsFor,
  UPSCALER,
  upscaleCreditCost,
} from './model-families';
import type {
  AudioMode,
  FamilyOption,
  GenerationInput,
  GenerationSettings,
  ModelFamily,
  ModelKind,
  PersonaSlot,
} from './model-families';
```

Replace the `Catalog` interface with:

```ts
/** Every persona rule the gateway enforces, so a client renders them instead of copying them. */
export interface CatalogPersona {
  creditsPerImage: number;
  enabled: boolean;
  photoSlots: { id: PersonaSlot; label: string }[];
  minEdge: number;
  maxBytes: number;
  maxNameLength: number;
  planSlots: Record<'studio' | 'pro' | 'owner', number>;
  aspectRatios: string[];
  batch: { min: number; max: number };
}

export interface Catalog {
  catalogVersion: string;
  families: CatalogFamily[];
  flat: {
    editTools: CatalogEditTool[];
    upscale: { credits: number; enabled: boolean };
    persona: CatalogPersona;
  };
  styles: { id: string; label: string }[];
  trends: { id: string; label: string; prompt: string; aspectRatio: string | null }[];
  toolPlans: Record<string, CatalogPlan>;
}
```

Directly above `export function buildCatalog`, add:

```ts
function personaEntry(row: ModelRow | undefined): CatalogPersona {
  return {
    creditsPerImage: personaGenCreditCost(),
    enabled: row?.enabled === true,
    photoSlots: PERSONA_SLOT_ORDER.map((id) => ({ id, label: PERSONA_SLOT_LABELS[id] })),
    minEdge: PERSONA_MIN_EDGE,
    maxBytes: PERSONA_MAX_BYTES,
    maxNameLength: PERSONA_NAME_MAX,
    planSlots: { ...PERSONA_SLOTS },
    aspectRatios: personaAspectRatios(),
    batch: { min: 1, max: IMAGE_BATCH_MAX },
  };
}
```

In `buildCatalog`, replace

```ts
      persona: { creditsPerImage: personaGenCreditCost(), enabled: byId.get(PERSONA_GEN.id)?.enabled === true },
```

with

```ts
      persona: personaEntry(byId.get(PERSONA_GEN.id)),
```

Run: `cd /Users/user/IdeaProjects/vansen && NVM; npm run sync-shared`
Expected: the script rewrites `supabase/functions/_shared/model-families.ts` and `build-catalog.ts` and exits 0.

- [ ] **Step 5: Run the Deno test to verify it passes**

Run: `cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/persona_catalog_test.ts api/build_catalog_test.ts`
Expected: PASS. Every test is `ok`, and the last line reads `ok | N passed | 0 failed`.

- [ ] **Step 6: The gateway imports the shared constants**

In `supabase/functions/api/personas.ts`, delete these two lines:

```ts
/** Minimum short edge for a persona photo, in pixels. The client enforces it too. */
export const PERSONA_MIN_EDGE = 1024;
```

In `supabase/functions/api/app.ts`:
- Add `PERSONA_MAX_BYTES,`, `PERSONA_MIN_EDGE,` and `PERSONA_NAME_MAX,` to the `./_shared/model-families.ts` import, directly after `PERSONA_GEN,`.
- Remove `PERSONA_MIN_EDGE,` from the `./personas.ts` import.
- After the `./_shared/model-families.ts` import, add `import { IMAGE_BATCH_MAX } from "./_shared/build-catalog.ts";`.
- Delete `const PERSONA_MAX_BYTES = 2.5 * 1024 * 1024;`.

Then replace

```ts
    if (batch < 1 || batch > 4) {
      return fail(c, 400, "invalid_batch", "batch must be 1–4");
    }
```

with

```ts
    if (batch < 1 || batch > IMAGE_BATCH_MAX) {
      return fail(c, 400, "invalid_batch", `batch must be 1–${IMAGE_BATCH_MAX}`);
    }
```

replace

```ts
      return fail(c, 400, "photo_too_large", "Use a smaller photo — at most 2.5 MB.");
```

with

```ts
      return fail(c, 400, "photo_too_large",
        `Use a smaller photo — at most ${PERSONA_MAX_BYTES / (1024 * 1024)} MB.`);
```

and replace

```ts
    if (!name || name.length > 40) {
      return fail(c, 400, "invalid_payload", "name required (max 40 chars)");
    }
```

with

```ts
    if (!name || name.length > PERSONA_NAME_MAX) {
      return fail(c, 400, "invalid_payload", `name required (max ${PERSONA_NAME_MAX} chars)`);
    }
```

Run: `cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/persona_routes_test.ts api/persona_generation_test.ts api/retry_routes_test.ts api/app_test.ts`
Expected: PASS, including `uploading a persona photo over 2.5 MB is refused with photo_too_large`, which asserts the unchanged message `Use a smaller photo — at most 2.5 MB.`.

- [ ] **Step 7: Write the failing web test**

Append inside the `describe('PersonaManager', …)` block of `src/app/features/workspace/persona-manager/persona-manager.spec.ts` (before its closing `});`):

```ts
  it('labels every slot and caps the name from the shared catalog', () => {
    const component = make();
    expect(component.slotLabels).toBe(PERSONA_SLOT_LABELS);
    expect(PERSONA_SLOT_ORDER.map((slot) => component.slotLabels[slot])).toEqual([
      'Front',
      'Left ¾',
      'Right ¾',
      'Left profile',
      'Right profile',
    ]);
    expect(component.nameMax).toBe(40);
  });
```

and change its import line to `import { PERSONA_SLOT_LABELS, PERSONA_SLOT_ORDER } from '../../../core/catalog/model-families';`.

In `src/app/core/personas/photo-prep.spec.ts`, replace line 2 with:

```ts
import { fitWithin, isTooSmall, PERSONA_MAX_EDGE } from './photo-prep';
import { PERSONA_MIN_EDGE } from '../catalog/model-families';
```

Run: `cd /Users/user/IdeaProjects/vansen && NVM; npm test -- --watch=false --include src/app/features/workspace/persona-manager/persona-manager.spec.ts --include src/app/core/personas/photo-prep.spec.ts`
Expected: FAIL. `slotLabels` is not the shared object, and `nameMax` is undefined.

- [ ] **Step 8: The web reads the shared constants**

In `src/app/core/personas/photo-prep.ts`, replace line 2 (`export const PERSONA_MIN_EDGE = 1024;`) with `import { PERSONA_MIN_EDGE } from '../catalog/model-families';`, and move that import above line 1.

In `persona-manager.ts`, replace

```ts
import { PERSONA_SLOT_ORDER, PersonaSlot } from '../../../core/catalog/model-families';
```

with

```ts
import {
  PERSONA_MAX_BYTES,
  PERSONA_MIN_EDGE,
  PERSONA_NAME_MAX,
  PERSONA_SLOT_LABELS,
  PERSONA_SLOT_ORDER,
  PersonaSlot,
} from '../../../core/catalog/model-families';
```

In `SLOT_UPLOAD_MESSAGES`, replace the two photo lines with:

```ts
  photo_too_small: `Use a sharper, higher-resolution photo (at least ${PERSONA_MIN_EDGE}px).`,
  photo_too_large: `Use a smaller photo — at most ${PERSONA_MAX_BYTES / (1024 * 1024)} MB.`,
```

Replace the `readonly slotLabels: Record<PersonaSlot, string> = { … };` block with:

```ts
  readonly slotLabels: Record<PersonaSlot, string> = PERSONA_SLOT_LABELS;
  readonly nameMax = PERSONA_NAME_MAX;
```

In `persona-manager.html`, replace `maxlength="40"` with `[attr.maxlength]="nameMax"`.

In `scripts/catalog-mobile.test.mjs`, in the first test after `assert.equal(catalog.flat.persona.enabled, false);`, add:

```js
    assert.deepEqual(catalog.flat.persona.photoSlots.map((s) => s.id), [
      'front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile',
    ]);
    assert.equal(catalog.flat.persona.minEdge, 1024);
    assert.equal(catalog.flat.persona.maxBytes, 2621440);
```

- [ ] **Step 9: Run the web and script tests to verify they pass**

Run: `cd /Users/user/IdeaProjects/vansen && NVM; npm test -- --watch=false --include src/app/features/workspace/persona-manager/persona-manager.spec.ts --include src/app/core/personas/photo-prep.spec.ts --include src/app/core/shared-sync.spec.ts --include src/app/core/catalog/catalog-version.spec.ts`
Expected: PASS. The existing message assertions still hold: `Use a sharper, higher-resolution photo (at least 1024px).` and `Use a smaller photo — at most 2.5 MB.`.

Run: `cd /Users/user/IdeaProjects/vansen && NVM; node --test scripts/catalog-mobile.test.mjs`
Expected: `# pass 2`, `# fail 0`.

---

## Task 2: Mobile parses `flat.persona`; fixture and bundled asset refreshed

**Files:**
- Create: `lib/data/catalog/persona_catalog.dart`
- Modify:
  - `lib/data/catalog/catalog_flat.dart`
  - `lib/data/catalog/catalog.dart` (the exports)
  - `test/helpers/catalog_fixture.dart` (`testCatalogJson`, `testCatalog`)
  - `test/data/catalog/catalog_test.dart`
  - `test/data/catalog/bundled_catalog_test.dart`
- Regenerate: `assets/catalog/catalog.json`

**Interfaces:**
- Consumes: the Task 1 `flat.persona` JSON, and `jsonMaps` (`catalog_family.dart`).
- Produces:
  - `class PersonaSlotInfo { final String id; final String label; }`
  - `class PersonaCatalog { final int creditsPerImage; final bool enabled; final List<PersonaSlotInfo> photoSlots; final int minEdge; final int maxBytes; final int maxNameLength; final Map<String, int> planSlots; final List<String> aspectRatios; final int batchMin; final int batchMax; factory PersonaCatalog.fromJson(Map<String, dynamic>?) }`. A missing field parses to 0 or empty, and a missing batch to `1..1`.
  - `CatalogFlat.persona` is a `PersonaCatalog`. `FlatPrice.fromJson(Map<String, dynamic>?)` loses its `creditsKey` parameter.
  - `catalog.dart` exports `persona_catalog.dart`.
  - Fixture: `testCatalogJson({…, bool personaEnabled = false})` and `testCatalog({…, bool personaEnabled = false})` carry the full persona map shown in the "Gateway JSON shapes" section.

- [ ] **Step 1: Write the failing tests**

In `test/data/catalog/catalog_test.dart`:
- Replace `import 'package:vansen_mobile/data/catalog/catalog_family.dart';` with `import 'package:vansen_mobile/data/catalog/catalog.dart';`.
- In `flat prices and tool plans`, replace `expect(catalog.flat.persona.credits, 46);` with `expect(catalog.flat.persona.creditsPerImage, 46);`.
- Append before the closing `}` of `main`:

```dart
  test('persona rules come from flat.persona', () {
    final persona = catalog.flat.persona;
    expect(persona.photoSlots.map((slot) => slot.id),
        ['front', 'left_three_quarter', 'right_three_quarter', 'left_profile', 'right_profile']);
    expect(persona.photoSlots[1].label, 'Left ¾');
    expect(persona.minEdge, 1024);
    expect(persona.maxBytes, 2621440);
    expect(persona.maxNameLength, 40);
    expect(persona.planSlots, {'studio': 2, 'pro': 5, 'owner': 5});
    expect(persona.aspectRatios, ['1:1', '3:4', '4:3', '16:9', '9:16']);
    expect((persona.batchMin, persona.batchMax), (1, 4));
    expect(testCatalog(personaEnabled: true).flat.persona.enabled, isTrue);
  });

  test('a catalog from before the persona rules parses to empty rules', () {
    final flat = CatalogFlat.fromJson({
      'persona': {'creditsPerImage': 46, 'enabled': true}
    });
    expect(flat.persona.creditsPerImage, 46);
    expect(flat.persona.enabled, isTrue);
    expect(flat.persona.photoSlots, isEmpty);
    expect(flat.persona.aspectRatios, isEmpty);
    expect(flat.persona.minEdge, 0);
    expect((flat.persona.batchMin, flat.persona.batchMax), (1, 1));
  });
```

In `test/data/catalog/bundled_catalog_test.dart`, append inside `main`:

```dart
  test('the bundled persona rules are the gateway rules, persona off', () {
    final persona = catalog.flat.persona;
    expect(persona.enabled, isFalse);
    expect(persona.creditsPerImage, 46);
    expect(persona.photoSlots.map((slot) => slot.label),
        ['Front', 'Left ¾', 'Right ¾', 'Left profile', 'Right profile']);
    expect(persona.minEdge, 1024);
    expect(persona.maxBytes, 2621440);
    expect(persona.maxNameLength, 40);
    expect(persona.aspectRatios, ['1:1', '3:4', '4:3', '16:9', '9:16']);
    expect((persona.batchMin, persona.batchMax), (1, 4));
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/data/catalog/catalog_test.dart test/data/catalog/bundled_catalog_test.dart`
Expected: FAIL with compile errors: `The getter 'creditsPerImage' isn't defined for the type 'FlatPrice'` and `No named parameter with the name 'personaEnabled'`.

- [ ] **Step 3: Write `PersonaCatalog`**

Create `lib/data/catalog/persona_catalog.dart`:

```dart
import 'catalog_family.dart';

class PersonaSlotInfo {
  const PersonaSlotInfo({required this.id, required this.label});

  final String id;
  final String label;

  factory PersonaSlotInfo.fromJson(Map<String, dynamic> json) => PersonaSlotInfo(
        id: json['id'] as String,
        label: json['label'] as String? ?? json['id'] as String,
      );
}

class PersonaCatalog {
  const PersonaCatalog({
    required this.creditsPerImage,
    required this.enabled,
    required this.photoSlots,
    required this.minEdge,
    required this.maxBytes,
    required this.maxNameLength,
    required this.planSlots,
    required this.aspectRatios,
    required this.batchMin,
    required this.batchMax,
  });

  final int creditsPerImage;
  final bool enabled;
  final List<PersonaSlotInfo> photoSlots;
  final int minEdge;
  final int maxBytes;
  final int maxNameLength;
  final Map<String, int> planSlots;
  final List<String> aspectRatios;
  final int batchMin;
  final int batchMax;

  factory PersonaCatalog.fromJson(Map<String, dynamic>? json) {
    final source = json ?? const <String, dynamic>{};
    final batch = source['batch'] as Map<String, dynamic>? ?? const <String, dynamic>{};
    return PersonaCatalog(
      creditsPerImage: _count(source['creditsPerImage']),
      enabled: source['enabled'] == true,
      photoSlots: jsonMaps(source['photoSlots']).map(PersonaSlotInfo.fromJson).toList(),
      minEdge: _count(source['minEdge']),
      maxBytes: _count(source['maxBytes']),
      maxNameLength: _count(source['maxNameLength']),
      planSlots: _planSlots(source['planSlots']),
      aspectRatios: [
        for (final ratio in source['aspectRatios'] as List<dynamic>? ?? const []) ratio as String
      ],
      batchMin: _count(batch['min'], 1),
      batchMax: _count(batch['max'], 1),
    );
  }
}

int _count(Object? raw, [int fallback = 0]) => (raw as num?)?.toInt() ?? fallback;

Map<String, int> _planSlots(Object? raw) =>
    (raw as Map<String, dynamic>? ?? const <String, dynamic>{})
        .map((plan, count) => MapEntry(plan, (count as num).toInt()));
```

- [ ] **Step 4: `CatalogFlat.persona` becomes a `PersonaCatalog`**

Replace the whole of `lib/data/catalog/catalog_flat.dart` from `class FlatPrice {` to the end with:

```dart
class FlatPrice {
  const FlatPrice({required this.credits, required this.enabled});

  final int credits;
  final bool enabled;

  factory FlatPrice.fromJson(Map<String, dynamic>? json) => FlatPrice(
        credits: (json?['credits'] as num? ?? 0).toInt(),
        enabled: json?['enabled'] == true,
      );
}

class CatalogFlat {
  const CatalogFlat({required this.editTools, required this.upscale, required this.persona});

  final List<EditToolPrice> editTools;
  final FlatPrice upscale;
  final PersonaCatalog persona;

  factory CatalogFlat.fromJson(Map<String, dynamic> json) => CatalogFlat(
        editTools: jsonMaps(json['editTools']).map(EditToolPrice.fromJson).toList(),
        upscale: FlatPrice.fromJson(json['upscale'] as Map<String, dynamic>?),
        persona: PersonaCatalog.fromJson(json['persona'] as Map<String, dynamic>?),
      );
}
```

Also add `import 'persona_catalog.dart';` below its `import 'catalog_family.dart';`. In `lib/data/catalog/catalog.dart`, add `export 'persona_catalog.dart';` after `export 'catalog_flat.dart';`.

- [ ] **Step 5: The fixture carries the full persona rules**

In `test/helpers/catalog_fixture.dart`, add above `Map<String, dynamic> testCatalogJson(`:

```dart
Map<String, dynamic> _persona(bool enabled) => {
      'creditsPerImage': 46,
      'enabled': enabled,
      'photoSlots': [
        {'id': 'front', 'label': 'Front'},
        {'id': 'left_three_quarter', 'label': 'Left ¾'},
        {'id': 'right_three_quarter', 'label': 'Right ¾'},
        {'id': 'left_profile', 'label': 'Left profile'},
        {'id': 'right_profile', 'label': 'Right profile'},
      ],
      'minEdge': 1024,
      'maxBytes': 2621440,
      'maxNameLength': 40,
      'planSlots': {'studio': 2, 'pro': 5, 'owner': 5},
      'aspectRatios': ['1:1', '3:4', '4:3', '16:9', '9:16'],
      'batch': {'min': 1, 'max': 4},
    };
```

Then change `testCatalogJson` and `testCatalog`:
- Add `bool personaEnabled = false,` to both parameter lists, after `bool editBgEnabled = true,`.
- In `testCatalogJson`, replace `'persona': {'creditsPerImage': 46, 'enabled': false},` with `'persona': _persona(personaEnabled),`.
- In `testCatalog`, pass `personaEnabled: personaEnabled,` to `testCatalogJson(…)`.

- [ ] **Step 6: Regenerate the bundled catalog**

Run: `cd /Users/user/IdeaProjects/vansen && NVM; npm run catalog:mobile /Users/user/StudioProjects/vansen-mobile/assets/catalog/catalog.json`
Expected: `wrote /Users/user/StudioProjects/vansen-mobile/assets/catalog/catalog.json`. Then `grep -c '"minEdge": 1024' /Users/user/StudioProjects/vansen-mobile/assets/catalog/catalog.json` prints `1`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/data/catalog && FLUTTER analyze --no-pub`
Expected: `All tests passed!` and `No issues found!`.

---

## Task 3: Persona data layer, error codes, strings and test helpers

**Files:**
- Create:
  - `lib/data/personas/persona_dto.dart`
  - `lib/data/personas/persona_repo.dart`
  - `lib/data/personas/personas_controller.dart`
  - `test/helpers/i18n.dart`
  - `test/helpers/router_harness.dart`
  - `test/data/personas/persona_dto_test.dart`
  - `test/data/personas/persona_repo_test.dart`
  - `test/data/personas/personas_controller_test.dart`
  - `test/core/i18n/persona_keys_test.dart`
- Modify:
  - `lib/core/api/api_error.dart` (the `apiErrors` map)
  - `lib/i18n/en.json`, `lib/i18n/ms.json`
  - `test/helpers/fakes.dart` (persona JSON helpers and the `FakeApi` class)
  - `test/core/api/api_error_test.dart`

**Interfaces:**
- Consumes (existing):
  - `ApiClient.postFile(path, {bytes, filename, fields})`. It already takes `fields`, so no change is needed.
  - `apiClientProvider` (`lib/data/repositories/profile_repo.dart`), `UploadResponse`, `ApiException`, `sessionControllerProvider` / `SessionState`, `Log.error`.
- Produces:
  - `class PersonaPhoto { String slot; String? url; bool get filled }`
  - `class PersonaDto { String id; String name; String status; List<PersonaPhoto> photos; String? thumbUrl; DateTime createdAt; bool get isReady; int get filledCount; PersonaPhoto? photo(String slot) }`
  - `class PersonaSlots { int used; int max; bool get full }`
  - `class PersonaList { List<PersonaDto> items; PersonaSlots slots; static const empty; List<PersonaDto> get ready; PersonaDto? byId(String id) }`
  - `personaRepoProvider`, and `class PersonaRepo { Future<PersonaList> list(); Future<PersonaDto> create(String name); Future<UploadResponse> uploadPhoto(List<int> bytes); Future<PersonaDto> setPhoto(String personaId, String slot, String uploadId); Future<void> delete(String id) }`
  - `personasProvider: AsyncNotifierProvider<PersonasController, PersonaList>`, and `PersonasController { Future<PersonaDto> create(String name); Future<void> setPhoto(String personaId, String slot, List<int> bytes); Future<void> remove(String id); Future<void> reload() }`
  - i18n keys, all used later:
    - `personas.*`: `title`, `slotsUsed`, `slotsFull`, `empty`, `newPersona`, `name`, `consent`, `create`, `ready`, `draft`, `tip`, `readyHint`, `deleteTitle`, `deleteBody`, `gone`, `camera`, `gallery`, `photoSmall`, `photoLarge`, `upgradeBody`, `loadFailed`
    - `workspace.*`: `persona`, `noPersona`, `managePersonas`, `personasOff`, `aspectRatio`
    - `errors.*`: `slotLimit`, `photoTooSmall`, `photoTooLarge`, `photoUnavailable`, `invalidSlot`, `personaPhotoFailed`, `personaLookupFailed`, `createFailed`, `deleteFailed`
  - Test helpers:
    - `personaSlotIds`, `personaJson(id, {name, status, filled})`, `personasJson(items, {max})`
    - `FakeApi.putResponses`, and `FakeApi.failures` keyed `'<METHOD> <path>'`, with the method one of `GET|PUT|DELETE|FILE`
    - `englishI18n()`
    - `routedApp({overrides, home, stubPaths})`, where each stub page shows `page:<path>`

- [ ] **Step 1: Test helpers**

In `test/helpers/fakes.dart`, add below `profileJson`:

```dart
const personaSlotIds = [
  'front',
  'left_three_quarter',
  'right_three_quarter',
  'left_profile',
  'right_profile',
];

Map<String, dynamic> personaJson(String id,
        {String name = 'Me', String status = 'ready', int filled = 5}) =>
    {
      'id': id,
      'name': name,
      'status': status,
      'photos': [
        for (final (index, slot) in personaSlotIds.indexed)
          {'slot': slot, 'url': index < filled ? 'https://photo/$id/$slot' : null}
      ],
      'thumbUrl': filled > 0 ? 'https://photo/$id/front' : '',
      'createdAt': '2026-09-23T00:00:00Z',
    };

Map<String, dynamic> personasJson(List<Map<String, dynamic>> items, {int max = 2}) => {
      'items': items,
      'slots': {'used': items.length, 'max': max},
    };
```

Make these edits to `class FakeApi` in the same file.

1. After `final getGates = <String, Completer<void>>{};`, add:

```dart
  final putResponses = <String, Map<String, dynamic>>{};
  final failures = <String, (int, String)>{};

  void _throwIfFailing(String method, String path) {
    final failure = failures['$method $path'];
    if (failure == null) return;
    throw ApiException.fromBody(failure.$1, {
      'error': {'code': failure.$2, 'message': failure.$2}
    });
  }
```

2. Add one line after each of these recording lines: `_throwIfFailing('GET', path);` after `calls.add(('GET', path, null));`, `_throwIfFailing('PUT', path);` after `calls.add(('PUT', path, body));`, `_throwIfFailing('DELETE', path);` after `calls.add(('DELETE', path, body));`, and `_throwIfFailing('FILE', path);` after `calls.add(('FILE', path, {'filename': filename, ...fields}));`.

3. In `put`, replace `return {};` with `return putResponses[path] ?? {};`.

`post` is unchanged, because it already has `postErrorCodes`.

Create `test/helpers/i18n.dart`:

```dart
import 'dart:convert';
import 'dart:io';
import 'package:vansen_mobile/core/i18n/i18n.dart';

I18n englishI18n() =>
    I18n(jsonDecode(File('lib/i18n/en.json').readAsStringSync()) as Map<String, dynamic>);

I18n malayI18n() =>
    I18n(jsonDecode(File('lib/i18n/ms.json').readAsStringSync()) as Map<String, dynamic>);
```

Create `test/helpers/router_harness.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

Widget routedApp({
  required List<Override> overrides,
  required Widget home,
  List<String> stubPaths = const [],
}) {
  final router = GoRouter(routes: [
    GoRoute(path: '/', builder: (context, state) => home),
    for (final path in stubPaths)
      GoRoute(
        path: path,
        builder: (context, state) => Scaffold(body: Text('page:${state.uri.path}')),
      ),
  ]);
  return ProviderScope(overrides: overrides, child: MaterialApp.router(routerConfig: router));
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/data/personas/persona_dto_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/data/personas/persona_dto.dart';
import '../../helpers/fakes.dart';

void main() {
  test('parses a ready persona in slot order', () {
    final persona = PersonaDto.fromJson(personaJson('p1'));
    expect(persona.id, 'p1');
    expect(persona.name, 'Me');
    expect(persona.isReady, isTrue);
    expect(persona.photos.map((photo) => photo.slot), personaSlotIds);
    expect(persona.filledCount, 5);
    expect(persona.thumbUrl, 'https://photo/p1/front');
    expect(persona.createdAt, DateTime.utc(2026, 9, 23));
  });

  test('an empty slot is null, a filled slot with a failed signature is still filled', () {
    final json = personaJson('p1', status: 'draft', filled: 1);
    (json['photos'] as List)[0]['url'] = '';
    final persona = PersonaDto.fromJson(json);
    expect(persona.photo('front')!.filled, isTrue);
    expect(persona.photo('left_profile')!.filled, isFalse);
    expect(persona.filledCount, 1);
  });

  test('an empty thumbUrl and an unknown status read as none and draft', () {
    final json = personaJson('p1', filled: 0)..['status'] = 'training';
    final persona = PersonaDto.fromJson(json);
    expect(persona.thumbUrl, isNull);
    expect(persona.isReady, isFalse);
  });

  test('the list keeps slots and filters ready personas', () {
    final list = PersonaList.fromJson(personasJson(
        [personaJson('p1'), personaJson('p2', status: 'draft', filled: 2)],
        max: 2));
    expect(list.items, hasLength(2));
    expect(list.ready.map((persona) => persona.id), ['p1']);
    expect(list.byId('p2')!.filledCount, 2);
    expect(list.byId('nope'), isNull);
    expect((list.slots.used, list.slots.max, list.slots.full), (2, 2, isTrue));
  });

  test('an empty body is an empty list with no slots', () {
    final list = PersonaList.fromJson(const {});
    expect(list.items, isEmpty);
    expect((list.slots.used, list.slots.max), (0, 0));
  });
}
```

Create `test/data/personas/persona_repo_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/api/api_exception.dart';
import 'package:vansen_mobile/data/personas/persona_repo.dart';
import '../../helpers/fakes.dart';

void main() {
  late FakeApi api;
  late PersonaRepo repo;

  setUp(() {
    api = FakeApi();
    repo = PersonaRepo(api);
  });

  test('list reads GET /personas', () async {
    api.getResponses['/personas'] = personasJson([personaJson('p1')], max: 5);
    final list = await repo.list();
    expect(list.items.single.id, 'p1');
    expect(list.slots.max, 5);
  });

  test('create posts the name with consent attested', () async {
    api.postResponses['/personas'] = {'item': personaJson('p2', status: 'draft', filled: 0)};
    final created = await repo.create('Sam');
    expect(api.calls.single, ('POST', '/personas', {'name': 'Sam', 'attested': true}));
    expect(created.id, 'p2');
  });

  test('uploadPhoto posts the file with purpose persona-photo', () async {
    final upload = await repo.uploadPhoto([1, 2, 3]);
    expect(api.calls.single.$1, 'FILE');
    expect(api.calls.single.$2, '/uploads');
    expect(api.calls.single.$3, {'filename': 'photo.jpg', 'purpose': 'persona-photo'});
    expect(upload.uploadId, 'u/ref.png');
  });

  test('setPhoto puts the upload id into the slot', () async {
    api.putResponses['/personas/p1/photos/front'] = {'item': personaJson('p1')};
    final updated = await repo.setPhoto('p1', 'front', 'u/ref.png');
    expect(api.calls.single, ('PUT', '/personas/p1/photos/front', {'uploadId': 'u/ref.png'}));
    expect(updated.isReady, isTrue);
  });

  test('delete removes the persona', () async {
    await repo.delete('p1');
    expect(api.calls.single, ('DELETE', '/personas/p1', null));
  });

  test('a refusal surfaces as an ApiException with the gateway code', () async {
    api.failures['PUT /personas/p1/photos/front'] = (400, 'photo_too_small');
    expect(
      () => repo.setPhoto('p1', 'front', 'u/ref.png'),
      throwsA(isA<ApiException>().having((error) => error.code, 'code', 'photo_too_small')),
    );
  });
}
```

Create `test/data/personas/personas_controller_test.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/api/api_exception.dart';
import 'package:vansen_mobile/core/auth/session_controller.dart';
import 'package:vansen_mobile/data/personas/personas_controller.dart';
import 'package:vansen_mobile/data/repositories/profile_repo.dart';
import '../../helpers/fakes.dart';

void main() {
  late FakeApi api;
  late ProviderContainer container;

  ProviderContainer make({bool signedIn = true}) {
    final made = ProviderContainer(overrides: [
      authGatewayProvider.overrideWithValue(FakeAuthGateway(signedIn: signedIn)),
      apiClientProvider.overrideWithValue(api),
    ]);
    addTearDown(made.dispose);
    return made;
  }

  int personaLoads() =>
      api.calls.where((call) => call.$1 == 'GET' && call.$2 == '/personas').length;

  setUp(() {
    api = FakeApi()..getResponses['/personas'] = personasJson([personaJson('p1')]);
    container = make();
  });

  test('loads on first use', () async {
    final list = await container.read(personasProvider.future);
    expect(list.items.single.id, 'p1');
    expect(personaLoads(), 1);
  });

  test('signed out holds an empty list without calling the gateway', () async {
    final signedOut = make(signedIn: false);
    final list = await signedOut.read(personasProvider.future);
    expect(list.items, isEmpty);
    expect(personaLoads(), 0);
  });

  test('create returns the new persona and reloads', () async {
    await container.read(personasProvider.future);
    api.postResponses['/personas'] = {'item': personaJson('p2', status: 'draft', filled: 0)};
    final created = await container.read(personasProvider.notifier).create('Sam');
    expect(created.id, 'p2');
    expect(personaLoads(), 2);
  });

  test('setPhoto uploads, puts the slot, then reloads', () async {
    await container.read(personasProvider.future);
    api.putResponses['/personas/p1/photos/front'] = {'item': personaJson('p1')};
    await container.read(personasProvider.notifier).setPhoto('p1', 'front', [1, 2, 3]);
    final methods = api.calls.map((call) => '${call.$1} ${call.$2}').toList();
    expect(methods, [
      'GET /personas',
      'FILE /uploads',
      'PUT /personas/p1/photos/front',
      'GET /personas',
    ]);
    expect(api.calls[2].$3, {'uploadId': 'u/ref.png'});
  });

  test('remove deletes and reloads', () async {
    await container.read(personasProvider.future);
    await container.read(personasProvider.notifier).remove('p1');
    expect(api.calls.any((call) => call.$1 == 'DELETE' && call.$2 == '/personas/p1'), isTrue);
    expect(personaLoads(), 2);
  });

  test('a refused mutation rethrows and keeps the list', () async {
    await container.read(personasProvider.future);
    api.failures['DELETE /personas/p1'] = (503, 'delete_failed');
    await expectLater(container.read(personasProvider.notifier).remove('p1'),
        throwsA(isA<ApiException>()));
    expect(container.read(personasProvider).valueOrNull!.items.single.id, 'p1');
    expect(personaLoads(), 1);
  });
}
```

Create `test/core/i18n/persona_keys_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import '../../helpers/i18n.dart';

void main() {
  const keys = [
    'personas.title', 'personas.slotsUsed', 'personas.slotsFull', 'personas.empty',
    'personas.newPersona', 'personas.name', 'personas.consent', 'personas.create',
    'personas.ready', 'personas.draft', 'personas.tip', 'personas.readyHint',
    'personas.deleteTitle', 'personas.deleteBody', 'personas.gone', 'personas.camera',
    'personas.gallery', 'personas.photoSmall', 'personas.photoLarge', 'personas.upgradeBody',
    'personas.loadFailed', 'workspace.persona', 'workspace.noPersona',
    'workspace.managePersonas', 'workspace.personasOff', 'workspace.aspectRatio',
  ];

  test('persona copy exists in both locales', () {
    for (final i18n in [englishI18n(), malayI18n()]) {
      for (final key in keys) {
        expect(i18n.t(key), isNot(key), reason: key);
      }
    }
  });

  test('placeholders survive translation', () {
    for (final i18n in [englishI18n(), malayI18n()]) {
      expect(i18n.t('personas.slotsUsed'), allOf(contains('{used}'), contains('{max}')));
      expect(i18n.t('personas.photoSmall'), contains('{minEdge}'));
      expect(i18n.t('personas.photoLarge'), contains('{maxMb}'));
    }
  });

  test('English carries the web copy verbatim', () {
    final t = englishI18n().t;
    expect(t('personas.consent'),
        'This is me, or someone who gave me permission to use their photos.');
    expect(t('personas.tip'),
        'Sharp photos, good light, one person, no sunglasses. Tap a slot to add or replace it.');
    expect(t('personas.readyHint'), 'Ready — choose it in the composer.');
    expect(t('workspace.personasOff'), 'Personas are temporarily unavailable.');
  });
}
```

In `test/core/api/api_error_test.dart`, append inside `main`:

```dart
  test('every persona code is mapped', () {
    const personaCodes = [
      'slot_limit',
      'photo_too_small',
      'photo_too_large',
      'photo_unavailable',
      'invalid_slot',
      'persona_unavailable',
      'persona_photo_failed',
      'persona_lookup_failed',
      'create_failed',
      'delete_failed',
    ];
    for (final code in personaCodes) {
      expect(apiErrors.containsKey(code), isTrue, reason: code);
    }
    final slotLimit =
        ApiException.fromBody(403, {'error': {'code': 'slot_limit', 'message': 'x'}});
    expect(errorActionFor(slotLimit), ErrorAction.upgrade);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/data/personas test/core/i18n/persona_keys_test.dart test/core/api/api_error_test.dart`
Expected: FAIL. `persona_dto.dart`, `persona_repo.dart` and `personas_controller.dart` do not exist, the persona keys are missing (`persona_keys_test`), and `slot_limit` is not mapped.

- [ ] **Step 4: Write the DTOs**

Create `lib/data/personas/persona_dto.dart`:

```dart
import 'package:collection/collection.dart';

class PersonaPhoto {
  const PersonaPhoto({required this.slot, this.url});

  final String slot;
  final String? url;

  bool get filled => url != null;

  factory PersonaPhoto.fromJson(Map<String, dynamic> json) =>
      PersonaPhoto(slot: json['slot'] as String, url: json['url'] as String?);
}

class PersonaDto {
  const PersonaDto({
    required this.id,
    required this.name,
    required this.status,
    required this.photos,
    required this.thumbUrl,
    required this.createdAt,
  });

  final String id;
  final String name;
  final String status;
  final List<PersonaPhoto> photos;
  final String? thumbUrl;
  final DateTime createdAt;

  bool get isReady => status == 'ready';
  int get filledCount => photos.where((photo) => photo.filled).length;
  PersonaPhoto? photo(String slot) => photos.firstWhereOrNull((photo) => photo.slot == slot);

  factory PersonaDto.fromJson(Map<String, dynamic> json) => PersonaDto(
        id: json['id'] as String,
        name: json['name'] as String? ?? '',
        status: json['status'] == 'ready' ? 'ready' : 'draft',
        photos: [
          for (final photo in json['photos'] as List<dynamic>? ?? const [])
            PersonaPhoto.fromJson(photo as Map<String, dynamic>)
        ],
        thumbUrl: _nonEmpty(json['thumbUrl']),
        createdAt: DateTime.parse(json['createdAt'] as String),
      );
}

class PersonaSlots {
  const PersonaSlots({required this.used, required this.max});

  final int used;
  final int max;

  bool get full => used >= max;

  factory PersonaSlots.fromJson(Map<String, dynamic>? json) => PersonaSlots(
        used: (json?['used'] as num? ?? 0).toInt(),
        max: (json?['max'] as num? ?? 0).toInt(),
      );
}

class PersonaList {
  const PersonaList({required this.items, required this.slots});

  static const empty = PersonaList(items: [], slots: PersonaSlots(used: 0, max: 0));

  final List<PersonaDto> items;
  final PersonaSlots slots;

  List<PersonaDto> get ready => items.where((persona) => persona.isReady).toList();
  PersonaDto? byId(String id) => items.firstWhereOrNull((persona) => persona.id == id);

  factory PersonaList.fromJson(Map<String, dynamic> json) => PersonaList(
        items: [
          for (final item in json['items'] as List<dynamic>? ?? const [])
            PersonaDto.fromJson(item as Map<String, dynamic>)
        ],
        slots: PersonaSlots.fromJson(json['slots'] as Map<String, dynamic>?),
      );
}

String? _nonEmpty(Object? raw) {
  if (raw is! String) return null;
  if (raw.isEmpty) return null;
  return raw;
}
```

- [ ] **Step 5: Write the repo and the controller**

Create `lib/data/personas/persona_repo.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_client.dart';
import '../dtos/upload_response.dart';
import '../repositories/profile_repo.dart';
import 'persona_dto.dart';

final personaRepoProvider =
    Provider<PersonaRepo>((ref) => PersonaRepo(ref.watch(apiClientProvider)));

class PersonaRepo {
  const PersonaRepo(this._api);

  final ApiClient _api;

  Future<PersonaList> list() async => PersonaList.fromJson(await _api.get('/personas'));

  Future<PersonaDto> create(String name) async =>
      _item(await _api.post('/personas', {'name': name, 'attested': true}));

  Future<UploadResponse> uploadPhoto(List<int> bytes) async =>
      UploadResponse.fromJson(await _api.postFile('/uploads',
          bytes: bytes, filename: 'photo.jpg', fields: const {'purpose': 'persona-photo'}));

  Future<PersonaDto> setPhoto(String personaId, String slot, String uploadId) async =>
      _item(await _api.put('/personas/$personaId/photos/$slot', {'uploadId': uploadId}));

  Future<void> delete(String id) => _api.delete('/personas/$id');

  PersonaDto _item(Map<String, dynamic> json) =>
      PersonaDto.fromJson(json['item'] as Map<String, dynamic>);
}
```

Create `lib/data/personas/personas_controller.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/session_controller.dart';
import '../../core/log.dart';
import 'persona_dto.dart';
import 'persona_repo.dart';

final personasProvider =
    AsyncNotifierProvider<PersonasController, PersonaList>(PersonasController.new);

class PersonasController extends AsyncNotifier<PersonaList> {
  @override
  Future<PersonaList> build() async {
    final session = ref.watch(sessionControllerProvider);
    if (session != SessionState.signedIn) return PersonaList.empty;
    return ref.read(personaRepoProvider).list();
  }

  Future<PersonaDto> create(String name) =>
      _mutate('create', () => ref.read(personaRepoProvider).create(name));

  Future<void> setPhoto(String personaId, String slot, List<int> bytes) =>
      _mutate('photo', () => _putPhoto(personaId, slot, bytes));

  Future<void> remove(String id) =>
      _mutate('delete', () => ref.read(personaRepoProvider).delete(id));

  Future<void> reload() async {
    ref.invalidateSelf();
    await future;
  }

  Future<PersonaDto> _putPhoto(String personaId, String slot, List<int> bytes) async {
    final repo = ref.read(personaRepoProvider);
    final upload = await repo.uploadPhoto(bytes);
    return repo.setPhoto(personaId, slot, upload.uploadId);
  }

  Future<T> _mutate<T>(String action, Future<T> Function() run) async {
    try {
      final result = await run();
      await reload();
      return result;
    } on ApiException catch (error) {
      _logUnexpected(action, error);
      rethrow;
    }
  }

  void _logUnexpected(String action, ApiException error) {
    if (error.status < 500) return;
    Log.error('persona $action failed', error);
  }
}
```

- [ ] **Step 6: Error codes**

In `lib/core/api/api_error.dart`, replace `'persona_unavailable': ApiError('errors.personaUnavailable'),` with:

```dart
  'persona_unavailable': ApiError('errors.personaUnavailable'),
  'slot_limit': ApiError('errors.slotLimit', ErrorAction.upgrade),
  'photo_too_small': ApiError('errors.photoTooSmall'),
  'photo_too_large': ApiError('errors.photoTooLarge'),
  'photo_unavailable': ApiError('errors.photoUnavailable'),
  'invalid_slot': ApiError('errors.invalidSlot'),
  'persona_photo_failed': ApiError('errors.personaPhotoFailed'),
  'persona_lookup_failed': ApiError('errors.personaLookupFailed'),
  'create_failed': ApiError('errors.createFailed'),
  'delete_failed': ApiError('errors.deleteFailed'),
```

`invalid_reference` stays unmapped on purpose. `apiErrorText` then shows the gateway's own message, which says which photo problem it was, as the web does.

- [ ] **Step 7: Strings**

Both JSON files round-trip byte for byte through `json.dumps(indent=2, ensure_ascii=False)`, so merge the keys with this script:

```bash
cd /Users/user/StudioProjects/vansen-mobile && python3 - <<'PY'
import json
ADD = {
  "en": {
    "errors": {
      "slotLimit": "All persona slots are in use.",
      "photoTooSmall": "This photo is too small. Use a sharper one.",
      "photoTooLarge": "This photo is too large. Use a smaller one.",
      "photoUnavailable": "That photo is in use or being removed. Upload a new one.",
      "invalidSlot": "Unknown photo slot. Update the app.",
      "personaPhotoFailed": "Could not save the photo. Try again.",
      "personaLookupFailed": "Could not read your persona. Try again.",
      "createFailed": "Could not create the persona. Try again.",
      "deleteFailed": "Could not delete. Try again."
    },
    "workspace": {
      "persona": "Persona",
      "noPersona": "No persona",
      "managePersonas": "Manage personas",
      "personasOff": "Personas are temporarily unavailable.",
      "aspectRatio": "Aspect ratio"
    },
    "personas": {
      "title": "Personas",
      "slotsUsed": "{used} of {max} used",
      "slotsFull": "All slots used — delete a persona to free one.",
      "empty": "No personas yet — add five photos of yourself from different angles.",
      "newPersona": "New persona",
      "name": "Name",
      "consent": "This is me, or someone who gave me permission to use their photos.",
      "create": "Create",
      "ready": "Ready",
      "draft": "Draft",
      "tip": "Sharp photos, good light, one person, no sunglasses. Tap a slot to add or replace it.",
      "readyHint": "Ready — choose it in the composer.",
      "deleteTitle": "Delete this persona?",
      "deleteBody": "Its photos are removed and the slot freed.",
      "gone": "That persona was deleted.",
      "camera": "Take a photo",
      "gallery": "Choose from library",
      "photoSmall": "Use a sharper photo — at least {minEdge} px on the short side.",
      "photoLarge": "Use a smaller photo — at most {maxMb} MB.",
      "upgradeBody": "Personas come with the Studio and Pro plans.",
      "loadFailed": "Could not load your personas."
    }
  },
  "ms": {
    "errors": {
      "slotLimit": "Semua slot persona sedang digunakan.",
      "photoTooSmall": "Foto ini terlalu kecil. Gunakan foto yang lebih tajam.",
      "photoTooLarge": "Foto ini terlalu besar. Gunakan foto yang lebih kecil.",
      "photoUnavailable": "Foto itu sedang digunakan atau sedang dipadam. Muat naik foto baharu.",
      "invalidSlot": "Slot foto tidak dikenali. Kemas kini aplikasi.",
      "personaPhotoFailed": "Tidak dapat menyimpan foto. Cuba lagi.",
      "personaLookupFailed": "Tidak dapat membaca persona anda. Cuba lagi.",
      "createFailed": "Tidak dapat mencipta persona. Cuba lagi.",
      "deleteFailed": "Tidak dapat memadam. Cuba lagi."
    },
    "workspace": {
      "persona": "Persona",
      "noPersona": "Tiada persona",
      "managePersonas": "Urus persona",
      "personasOff": "Persona tidak tersedia buat sementara.",
      "aspectRatio": "Nisbah aspek"
    },
    "personas": {
      "title": "Persona",
      "slotsUsed": "{used} daripada {max} digunakan",
      "slotsFull": "Semua slot digunakan — padam persona untuk mengosongkan satu.",
      "empty": "Belum ada persona — tambah lima foto diri anda dari sudut berbeza.",
      "newPersona": "Persona baharu",
      "name": "Nama",
      "consent": "Ini saya, atau seseorang yang memberi saya kebenaran menggunakan foto mereka.",
      "create": "Cipta",
      "ready": "Sedia",
      "draft": "Draf",
      "tip": "Foto tajam, cahaya baik, seorang sahaja, tanpa cermin mata hitam. Ketik slot untuk menambah atau menggantikannya.",
      "readyHint": "Sedia — pilih dalam komposer.",
      "deleteTitle": "Padam persona ini?",
      "deleteBody": "Fotonya dipadam dan slotnya dikosongkan.",
      "gone": "Persona itu telah dipadam.",
      "camera": "Ambil foto",
      "gallery": "Pilih daripada galeri",
      "photoSmall": "Gunakan foto yang lebih tajam — sekurang-kurangnya {minEdge} px pada sisi pendek.",
      "photoLarge": "Gunakan foto yang lebih kecil — maksimum {maxMb} MB.",
      "upgradeBody": "Persona tersedia dengan pelan Studio dan Pro.",
      "loadFailed": "Tidak dapat memuatkan persona anda."
    }
  }
}
for locale, sections in ADD.items():
    path = f"lib/i18n/{locale}.json"
    data = json.load(open(path, encoding="utf-8"))
    for section, entries in sections.items():
        data.setdefault(section, {}).update(entries)
    open(path, "w", encoding="utf-8").write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
PY
```

Expected: no output. `git diff --stat lib/i18n` shows only added lines.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/data/personas test/core && FLUTTER test --no-pub && FLUTTER analyze --no-pub`
Expected: `All tests passed!` twice, with the full suite still green after the `FakeApi` change. Then `No issues found!`.

---

## Task 4: Photo prep

**Files:**
- Create: `lib/features/personas/photo_prep.dart`, `test/features/personas/photo_prep_test.dart`

**Interfaces:**
- Consumes: `PersonaCatalog` (Task 2); `ImageSizer` = `Future<(int, int)> Function(Uint8List)` and `imageSizerProvider` (existing, `lib/features/studio/image_bytes.dart`); keys `personas.photoSmall` / `personas.photoLarge` (Task 3); `englishI18n()` (Task 3).
- Produces:
  - `enum PhotoSource { camera, gallery }`, `enum PhotoVerdict { ok, tooSmall, tooLarge }`
  - `typedef PersonaPhotoPicker = Future<Uint8List?> Function(PhotoSource source)`, and `personaPhotoPickerProvider`, whose default is `ImagePicker().pickImage(maxWidth: 2048, maxHeight: 2048, imageQuality: 92)`
  - `PhotoVerdict judgePhoto({required int width, required int height, required int byteLength, required PersonaCatalog rules})`
  - `Future<PhotoVerdict> checkPersonaPhoto(Uint8List bytes, PersonaCatalog rules, ImageSizer sizer)`
  - `String? photoVerdictText(String Function(String) t, PhotoVerdict verdict, PersonaCatalog rules)`
  - `String megabytes(int bytes)`

- [ ] **Step 1: Write the failing test**

Create `test/features/personas/photo_prep_test.dart`:

```dart
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/features/personas/photo_prep.dart';
import '../../helpers/catalog_fixture.dart';
import '../../helpers/i18n.dart';

void main() {
  final rules = testCatalog().flat.persona;

  test('a photo under the minimum short edge is refused', () {
    expect(judgePhoto(width: 1023, height: 3000, byteLength: 1000, rules: rules),
        PhotoVerdict.tooSmall);
    expect(judgePhoto(width: 1024, height: 1024, byteLength: 1000, rules: rules),
        PhotoVerdict.ok);
  });

  test('a photo over the byte cap is refused', () {
    expect(judgePhoto(width: 2048, height: 1536, byteLength: 2621441, rules: rules),
        PhotoVerdict.tooLarge);
    expect(judgePhoto(width: 2048, height: 1536, byteLength: 2621440, rules: rules),
        PhotoVerdict.ok);
  });

  test('checkPersonaPhoto judges the decoded size', () async {
    Future<(int, int)> sizer(Uint8List bytes) async => (800, 600);
    expect(await checkPersonaPhoto(Uint8List(10), rules, sizer), PhotoVerdict.tooSmall);
  });

  test('refusal copy carries the catalog numbers', () {
    final t = englishI18n().t;
    expect(photoVerdictText(t, PhotoVerdict.tooSmall, rules),
        'Use a sharper photo — at least 1024 px on the short side.');
    expect(photoVerdictText(t, PhotoVerdict.tooLarge, rules),
        'Use a smaller photo — at most 2.5 MB.');
    expect(photoVerdictText(t, PhotoVerdict.ok, rules), isNull);
  });

  test('megabytes drops a whole-number decimal', () {
    expect(megabytes(2621440), '2.5');
    expect(megabytes(3145728), '3');
  });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/personas/photo_prep_test.dart`
Expected: FAIL. `Error when reading 'lib/features/personas/photo_prep.dart'`.

- [ ] **Step 3: Write photo prep**

Create `lib/features/personas/photo_prep.dart`:

```dart
import 'dart:math' as math;
import 'dart:typed_data';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import '../../data/catalog/catalog.dart';
import '../studio/image_bytes.dart';

enum PhotoSource { camera, gallery }

enum PhotoVerdict { ok, tooSmall, tooLarge }

typedef PersonaPhotoPicker = Future<Uint8List?> Function(PhotoSource source);

final personaPhotoPickerProvider = Provider<PersonaPhotoPicker>((ref) => _pickPhoto);

Future<Uint8List?> _pickPhoto(PhotoSource source) async {
  final picked = await ImagePicker().pickImage(
    source: source == PhotoSource.camera ? ImageSource.camera : ImageSource.gallery,
    maxWidth: 2048,
    maxHeight: 2048,
    imageQuality: 92,
  );
  if (picked == null) return null;
  return picked.readAsBytes();
}

PhotoVerdict judgePhoto({
  required int width,
  required int height,
  required int byteLength,
  required PersonaCatalog rules,
}) {
  if (math.min(width, height) < rules.minEdge) return PhotoVerdict.tooSmall;
  if (rules.maxBytes > 0 && byteLength > rules.maxBytes) return PhotoVerdict.tooLarge;
  return PhotoVerdict.ok;
}

Future<PhotoVerdict> checkPersonaPhoto(
    Uint8List bytes, PersonaCatalog rules, ImageSizer sizer) async {
  final (width, height) = await sizer(bytes);
  return judgePhoto(width: width, height: height, byteLength: bytes.length, rules: rules);
}

String? photoVerdictText(
        String Function(String) t, PhotoVerdict verdict, PersonaCatalog rules) =>
    switch (verdict) {
      PhotoVerdict.ok => null,
      PhotoVerdict.tooSmall =>
        t('personas.photoSmall').replaceAll('{minEdge}', '${rules.minEdge}'),
      PhotoVerdict.tooLarge =>
        t('personas.photoLarge').replaceAll('{maxMb}', megabytes(rules.maxBytes)),
    };

String megabytes(int bytes) {
  final mebibytes = bytes / (1024 * 1024);
  if (mebibytes == mebibytes.roundToDouble()) return '${mebibytes.round()}';
  return mebibytes.toStringAsFixed(1);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/personas/photo_prep_test.dart && FLUTTER analyze --no-pub`
Expected: `All tests passed!` and `No issues found!`.

---

## Task 5: Personas screen: list, create, delete, upgrade prompt

**Files:**
- Create:
  - `lib/features/personas/personas_screen.dart`
  - `lib/features/personas/persona_row.dart`
  - `lib/features/personas/new_persona_sheet.dart`
  - `test/features/personas/personas_screen_test.dart`
  - `test/features/personas/new_persona_sheet_test.dart`

**Interfaces:**
- Consumes:
  - From Task 3: `personasProvider` (`create`, `remove`, `reload`), `PersonaList`, `PersonaDto`, `PersonaSlots`, the i18n keys, `personaJson` / `personasJson`, `englishI18n`, `routedApp`.
  - From Task 2: `catalogProvider.flat.persona.maxNameLength`.
  - Existing: `profileControllerProvider`, `PlanAccess.hasPlan`, `apiErrorText`, `EmptyState`, `BusyButton`, `RemoteImage`.
- Produces:
  - `class PersonasScreen extends ConsumerWidget`. It is routed as `/personas` in Task 9, pushes `/personas/<id>` and `/billing`, and uses the keys `personaSlotsText`, `newPersonaButton`, `upgradePersonas`, `retryPersonas` and `confirmDeletePersona`.
  - `class PersonaRow`, with keys `persona-<id>` and `deletePersona-<id>`.
  - `class NewPersonaSheet`, which pops the created `PersonaDto` and uses the keys `personaNameField`, `personaConsent`, `createPersonaButton` and `personaCreateError`.

- [ ] **Step 1: Write the failing tests**

Create `test/features/personas/personas_screen_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/auth/session_controller.dart';
import 'package:vansen_mobile/core/i18n/i18n.dart';
import 'package:vansen_mobile/data/repositories/profile_repo.dart';
import 'package:vansen_mobile/features/personas/personas_screen.dart';
import 'package:vansen_mobile/shared/widgets/remote_image.dart';
import '../../helpers/catalog_fixture.dart';
import '../../helpers/fakes.dart';
import '../../helpers/i18n.dart';
import '../../helpers/router_harness.dart';

void main() {
  late FakeApi api;

  Widget app() => routedApp(
        overrides: [
          authGatewayProvider.overrideWithValue(FakeAuthGateway(signedIn: true)),
          apiClientProvider.overrideWithValue(api),
          i18nProvider.overrideWithValue(englishI18n()),
          remoteImageBuilderProvider.overrideWithValue((context, url, fit) => const SizedBox()),
          ...catalogOverrides(),
        ],
        home: const PersonasScreen(),
        stubPaths: const ['/billing', '/personas/:id'],
      );

  int personaLoads() =>
      api.calls.where((call) => call.$1 == 'GET' && call.$2 == '/personas').length;

  setUp(() {
    api = FakeApi()
      ..getResponses['/personas'] = personasJson([
        personaJson('p1', name: 'Me'),
        personaJson('p2', name: 'Sam', status: 'draft', filled: 2),
      ]);
  });

  testWidgets('lists personas with status and slot usage', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.text('Me'), findsOneWidget);
    expect(find.text('Ready'), findsOneWidget);
    expect(find.text('Draft · 2/5'), findsOneWidget);
    expect(find.text('2 of 2 used'), findsOneWidget);
    expect(find.text('All slots used — delete a persona to free one.'), findsOneWidget);
    final create = tester.widget<FilledButton>(find.byKey(const Key('newPersonaButton')));
    expect(create.onPressed, isNull);
  });

  testWidgets('no plan shows the upgrade prompt and loads no personas', (tester) async {
    api.getResponses['/profile'] = profileJson()..['subscription'] = null;
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.text('This needs the Studio plan.'), findsOneWidget);
    expect(personaLoads(), 0);
    await tester.tap(find.byKey(const Key('upgradePersonas')));
    await tester.pumpAndSettle();
    expect(find.text('page:/billing'), findsOneWidget);
  });

  testWidgets('creating a persona opens its detail', (tester) async {
    api.getResponses['/personas'] = personasJson([personaJson('p1')], max: 5);
    api.postResponses['/personas'] = {'item': personaJson('p9', status: 'draft', filled: 0)};
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('newPersonaButton')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('personaNameField')), '  Me  ');
    await tester.tap(find.byKey(const Key('personaConsent')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('createPersonaButton')));
    await tester.pumpAndSettle();
    final posted = api.calls.firstWhere((call) => call.$1 == 'POST' && call.$2 == '/personas');
    expect(posted.$3, {'name': 'Me', 'attested': true});
    expect(find.text('page:/personas/p9'), findsOneWidget);
  });

  testWidgets('delete confirms, then deletes and reloads', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('deletePersona-p1')));
    await tester.pumpAndSettle();
    expect(find.text('Delete this persona?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirmDeletePersona')));
    await tester.pumpAndSettle();
    expect(api.calls.where((call) => call.$1 == 'DELETE' && call.$2 == '/personas/p1'),
        hasLength(1));
    expect(personaLoads(), 2);
  });

  testWidgets('a cancelled delete deletes nothing', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('deletePersona-p1')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(api.calls.where((call) => call.$1 == 'DELETE'), isEmpty);
  });

  testWidgets('tapping a row opens that persona', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('persona-p2')));
    await tester.pumpAndSettle();
    expect(find.text('page:/personas/p2'), findsOneWidget);
  });
}
```

Create `test/features/personas/new_persona_sheet_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/auth/session_controller.dart';
import 'package:vansen_mobile/core/i18n/i18n.dart';
import 'package:vansen_mobile/data/repositories/profile_repo.dart';
import 'package:vansen_mobile/features/personas/new_persona_sheet.dart';
import 'package:vansen_mobile/shared/widgets/busy_button.dart';
import '../../helpers/catalog_fixture.dart';
import '../../helpers/fakes.dart';
import '../../helpers/i18n.dart';

void main() {
  late FakeApi api;

  Widget app() => ProviderScope(
        overrides: [
          authGatewayProvider.overrideWithValue(FakeAuthGateway(signedIn: true)),
          apiClientProvider.overrideWithValue(api),
          i18nProvider.overrideWithValue(englishI18n()),
          ...catalogOverrides(),
        ],
        child: const MaterialApp(home: Scaffold(body: NewPersonaSheet())),
      );

  VoidCallback? createAction(WidgetTester tester) =>
      tester.widget<BusyButton>(find.byKey(const Key('createPersonaButton'))).onPressed;

  setUp(() => api = FakeApi());

  testWidgets('Create stays disabled until both a name and consent are given', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(createAction(tester), isNull);
    await tester.enterText(find.byKey(const Key('personaNameField')), 'Me');
    await tester.pump();
    expect(createAction(tester), isNull);
    await tester.tap(find.byKey(const Key('personaConsent')));
    await tester.pump();
    expect(createAction(tester), isNotNull);
    await tester.enterText(find.byKey(const Key('personaNameField')), '   ');
    await tester.pump();
    expect(createAction(tester), isNull);
  });

  testWidgets('the name is capped by the catalog and the consent copy is the web copy',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(find.byKey(const Key('personaNameField'))).maxLength, 40);
    expect(find.text('This is me, or someone who gave me permission to use their photos.'),
        findsOneWidget);
  });

  testWidgets('a refusal shows its mapped message', (tester) async {
    api.postErrorCodes['/personas'] = (403, 'slot_limit');
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('personaNameField')), 'Me');
    await tester.tap(find.byKey(const Key('personaConsent')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('createPersonaButton')));
    await tester.pumpAndSettle();
    expect(find.text('All persona slots are in use.'), findsOneWidget);
    expect(createAction(tester), isNotNull);
  });
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/personas/personas_screen_test.dart test/features/personas/new_persona_sheet_test.dart`
Expected: FAIL. `personas_screen.dart` and `new_persona_sheet.dart` do not exist.

- [ ] **Step 3: Write the row and the sheet**

Create `lib/features/personas/persona_row.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/i18n/i18n.dart';
import '../../core/theme/vansen_colors.dart';
import '../../data/personas/persona_dto.dart';
import '../../shared/widgets/remote_image.dart';

class PersonaRow extends ConsumerWidget {
  const PersonaRow(
      {required this.persona, required this.onOpen, required this.onDelete, super.key});

  final PersonaDto persona;
  final VoidCallback onOpen;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(i18nProvider).t;
    return ListTile(
      key: Key('persona-${persona.id}'),
      contentPadding: EdgeInsets.zero,
      leading: ClipOval(child: SizedBox(width: 40, height: 40, child: _thumb())),
      title: Text(persona.name),
      subtitle: Text(_status(t)),
      trailing: IconButton(
        key: Key('deletePersona-${persona.id}'),
        icon: const Icon(Icons.delete_outline),
        onPressed: onDelete,
      ),
      onTap: onOpen,
    );
  }

  Widget _thumb() {
    final url = persona.thumbUrl;
    if (url == null) {
      return const ColoredBox(
          color: VansenColors.card, child: Icon(Icons.person_outline, size: 20));
    }
    return RemoteImage(url);
  }

  String _status(String Function(String) t) {
    if (persona.isReady) return t('personas.ready');
    return '${t('personas.draft')} · ${persona.filledCount}/${persona.photos.length}';
  }
}
```

Create `lib/features/personas/new_persona_sheet.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_error_text.dart';
import '../../core/api/api_exception.dart';
import '../../core/i18n/i18n.dart';
import '../../core/theme/vansen_colors.dart';
import '../../data/catalog/catalog_controller.dart';
import '../../data/personas/personas_controller.dart';
import '../../shared/widgets/busy_button.dart';

class NewPersonaSheet extends ConsumerStatefulWidget {
  const NewPersonaSheet({super.key});

  @override
  ConsumerState<NewPersonaSheet> createState() => _NewPersonaSheetState();
}

class _NewPersonaSheetState extends ConsumerState<NewPersonaSheet> {
  final _name = TextEditingController();
  bool _consented = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  bool get _canCreate => _name.text.trim().isNotEmpty && _consented;

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(i18nProvider).t;
    final maxLength = ref.watch(catalogProvider).flat.persona.maxNameLength;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(t('personas.newPersona'),
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            TextField(
              key: const Key('personaNameField'),
              controller: _name,
              maxLength: maxLength > 0 ? maxLength : null,
              decoration: InputDecoration(labelText: t('personas.name')),
              onChanged: (_) => setState(() {}),
            ),
            CheckboxListTile(
              key: const Key('personaConsent'),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _consented,
              title: Text(t('personas.consent')),
              onChanged: (value) => setState(() => _consented = value ?? false),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(_error!,
                    key: const Key('personaCreateError'),
                    style: const TextStyle(color: VansenColors.destructive)),
              ),
            BusyButton(
              key: const Key('createPersonaButton'),
              busy: _busy,
              onPressed: _canCreate ? _create : null,
              child: Text(t('personas.create')),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _create() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final created = await ref.read(personasProvider.notifier).create(_name.text.trim());
      if (!mounted) return;
      Navigator.of(context).pop(created);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = apiErrorText(ref.read(i18nProvider), error);
      });
    }
  }
}
```

- [ ] **Step 4: Write the screen**

Create `lib/features/personas/personas_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api/api_error_text.dart';
import '../../core/api/api_exception.dart';
import '../../core/auth/profile_controller.dart';
import '../../core/i18n/i18n.dart';
import '../../core/theme/vansen_colors.dart';
import '../../data/dtos/profile_response.dart';
import '../../data/personas/persona_dto.dart';
import '../../data/personas/personas_controller.dart';
import '../../shared/widgets/empty_state.dart';
import 'new_persona_sheet.dart';
import 'persona_row.dart';

class PersonasScreen extends ConsumerWidget {
  const PersonasScreen({super.key});

  static const _muted = TextStyle(fontSize: 13, color: VansenColors.mutedForeground);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(i18nProvider).t;
    final profile = ref.watch(profileControllerProvider).valueOrNull;
    return Scaffold(
      appBar: AppBar(title: Text(t('personas.title'))),
      body: _body(context, ref, t, profile),
    );
  }

  Widget _body(
      BuildContext context, WidgetRef ref, String Function(String) t, ProfileResponse? profile) {
    if (profile == null) return _spinner();
    if (!profile.hasPlan) return _upgrade(context, t);
    return ref.watch(personasProvider).when(
          data: (list) => _list(context, ref, t, list),
          loading: _spinner,
          error: (_, _) => _loadFailed(ref, t),
        );
  }

  Widget _spinner() => const Center(child: CircularProgressIndicator());

  Widget _upgrade(BuildContext context, String Function(String) t) => EmptyState(
        icon: Icons.face_outlined,
        title: t('errors.studioRequired'),
        body: t('personas.upgradeBody'),
        action: FilledButton(
          key: const Key('upgradePersonas'),
          onPressed: () => context.push('/billing'),
          child: Text(t('errors.actionSubscribe')),
        ),
      );

  Widget _loadFailed(WidgetRef ref, String Function(String) t) => EmptyState(
        icon: Icons.error_outline,
        title: t('personas.loadFailed'),
        action: OutlinedButton(
          key: const Key('retryPersonas'),
          onPressed: () => ref.read(personasProvider.notifier).reload(),
          child: Text(t('common.retry')),
        ),
      );

  Widget _list(
          BuildContext context, WidgetRef ref, String Function(String) t, PersonaList list) =>
      ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          Text(_slotsText(t, list.slots), key: const Key('personaSlotsText'), style: _muted),
          const SizedBox(height: 12),
          if (list.items.isEmpty) Text(t('personas.empty'), style: _muted),
          for (final persona in list.items)
            PersonaRow(
              persona: persona,
              onOpen: () => context.push('/personas/${persona.id}'),
              onDelete: () => _delete(context, ref, persona),
            ),
          const SizedBox(height: 16),
          FilledButton(
            key: const Key('newPersonaButton'),
            onPressed: list.slots.full ? null : () => _create(context),
            child: Text(t('personas.newPersona')),
          ),
          if (list.slots.full)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(t('personas.slotsFull'), style: _muted),
            ),
        ],
      );

  String _slotsText(String Function(String) t, PersonaSlots slots) => t('personas.slotsUsed')
      .replaceAll('{used}', '${slots.used}')
      .replaceAll('{max}', '${slots.max}');

  Future<void> _create(BuildContext context) async {
    final created = await showModalBottomSheet<PersonaDto>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const NewPersonaSheet(),
    );
    if (created == null) return;
    if (!context.mounted) return;
    context.push('/personas/${created.id}');
  }

  Future<void> _delete(BuildContext context, WidgetRef ref, PersonaDto persona) async {
    final i18n = ref.read(i18nProvider);
    final confirmed = await _confirmDelete(context, i18n.t);
    if (confirmed != true) return;
    try {
      await ref.read(personasProvider.notifier).remove(persona.id);
    } on ApiException catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(apiErrorText(i18n, error))));
    }
  }

  Future<bool?> _confirmDelete(BuildContext context, String Function(String) t) =>
      showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(t('personas.deleteTitle')),
          content: Text(t('personas.deleteBody')),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text(t('common.cancel')),
            ),
            TextButton(
              key: const Key('confirmDeletePersona'),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(t('library.delete')),
            ),
          ],
        ),
      );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/personas && FLUTTER analyze --no-pub`
Expected: `All tests passed!` and `No issues found!`.

---

## Task 6: Persona detail: five slots, guide images, camera/gallery → prep → upload → PUT

**Files:**
- Create:
  - `lib/features/personas/persona_detail_screen.dart`
  - `lib/features/personas/persona_slot_tile.dart`
  - `lib/features/personas/guide_image.dart`
  - `lib/features/personas/photo_source_sheet.dart`
  - `test/features/personas/persona_detail_screen_test.dart`
  - `test/features/personas/guide_image_test.dart`

**Interfaces:**
- Consumes:
  - From Task 3: `personasProvider` (`setPhoto`, `reload`), `PersonaDto.photo(slot)`, `PersonaList.byId`, `personaJson` / `personasJson`, `FakeApi.putResponses` / `failures`, `englishI18n`.
  - From Task 2: `catalogProvider.flat.persona.photoSlots`.
  - From Task 4: `PhotoSource`, `personaPhotoPickerProvider`, `checkPersonaPhoto`, `photoVerdictText`.
  - Existing: `imageSizerProvider`, `RemoteImage` / `remoteImageBuilderProvider`, `Env.webBaseUrl`, `apiErrorText`.
- Produces:
  - `class PersonaDetailScreen({required String id})`, routed as `/personas/:id` in Task 9. Keys: `slot-<slotId>`, `personaReadyText`, `personaGoneText`.
  - `class PersonaSlotTile({label, photoUrl, guideUrl, uploading, onTap})`
  - `String guideUrlFor(String slot)`, which returns `'${Env.webBaseUrl}/personas/guides/$slot.jpg'`
  - `typedef GuideImageBuilder = Widget Function(String url, Widget fallback)`, `guideImageBuilderProvider`, `GuideImage({required String url})`, `GuideSilhouette` (key `guideSilhouette`)
  - `Future<PhotoSource?> showPhotoSourceSheet(BuildContext, String Function(String) t)`, with keys `photoCamera` and `photoGallery`

- [ ] **Step 1: Write the failing tests**

Create `test/features/personas/guide_image_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/config/env.dart';
import 'package:vansen_mobile/features/personas/guide_image.dart';

void main() {
  test('guide images live on the web origin', () {
    expect(guideUrlFor('front'), '${Env.webBaseUrl}/personas/guides/front.jpg');
    expect(guideUrlFor('left_profile'), '${Env.webBaseUrl}/personas/guides/left_profile.jpg');
  });

  testWidgets('a missing guide falls back to the bundled silhouette', (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [guideImageBuilderProvider.overrideWithValue((url, fallback) => fallback)],
      child: const MaterialApp(home: GuideImage(url: 'https://x/front.jpg')),
    ));
    expect(find.byKey(const Key('guideSilhouette')), findsOneWidget);
  });
}
```

Create `test/features/personas/persona_detail_screen_test.dart`:

```dart
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/auth/session_controller.dart';
import 'package:vansen_mobile/core/config/env.dart';
import 'package:vansen_mobile/core/i18n/i18n.dart';
import 'package:vansen_mobile/data/repositories/profile_repo.dart';
import 'package:vansen_mobile/features/personas/guide_image.dart';
import 'package:vansen_mobile/features/personas/persona_detail_screen.dart';
import 'package:vansen_mobile/features/personas/persona_slot_tile.dart';
import 'package:vansen_mobile/features/personas/photo_prep.dart';
import 'package:vansen_mobile/features/studio/image_bytes.dart';
import 'package:vansen_mobile/shared/widgets/remote_image.dart';
import '../../helpers/catalog_fixture.dart';
import '../../helpers/fakes.dart';
import '../../helpers/i18n.dart';

void main() {
  late FakeApi api;
  late List<PhotoSource> picked;
  late (int, int) decodedSize;

  Widget app() => ProviderScope(
        overrides: [
          authGatewayProvider.overrideWithValue(FakeAuthGateway(signedIn: true)),
          apiClientProvider.overrideWithValue(api),
          i18nProvider.overrideWithValue(englishI18n()),
          remoteImageBuilderProvider.overrideWithValue((context, url, fit) => Text('photo:$url')),
          guideImageBuilderProvider.overrideWithValue((url, fallback) => Text('guide:$url')),
          personaPhotoPickerProvider.overrideWithValue((source) async {
            picked.add(source);
            return Uint8List.fromList([1, 2, 3]);
          }),
          imageSizerProvider.overrideWithValue((bytes) async => decodedSize),
          ...catalogOverrides(),
        ],
        child: const MaterialApp(home: PersonaDetailScreen(id: 'p1')),
      );

  Future<void> pickFor(WidgetTester tester, String slot, String sourceKey) async {
    await tester.tap(find.byKey(Key('slot-$slot')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(Key(sourceKey)));
    await tester.pumpAndSettle();
  }

  setUp(() {
    picked = [];
    decodedSize = (2048, 1536);
    api = FakeApi()
      ..getResponses['/personas'] =
          personasJson([personaJson('p1', status: 'draft', filled: 2)]);
  });

  testWidgets('renders the catalog slots in order with photos, guides and labels',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    final labels = tester
        .widgetList<PersonaSlotTile>(find.byType(PersonaSlotTile))
        .map((tile) => tile.label);
    expect(labels, ['Front', 'Left ¾', 'Right ¾', 'Left profile', 'Right profile']);
    expect(find.text('photo:https://photo/p1/front'), findsOneWidget);
    expect(find.text('guide:${Env.webBaseUrl}/personas/guides/right_profile.jpg'),
        findsOneWidget);
    expect(find.text(
            'Sharp photos, good light, one person, no sunglasses. Tap a slot to add or replace it.'),
        findsOneWidget);
    expect(find.byKey(const Key('personaReadyText')), findsNothing);
  });

  testWidgets('a slot takes a camera photo, uploads it as a persona photo, then PUTs it',
      (tester) async {
    api.putResponses['/personas/p1/photos/right_three_quarter'] = {
      'item': personaJson('p1', status: 'draft', filled: 3)
    };
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await pickFor(tester, 'right_three_quarter', 'photoCamera');
    expect(picked, [PhotoSource.camera]);
    final upload = api.calls.firstWhere((call) => call.$1 == 'FILE');
    expect(upload.$2, '/uploads');
    expect(upload.$3, {'filename': 'photo.jpg', 'purpose': 'persona-photo'});
    final put = api.calls.firstWhere((call) => call.$1 == 'PUT');
    expect(put.$2, '/personas/p1/photos/right_three_quarter');
    expect(put.$3, {'uploadId': 'u/ref.png'});
  });

  testWidgets('a photo below the minimum edge is refused before any upload', (tester) async {
    decodedSize = (800, 600);
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await pickFor(tester, 'front', 'photoGallery');
    expect(picked, [PhotoSource.gallery]);
    expect(find.text('Use a sharper photo — at least 1024 px on the short side.'),
        findsOneWidget);
    expect(api.calls.where((call) => call.$1 == 'FILE'), isEmpty);
  });

  testWidgets('a gateway refusal shows its message', (tester) async {
    api.failures['PUT /personas/p1/photos/front'] = (409, 'photo_unavailable');
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await pickFor(tester, 'front', 'photoCamera');
    expect(find.text('That photo is in use or being removed. Upload a new one.'),
        findsOneWidget);
  });

  testWidgets('a persona deleted elsewhere says so', (tester) async {
    api.failures['PUT /personas/p1/photos/front'] = (404, 'not_found');
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    api.getResponses['/personas'] = personasJson([]);
    await pickFor(tester, 'front', 'photoCamera');
    expect(find.byKey(const Key('personaGoneText')), findsOneWidget);
  });

  testWidgets('a ready persona says so', (tester) async {
    api.getResponses['/personas'] = personasJson([personaJson('p1')]);
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.text('Ready — choose it in the composer.'), findsOneWidget);
  });
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/personas/guide_image_test.dart test/features/personas/persona_detail_screen_test.dart`
Expected: FAIL. `guide_image.dart`, `persona_detail_screen.dart` and `persona_slot_tile.dart` do not exist.

- [ ] **Step 3: Write the guide image, the slot tile and the source sheet**

Create `lib/features/personas/guide_image.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/config/env.dart';
import '../../core/theme/vansen_colors.dart';

typedef GuideImageBuilder = Widget Function(String url, Widget fallback);

final guideImageBuilderProvider = Provider<GuideImageBuilder>((ref) => _networkGuide);

String guideUrlFor(String slot) => '${Env.webBaseUrl}/personas/guides/$slot.jpg';

Widget _networkGuide(String url, Widget fallback) => Image.network(
      url,
      fit: BoxFit.cover,
      errorBuilder: (context, error, stackTrace) => fallback,
    );

class GuideImage extends ConsumerWidget {
  const GuideImage({required this.url, super.key});

  final String url;

  @override
  Widget build(BuildContext context, WidgetRef ref) =>
      ref.watch(guideImageBuilderProvider)(url, const GuideSilhouette());
}

class GuideSilhouette extends StatelessWidget {
  const GuideSilhouette({super.key});

  @override
  Widget build(BuildContext context) => const ColoredBox(
        key: Key('guideSilhouette'),
        color: VansenColors.card,
        child: Center(
          child: Icon(Icons.person_outline, size: 40, color: VansenColors.mutedForeground),
        ),
      );
}
```

Create `lib/features/personas/persona_slot_tile.dart`:

```dart
import 'package:flutter/material.dart';
import '../../shared/widgets/remote_image.dart';
import 'guide_image.dart';

class PersonaSlotTile extends StatelessWidget {
  const PersonaSlotTile({
    required this.label,
    required this.photoUrl,
    required this.guideUrl,
    required this.uploading,
    required this.onTap,
    super.key,
  });

  final String label;
  final String? photoUrl;
  final String guideUrl;
  final bool uploading;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Column(
          children: [
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    _image(),
                    if (uploading) _spinner(),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 6),
            Text(label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12)),
          ],
        ),
      );

  Widget _image() {
    final url = photoUrl;
    if (url == null) return GuideImage(url: guideUrl);
    return RemoteImage(url);
  }

  Widget _spinner() => const ColoredBox(
        color: Color(0x88000000),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
}
```

Create `lib/features/personas/photo_source_sheet.dart`:

```dart
import 'package:flutter/material.dart';
import 'photo_prep.dart';

Future<PhotoSource?> showPhotoSourceSheet(BuildContext context, String Function(String) t) =>
    showModalBottomSheet<PhotoSource>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              key: const Key('photoCamera'),
              leading: const Icon(Icons.photo_camera_outlined),
              title: Text(t('personas.camera')),
              onTap: () => Navigator.of(sheetContext).pop(PhotoSource.camera),
            ),
            ListTile(
              key: const Key('photoGallery'),
              leading: const Icon(Icons.photo_library_outlined),
              title: Text(t('personas.gallery')),
              onTap: () => Navigator.of(sheetContext).pop(PhotoSource.gallery),
            ),
          ],
        ),
      ),
    );
```

- [ ] **Step 4: Write the detail screen**

Create `lib/features/personas/persona_detail_screen.dart`:

```dart
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api/api_error_text.dart';
import '../../core/api/api_exception.dart';
import '../../core/i18n/i18n.dart';
import '../../core/theme/vansen_colors.dart';
import '../../data/catalog/catalog_controller.dart';
import '../../data/personas/persona_dto.dart';
import '../../data/personas/personas_controller.dart';
import '../studio/image_bytes.dart';
import 'guide_image.dart';
import 'persona_slot_tile.dart';
import 'photo_prep.dart';
import 'photo_source_sheet.dart';

class PersonaDetailScreen extends ConsumerStatefulWidget {
  const PersonaDetailScreen({required this.id, super.key});

  final String id;

  @override
  ConsumerState<PersonaDetailScreen> createState() => _PersonaDetailScreenState();
}

class _PersonaDetailScreenState extends ConsumerState<PersonaDetailScreen> {
  String? _uploadingSlot;

  @override
  Widget build(BuildContext context) {
    final t = ref.watch(i18nProvider).t;
    final personas = ref.watch(personasProvider);
    final persona = personas.valueOrNull?.byId(widget.id);
    return Scaffold(
      appBar: AppBar(title: Text(persona?.name ?? t('personas.title'))),
      body: _body(t, personas.isLoading, persona),
    );
  }

  Widget _body(String Function(String) t, bool loading, PersonaDto? persona) {
    if (persona == null && loading) return const Center(child: CircularProgressIndicator());
    if (persona == null) {
      return Center(child: Text(t('personas.gone'), key: const Key('personaGoneText')));
    }
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _slotGrid(persona),
        const SizedBox(height: 16),
        Text(t('personas.tip'),
            style: const TextStyle(fontSize: 13, color: VansenColors.mutedForeground)),
        if (persona.isReady) ...[
          const SizedBox(height: 8),
          Text(t('personas.readyHint'), key: const Key('personaReadyText')),
        ],
      ],
    );
  }

  Widget _slotGrid(PersonaDto persona) {
    final slots = ref.watch(catalogProvider).flat.persona.photoSlots;
    return GridView.count(
      crossAxisCount: 3,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 12,
      crossAxisSpacing: 12,
      childAspectRatio: 0.75,
      children: [
        for (final slot in slots)
          PersonaSlotTile(
            key: Key('slot-${slot.id}'),
            label: slot.label,
            photoUrl: persona.photo(slot.id)?.url,
            guideUrl: guideUrlFor(slot.id),
            uploading: _uploadingSlot == slot.id,
            onTap: _uploadingSlot == null ? () => _replace(persona.id, slot.id) : null,
          ),
      ],
    );
  }

  Future<void> _replace(String personaId, String slot) async {
    final source = await showPhotoSourceSheet(context, ref.read(i18nProvider).t);
    if (source == null) return;
    final bytes = await ref.read(personaPhotoPickerProvider)(source);
    if (bytes == null) return;
    final refusal = await _refusal(bytes);
    if (refusal != null) {
      _notify(refusal);
      return;
    }
    await _upload(personaId, slot, bytes);
  }

  Future<String?> _refusal(Uint8List bytes) async {
    final rules = ref.read(catalogProvider).flat.persona;
    final verdict = await checkPersonaPhoto(bytes, rules, ref.read(imageSizerProvider));
    return photoVerdictText(ref.read(i18nProvider).t, verdict, rules);
  }

  Future<void> _upload(String personaId, String slot, Uint8List bytes) async {
    setState(() => _uploadingSlot = slot);
    try {
      await ref.read(personasProvider.notifier).setPhoto(personaId, slot, bytes);
    } on ApiException catch (error) {
      _onUploadFailed(error);
    } finally {
      if (mounted) setState(() => _uploadingSlot = null);
    }
  }

  void _onUploadFailed(ApiException error) {
    final i18n = ref.read(i18nProvider);
    if (error.code == 'not_found') {
      _notify(i18n.t('personas.gone'));
      ref.read(personasProvider.notifier).reload();
      return;
    }
    _notify(apiErrorText(i18n, error));
  }

  void _notify(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/personas && FLUTTER analyze --no-pub`
Expected: `All tests passed!` and `No issues found!`.

---

## Task 7: Composer state and controller: choose, price and submit a persona

**Files:**
- Modify:
  - `lib/features/workspace/composer_state.dart` (whole file)
  - `lib/features/workspace/generate_controller.dart`
  - `lib/features/workspace/generate_gate.dart` (whole file)
  - `lib/data/repositories/generation_repo.dart` (`submit`)
  - `test/features/workspace/generate_gate_test.dart` (append)
  - `test/data/repositories/generation_repo_test.dart` (append)
- Create: `test/features/workspace/generate_controller_persona_test.dart`

**Interfaces:**
- Consumes: `PersonaCatalog` via `catalogProvider.flat.persona` (Task 2), `PersonaDto` (Task 3), `personaJson` (Task 3), and `testCatalog(personaEnabled:)` (Task 2).
- Produces:
  - `class PersonaChoice { String id; String name; String aspectRatio; int unitCredits; PersonaChoice withRatio(String); PersonaChoice withPrice(int) }`
  - `ComposerState.persona: PersonaChoice?`, `bool get hasPersona`, and `ComposerState withPersona(PersonaChoice? choice, int batch)`. With a persona, `totalCost` = `unitCredits × batch`. `withoutReference()` keeps the persona.
  - `GenerateController`:
    - `void selectPersona(PersonaDto)`, which accepts ready personas only and clears the reference
    - `void clearPersona()`, `void updatePersonaRatio(String)`, `(int, int) get batchRange`
    - `selectFamily` drops the persona, and `submit` sends `personaId`
  - `String? generateBlockReason({required ProfileResponse? profile, required int? totalCost, bool personaOff = false})`. `personaOff` takes precedence and returns `'workspace.personasOff'`.
  - `GenerationRepo.submit({…, String? personaId})` sends `'personaId': ?personaId`.

- [ ] **Step 1: Write the failing tests**

Create `test/features/workspace/generate_controller_persona_test.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/auth/session_controller.dart';
import 'package:vansen_mobile/core/push/push_gateway.dart';
import 'package:vansen_mobile/data/personas/persona_dto.dart';
import 'package:vansen_mobile/data/repositories/profile_repo.dart';
import 'package:vansen_mobile/features/library/generations_controller.dart';
import 'package:vansen_mobile/features/workspace/generate_controller.dart';
import '../../helpers/catalog_fixture.dart';
import '../../helpers/fakes.dart';

void main() {
  late FakeApi api;
  late ProviderContainer container;

  PersonaDto persona(String id, {String status = 'ready'}) =>
      PersonaDto.fromJson(personaJson(id, status: status));

  GenerateController notifier() => container.read(generateControllerProvider.notifier);

  setUp(() async {
    api = FakeApi()
      ..postResponses['/generations'] = {
        'items': [generationJson('g1')],
        'credits': {'plan': 54, 'pack': 0},
      };
    container = ProviderContainer(overrides: [
      authGatewayProvider.overrideWithValue(FakeAuthGateway(signedIn: true)),
      apiClientProvider.overrideWithValue(api),
      pushGatewayProvider.overrideWithValue(FakePushGateway()),
      jobPollDelayProvider.overrideWithValue((_) async {}),
      ...catalogOverrides(catalog: testCatalog(personaEnabled: true)),
    ]);
    addTearDown(container.dispose);
    container.read(generateControllerProvider);
    await container.read(generationsControllerProvider.future);
  });

  test('choosing a persona clears the reference and prices creditsPerImage × batch', () async {
    await notifier().attachReference([1], 'r.png');
    notifier().selectPersona(persona('p1'));
    final state = container.read(generateControllerProvider);
    expect(state.referenceUploadId, isNull);
    expect(state.persona!.id, 'p1');
    expect(state.persona!.aspectRatio, '1:1');
    expect(state.totalCost, 46);
    notifier().updateBatch(3);
    expect(container.read(generateControllerProvider).totalCost, 138);
    notifier().updateBatch(9);
    expect(container.read(generateControllerProvider).batch, 4);
  });

  test('a draft persona cannot be chosen', () {
    notifier().selectPersona(persona('p2', status: 'draft'));
    expect(container.read(generateControllerProvider).persona, isNull);
  });

  test('choosing a model clears the persona', () {
    notifier().selectPersona(persona('p1'));
    notifier().selectFamily('flux');
    final state = container.read(generateControllerProvider);
    expect(state.persona, isNull);
    expect(state.familyId, 'flux');
  });

  test('clearing the persona returns to the model price', () {
    notifier().selectPersona(persona('p1'));
    notifier().clearPersona();
    expect(container.read(generateControllerProvider).totalCost, 12);
  });

  test('the persona ratio is limited to the catalog ratios', () {
    notifier().selectPersona(persona('p1'));
    notifier().updatePersonaRatio('9:16');
    expect(container.read(generateControllerProvider).persona!.aspectRatio, '9:16');
    notifier().updatePersonaRatio('21:9');
    expect(container.read(generateControllerProvider).persona!.aspectRatio, '9:16');
  });

  test('submit sends personaId with the ratio, the batch and no reference', () async {
    notifier().selectPersona(persona('p1'));
    notifier().updatePersonaRatio('16:9');
    notifier().updateBatch(2);
    await notifier().submit('me on a beach');
    final body = api.calls.firstWhere((call) => call.$2 == '/generations').$3!;
    expect(body['familyId'], 'nano-banana');
    expect(body['op'], 'generate');
    expect(body['personaId'], 'p1');
    expect(body['settings'], {'aspectRatio': '16:9', 'batch': 2});
    expect(body['batch'], 2);
    expect(body['catalogVersion'], testCatalogVersion);
    expect(body.containsKey('referenceUploadId'), isFalse);
    expect(container.read(generateControllerProvider).persona!.id, 'p1');
  });

  test('a plain submit carries no personaId', () async {
    await notifier().submit('a red fox');
    final body = api.calls.firstWhere((call) => call.$2 == '/generations').$3!;
    expect(body.containsKey('personaId'), isFalse);
  });
}
```

Append inside `main` of `test/features/workspace/generate_gate_test.dart`:

```dart
  test('a disabled persona blocks before anything else', () {
    expect(
      generateBlockReason(
          profile: profileWith(subscription: subscriptionWith(), plan: 100),
          totalCost: 46,
          personaOff: true),
      'workspace.personasOff',
    );
    expect(
      generateBlockReason(
          profile: profileWith(subscription: subscriptionWith(), plan: 100), totalCost: 46),
      isNull,
    );
  });
```

Append inside `main` of `test/data/repositories/generation_repo_test.dart`:

```dart
  test('submit carries personaId when a persona is chosen', () async {
    final api = RecordingApiClient()
      ..responses['/generations'] = {
        'items': [generationJson('g4', status: 'pending')],
        'credits': {'plan': 50, 'pack': 0},
      };
    await GenerationRepo(api).submit(
      familyId: 'nano-banana',
      op: GenerationOp.generate,
      prompt: 'me',
      settings: const {'aspectRatio': '1:1', 'batch': 1},
      batch: 1,
      personaId: 'p1',
    );
    expect(api.calls.single.$3!['personaId'], 'p1');
    expect(api.calls.single.$3!.containsKey('referenceUploadId'), isFalse);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/workspace/generate_controller_persona_test.dart test/features/workspace/generate_gate_test.dart test/data/repositories/generation_repo_test.dart`
Expected: FAIL with compile errors: `The method 'selectPersona' isn't defined`, `No named parameter with the name 'personaOff'` and `No named parameter with the name 'personaId'`.

- [ ] **Step 3: `ComposerState` with a persona**

Replace the whole of `lib/features/workspace/composer_state.dart` with:

```dart
import '../../data/catalog/catalog.dart';

bool selectableOnMobile(CatalogFamily family) =>
    family.enabled && family.supported && !family.isVideo;

class PersonaChoice {
  const PersonaChoice({
    required this.id,
    required this.name,
    required this.aspectRatio,
    required this.unitCredits,
  });

  final String id;
  final String name;
  final String aspectRatio;
  final int unitCredits;

  PersonaChoice withRatio(String ratio) =>
      PersonaChoice(id: id, name: name, aspectRatio: ratio, unitCredits: unitCredits);

  PersonaChoice withPrice(int credits) =>
      PersonaChoice(id: id, name: name, aspectRatio: aspectRatio, unitCredits: credits);
}

class ComposerState {
  const ComposerState({
    required this.family,
    required this.settings,
    this.batch = 1,
    this.referenceUploadId,
    this.referenceUrl,
    this.persona,
    this.uploadingReference = false,
    this.submitting = false,
  });

  factory ComposerState.forFamily(CatalogFamily? family) => ComposerState(
        family: family,
        settings: family?.defaultSettings ?? const {},
        batch: family?.batchMin ?? 1,
      );

  final CatalogFamily? family;
  final Map<String, Object> settings;
  final int batch;
  final String? referenceUploadId;
  final String? referenceUrl;
  final PersonaChoice? persona;
  final bool uploadingReference;
  final bool submitting;

  String? get familyId => family?.id;

  bool get hasPersona => persona != null;

  int get referenceCount => referenceUploadId == null ? 0 : 1;

  int? get totalCost {
    final unit = _unitCost;
    if (unit == null) return null;
    return unit * batch;
  }

  int? get _unitCost {
    final chosen = persona;
    if (chosen != null) return chosen.unitCredits;
    return family?.priceFor(settings, referenceCount);
  }

  ComposerState copyWith({
    CatalogFamily? family,
    Map<String, Object>? settings,
    int? batch,
    bool? uploadingReference,
    bool? submitting,
  }) =>
      ComposerState(
        family: family ?? this.family,
        settings: settings ?? this.settings,
        batch: batch ?? this.batch,
        referenceUploadId: referenceUploadId,
        referenceUrl: referenceUrl,
        persona: persona,
        uploadingReference: uploadingReference ?? this.uploadingReference,
        submitting: submitting ?? this.submitting,
      );

  ComposerState withReference(String uploadId, String url) => ComposerState(
        family: family,
        settings: settings,
        batch: batch,
        referenceUploadId: uploadId,
        referenceUrl: url,
      );

  ComposerState withoutReference() => ComposerState(
        family: family,
        settings: settings,
        batch: batch,
        persona: persona,
        submitting: submitting,
      );

  ComposerState withPersona(PersonaChoice? choice, int batch) => ComposerState(
        family: family,
        settings: settings,
        batch: batch,
        persona: choice,
        submitting: submitting,
      );
}
```

- [ ] **Step 4: The gate and the repo**

Replace the whole of `lib/features/workspace/generate_gate.dart` with:

```dart
import '../../data/dtos/profile_response.dart';

String? generateBlockReason({
  required ProfileResponse? profile,
  required int? totalCost,
  bool personaOff = false,
}) {
  if (personaOff) return 'workspace.personasOff';
  if (totalCost == null) return 'workspace.optionUnavailable';
  if (profile == null) return null;
  if (!profile.hasPlan) return 'workspace.subscriptionRequired';
  if (profile.subscription?.plan == 'owner') return null;
  if (totalCost > profile.credits.total) return 'workspace.notEnoughCredits';
  return null;
}
```

In `lib/data/repositories/generation_repo.dart` `submit`:
- Add `String? personaId,` after `String? maskPngBase64,` in the parameter list.
- Add `'personaId': ?personaId,` after `'maskPngBase64': ?maskPngBase64,` in `body`.

- [ ] **Step 5: The controller**

Make these edits to `lib/features/workspace/generate_controller.dart`.

1. Add `import '../../data/personas/persona_dto.dart';` after `import '../../data/dtos/generation_dto.dart';`.

2. After `const catalogRefreshCodes = {'catalog_stale', 'model_disabled'};`, add:

```dart
const _gatewayDefaultRatio = '1:1';
```

3. Replace from `  void _reconcile(Catalog catalog) {` through the end of `updateBatch` (the `}` after `state = state.copyWith(batch: batch.clamp(family.batchMin, family.batchMax));`) with:

```dart
  PersonaCatalog get _personaRules => ref.read(catalogProvider).flat.persona;

  (int, int) get batchRange {
    if (state.hasPersona) return (_personaRules.batchMin, _personaRules.batchMax);
    final family = state.family;
    if (family == null) return (1, 1);
    return (family.batchMin, family.batchMax);
  }

  void _reconcile(Catalog catalog) {
    final id = state.familyId;
    final family = id == null ? null : catalog.family(id);
    if (family == null || !selectableOnMobile(family)) {
      state = ComposerState.forFamily(_firstSelectable(catalog));
      return;
    }
    state = state.copyWith(
      family: family,
      settings: family.normalize(state.settings),
      batch: state.batch.clamp(family.batchMin, family.batchMax),
    );
    _repricePersona(catalog.flat.persona);
  }

  void _repricePersona(PersonaCatalog rules) {
    final persona = state.persona;
    if (persona == null) return;
    state = state.withPersona(persona.withPrice(rules.creditsPerImage), state.batch);
  }

  void selectFamily(String id) {
    final family = ref.read(catalogProvider).family(id);
    if (family == null) return;
    if (!selectableOnMobile(family)) return;
    state = ComposerState.forFamily(family);
  }

  void selectPersona(PersonaDto persona) {
    if (!persona.isReady) return;
    final rules = _personaRules;
    final choice = PersonaChoice(
      id: persona.id,
      name: persona.name,
      aspectRatio: _personaRatio(rules),
      unitCredits: rules.creditsPerImage,
    );
    state = state.withPersona(choice, state.batch.clamp(rules.batchMin, rules.batchMax));
  }

  String _personaRatio(PersonaCatalog rules) {
    final current = state.settings['aspectRatio'];
    if (rules.aspectRatios.contains(current)) return current as String;
    return rules.aspectRatios.firstOrNull ?? _gatewayDefaultRatio;
  }

  void clearPersona() {
    state = state.withPersona(null, state.batch);
    final (lowest, highest) = batchRange;
    state = state.copyWith(batch: state.batch.clamp(lowest, highest));
  }

  void updatePersonaRatio(String ratio) {
    final persona = state.persona;
    if (persona == null) return;
    if (!_personaRules.aspectRatios.contains(ratio)) return;
    state = state.withPersona(persona.withRatio(ratio), state.batch);
  }

  void updateSetting(String axisId, Object value) {
    final family = state.family;
    if (family == null) return;
    state = state.copyWith(settings: family.normalize({...state.settings, axisId: value}));
  }

  void updateBatch(int batch) {
    if (state.family == null) return;
    final (lowest, highest) = batchRange;
    state = state.copyWith(batch: batch.clamp(lowest, highest));
  }
```

4. In `submit`, replace the `final response = await ref.read(generationRepoProvider).submit(` … `);` call with `final response = await _send(family, prompt);`. Then add these two methods directly after `submit`:

```dart
  Future<CreateGenerationResponse> _send(CatalogFamily family, String prompt) {
    final persona = state.persona;
    if (persona != null) return _sendPersona(family, persona, prompt);
    return ref.read(generationRepoProvider).submit(
          familyId: family.id,
          op: GenerationOp.generate,
          prompt: prompt,
          settings: {...state.settings, 'batch': state.batch},
          batch: state.batch,
          catalogVersion: _catalogVersion,
          referenceUploadId: state.referenceUploadId,
        );
  }

  Future<CreateGenerationResponse> _sendPersona(
          CatalogFamily family, PersonaChoice persona, String prompt) =>
      ref.read(generationRepoProvider).submit(
            familyId: family.id,
            op: GenerationOp.generate,
            prompt: prompt,
            settings: {'aspectRatio': persona.aspectRatio, 'batch': state.batch},
            batch: state.batch,
            catalogVersion: _catalogVersion,
            personaId: persona.id,
          );
```

The rest of the file (`_refreshCatalogOn`, `replay`, `submitEdit`, `_accept` and polling) is unchanged. After a successful submit, `state.withoutReference()` keeps the persona. `_gatewayDefaultRatio` is not a persona rule: it is the gateway's own `settings.aspectRatio ?? "1:1"` default, used only when the catalog lists no ratio.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/workspace test/data/repositories && FLUTTER analyze --no-pub`
Expected: `All tests passed!`, including the existing composer, controller and settings-sheet tests. Then `No issues found!`.

---

## Task 8: Composer UI: persona chip, persona sheet, persona settings, disabled notice

**Files:**
- Modify:
  - `lib/features/workspace/composer.dart`
  - `lib/features/workspace/settings_sheet.dart`
  - `lib/features/workspace/workspace_screen.dart` (the `Composer(...)` call and the imports)
- Create:
  - `lib/features/workspace/persona_sheet.dart`
  - `test/features/workspace/composer_persona_test.dart`
  - `test/features/workspace/persona_sheet_test.dart`
  - `test/features/workspace/settings_sheet_persona_test.dart`

**Interfaces:**
- Consumes:
  - From Task 7: `GenerateController.selectPersona / clearPersona / updatePersonaRatio / batchRange`, `ComposerState.persona / hasPersona`, `generateBlockReason(personaOff:)`.
  - From Task 3: `personasProvider`, `PersonaList.ready`, `personaJson` / `personasJson`, `englishI18n`, `routedApp`.
  - From Task 2: `catalogProvider.flat.persona.enabled / aspectRatios`.
- Produces:
  - `Composer({onOpenModelPicker, onOpenSettings, onOpenPersonas})`. The persona chip (key `personaChip`) shows only when `profile.hasPlan`. With a persona chosen, `modelChip` and `attachButton` are hidden.
  - `PersonaSheet`, with keys `personaNone`, `persona-<id>` and `managePersonas`. `managePersonas` pushes `/personas`.

- [ ] **Step 1: Write the failing tests**

Create `test/features/workspace/composer_persona_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/auth/session_controller.dart';
import 'package:vansen_mobile/core/i18n/i18n.dart';
import 'package:vansen_mobile/data/personas/persona_dto.dart';
import 'package:vansen_mobile/data/repositories/profile_repo.dart';
import 'package:vansen_mobile/features/workspace/composer.dart';
import 'package:vansen_mobile/features/workspace/generate_controller.dart';
import '../../helpers/catalog_fixture.dart';
import '../../helpers/fakes.dart';
import '../../helpers/i18n.dart';

void main() {
  late FakeApi api;
  late ProviderContainer container;
  late int personaTaps;

  ProviderContainer make({bool personaEnabled = true}) {
    final made = ProviderContainer(overrides: [
      authGatewayProvider.overrideWithValue(FakeAuthGateway(signedIn: true)),
      apiClientProvider.overrideWithValue(api),
      jobPollDelayProvider.overrideWithValue((_) async {}),
      i18nProvider.overrideWithValue(englishI18n()),
      ...catalogOverrides(catalog: testCatalog(personaEnabled: personaEnabled)),
    ]);
    addTearDown(made.dispose);
    return made;
  }

  Widget app() => UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: Scaffold(
            bottomNavigationBar: Composer(onOpenPersonas: () => personaTaps++),
          ),
        ),
      );

  void choosePersona() => container
      .read(generateControllerProvider.notifier)
      .selectPersona(PersonaDto.fromJson(personaJson('p1', name: 'Me')));

  String cost(WidgetTester tester) =>
      tester.widget<Text>(find.byKey(const Key('composerCostText'))).data!;

  setUp(() {
    personaTaps = 0;
    api = FakeApi()
      ..postResponses['/generations'] = {
        'items': [generationJson('g1')],
        'credits': {'plan': 54, 'pack': 0},
      };
    container = make();
  });

  testWidgets('entitled users see the persona chip and it opens the persona sheet',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('personaChip')), findsOneWidget);
    await tester.tap(find.byKey(const Key('personaChip')));
    expect(personaTaps, 1);
  });

  testWidgets('users without a plan see no persona chip', (tester) async {
    api.getResponses['/profile'] = profileJson()..['subscription'] = null;
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('personaChip')), findsNothing);
  });

  testWidgets('a chosen persona hides the model chip and attach, and prices 46 per image',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attachButton')), findsOneWidget);
    choosePersona();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('modelChip')), findsNothing);
    expect(find.byKey(const Key('attachButton')), findsNothing);
    expect(find.text('Me'), findsOneWidget);
    expect(cost(tester), '46 credits');
    container.read(generateControllerProvider.notifier).updateBatch(2);
    await tester.pumpAndSettle();
    expect(cost(tester), '92 credits');
  });

  testWidgets('Generate sends personaId', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    choosePersona();
    await tester.enterText(find.byKey(const Key('promptField')), 'me in Lisbon');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('generateButton')));
    await tester.pumpAndSettle();
    final body = api.calls.firstWhere((call) => call.$2 == '/generations').$3!;
    expect(body['personaId'], 'p1');
    expect(body['prompt'], 'me in Lisbon');
  });

  testWidgets('a disabled persona blocks Generate with the notice', (tester) async {
    container = make(personaEnabled: false);
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    choosePersona();
    await tester.enterText(find.byKey(const Key('promptField')), 'me in Lisbon');
    await tester.pumpAndSettle();
    expect(find.text('Personas are temporarily unavailable.'), findsOneWidget);
    final button = tester.widget<IconButton>(find.byKey(const Key('generateButton')));
    expect(button.onPressed, isNull);
  });
}
```

Create `test/features/workspace/persona_sheet_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/auth/session_controller.dart';
import 'package:vansen_mobile/data/repositories/profile_repo.dart';
import 'package:vansen_mobile/features/workspace/generate_controller.dart';
import 'package:vansen_mobile/features/workspace/persona_sheet.dart';
import 'package:vansen_mobile/shared/widgets/remote_image.dart';
import '../../helpers/catalog_fixture.dart';
import '../../helpers/fakes.dart';
import '../../helpers/router_harness.dart';

void main() {
  late FakeApi api;

  Widget app() => routedApp(
        overrides: [
          authGatewayProvider.overrideWithValue(FakeAuthGateway(signedIn: true)),
          apiClientProvider.overrideWithValue(api),
          remoteImageBuilderProvider.overrideWithValue((context, url, fit) => const SizedBox()),
          ...catalogOverrides(catalog: testCatalog(personaEnabled: true)),
        ],
        home: const Scaffold(body: PersonaSheet()),
        stubPaths: const ['/personas'],
      );

  ProviderContainer containerOf(WidgetTester tester) =>
      ProviderScope.containerOf(tester.element(find.byType(PersonaSheet)));

  setUp(() {
    api = FakeApi()
      ..getResponses['/personas'] = personasJson([
        personaJson('p1', name: 'Me'),
        personaJson('p2', name: 'Sam', status: 'draft', filled: 2),
      ]);
  });

  testWidgets('lists ready personas only, plus none and manage', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('personaNone')), findsOneWidget);
    expect(find.byKey(const Key('persona-p1')), findsOneWidget);
    expect(find.byKey(const Key('persona-p2')), findsNothing);
    expect(find.byKey(const Key('managePersonas')), findsOneWidget);
  });

  testWidgets('tapping a persona chooses it; None clears it', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('persona-p1')));
    await tester.pumpAndSettle();
    expect(containerOf(tester).read(generateControllerProvider).persona!.id, 'p1');
    await tester.tap(find.byKey(const Key('personaNone')));
    await tester.pumpAndSettle();
    expect(containerOf(tester).read(generateControllerProvider).persona, isNull);
  });

  testWidgets('Manage personas opens the personas screen', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('managePersonas')));
    await tester.pumpAndSettle();
    expect(find.text('page:/personas'), findsOneWidget);
  });
}
```

Create `test/features/workspace/settings_sheet_persona_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vansen_mobile/core/auth/session_controller.dart';
import 'package:vansen_mobile/data/personas/persona_dto.dart';
import 'package:vansen_mobile/data/repositories/profile_repo.dart';
import 'package:vansen_mobile/features/workspace/generate_controller.dart';
import 'package:vansen_mobile/features/workspace/settings_sheet.dart';
import '../../helpers/catalog_fixture.dart';
import '../../helpers/fakes.dart';

void main() {
  late ProviderContainer container;

  setUp(() {
    container = ProviderContainer(overrides: [
      authGatewayProvider.overrideWithValue(FakeAuthGateway(signedIn: true)),
      apiClientProvider.overrideWithValue(FakeApi()),
      ...catalogOverrides(catalog: testCatalog(personaEnabled: true)),
    ]);
    addTearDown(container.dispose);
    container
        .read(generateControllerProvider.notifier)
        .selectPersona(PersonaDto.fromJson(personaJson('p1')));
  });

  Widget app() => UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: Scaffold(body: SettingsSheet())),
      );

  String cost(WidgetTester tester) =>
      tester.widget<Text>(find.byKey(const Key('sheetCostText'))).data!;

  testWidgets('with a persona the sheet offers only the persona ratios and batch',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.text('Version'), findsNothing);
    expect(find.text('Resolution'), findsNothing);
    expect(find.text('workspace.aspectRatio'), findsOneWidget);
    for (final ratio in ['1:1', '3:4', '4:3', '16:9', '9:16']) {
      expect(find.byKey(Key('option-aspectRatio-$ratio')), findsOneWidget);
    }
    expect(cost(tester), '46 workspace.credits');
    await tester.tap(find.byKey(const Key('batchPlus')));
    await tester.pumpAndSettle();
    expect(cost(tester), '92 workspace.credits');
    await tester.tap(find.byKey(const Key('option-aspectRatio-9:16')));
    await tester.pumpAndSettle();
    expect(container.read(generateControllerProvider).persona!.aspectRatio, '9:16');
  });
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/workspace/composer_persona_test.dart test/features/workspace/persona_sheet_test.dart test/features/workspace/settings_sheet_persona_test.dart`
Expected: FAIL with compile errors: `No named parameter with the name 'onOpenPersonas'` and `persona_sheet.dart` does not exist.

- [ ] **Step 3: The persona sheet**

Create `lib/features/workspace/persona_sheet.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/i18n/i18n.dart';
import '../../data/personas/persona_dto.dart';
import '../../data/personas/personas_controller.dart';
import '../../shared/widgets/remote_image.dart';
import 'generate_controller.dart';

class PersonaSheet extends ConsumerWidget {
  const PersonaSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(i18nProvider).t;
    final personas = ref.watch(personasProvider);
    final selected = ref.watch(generateControllerProvider).persona?.id;
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          children: [
            ListTile(
              key: const Key('personaNone'),
              leading: const Icon(Icons.person_off_outlined),
              title: Text(t('workspace.noPersona')),
              selected: selected == null,
              onTap: () => _clear(context, ref),
            ),
            ..._readyTiles(context, ref, t, personas, selected),
            ListTile(
              key: const Key('managePersonas'),
              leading: const Icon(Icons.manage_accounts_outlined),
              title: Text(t('workspace.managePersonas')),
              onTap: () => _manage(context),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _readyTiles(BuildContext context, WidgetRef ref, String Function(String) t,
      AsyncValue<PersonaList> personas, String? selected) {
    final list = personas.valueOrNull;
    if (list == null && personas.isLoading) return const [LinearProgressIndicator()];
    if (list == null) return [ListTile(title: Text(t('personas.loadFailed')))];
    return [for (final persona in list.ready) _personaTile(context, ref, persona, selected)];
  }

  Widget _personaTile(
          BuildContext context, WidgetRef ref, PersonaDto persona, String? selected) =>
      ListTile(
        key: Key('persona-${persona.id}'),
        leading: ClipOval(
          child: SizedBox(width: 36, height: 36, child: RemoteImage(persona.thumbUrl ?? '')),
        ),
        title: Text(persona.name),
        selected: persona.id == selected,
        onTap: () => _choose(context, ref, persona),
      );

  void _choose(BuildContext context, WidgetRef ref, PersonaDto persona) {
    ref.read(generateControllerProvider.notifier).selectPersona(persona);
    Navigator.of(context).maybePop();
  }

  void _clear(BuildContext context, WidgetRef ref) {
    ref.read(generateControllerProvider.notifier).clearPersona();
    Navigator.of(context).maybePop();
  }

  void _manage(BuildContext context) {
    final router = GoRouter.of(context);
    Navigator.of(context).maybePop();
    router.push('/personas');
  }
}
```

- [ ] **Step 4: The composer**

Make these edits to `lib/features/workspace/composer.dart`.

1. Add `import '../../data/catalog/catalog_controller.dart';` and `import '../../data/dtos/profile_response.dart';` after `import '../../core/theme/vansen_colors.dart';`, and add `import 'composer_state.dart';` after `import '../onboarding/tour_steps.dart';`.

2. Replace the `Composer` constructor and fields with:

```dart
  const Composer(
      {this.onOpenModelPicker, this.onOpenSettings, this.onOpenPersonas, super.key});

  final VoidCallback? onOpenModelPicker;
  final VoidCallback? onOpenSettings;
  final VoidCallback? onOpenPersonas;
```

3. In `build`, replace

```dart
    final blockReason =
        generateBlockReason(profile: profile, totalCost: composer.totalCost);
```

with

```dart
    final personaOff =
        composer.hasPersona && !ref.watch(catalogProvider).flat.persona.enabled;
    final blockReason = generateBlockReason(
        profile: profile, totalCost: composer.totalCost, personaOff: personaOff);
```

and replace `_actionsRow(t, composer.family?.acceptsReference ?? false, blockReason),` with `_actionsRow(t, composer, profile?.hasPlan ?? false, blockReason),`.

4. Replace the whole `_actionsRow` method (from `  Widget _actionsRow(` to the `}` closing it, just before `_costText`) with:

```dart
  Widget _actionsRow(String Function(String) t, ComposerState composer, bool entitled,
      String? blockReason) {
    final attachable = (composer.family?.acceptsReference ?? false) && !composer.hasPersona;
    return Row(
      children: [
        if (!composer.hasPersona) ...[
          Flexible(child: _modelChip(composer)),
          const SizedBox(width: 8),
        ],
        if (entitled) ...[
          Flexible(child: _personaChip(t, composer)),
          const SizedBox(width: 8),
        ],
        ActionChip(
          key: const Key('settingsChip'),
          avatar: const Icon(Icons.tune, size: 14),
          label: Text(t('workspace.settings')),
          onPressed: widget.onOpenSettings,
        ),
        if (attachable) _attachButton(composer),
        const Spacer(),
        _generateButton(composer, blockReason),
      ],
    );
  }

  Widget _modelChip(ComposerState composer) => KeyedSubtree(
        key: tourModelKey,
        child: ActionChip(
          key: const Key('modelChip'),
          label: Text(composer.family?.label ?? '—',
              maxLines: 1, overflow: TextOverflow.ellipsis),
          onPressed: widget.onOpenModelPicker,
        ),
      );

  Widget _personaChip(String Function(String) t, ComposerState composer) => ActionChip(
        key: const Key('personaChip'),
        avatar: const Icon(Icons.face_outlined, size: 14),
        label: Text(composer.persona?.name ?? t('workspace.persona'),
            maxLines: 1, overflow: TextOverflow.ellipsis),
        onPressed: widget.onOpenPersonas,
      );

  Widget _attachButton(ComposerState composer) => IconButton(
        key: const Key('attachButton'),
        icon: composer.uploadingReference
            ? const SizedBox(
                width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
            : const Icon(Icons.add_photo_alternate_outlined),
        onPressed: composer.uploadingReference ? null : _attachReference,
      );

  Widget _generateButton(ComposerState composer, String? blockReason) => IconButton.filled(
        key: const Key('generateButton'),
        icon: composer.submitting
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                    strokeWidth: 2, color: VansenColors.background))
            : const Icon(Icons.arrow_upward),
        onPressed: _canSubmit(blockReason) ? _submit : null,
      );
```

The tour keeps working: `tourModelKey` still wraps the model chip whenever no persona is chosen, which is always the case during the first-run tour.

- [ ] **Step 5: The settings sheet**

Make these edits to `lib/features/workspace/settings_sheet.dart`.

1. Add `import '../../data/catalog/catalog_controller.dart';` after `import '../../data/catalog/catalog.dart';`.

2. In `build`, replace the `for (final axis in family.axes) OptionControl(…),` element and the `_batchRow(t, composer, family, notifier),` line with:

```dart
            ..._optionControls(ref, t, composer, family, notifier),
            _batchRow(t, composer.batch, notifier),
```

3. Replace the whole `_batchRow` method with:

```dart
  List<Widget> _optionControls(WidgetRef ref, String Function(String) t, ComposerState composer,
      CatalogFamily family, GenerateController notifier) {
    final persona = composer.persona;
    if (persona != null) return [_personaRatio(ref, t, persona, notifier)];
    return [
      for (final axis in family.axes)
        OptionControl(
          axis: axis,
          values: family.valuesFor(axis.id, composer.settings),
          selected: composer.settings[axis.id],
          onSelect: (value) => notifier.updateSetting(axis.id, value),
        ),
    ];
  }

  Widget _personaRatio(WidgetRef ref, String Function(String) t, PersonaChoice persona,
      GenerateController notifier) {
    final ratios = ref.watch(catalogProvider).flat.persona.aspectRatios;
    final axis = CatalogAxis(
      id: 'aspectRatio',
      label: t('workspace.aspectRatio'),
      control: ControlType.aspectRatio,
      values: [for (final ratio in ratios) CatalogValue(value: ratio, label: ratio)],
    );
    return OptionControl(
      axis: axis,
      values: axis.values,
      selected: persona.aspectRatio,
      onSelect: (value) => notifier.updatePersonaRatio(value as String),
    );
  }

  Widget _batchRow(String Function(String) t, int batch, GenerateController notifier) {
    final (lowest, highest) = notifier.batchRange;
    return Row(
      children: [
        Text(t('workspace.batch')),
        const Spacer(),
        IconButton(
          key: const Key('batchMinus'),
          icon: const Icon(Icons.remove),
          onPressed: batch > lowest ? () => notifier.updateBatch(batch - 1) : null,
        ),
        Text('$batch'),
        IconButton(
          key: const Key('batchPlus'),
          icon: const Icon(Icons.add),
          onPressed: batch < highest ? () => notifier.updateBatch(batch + 1) : null,
        ),
      ],
    );
  }
```

`_costRow` is unchanged.

- [ ] **Step 6: The workspace opens the persona sheet**

In `lib/features/workspace/workspace_screen.dart`, add `import 'persona_sheet.dart';` after `import 'model_picker_sheet.dart';`, then add this line to the `Composer(` call after `onOpenSettings: () => _openSheet(context, const SettingsSheet()),`:

```dart
                onOpenPersonas: () => _openSheet(context, const PersonaSheet()),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/features/workspace && FLUTTER analyze --no-pub`
Expected: `All tests passed!`, with the existing `composer_test`, `settings_sheet_test`, `workspace_screen_test` and `tour_integration_test` unchanged and green. Then `No issues found!`.

---

## Task 9: Routes, Settings entry, iOS camera permission

**Files:**
- Modify:
  - `lib/core/router/app_router.dart` (imports and `routes`)
  - `lib/features/settings/settings_screen.dart` (the account `_sectionCard`)
  - `ios/Runner/Info.plist` (after `NSPhotoLibraryAddUsageDescription`)
  - `test/core/router/app_router_test.dart` (append)
  - `test/features/settings/settings_screen_test.dart` (append and imports)
- Create: `test/core/platform/ios_permissions_test.dart`

**Interfaces:**
- Consumes: `PersonasScreen` (Task 5) and `PersonaDetailScreen(id:)` (Task 6).
- Produces: the routes `/personas` and `/personas/:id`, and the Settings tile `settingsPersonasTile`.

- [ ] **Step 1: Write the failing tests**

Append inside `main` of `test/core/router/app_router_test.dart`:

```dart
  test('the persona routes are registered', () {
    final container = ProviderContainer(overrides: [
      authGatewayProvider.overrideWithValue(FakeAuthGateway(signedIn: true)),
      apiClientProvider.overrideWithValue(FakeApi()),
    ]);
    addTearDown(container.dispose);
    final router = container.read(routerProvider);
    final paths =
        router.configuration.routes.whereType<GoRoute>().map((route) => route.path);
    expect(paths, containsAll(['/personas', '/personas/:id']));
  });
```

In `test/features/settings/settings_screen_test.dart`, add `import 'package:go_router/go_router.dart';`, then append inside `main`:

```dart
  testWidgets('the personas tile opens the personas screen', (tester) async {
    final router = GoRouter(routes: [
      GoRoute(path: '/', builder: (context, state) => const SettingsScreen()),
      GoRoute(path: '/personas', builder: (context, state) => const Text('page:/personas')),
    ]);
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(routerConfig: router),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settingsPersonasTile')));
    await tester.pumpAndSettle();
    expect(find.text('page:/personas'), findsOneWidget);
  });
```

Create `test/core/platform/ios_permissions_test.dart`:

```dart
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('iOS explains camera use for persona photos', () {
    final plist = File('ios/Runner/Info.plist').readAsStringSync();
    expect(
      plist,
      contains('<key>NSCameraUsageDescription</key>\n'
          '\t<string>Take persona photos with the camera.</string>'),
    );
  });
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/core/router/app_router_test.dart test/features/settings/settings_screen_test.dart test/core/platform/ios_permissions_test.dart`
Expected: FAIL. The route list lacks `/personas`, `settingsPersonasTile` is not found, and the plist has no `NSCameraUsageDescription`.

- [ ] **Step 3: Implement**

In `lib/core/router/app_router.dart`, add the two imports after `import '../../features/onboarding/age_gate_screen.dart';`:

```dart
import '../../features/personas/persona_detail_screen.dart';
import '../../features/personas/personas_screen.dart';
```

and add after the `/settings` route:

```dart
      GoRoute(path: '/personas', builder: (context, state) => const PersonasScreen()),
      GoRoute(
        path: '/personas/:id',
        builder: (context, state) => PersonaDetailScreen(id: state.pathParameters['id']!),
      ),
```

In `lib/features/settings/settings_screen.dart`, inside the account `_sectionCard([`, add this tile between `settingsBillingTile` and `settingsShowTourTile`:

```dart
            _tile(
              key: const Key('settingsPersonasTile'),
              icon: Icons.face_outlined,
              title: t('personas.title'),
              trailing: _chevron,
              onTap: () => context.push('/personas'),
            ),
```

In `ios/Runner/Info.plist`, insert after the line `<string>Save generated images to your photo library.</string>`:

```xml
	<key>NSCameraUsageDescription</key>
	<string>Take persona photos with the camera.</string>
```

Indent each line with one tab, as its neighbours are. Leave `android/` unchanged, because `image_picker` camera capture needs no manifest permission.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER test --no-pub test/core test/features/settings && FLUTTER analyze --no-pub`
Expected: `All tests passed!` and `No issues found!`.

---

## Task 10: Final gates and the review doc

**Files:**
- Modify: `/Users/user/IdeaProjects/vansen/docs/superpowers/plans/post-implementation-review.md` (the "Persona as saved references" item, line 126)

- [ ] **Step 1: Backend and web gates**

Run:

```bash
cd /Users/user/IdeaProjects/vansen && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null \
  && npm run db:test:start \
  && VANSEN_LOCAL_DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run verify; \
  status=$?; npm run db:test:stop; echo "verify exit $status"
```

Expected: every check listed by `verify-all.mjs` passes, including the Deno tests (`persona_catalog_test.ts` among them), the web tests, `check:shared` and the SQL gates. The last line is `verify exit 0`.

Run: `cd /Users/user/IdeaProjects/vansen && NVM; npx ng build`
Expected: `Application bundle generation complete.`

- [ ] **Step 2: Mobile gates**

Run: `cd /Users/user/StudioProjects/vansen-mobile && FLUTTER analyze --no-pub && FLUTTER test --no-pub`
Expected: `No issues found!` and `All tests passed!`.

- [ ] **Step 3: Record mobile in the persona item**

In `docs/superpowers/plans/post-implementation-review.md`, replace

```
and set `PERSONA_GEN.premium`.
```

with

```
and set `PERSONA_GEN.premium`. Mobile (`2026-09-23-mobile-personas.md`) reads the same switch from `/catalog` `flat.persona.enabled` and shows "Personas are temporarily unavailable." until it is on; guide JPEGs from `npm run persona:guides` are also what the phone's slot tiles load from the web origin (silhouette until then).
```

Run: `cd /Users/user/IdeaProjects/vansen && grep -c "2026-09-23-mobile-personas.md" docs/superpowers/plans/post-implementation-review.md`
Expected: `1`.

Leave every change uncommitted in both repos. The controller commits.

---

## Deploy (controller-run, after review)

Deploy is not a task.
1. From `/Users/user/IdeaProjects/vansen`, run `./deploy.sh`. The change is additive.
2. Read back `flat.persona`: `curl -s https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/catalog | jq .flat.persona`. Expect the "Gateway JSON shapes" block with `"enabled": false`.
3. The mobile commit is local. `persona` stays `enabled = false` until the owner's live smoke.

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| §1–2 `flat.persona` gains photoSlots, minEdge, maxBytes, maxNameLength, planSlots, aspectRatios, batch; additive | 1 |
| §2 one shared `PERSONA_MIN_EDGE` imported by the gateway and web `photo-prep.ts`; `PERSONA_MAX_BYTES` moved from `app.ts`; `PERSONA_SLOT_LABELS` moved from the web manager | 1 (Steps 3, 6, 8) |
| §2 guard test `planSlots` = SQL `persona_slots:*` seed | 1 (`persona_catalog_test.ts`) |
| §3 Data: `PersonaDto`, `PersonaSlots`, `PersonaRepo` over the five calls, `purpose=persona-photo`, `CatalogFlat.persona` parses new fields, `personasProvider` loads on first use and reloads after mutations | 2, 3 |
| §3 Photo prep: gallery/camera, 2048/92, decoded short edge vs `minEdge`, bytes vs `maxBytes` | 4, 6 |
| §3 Personas screen: list with thumb/name/badge/"n of max used"; New persona with name cap + consent, Create gated; delete with confirm; no plan → upgrade prompt | 5 |
| §3 Detail: five slots in `photoSlots` order, photo or `<webOrigin>/personas/guides/<slot>.jpg` with silhouette fallback, label, tap → camera/gallery → prep → upload → PUT; tip and ready copy | 6 |
| §3 Composer: chip for entitled users; sheet with Ready personas + Manage; persona hides model chip and attach; settings sheet only `aspectRatios` + batch; price `creditsPerImage × batch`; submit sends `personaId`; disabled → "Personas are temporarily unavailable." blocks Generate; persona clears reference; model clears persona | 7, 8 |
| §3 Errors: ten codes mapped with messages and actions | 3 |
| §3 Permissions: iOS `NSCameraUsageDescription`; Android none | 9 |
| §3 Library: already renders persona items (phase 1) | none needed |
| §4 Testing list; gates `npm run verify`, `ng build`, `flutter analyze --no-pub`, `flutter test --no-pub` | 1–9, 10 |
| §5 Rollout | Deploy note |

**Placeholder scan:** No TBD, TODO or "similar to Task N" remains, and every code step carries its code. The Deploy step's curl output is a runtime value.

**Type consistency, checked across tasks:**
- `PersonaCatalog` (2): `photoSlots` (6), `minEdge` / `maxBytes` (4), `maxNameLength` (5), `aspectRatios` / `batchMin` / `batchMax` / `creditsPerImage` / `enabled` (7, 8).
- `PersonaDto.isReady / photo / filledCount / thumbUrl` and `PersonaList.ready / byId / slots.full` (3) are used by 5, 6, 7 and 8.
- `personasProvider.notifier.create / setPhoto / remove / reload` (3) are used by 5 and 6.
- `personaPhotoPickerProvider`, `checkPersonaPhoto`, `photoVerdictText` and `PhotoSource` (4) are used by 6.
- `GenerateController.selectPersona / clearPersona / updatePersonaRatio / batchRange` and `ComposerState.persona / hasPersona` (7) are used by 8.
- `generateBlockReason(personaOff:)` (7) is used by `Composer` (8).
- `GenerationRepo.submit(personaId:)` (7).
- Test helpers from 3 (`FakeApi.putResponses / failures`, `personaJson`, `personasJson`, `englishI18n`, `malayI18n`, `routedApp`) are used by 5–8. `testCatalog(personaEnabled:)` (2) is used by 4–8.
- Backend: `PERSONA_SLOT_LABELS / PERSONA_MIN_EDGE / PERSONA_MAX_BYTES / PERSONA_NAME_MAX / personaAspectRatios` (1) are used by `build-catalog.ts`, `app.ts`, `photo-prep.ts` and `persona-manager.ts`.

**Deviations from the spec, found in the code:**
- `ApiClient.postFile` already takes `fields`, so no change is needed.
- The gateway did not enforce three of the named constants. It used the literals `4` (batch) and `40` (name), and `PERSONA_MIN_EDGE` lived only in `personas.ts`. Task 1 moves all three to shared constants and makes the gateway import them.
- `thumbUrl` is `""`, not absent, when the front slot is empty. Mobile reads `""` as none.
- The persona sheet adds a "No persona" row, as the web's "None" does. Without it, a chosen persona could not be cleared while the model chip is hidden.
- `public/personas/guides/` holds only `silhouette.svg`, so every guide is a silhouette until `npm run persona:guides` runs. The bundled silhouette is a Material icon, because mobile has no SVG dependency.
- `Env.webBaseUrl` defaults to `https://vansen.com`, but `deploy.sh` publishes the web at `https://vansen.fendyhaddad-d36.workers.dev/`. The plan uses `Env.webBaseUrl` as it is, and the owner decides the default.
