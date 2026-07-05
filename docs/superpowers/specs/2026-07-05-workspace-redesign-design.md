# Vansen Workspace Redesign — Design Spec

Date: 2026-07-05
Status: approved in brainstorming; pending user review of this document
Scope: frontend only (stub data). Real Supabase schema/auth/dispatch remain out of scope and paused.

## 1. Problem

The current workspace is a flat 33-entry model list that conflates model families with their
variants (e.g. "GPT Image 2 (medium)" as a standalone model). Users cannot tell why Google
models are labeled 1K/2K/4K while OpenAI models are labeled low/medium/high. There is no
image-to-image editing, no upscaling, no profile area, and the page reads as half-baked.

Key semantic fact driving the redesign (verified against provider docs, 2026-07-05):

- **OpenAI GPT Image**: `quality` (low/medium/high) = compute effort spent rendering —
  detail, textures, text fidelity. `size` = output resolution, a separate parameter
  (gpt-image-2 goes up to 3840×2160). Price = f(quality, size).
- **Google Nano Banana / Pro**: `image_size` (1K/2K/4K, uppercase K required) = pure output
  resolution. No effort knob. Price = f(resolution).
- These are different axes. The UI must teach this via tooltips, not hide it.

## 2. Decisions made (brainstorming answers)

1. Layout: keep the current settings-rail + library layout, polished ("C, less lazy").
2. Settings vocabulary: **native provider terms + tooltips** (option A), rendered in a
   **fixed settings panel** where every option group is always visible and unsupported
   groups are greyed out. Chip labels go native per model; group positions never move.
3. Editing scope: **full suite** — reference-image edit, masked inpainting, upscale,
   variations (option B).
4. Profile: **full settings suite** — Profile / Billing / Usage / Preferences tabs (option C).
5. Model lineup: tight launch set **plus ByteDance both sides, plus full GPT version family**:
   - Image: Nano Banana, Nano Banana Pro, GPT Image (versions 1 / 1.5 / 2), FLUX, Seedream
   - Video: Veo, Sora, Kling, Runway, Seedance
   - Providers on landing page reduce to the 6 represented: Google, OpenAI, ByteDance,
     Black Forest Labs, Kuaishou, Runway.
6. Architecture: **Approach 2 — dedicated editor route.** `/app` (generate + library),
   `/app/edit/:id` (full-page editor), `/app/settings` (settings suite).
7. Billing semantics: every operation is an independent charge at the model performing it.
   Generate with Nano Banana ($0.10 user price at 1K), then mask-edit with GPT Image
   ($0.31 user price at high quality) = two ledger rows against two providers. The editor's Apply button always shows the price of the
   currently selected tool-model.
8. Pricing rule unchanged: user price = provider cost / (1 − 0.33), everywhere, including
   edits and upscales.

## 3. Model catalog restructure

Replace `MODEL_CATALOG` (flat) with `MODEL_FAMILIES`:

```typescript
type OptionValue = string; // '1K' | 'high' | 'turbo' | ...

interface FamilyOption {
  value: OptionValue;
  label: string;        // native provider term, e.g. "High", "4K", "Turbo"
  tooltip: string;      // real semantics, e.g. "More compute per image — sharper detail, better text. Not a resolution setting."
}

interface ModelFamily {
  id: string;                     // 'gpt-image'
  name: string;                   // 'GPT Image'
  provider: string;               // 'OpenAI'
  logo: string;                   // '/logos/openai.svg'
  kind: 'image' | 'video';
  blurb: string;                  // one-liner shown in the model card
  capabilities: {
    versions?: FamilyOption[];    // model generations within the family
    aspectRatios: string[];       // always present
    resolutions?: FamilyOption[]; // pixel-size axis
    qualities?: FamilyOption[];   // effort axis
    durations?: number[];         // seconds, video only
    audio?: boolean;              // model can generate soundtrack (Veo)
    imageInput: boolean;          // accepts reference image (edit-capable)
    maskInput: boolean;           // accepts inpainting mask
  };
  providerCost(settings: GenerationSettings): number; // matrix lookup
}

interface GenerationSettings {
  version?: OptionValue;
  aspectRatio: string;
  resolution?: OptionValue;
  quality?: OptionValue;
  durationS?: number;
}
```

