# Studio Editing Panel — Design (Phase 3b)

Date: 2026-07-09
Status: approved in brainstorming; supersedes the old Phase 3b (video), which moves to
Phase 4b.

## Goal

Give the $5/mo Studio subscription a real product: a Photoshop-lite editing panel inside
the workspace. Local canvas tools are free and instant; AI tools cost credits with the
price always visible. The separation between free and paid must be obvious at a glance —
cost is never a surprise.

Pro tier (video editing tools + more free photo tools) comes later and is only teased in
this phase.

## Decisions (locked with user)

| Question | Decision |
|---|---|
| Where does the panel live? | Workspace page (not a separate route) |
| What happens to the center? | Grid swaps to a canvas viewport in a new "edit mode" |
| Who can use it? | Edit mode open to all (replaces old editor); the Studio panel needs an active Studio subscription — others see it locked with a $5/mo upsell CTA |
| v1 tools | All four bundles: core local, retouch local, mask, AI tools |
| Free/paid separation UX | Two labeled sections + live price chips on every AI tool |
| How do local edits persist? | "Save" uploads the canvas as a new generation version (price $0, `parent_id` chain) |
| Pro side of the switch | Visible but locked, "Pro — coming soon" |
| AI tool model choice | Fixed-function: each tool maps to one curated backend model; user never picks |
| AI tool pricing | Fixed retail prices (not the PAYG margin formula): $0.10 fill-type ops, $0.05 background removal |
| Engine approach | Custom Canvas2D engine + Web Worker + lazy OpenCV.js for heal (Approach A) |

## 1. Layout & flow

Workspace gains a `mode` signal: `'library' | 'edit'`.

