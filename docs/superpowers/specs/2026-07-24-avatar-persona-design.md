# Avatar Personas — Design Spec

**Date:** 2026-07-24
**Status:** Approved design, pending implementation plan
**Scope:** Image generation only. Trained-likeness personas (Higgsfield-style): user
uploads photos of a person, trains a persona, reuses it in prompts ("me as an
astronaut"). Follows the style-presets spec (2026-07-24), which reserved this as its
own spec.

## Summary

A persona is a trained FLUX LoRA of one person's likeness. The user uploads 5–20 face
photos, pays a fixed 350 credits, and fal's FLUX LoRA portrait trainer produces
weights in ~2–5 minutes. Selecting a persona in the left panel routes generation
through a hidden `persona` model family (fal flux-lora inference with the trained
weights); the persona's trigger word is injected server-side, keeping the stored
prompt clean. Studio+ only; Studio gets 2 persona slots, Pro gets 5.

A companion **Trends** gallery ships curated, rotating prompt templates
("90s yearbook", "Action figure", …) with example thumbnails. Picking a trend
prefills the prompt box (editable) and applies suggested settings; generation then
follows the normal persona flow. All persona generations — trend or free-form —
run on fal: fal trains the LoRA and fal's flux-lora endpoint generates with it.

## Decisions (brainstorm outcomes)

- **Subjects:** people only. No pets/products/characters.
- **Consent:** self-attestation at creation ("this is me, or someone who gave me
  permission"), backed by ToS. No identity verification. Prompt/image moderation
  unchanged.
- **Architecture:** trained LoRA (option B), chosen over zero-shot multi-image
  reference conditioning for maximum likeness fidelity. Accepted consequence:
  **persona generations run only on the FLUX-LoRA pipeline** — Nano Banana, GPT
  Image, and Seedream cannot be used with a persona.
- **Gating:** persona creation and use require an active Studio or Pro subscription.
- **Training price:** fixed 350 credits per training run (EDIT_TOOLS-style fixed
  retail, ~43% margin on ~$2 fal training cost). Retrain = same fee.
- **Slots:** Studio 2 / Pro 5 concurrent personas; deleting frees a slot.
- **Trends:** curated prompt templates that prefill the prompt box (editable, not
  one-click hidden prompts), managed as a static deploy-shipped catalog like style
  presets (not DB-backed).

## Non-goals

- Video personas (revisit at Phase 4b).
- Zero-shot likeness on other models (rejected in brainstorm; could return later as
  a separate mode).
- Multi-person scenes from multiple personas in one generation.
- Identity verification / liveness checks.
- Public or shared personas — personas are private to their owner.
- One-click hidden-prompt trend generation (trend templates are transparent and
  editable).
- DB-backed / deploy-free trend rotation, or automated trend ingestion — refreshing
  the trend list is a normal commit + deploy.
- Server-side trend tracking (no `settings.trend`; the prefilled prompt is stored
  like any user prompt).

## Data model

New `personas` table (RLS deny-all; all access via `api` gateway; migration applied
via MCP, recorded alongside the schema record):

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | owner |
| name | text | display name, e.g. "Me" |
| status | text | `draft` \| `training` \| `ready` \| `failed` |
| photo_paths | jsonb | array of `uploads` bucket paths (moderated) |
| lora_url | text null | fal-hosted safetensors URL when ready |
| trigger_word | text null | trainer-assigned trigger phrase |
| provider_ref | text null | fal queue request id while training |
| error | text null | failure detail |
| created_at / trained_at | timestamptz | |

Slot count = non-deleted rows per user (any status).

## Training pipeline

1. `POST /personas` — creates a `draft` with name + required consent-attestation
   boolean. 403 `studio_required` without active Studio/Pro; 403 `slot_limit` when
   slots are full.
2. Photos upload through the **existing** upload endpoint (`uploads` bucket,
   per-image moderation already runs there). The draft references those paths;
   5–20 photos required. UI guidance: one person, clear face, varied angles.
3. `POST /personas/:id/train` — validates draft + photo count, charges **350
   credits** (ledger op `persona_training`), zips the photos, submits to fal's FLUX
   LoRA portrait trainer via the existing fal queue pattern, stores `provider_ref`,
   sets `status='training'`. Exact fal endpoint/parameters (steps, trigger word
   handling) finalized during implementation.
4. Completion follows the existing async-job pattern (`GET /jobs` polling from the
   client; the 5-minute stale-job sweep cron as backstop with a longer staleness
   threshold for training jobs, since runs take ~2–5 min). Success → store
   `lora_url` + `trigger_word`, `status='ready'`. Failure or sweep-timeout →
   `status='failed'` + **one-time refund** of 350 credits guarded like
   `ledger_refund_once`. Retry from the UI starts a fresh charged run.

**Weights storage:** we keep fal's CDN URL instead of copying ~100–300 MB
safetensors through an edge function (memory limits). Passing that URL to fal's
flux-lora inference endpoint is fal's canonical reuse pattern. Accepted risk: fal
file retention; future hardening = background mirror to owned storage (R2).

## Generation with a persona

- Hidden model family `persona` (like `UPSCALER`, not in the picker), backed by fal
  flux-lora inference. Kill-switch row in `models` like every family.
- Request body gains `personaId?: string`. Server validates ownership and
  `status='ready'` → else 400 `persona_not_ready`. Studio gate applies.
- Server injects the persona's `trigger_word` into the effective prompt **before**
  the moderation gate and provider call — same pattern as style modifiers. Stored
  `prompt` remains the user's clean text; `settings.persona = id` in the existing
  settings jsonb (no generations schema change).
- Pricing: normal margin formula over fal flux-lora inference cost (≈$0.035–0.04
  per MP; exact rate verified during implementation like other fal prices).
- Style presets compose with personas (both trigger word and style modifier are
  appended). Capabilities (aspect ratios, resolutions) mirror the FLUX family.
- `SubmitCtx` gains what the fal adapter needs to attach `loras: [{ path:
  lora_url }]` on the inference call.

## Trend presets

Curated persona prompt templates with example output thumbnails — the "trending AI
generation" gallery. Purely a client-side content layer: **no server logic, no new
endpoints** — the same persona generation flow runs underneath, on fal.

New Angular master `src/app/core/catalog/trend-presets.ts`:

```ts
export interface TrendPreset {
  id: string;           // kebab-case, e.g. 'action-figure'
  name: string;         // display, e.g. 'Action figure'
  prompt: string;       // persona-neutral template prefilled into the prompt box
  thumb: string;        // '/trends/<id>.webp' example output
  aspectRatio?: string; // suggested AR applied on pick (user can change)
}
```

- ~12 launch trends (e.g. 90s yearbook, Action figure, Astronaut, Ghibli-style
  portrait, Renaissance painting, Cyberpunk street, Red-carpet, Passport photo,
  LinkedIn headshot, Barbie box, Pixel avatar, Movie poster). Exact list and
  prompt strings finalized during implementation.
- Prompts are written persona-neutral ("portrait as a 1990s yearbook photo, …");
  the persona trigger word is injected server-side exactly as in free-form
  generation, so templates need no placeholder tokens.
- Picking a trend **prefills the prompt box (editable)** and applies the suggested
  aspect ratio. The user generates normally; the stored prompt is whatever text
  they submitted. No trend id is sent to or stored by the server.
- Catalog is client-only (templates are user-visible by design), so it is NOT
  added to sync-shared — no edge copy, no drift guard needed.
- Thumbnails: generated once with a generic sample subject (same one-off script
  pattern as `scripts/gen-style-thumbs.mjs` — no trained persona needed, the thumb
  shows the trend's look), downscaled/webp-encoded, committed to `public/trends/`
  (served at `/trends/`, same pattern as style thumbs in `public/styles/`).
- Rotation: editing `trend-presets.ts` + committing new thumbs + deploy.

## UI

**Left panel — Persona field** (Create section, adjacent to Style; image mode only;
separate `.ts`/`.html`/`.css` files):

- Trigger button: persona thumb (first photo) + name, or "None". Popover: "None",
  the user's personas with status chips, and a "New persona" action.
- Selecting a persona locks the model picker to a "Persona — FLUX likeness" state
  with a hint explaining the lock; clearing restores the prior model selection.
- Selection persists in workspace preferences; resets to "None" silently if the
  persona is deleted or not `ready`.
- Non-Studio users see the field with a lock chip (existing Studio-gated pattern)
  as an upsell.

**Trends gallery** (own component files, below/beside the Persona field, image mode
only):

- Trigger opens a popover grid of trend tiles (example thumb + name), same visual
  language as the Style picker.
- Clicking a tile: if a ready persona is selected, prefill prompt + suggested
  aspect ratio and close; the user can edit anything before Generate. If no
  persona is selected, the tile prompts to pick or create one first.
- Prefill replaces the current prompt text; if the box has user text, confirm
  before overwriting.

**Persona manager dialog** (from "New persona" / "Manage"):

- List with status chips (Training — spinner + "~5 min", Ready, Failed + Retry),
  delete with confirmation, slots indicator ("2 of 5 used").
- Create wizard: name → consent attestation checkbox → photo uploader grid (5–20,
  guidance text, per-photo moderation errors surfaced) → Train button labeled with
  the 350-credit price and current balance check.
- Closing the dialog does not interrupt training; the picker chip reflects
  progress.

## Lifecycle

- Delete persona → row + referenced photos removed, slot freed (fal-hosted weights
  become unreferenced).
- Subscription lapse → 30-day grace, then the existing `purge_lapsed_libraries`
  cron additionally purges the user's personas (photos + rows). During grace,
  personas are visible but training and persona generation are blocked by the
  Studio gate.

## Error handling

- 403 `studio_required` — create/train/generate without active Studio+.
- 403 `slot_limit` — create beyond tier slots.
- 400 `invalid_payload` — photo count outside 5–20, missing attestation.
- 400 `persona_not_ready` — generate with non-ready persona.
- Training failure/timeout → `failed` + one-time 350-credit refund; retry is a new
  charged run.
- Kill switch: `models.enabled=false` on `persona` → field hidden client-side, 503
  server-side, consistent with other families.

## Testing

- Vitest (Angular masters): slot-limit helper, fixed-price constant, trigger-word
  injection (stored prompt stays clean), settings persistence shape; sync-shared
  drift guard covers any new shared catalog entries.
- Component tests: persona picker (gating, lock/unlock of model picker, reset on
  missing persona), wizard validation (photo count, attestation required); trends
  gallery (prefill + AR apply, overwrite confirm, no-persona path).
- Trend catalog vitest: unique ids, non-empty prompts, thumbs resolve, valid ARs.
- Endpoint wiring (gates, charge/refund, fal submission, trigger injection)
  verified by live smoke test after deploy — one real training run (~$2) — since
  the repo has no Deno endpoint test harness (same rationale as style presets).

## Rollout

1. Migration (`personas` table) + `models` kill-switch row.
2. API: persona CRUD + train endpoint + job completion handling + refund path.
3. Generation path: `personaId` param, trigger injection, fal flux-lora adapter
   support, pricing; redeploy `api` with full `_shared/` bundle.
4. Left panel picker + persona manager dialog + preferences wiring.
5. Trend catalog + trends gallery UI (temporary text tiles until thumbs land).
6. Live smoke: train one persona, generate free-form + one trend, verify ledger
   charge/refund paths.
7. Trend thumbnail asset generation (uses the live pipeline) + commit.