The settings rail renders ONLY from this schema. `paygPriceUsd = providerCost / (1 − 0.33)`
recomputes on every chip click.

### Launch families and verified costs

Provider costs below are from provider docs / fal / Runway API pricing. Rows marked
**(verify)** need a final check during implementation before the numbers go into
`providerCost`.

**Image**

| Family | Axes | Edit | Mask | Provider cost |
|---|---|---|---|---|
| Nano Banana (Google) | Version 1 / 2 · v2 adds Resolution 1K/2K/4K | ✅ (semantic) | ❌ | v1 $0.039 flat · v2: 1K $0.067, 2K $0.101, 4K $0.151 |
| Nano Banana Pro (Google) | Resolution 1K·2K / 4K | ✅ (semantic) | ❌ | 1K/2K $0.134 · 4K $0.24 |
| GPT Image (OpenAI) | Version 1 / 1.5 / 2 · Quality low/med/high · v2 adds Resolution 1K/2K/4K | ✅ | ✅ | matrix below |
| FLUX (BFL, via fal) | Resolution 1MP/2MP/4MP | ✅ (reference) | ❌ | $0.03 per MP |
| Seedream (ByteDance, via fal) | Resolution 1K/2K/4K **(verify 4K rate)** | ✅ | ❌ | $0.03 per image |