- **Library mode** (today's view): grid center, left AI rail, right Studio panel shown as
  a slim teaser rail — for subscribers: "open an image to edit"; for non-subscribers: the
  locked upsell state.
- **Edit mode**: user clicks an image → "Edit" → the grid swaps out and a canvas viewport
  swaps in. Breadcrumb becomes `Workspace › Library › Edit`. Back arrow returns to the
  grid, with an unsaved-changes confirm if the session is dirty.

Three columns in edit mode:

```
┌──────────┬──────────────────────┬──────────────┐
│ AI panel │   canvas viewport    │ Studio panel │
│ (left,   │   image + zoom/pan   │ [Studio|Pro] │
│ exists)  │   mask overlay       │  Tools       │
│          │                      │  ─────────   │
│ prompt   │                      │  AI Tools $  │
│ model    │                      │  ─────────   │
│ generate │                      │  Save/Undo   │
└──────────┴──────────────────────┴──────────────┘
```

- **Left AI panel**: the existing settings-rail, made edit-aware. In edit mode it targets
  the canvas image (`op: 'edit'`, respects a drawn mask). The Video option is visible but
  locked with "Pro — coming soon".
- **Right Studio panel**: `[Studio | Pro]` switch at the top; Pro side locked. Studio side
  has two sections separated by a divider:
  - **Tools** (free, no badges): crop/rotate, brightness, contrast, saturation, sharpen,
    smooth, liquify, spot heal, mask.
  - **AI Tools · uses balance**: remove object, generative fill, remove background,
    expand — each with a live price chip; the apply button repeats the price
    ("Remove object — $0.10"). Insufficient balance disables the button and shows a
    top-up hint, same as the generate flow.
- **Gating**: edit mode itself is open to every user — it replaces the old `/app/edit`
  page, and AI editing via the left panel is PAYG generation, not a Studio perk. Only the
  right Studio panel requires an active Studio subscription (`studioActive()`, the same
  signal as the topbar badge). Non-subscribers see that panel blurred with a lock and a
  "Subscribe to Studio $5/mo" CTA — the upsell sits right next to the canvas they are
  already editing. On lapse the panel locks immediately; storage grace and future
  balance-expiry consequences are governed elsewhere (see Out of scope).
- **Old editor route**: `/app/edit/:id` is absorbed — it redirects into workspace edit
  mode. The MaskCanvas component migrates into the canvas viewport.

### Local vs AI: the heal distinction

Content-aware spot heal does NOT require AI. Small-area retouch (blemish, smudge, stray
hair) uses classical inpainting (OpenCV Telea/Navier-Stokes — samples surrounding pixels)
and runs free in the browser. Large-area object removal, where the model must invent
structure it cannot sample, is the AI tool. Same gesture, two tiers: small brush = free
spot heal; big masked region = paid "Remove object".

## 2. Client architecture

New feature folder `src/app/features/studio/`; engine in `src/app/core/editing/`.

**Engine (pure TypeScript, no Angular):**

- `edit-engine.ts` — holds the working `ImageData`, applies ops, history stack
  (undo/redo via snapshots).
- `ops/adjust.ts` — brightness/contrast/saturation (pixel math).
- `ops/convolve.ts` — sharpen, smooth (convolution kernels).
- `ops/liquify.ts` — displacement-field warp, backward mapping.
- `ops/crop.ts` — crop/rotate.
- `ops/heal.ts` — wraps OpenCV.js `inpaint`; dynamic `import()` so the WASM chunk
  (~8 MB) loads only on first heal use, never in the main bundle.
- `edit-worker.ts` — Web Worker: full-resolution ops run here; preview-resolution ops run
  inline for interactivity.

Every op is a pure function `(ImageData, params) → ImageData`, unit-testable in vitest
without a DOM.

**Quality guarantee (Approach A vs GPU):** output quality is identical to a GPU pipeline —
same math, same kernels. The only GPU advantage is live-preview latency, neutralized by:
preview at screen resolution (~1500 px) during drag, full-resolution recompute in the
worker on release. The `ImageData`-in/`ImageData`-out contract means any single op can be
swapped to a WebGL shader later without touching the others.

**Components (each `.ts` + `.html` + `.css`, per project rule):**

- `canvas-viewport` — displays the working image, zoom/pan, hosts the MaskCanvas overlay
  and liquify/heal brush cursors.
- `studio-panel` — right rail: Studio|Pro switch, tool sections, price chips,
  save/undo/redo.
- `tool-options` — active tool's parameters (brush size, strength, crop ratio, sliders).
- `workspace-page` — gains the `mode` signal and the editing item id.

**State:** an `EditSession` signal-based service: current item, dirty flag, history,
active tool, mask presence. The edit-aware left rail reads the same session (drawn mask
feeds AI edit requests).

**Tier gating:** `studioActive()` (existing billing signal) gates the Edit button and the
Studio panel. The Pro switch reads `SubscriptionPlan.StudioPro` — always locked in v1.

## 3. Backend & data flow

### New endpoint: `POST /edits/save` (existing `api` gateway)

Multipart body: edited canvas PNG + `parentId`.

Flow: auth → Studio-active check (403 `studio_required`) → mime sniff → **moderation gate**
(omni-moderation on the image, strikes apply — prevents laundering banned content through
"local edits") → store `media/{userId}/{genId}.png` → insert generation row:
`op: 'edit'`, `family_id: 'studio'`, `family_name: 'Studio Edit'`, `price_usd: 0`,
`status: 'done'`, `parent_id` chain. No ledger entry. Storage retention follows existing
Studio rules.

### AI tools: fixed-function, fixed retail pricing

Four new catalog entries in `model-families.ts` (new `EDIT_TOOLS` export, synced to
`_shared/` via `npm run sync-shared`, drift-guarded by vitest). Each entry carries an
explicit `userPriceUsd` — the PAYG margin formula is NOT used for edit tools and stays
untouched for generation families.

| Tool | Tool id (`family_id` + kill-switch row) | fal model (verify slugs at implementation) | Provider cost | User pays |
|---|---|---|---|---|
| Remove object | `edit-remove` | flux-pro fill (mask, no prompt) | $0.05 | **$0.10** |
| Generative fill | `edit-fill` | flux-pro fill (mask + prompt) | $0.05 | **$0.10** |
| Expand | `edit-expand` | flux-pro fill outpaint | $0.05 | **$0.10** |
| Remove background | `edit-bg` | birefnet | $0.002 | **$0.05** |

Requests reuse `op: 'edit'` with `familyId` set to the tool id — the tool id drives
pricing, the provider slug, the kill switch, and the ledger `family_id`, so no new
GenerationOp values are needed.

The tool → provider+slug mapping is catalog data, so the backend model can be swapped any
time without UI changes. Users never pick the model — the right panel is task-centric
(click "Remove object"), while the left AI panel remains model-centric (pick GPT
Image/Seedream/FLUX, prompt, mask). Both act on the same canvas.

### Request flow for an AI tool

1. Client saves the current canvas via `POST /edits/save` (guarantees moderation +
   persistence), then
2. calls the existing `POST /generations` with `op: 'edit'`, `familyId` set to the tool
   id, the saved generation as reference, and the mask where applicable.

The entire Phase 3a machinery is reused unchanged: charge RPC (`fn_charge_and_generate`),
jobs table, `GET /jobs` polling, `fn_fail_job` single-refund (`ledger_refund_once`),
stale-job sweep, suspension check, prompt moderation (on fill), kill switch. The fal
adapter extends `slugFor`/`payloadFor` for the new ops — no new adapter.

### Migration `0005_studio_editing.sql`

Four `models` kill-switch rows: `edit-remove`, `edit-fill`, `edit-bg`, `edit-expand`.
No schema changes — the generations table already fits.

## 4. Errors, safety, testing

**Errors:**

- AI tool failure → existing path: job fails, `fn_fail_job` refunds once, canvas
  untouched, toast with retry.
- `/edits/save` moderation flag → 422 + strike, edit not saved. The canvas stays
  client-side (work not lost) but cannot persist.
- Unsaved changes + navigate away → confirm dialog.
- OpenCV lazy-load failure → heal tool shows "couldn't load, retry"; the rest of the
  panel is unaffected. The WASM asset is bundled (no CDN — provider keys and CSP posture
  unchanged).
- Worker crash → engine falls back to main-thread execution (slower, still correct).

**Safety:** every pixel path into storage passes the moderation gate; every AI op passes
the existing prompt + reference gates. Suspension blocks save and AI tools. Local-only
editing of already-owned images still works while suspended (nothing persists, harmless).

**Testing:**

- Engine ops are pure functions → vitest with known pixel fixtures: brightness shifts
  values, sharpen kernel sums, crop dimensions, liquify identity at zero strength,
  history undo/redo round-trips.
- Catalog: `EDIT_TOOLS` prices asserted ($0.10 / $0.05); sync-shared drift guard covers
  the new export automatically.
- Gateway: `/edits/save` auth, Studio gating, moderation paths.
- E2E script extension: save edit → new row at price 0 → AI tool on the saved version →
  refund drill against a kill-switched tool.

## Out of scope (this phase)

- Pro tier content: video editing tools, extra free photo tools, the Pro side of the
  switch beyond the locked teaser.
- Video generation (moved to Phase 4b); the Video option in the left panel is a locked
  teaser only.
- Balance-expiry enforcement after Studio lapse (user-stated future consequence; today
  only the panel lock, the existing 30-day storage grace, and the purge cron apply).
- Mask-scoped local ops (apply sharpen only inside the mask) — the mask feeds AI edits in
  v1; local scoping is a later enhancement.
- Selection tools beyond the brush mask (lasso, magic wand), text/layers, clone stamp,
  recolor, relight.
