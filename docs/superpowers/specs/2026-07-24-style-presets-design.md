# Style Presets — Design Spec

**Date:** 2026-07-24
**Status:** Approved design, pending implementation plan
**Scope:** Image generation only. Video mode excluded (Phase 4b). Avatar/likeness feature is a separate future spec.

## Summary

A NightCafe-style "Style" picker in the workspace left panel. The user picks one of 20
visual styles (Realistic, Anime, Oil painting, …); at generation time the server appends
that style's prompt modifier to the user's prompt before moderation and the provider
call. The user's own prompt stays clean in records; the style is stored as its own
field. Works with every image model — no model gating, no price change.

## Goals

- Help users steer output toward an intended look without prompt-engineering knowledge.
- Keep the user's stored prompt clean (no booster text pollution).
- Follow the existing shared-catalog pattern (Angular master → sync-shared → edge copy).

## Non-goals

- Video styles (add when video ships).
- User-defined or dynamic styles (static list of 20; changes ship via deploy).
- Per-model style tuning (one modifier string works across providers).
- Any pricing impact (style is free — pure prompt text).

## Catalog

New Angular master file `src/app/core/catalog/style-presets.ts`:

```ts
export interface StylePreset {
  id: string;          // kebab-case, e.g. 'oil-painting'
  name: string;        // display, e.g. 'Oil painting'
  category: StyleCategory;
  modifier: string;    // appended to prompt as `, ${modifier}`
  thumb: string;       // asset path, e.g. 'assets/styles/oil-painting.webp'
}
export type StyleCategory = 'art' | 'anime' | 'photo' | 'stylized';
```

20 presets, 5 per category:

| Category (micro-title) | Presets |
|---|---|
| `art` — Art media | Oil painting, Watercolor, Pencil sketch, 3D render, Pixel art |
| `anime` — Anime & comic | Anime, Manga (B&W), Comic book, Cartoon, Soft anime |
| `photo` — Photo looks | Realistic photo, Cinematic, Portrait studio, Analog film, B&W noir |
| `stylized` — Stylized | Cyberpunk, Fantasy art, Vaporwave, Pop art, Minimalist flat |

Modifier strings are short comma phrases (e.g. oil painting: `"oil painting, visible
brushstrokes, canvas texture, rich impasto color"`). Exact strings finalized during
implementation; each stays under ~120 chars so combined prompt stays well within
provider limits.

- `npm run sync-shared` regenerates the edge copy in `supabase/functions/_shared/`
  (same generator as enums/model catalog); vitest drift guard extends to this file.
- Redeploy `api` after catalog changes (bundles `_shared/`).

## Left panel UI

- New **Style** field in the Create section, between Prompt and Reference image.
  Separate component files per project rules (`.ts` + `.html` + `.css`).
- Trigger button: selected style's thumb (16px) + name, or "None". Same visual
  language as the Model trigger (sectioned rail, uppercase micro-titles, muted labels).
- Opens a popover panel: "None" tile first, then a 4-column thumbnail grid grouped
  under category micro-titles. Each tile = thumbnail + name below. Selected tile
  highlighted; click selects and closes.
- Hint icon on the field label: "Boosts your prompt toward a visual style. Applied at
  generation — your prompt text is untouched."
- Visible in image mode only (`@if (mode() === 'image')`).
- Selection persists in workspace preferences alongside other panel settings; default
  "None".

## Generate flow

- Generation request body gains optional `style?: string` (preset id). Omitted or
  `null` = no style.
- `api` edge function validates the id against the synced catalog: unknown id → 400
  `invalid_style`.
- Server appends `", " + modifier` to the prompt **before** the moderation gate and
  **before** any provider call — moderation sees the full effective prompt.
- Generation record: style id persisted in the existing `settings` jsonb
  (`settings.style = id`) — no schema change. The stored `prompt` remains the user's
  original text only.
- Library/detail view shows the style name as a settings chip. (No reuse-prompt
  feature exists today; when one ships it should restore the style too.)
- No credit price change; pricing formula untouched.

## Thumbnails

- One-time generation: same base subject rendered in each of the 20 styles via
  Nano Banana (consistent NightCafe-style grid). ~20 generations, under $1.
- Post-process: downscale to 128×128, encode webp (~10 KB each), commit to
  `public/styles/` (Angular serves `public/` at the site root, same as `/logos/`),
  referenced as `/styles/<id>.webp`.
- Base subject: single portrait-with-scene prompt that shows style differences
  clearly (finalized during asset generation).

## Error handling

- Unknown style id → 400 `invalid_style` (client should never send one; guards stale
  clients after catalog changes).
- Client with a persisted style id no longer in the catalog: selection resets to
  "None" silently on load.
- Moderation rejection behavior unchanged — runs on the boosted prompt, same strikes
  policy.

## Testing

- Drift guard: sync-shared vitest covers `style-presets` shared copy.
- Boost logic unit tests (vitest on the master catalog): `applyStyle` appends the
  modifier; unknown/absent style → prompt unchanged; `styleById` rejects unknown ids.
  Endpoint wiring (400 `invalid_style`, `settings.style` persisted, boosted prompt to
  moderation/provider) verified by live smoke test after deploy — the repo has no
  Deno endpoint test harness.
- Left panel component test: picker renders 20 + None, selection updates prefs,
  hidden in video mode.

## Rollout

1. Catalog + sync-shared + tests.
2. Left panel picker UI (temporary text tiles acceptable until thumbs land).
3. API param + append + tests; redeploy `api`.
4. Thumbnail asset generation + commit.