GPT Image provider-cost matrix (square / portrait / landscape at ~1K; v2 4K ≈ 2× the 1K
figure per Runway's published credit table — exact token math at implementation):

| Version | Low | Medium | High |
|---|---|---|---|
| 2 | $0.006 / $0.005 / $0.005 | $0.053 / $0.041 / $0.041 | $0.211 / $0.165 / $0.165 |
| 1.5 | $0.009 / $0.013 / $0.013 | $0.034 / $0.05 / $0.05 | $0.133 / $0.20 / $0.20 |
| 1 | $0.011 / $0.016 / $0.016 | $0.042 / $0.063 / $0.063 | $0.167 / $0.25 / $0.25 |

GPT edit calls also incur provider-side input-image tokens (fractions of a cent); absorbed
into the cost matrix, never itemized to the user.

**Video** (costs are per base clip; duration scales linearly)

| Family | Axes | Provider cost |
|---|---|---|
| Veo (Google) | Tier Fast/Standard · Resolution 720p/1080p/4K · Audio · Duration 4/6/8s | Standard $0.40/s (4K $0.60/s) · Fast $0.10/s · **(verify Lite tier inclusion)** |
| Sora (OpenAI) | Tier Standard/Pro · Resolution 720p/1080p (Pro) · Duration 4/8/12s | Std 720p $0.10/s · Pro 720p $0.30/s · Pro 1080p $0.70/s **(verify per-second rates)** |
| Kling (Kuaishou, via fal) | Duration 5/10s | $0.35 per 5s |
| Runway | Version Gen-4 Turbo / Gen-4.5 · Duration 5/10s | Turbo $0.25/5s · 4.5 $0.60/5s |
| Seedance (ByteDance, via fal) | Resolution 720p/1080p · Duration 5/10s | 1080p $0.62/5s · **(verify 720p rate)** |

**Utility (hidden from picker):** Magnific Precision Upscaler v2 via Runway API —
$0.25/image, $1.50 when output exceeds 4096px. User price $0.37 / $2.24. Powers the
Upscale action everywhere.

### Grey-out and tooltip rules

- All groups (Version · Aspect ratio · Resolution · Quality · Duration · Audio) render
  always, in fixed order. A group a model lacks is greyed with tooltip
  "Not supported by {family}".
- Every chip carries an ⓘ tooltip from `FamilyOption.tooltip`. Group headers carry axis
  tooltips: Quality = "compute effort, not pixels"; Resolution = "output pixel size".
- Mask section in the editor greys for non-mask models with tooltip:
  "{family} edits semantically from your prompt — no mask needed. Masking is available on
  GPT Image."

## 4. Generate page (`/app`)

Polished version of current layout. Left fixed rail (320px, sticky), right library.

Rail top→bottom:
1. Mode toggle (Image / Video)
2. Model cards — 5 per mode: provider logo (reuse `/public/logos/*.svg`), name, blurb,
   "from $X.XX" floor price, ring highlight on selection
3. Settings groups per §3 rules
4. Reference image slot — drop zone + "pick from library" (opens small library picker);
   greys when `imageInput: false`. When filled, generation runs as image-to-image and the
   thumbnail shows in the slot with a clear ✕
5. Prompt textarea + `Generate · $X.XX` button (live price), insufficient-balance state
   links to top-up

Library right:
- Grid of generation cards (image thumb; video thumb with ▶ duration tag)
- Hover quick actions: Download, Upscale $0.37, Variation, Edit
- Filter row: All / Images / Videos / Edited / Upscaled
- Click card → detail overlay (§5)

## 5. Detail overlay

Lightweight modal on `/app`:
- Large preview left; right column: prompt, model + settings chips, price paid, created
  date, provenance ("Edited from →" thumbnail links to parent)
- Actions: Download · Upscale $0.37 · Variation (rerun same prompt+settings, new charge) ·
  Edit → routes to `/app/edit/:id` · Delete
- Esc / backdrop closes. No mask tools here.

## 6. Editor (`/app/edit/:id`)

Full-page route, authGuard.

- Center canvas: source image with a `<canvas>` mask layer. Tools: brush / eraser, size
  slider, clear mask. Mask exports as base64 PNG (GPT edits format).
- Left rail (same fixed-panel pattern):
  - Tool-model picker: only `imageInput: true` families
  - Mask section: enabled only for `maskInput: true` (GPT Image); greyed otherwise per §3
  - Settings groups + edit prompt + `Apply edit · $X.XX`
- Result = new library item with provenance → parent. Version chain (v1 → v2 → v3) shown
  across the top; clicking a version loads it into the canvas.
- Toolbar also has Upscale and Download.
- Charged at the tool-model's price. Cross-model editing is expected and normal (§2.7).

## 7. Profile menu + settings suite (`/app/settings`)

Header (right side): balance chip, Studio badge, then avatar dropdown (initial from
email) → balance row with Top up, Settings, Sign out.

Settings page, left tab nav:
1. **Profile** — avatar, email, display name (editable, stub), member since; danger zone:
   delete account (confirm dialog; stub wipes localStorage)
2. **Billing** — balance card + top-up buttons ($20/$50/$100) · Studio card
   (Active / renews date / Cancel with 30-day-grace purge warning) · transaction ledger
   listing every credit/debit: type (topup / generate / edit / upscale / studio_fee),
   model family, date, amount
3. **Usage** — current month: spend by operation type, count by model family, simple bar
   breakdown; computed from the ledger
4. **Preferences** — default mode, default model per mode, default aspect ratio,
   "confirm before generations over $X" threshold; persisted to localStorage; generate
   page applies them on load

## 8. Stub data layer

New `LedgerService` (signal store, localStorage) becomes the single source of truth:

```typescript
interface LedgerEntry {
  id: string;
  at: string;             // ISO timestamp
  type: 'topup' | 'generate' | 'edit' | 'upscale' | 'studio_fee';
  familyId?: string;
  amountUsd: number;      // positive = credit, negative = debit
  note?: string;
}
// balance = sum(entries)
```

- AuthService slims to identity + Studio flag; balance moves to LedgerService.
- Workspace/editor debit by appending entries; Billing and Usage tabs read the same store.
- This shape mirrors the future Postgres `transactions` table, so the stub is a dry run of
  the schema.
- Generation store also persists to localStorage (currently in-memory only) so the library
  and provenance chains survive reload. Placeholder outputs continue to use the verified
  Unsplash pool; edits reuse the parent image so provenance is visibly demonstrated.

## 9. Landing + plans sync

- Carousel: 6 provider logos (Google, OpenAI, ByteDance, BFL, Kuaishou, Runway). Remove
  Ideogram, Recraft, MiniMax.
- Landing services copy: reference only launch families.
- Plans page example-price grid: launch families only (Ideogram row out, Seedance in).
- Admin pages (`/admin/pricing`, `/admin/compare`) keep the old flat catalog import until
  they are reworked; they must not break. The flat `MODEL_CATALOG` stays exported (marked
  deprecated) until admin pages migrate.

## 10. Component decomposition

```
src/app/core/ledger/ledger-service.ts
src/app/core/preferences/preferences-service.ts
src/app/core/catalog/model-families.ts          // data + types + providerCost fns
src/app/shared/hint/hint.{ts,html,css}          // tooltip wrapper (spartan tooltip)
src/app/shared/profile-menu/                    // header avatar dropdown
src/app/features/workspace/
  workspace-page.{ts,html,css}                  // layout shell
  settings-rail/                                // model picker + option groups + prompt
  option-group/                                 // renders ONE axis with grey-out + tooltips
  library-grid/                                 // grid + filters + quick actions
  detail-overlay/
src/app/features/editor/
  editor-page.{ts,html,css}
  mask-canvas/                                  // brush/eraser canvas component
src/app/features/settings/
  settings-page.{ts,html,css}                   // tab shell
  tabs: profile-tab/ billing-tab/ usage-tab/ preferences-tab/
```

Every component: separate .ts/.html/.css (hard user requirement). `option-group` is the
isolation win: one component owns the grey-out/tooltip/native-label pattern; the rail just
maps axes over it.

New spartan installs: `tooltip` (required), `dialog` (detail overlay + confirm dialogs),
`tabs` (settings page), `dropdown-menu` (profile menu) — via
`ng g @spartan-ng/cli:ui <name>`.

## 11. Routes

```
/app                → WorkspacePage    (authGuard)
/app/edit/:id       → EditorPage       (authGuard)
/app/settings       → SettingsPage     (authGuard)
```

Unknown `:id` in editor → redirect `/app`.

## 12. Implementation phases

1. **Core**: model-families catalog + LedgerService + PreferencesService; migrate
   workspace debits to ledger (no visual change yet)
2. **Generate page**: settings rail rebuild (option-group, model cards, reference slot,
   tooltips), library grid + filters
3. **Detail overlay + editor route** (mask canvas, provenance, variations, upscale)
4. **Settings suite + profile dropdown**
5. **Landing/plans sync + cost-number verification pass** (all "(verify)" rows in §3)

Each phase builds green (`npx ng build`) and is preview-verified before the next.

## 13. Error handling & edge cases

- Insufficient balance: Generate/Apply/Upscale buttons disable with inline top-up link
  (existing pattern).
- Price-confirm threshold (Preferences) intercepts operations above $X with a confirm
  dialog.
- Editor with deleted/unknown id: redirect `/app`.
- Deleting a parent image keeps children; provenance link renders as "(deleted)".
- Old localStorage session/ledger shapes: invalidated on parse failure (existing pattern).
- Video families: Edit/Upscale actions hidden (image-only operations at launch).

## 14. Out of scope

- Real provider dispatch, Supabase schema/auth/storage, Stripe — all still paused.
- Onboarding flow (user wants a proper one post-login; separate project).
- Admin pages rework.
- Multi-output batches (n>1 per generation) — noted in vansen.md as future work.
