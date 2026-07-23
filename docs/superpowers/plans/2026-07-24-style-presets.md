# Style Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NightCafe-style "Style" picker in the workspace left panel — 20 visual styles whose prompt modifier is appended server-side before moderation and the provider call.

**Architecture:** New Angular master catalog `style-presets.ts` synced to `supabase/functions/_shared/` (existing sync-shared pattern). Client sends optional top-level `style` id on `POST /generations`; the edge function validates it, boosts the prompt for moderation + provider, and persists the id in the generation's `settings` jsonb (`settings.style`). Picker UI reuses the Model-menu dropdown pattern; selection persists in workspace prefs (`defaultStyle`).

**Tech Stack:** Angular 20 (signals, standalone, separate `.ts`/`.html`/`.css` files), Spartan-NG helm dropdown, vitest via `npm test` (`ng test`), Supabase Edge Functions (Deno/Hono), Nano Banana (Google) for one-time thumbnail assets.

**Spec:** `docs/superpowers/specs/2026-07-24-style-presets-design.md`

## Status punchlist (2026-07-24)

- [x] Tasks 1–8 done and deployed (`api` live, boot-verified). Code feature-complete.
- [x] Task 9 thumbnails done via **GPT Image** (`gpt-image-1`, low quality, ~$0.22) after
  Google prepay 429'd (`RESOURCE_EXHAUSTED`). 20 × 128px webp in `public/styles/`,
  verified in prod build output. Script `scripts/gen-style-thumbs.mjs` now targets OpenAI.
- [ ] **Google prepay top-up still needed for PRODUCTION** — deployed api's Nano Banana
  generations 429 until topped up at https://ai.studio/projects. User available
  **earliest 2026-07-28**.
- [ ] Task 8 Step 3 live smoke test — user runs: login → pick a style → generate →
  verify style chip in detail overlay + thumbnails in picker (Task 9 Step 5 visual
  check folds into this; assistant verified assets serve at `/styles/<id>.webp` but
  cannot log in).

## Global Constraints

- **NEVER run `git commit`, `git branch`, or `git push`. The user makes all commits.** Each task ends by telling the user the task is done so they can commit — then continue.
- Angular components always use separate files: `.ts` + `.html` + `.css`. Never inline templates or styles. Prefer stylesheet classes over inline `style` attributes.
- Test command is `npm test` (`ng test`). NEVER bare `npx vitest run` — it falsely fails TestBed specs.
- Build command: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
- After changing any synced master file, run `npm run sync-shared` — vitest drift guard (`src/app/core/shared-sync.spec.ts`) fails otherwise.
- `api` edge function redeploy (final task only): supabase CLI with `--no-verify-jwt` (the MCP deploy tool is broken for this function). Project ref `bnorhcxhvxydkgvcxjad`.
- No provider/API keys in the repo, ever.
- Image mode only. Video untouched.
- No pricing change anywhere — style is free prompt text.

---

### Task 1: Style presets catalog (Angular master + tests)

**Files:**
- Create: `src/app/core/catalog/style-presets.ts`
- Create: `src/app/core/catalog/style-presets.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StylePreset { id, name, category, modifier, thumb }`, `StyleCategory = 'art' | 'anime' | 'photo' | 'stylized'`, `STYLE_PRESETS: StylePreset[]` (20 entries), `STYLE_CATEGORY_TITLES: Record<StyleCategory, string>`, `styleById(id: string): StylePreset | null`, `applyStyle(prompt: string, styleId: string | null | undefined): string`. Later tasks import these from `../../../core/catalog/style-presets` (Angular) and `../_shared/style-presets.ts` (edge).

- [x] **Step 1: Write the failing test**

Create `src/app/core/catalog/style-presets.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  STYLE_CATEGORY_TITLES,
  STYLE_PRESETS,
  applyStyle,
  styleById,
} from './style-presets';

describe('style presets catalog', () => {
  it('has exactly 20 presets, 5 per category', () => {
    expect(STYLE_PRESETS.length).toBe(20);
    for (const category of Object.keys(STYLE_CATEGORY_TITLES)) {
      expect(
        STYLE_PRESETS.filter((p) => p.category === category).length,
        `category ${category}`,
      ).toBe(5);
    }
  });

  it('has unique kebab-case ids and matching thumb paths', () => {
    const ids = STYLE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of STYLE_PRESETS) {
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(p.thumb).toBe(`/styles/${p.id}.webp`);
    }
  });

  it('keeps every modifier non-empty and under 120 chars', () => {
    for (const p of STYLE_PRESETS) {
      expect(p.modifier.length, p.id).toBeGreaterThan(0);
      expect(p.modifier.length, p.id).toBeLessThanOrEqual(120);
    }
  });

  it('styleById resolves known ids and rejects unknown', () => {
    expect(styleById('oil-painting')?.name).toBe('Oil painting');
    expect(styleById('nope')).toBeNull();
  });

  it('applyStyle appends the modifier, untouched without a style', () => {
    const boosted = applyStyle('a photo of batman', 'oil-painting');
    expect(boosted.startsWith('a photo of batman, ')).toBe(true);
    expect(boosted).toContain(styleById('oil-painting')!.modifier);
    expect(applyStyle('a photo of batman', null)).toBe('a photo of batman');
    expect(applyStyle('a photo of batman', undefined)).toBe('a photo of batman');
    expect(applyStyle('a photo of batman', 'nope')).toBe('a photo of batman');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./style-presets`.

- [x] **Step 3: Write the catalog**

Create `src/app/core/catalog/style-presets.ts`:

```ts
/**
 * Style presets — prompt boosters for image generation.
 * MASTER copy. The edge functions consume a synced copy in
 * supabase/functions/_shared/ (npm run sync-shared).
 * Style is free: pure prompt text, no pricing impact.
 */

export type StyleCategory = 'art' | 'anime' | 'photo' | 'stylized';

export interface StylePreset {
  id: string;
  name: string;
  category: StyleCategory;
  /** Appended to the user's prompt as `, ${modifier}` at generation time. */
  modifier: string;
  /** Thumbnail asset path (public/styles/<id>.webp served at /styles/). */
  thumb: string;
}

export const STYLE_CATEGORY_TITLES: Record<StyleCategory, string> = {
  art: 'Art media',
  anime: 'Anime & comic',
  photo: 'Photo looks',
  stylized: 'Stylized',
};

const p = (
  id: string,
  name: string,
  category: StyleCategory,
  modifier: string,
): StylePreset => ({ id, name, category, modifier, thumb: `/styles/${id}.webp` });

export const STYLE_PRESETS: StylePreset[] = [
  // Art media
  p('oil-painting', 'Oil painting', 'art', 'oil painting, visible brushstrokes, canvas texture, rich impasto color'),
  p('watercolor', 'Watercolor', 'art', 'watercolor painting, soft washes, bleeding pigment, paper texture'),
  p('pencil-sketch', 'Pencil sketch', 'art', 'pencil sketch, graphite shading, cross-hatching, sketchbook drawing'),
  p('3d-render', '3D render', 'art', 'polished 3D render, global illumination, soft studio lighting, smooth surfaces'),
  p('pixel-art', 'Pixel art', 'art', 'pixel art, 16-bit retro game sprite, limited palette, crisp pixels'),
  // Anime & comic
  p('anime', 'Anime', 'anime', 'anime style, clean line art, cel shading, vibrant colors'),
  p('manga', 'Manga', 'anime', 'black and white manga panel, screentone shading, dynamic ink lines'),
  p('comic-book', 'Comic book', 'anime', 'western comic book art, bold ink outlines, halftone dots, dramatic shading'),
  p('cartoon', 'Cartoon', 'anime', 'playful cartoon style, thick outlines, flat bright colors, exaggerated shapes'),
  p('soft-anime', 'Soft anime', 'anime', 'soft anime film style, painterly backgrounds, gentle pastel light, wistful mood'),
  // Photo looks
  p('realistic-photo', 'Realistic photo', 'photo', 'photorealistic, natural lighting, sharp focus, high detail photography'),
  p('cinematic', 'Cinematic', 'photo', 'cinematic still, anamorphic lens, dramatic lighting, film grain, shallow depth of field'),
  p('portrait-studio', 'Portrait studio', 'photo', 'studio portrait, softbox lighting, seamless backdrop, 85mm lens, crisp detail'),
  p('analog-film', 'Analog film', 'photo', 'analog 35mm film photo, fine grain, faded highlights, vintage color tones'),
  p('bw-noir', 'B&W noir', 'photo', 'black and white noir photograph, hard shadows, high contrast, moody atmosphere'),
  // Stylized
  p('cyberpunk', 'Cyberpunk', 'stylized', 'cyberpunk scene, neon lights, rain-slick streets, holographic glow, night city'),
  p('fantasy-art', 'Fantasy art', 'stylized', 'epic fantasy art, ornate detail, dramatic light, painterly concept art'),
  p('vaporwave', 'Vaporwave', 'stylized', 'vaporwave aesthetic, pink and teal palette, retro 80s grid, chrome accents'),
  p('pop-art', 'Pop art', 'stylized', 'pop art, ben-day dots, bold flat colors, thick outlines, screen print look'),
  p('minimalist-flat', 'Minimalist flat', 'stylized', 'minimalist flat illustration, simple geometric shapes, limited palette, clean vector look'),
];

export function styleById(id: string): StylePreset | null {
  return STYLE_PRESETS.find((s) => s.id === id) ?? null;
}

/** Boost a prompt with a style modifier. Unknown/absent style = prompt unchanged. */
export function applyStyle(prompt: string, styleId: string | null | undefined): string {
  const style = styleId ? styleById(styleId) : null;
  return style ? `${prompt}, ${style.modifier}` : prompt;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all suites — pre-existing specs must stay green).

- [x] **Step 5: Done — tell the user Task 1 is ready to commit.**

---

### Task 2: Sync to edge + `GenerationSettings.style`

**Files:**
- Modify: `scripts/sync-shared.mjs` (FILES array)
- Modify: `src/app/core/catalog/model-families.ts` (GenerationSettings interface, ~line 12)
- Generated: `supabase/functions/_shared/style-presets.ts`, refreshed `supabase/functions/_shared/model-families.ts`

**Interfaces:**
- Consumes: `src/app/core/catalog/style-presets.ts` (Task 1).
- Produces: `supabase/functions/_shared/style-presets.ts` importable by the api function; `GenerationSettings.style?: string` available on both sides. The drift guard (`src/app/core/shared-sync.spec.ts`) automatically covers any FILES entry — no test change needed.

- [x] **Step 1: Add the sync entry**

In `scripts/sync-shared.mjs`, append to the `FILES` array (after the `model-families.ts` entry):

```js
  {
    src: 'src/app/core/catalog/style-presets.ts',
    out: 'style-presets.ts',
    transform: (code) => code,
  },
```

- [x] **Step 2: Add `style` to GenerationSettings**

In `src/app/core/catalog/model-families.ts`, extend the interface (currently lines 12–20):

```ts
export interface GenerationSettings {
  version?: string;
  aspectRatio: string;
  resolution?: string;
  quality?: string;
  durationS?: number;
  /** Outputs per run (1–4). Price multiplies per output. */
  batch?: number;
  /** Style preset id (style-presets.ts). Set server-side; free — no price impact. */
  style?: string;
}
```

- [x] **Step 3: Verify drift guard fails before sync**

Run: `npm test`
Expected: FAIL in `shared-sync.spec.ts` — `style-presets.ts drifted — run: npm run sync-shared` (file missing) and `model-families.ts` mismatch.

- [x] **Step 4: Sync and verify green**

Run: `npm run sync-shared`
Expected output includes: `synced src/app/core/catalog/style-presets.ts -> supabase/functions/_shared/style-presets.ts`

Run: `npm test`
Expected: PASS.

- [x] **Step 5: Done — tell the user Task 2 is ready to commit.**

---

### Task 3: API — validate style, boost prompt, persist id, prefs whitelist

**Files:**
- Modify: `supabase/functions/api/index.ts`

**Interfaces:**
- Consumes: `styleById`, `applyStyle` from `../_shared/style-presets.ts` (Task 2).
- Produces: `POST /generations` accepts optional top-level `style: string`; unknown id → 400 `invalid_style`; stored generation `settings.style = id`; stored `prompt` = user text only; moderation and provider receive the boosted prompt. `PUT /prefs` accepts `defaultStyle` (string ≤ 40 chars).

No Deno test harness exists for endpoint handlers in this repo — the boost/validation logic itself is vitest-covered in Task 1 (`applyStyle`, `styleById`); the endpoint wiring is verified live in Task 8.

- [x] **Step 1: Import the shared catalog**

In `supabase/functions/api/index.ts`, next to the existing `_shared/model-families.ts` import, add:

```ts
import { applyStyle, styleById } from '../_shared/style-presets.ts';
```

- [x] **Step 2: Whitelist the pref**

In the `PREF_CHECKS` array (~line 131), after the `defaultAspect` entry, add:

```ts
  ['defaultStyle', (v) => typeof v === 'string' && v.length <= 40],
```

- [x] **Step 3: Parse and validate `style` in POST /generations**

In the `POST /generations` handler (~line 640), after `const parentId = ...`, add:

```ts
  const styleId = typeof body.style === 'string' && body.style ? body.style : null;
```

After the existing `batch` range check (`if (batch < 1 || batch > 4) ...`), add:

```ts
  if (styleId && !styleById(styleId)) {
    return fail(c, 400, 'invalid_style', 'Unknown style preset');
  }
  // Boosted prompt is what moderation and the provider see; the stored prompt stays the user's text.
  const effectivePrompt = applyStyle(prompt, styleId);
```

- [x] **Step 4: Persist the id and use the boosted prompt**

Three surgical changes in the same handler:

a) After `const settings = sanitizeSettings(body.settings);` the sanitizer strips unknown keys — re-attach the validated style just before items are built. Change the moderation call (~line 722) from:

```ts
  const mod = await moderate({ text: prompt });
```

to:

```ts
  const mod = await moderate({ text: effectivePrompt });
```

(Keep `recordStrike(userId, 'prompt', prompt, ...)` on the next line using the *user's* prompt — evidence should be their own text.)

b) Just before the `items` array is built (~line 749), add:

```ts
  if (styleId) settings.style = styleId;
```

(`items` already spreads `settings`, so `settings.style` lands in every stored row.)

c) In the `adapter.submit({...})` call (~line 789), change `prompt,` to:

```ts
        prompt: effectivePrompt,
```

Leave `prompt` in the `items` objects unchanged — stored prompt stays clean.

- [x] **Step 5: Type-check the function**

Run: `deno check supabase/functions/api/index.ts` (from repo root; if `deno` is unavailable, note it and rely on Task 8's deploy, which type-checks)
Expected: no errors.

- [x] **Step 6: Done — tell the user Task 3 is ready to commit** (deploy happens in Task 8).

---

### Task 4: Client prefs — `defaultStyle`

**Files:**
- Modify: `src/app/core/preferences/preferences-service.ts`
- Modify: `src/app/core/preferences/preferences-service.spec.ts` (extend existing spec)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Prefs.defaultStyle: string` (`''` = none) with default `''`. Left panel (Task 6) reads `prefs.defaultStyle` and calls `prefsService.update({ defaultStyle })`.

- [x] **Step 1: Extend the failing test**

In `src/app/core/preferences/preferences-service.spec.ts`, add a test following the file's existing setup pattern (reuse its TestBed/mocking helpers):

```ts
  it('defaults defaultStyle to none and round-trips updates', async () => {
    // arrange service exactly as the neighbouring tests do
    expect(service.prefs().defaultStyle).toBe('');
    await service.update({ defaultStyle: 'oil-painting' });
    expect(service.prefs().defaultStyle).toBe('oil-painting');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `defaultStyle` missing from `Prefs`.

- [x] **Step 3: Implement**

In `preferences-service.ts`:

```ts
export interface Prefs {
  defaultMode: 'image' | 'video';
  defaultImageFamily: string;
  defaultVideoFamily: string;
  defaultAspect: string;
  /** Style preset id preselected in the left panel ('' = none). */
  defaultStyle: string;
  /** True once the onboarding tour was finished or skipped. */
  tourSeen: boolean;
}
```

and in `DEFAULTS`:

```ts
  defaultStyle: '',
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [x] **Step 5: Done — tell the user Task 4 is ready to commit.**

---

### Task 5: Style picker component

**Files:**
- Create: `src/app/features/workspace/style-picker/style-picker.ts`
- Create: `src/app/features/workspace/style-picker/style-picker.html`
- Create: `src/app/features/workspace/style-picker/style-picker.css`
- Create: `src/app/features/workspace/style-picker/style-picker.spec.ts`

**Interfaces:**
- Consumes: `STYLE_PRESETS`, `STYLE_CATEGORY_TITLES`, `StyleCategory`, `styleById` from `../../../core/catalog/style-presets`; `Hint` from `../../../shared/hint/hint`; Spartan `HlmDropdownMenuImports` (same pattern as the left panel's model menu).
- Produces: `<app-style-picker [selected]="styleId" (changed)="...">` — `selected: input<string | null>`, `changed: output<string | null>` (`null` = None). Task 6 embeds it.

- [x] **Step 1: Write the failing test**

Create `style-picker.spec.ts` (TestBed, mirrors repo component-spec conventions):

```ts
import { TestBed } from '@angular/core/testing';
import { describe, beforeEach, expect, it } from 'vitest';
import { StylePicker } from './style-picker';
import { STYLE_PRESETS } from '../../../core/catalog/style-presets';

describe('StylePicker', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [StylePicker] });
  });

  it('shows "None" on the trigger when nothing selected', () => {
    const fixture = TestBed.createComponent(StylePicker);
    fixture.componentRef.setInput('selected', null);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('None');
  });

  it('shows the selected style name on the trigger', () => {
    const fixture = TestBed.createComponent(StylePicker);
    fixture.componentRef.setInput('selected', 'oil-painting');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Oil painting');
  });

  it('groups all 20 presets into 4 categories', () => {
    const fixture = TestBed.createComponent(StylePicker);
    fixture.componentRef.setInput('selected', null);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    expect(cmp.groups.length).toBe(4);
    expect(cmp.groups.flatMap((g) => g.presets).length).toBe(STYLE_PRESETS.length);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `./style-picker` not found.

- [x] **Step 3: Implement the component**

`style-picker.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucidePalette } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  STYLE_CATEGORY_TITLES,
  STYLE_PRESETS,
  StyleCategory,
  StylePreset,
  styleById,
} from '../../../core/catalog/style-presets';
import { Hint } from '../../../shared/hint/hint';

interface StyleGroup {
  category: StyleCategory;
  title: string;
  presets: StylePreset[];
}

@Component({
  selector: 'app-style-picker',
  templateUrl: './style-picker.html',
  styleUrl: './style-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, Hint, ...HlmDropdownMenuImports],
  providers: [provideIcons({ lucideChevronDown, lucidePalette })],
})
export class StylePicker {
  readonly selected = input<string | null>(null);
  readonly changed = output<string | null>();

  readonly groups: StyleGroup[] = (
    Object.keys(STYLE_CATEGORY_TITLES) as StyleCategory[]
  ).map((category) => ({
    category,
    title: STYLE_CATEGORY_TITLES[category],
    presets: STYLE_PRESETS.filter((s) => s.category === category),
  }));

  readonly current = computed(() => {
    const id = this.selected();
    return id ? styleById(id) : null;
  });

  select(id: string | null): void {
    this.changed.emit(id);
  }
}
```

`style-picker.html`:

```html
<div class="field">
  <span class="field-label">
    Style
    <app-hint
      text="Boosts your prompt toward a visual style. Applied at generation — your prompt text is untouched."
    >
      <span class="og-info">ⓘ</span>
    </app-hint>
  </span>
  <button type="button" class="style-trigger" [hlmDropdownMenuTrigger]="styleMenu" align="start">
    @if (current(); as style) {
      <img [src]="style.thumb" [alt]="style.name" class="style-trigger-thumb"/>
      <span class="style-trigger-name">{{ style.name }}</span>
    } @else {
      <ng-icon name="lucidePalette" size="14" class="style-trigger-none"/>
      <span class="style-trigger-name">None</span>
    }
    <ng-icon name="lucideChevronDown" size="14" class="style-chevron"/>
  </button>
  <ng-template #styleMenu>
    <div hlmDropdownMenu class="style-menu">
      <button
        type="button"
        class="style-tile style-tile-none"
        [class.style-tile-active]="!selected()"
        (click)="select(null)"
      >
        <span class="style-tile-blank"><ng-icon name="lucidePalette" size="18"/></span>
        <span class="style-tile-name">None</span>
      </button>
      @for (group of groups; track group.category) {
        <h4 class="style-group-title">{{ group.title }}</h4>
        <div class="style-grid">
          @for (style of group.presets; track style.id) {
            <button
              type="button"
              class="style-tile"
              [class.style-tile-active]="selected() === style.id"
              (click)="select(style.id)"
            >
              <img [src]="style.thumb" [alt]="style.name" loading="lazy"/>
              <span class="style-tile-name">{{ style.name }}</span>
            </button>
          }
        </div>
      }
    </div>
  </ng-template>
</div>
```

Note: tiles use plain `(click)` + `hlmDropdownMenu` container. If the dropdown does not close on tile click, switch the tile buttons to `hlmDropdownMenuItem` with `(triggered)` — same as `model-item` in `left-panel.html`.

`style-picker.css` (match panel design language — sectioned rail, uppercase micro-titles, muted labels; copy token usage from `left-panel.css` classes `model-trigger`/`model-menu`):

```css
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.style-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--background);
  cursor: pointer;
  font-size: 13px;
  color: var(--foreground);
}

.style-trigger-thumb {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  object-fit: cover;
}

.style-trigger-none {
  color: var(--muted-foreground);
}

.style-trigger-name {
  flex: 1;
  text-align: left;
}

.style-chevron {
  color: var(--muted-foreground);
}

.style-menu {
  width: 320px;
  max-height: 420px;
  overflow-y: auto;
  padding: 10px;
}

.style-group-title {
  margin: 10px 2px 6px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}

.style-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.style-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  cursor: pointer;
}

.style-tile img,
.style-tile-blank {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 6px;
  object-fit: cover;
  background: var(--muted);
}

.style-tile-blank {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
}

.style-tile-none {
  width: calc(25% - 5px);
}

.style-tile-active {
  border-color: var(--primary);
}

.style-tile-name {
  font-size: 10px;
  color: var(--muted-foreground);
  text-align: center;
  line-height: 1.2;
}
```

Adjust CSS custom property names to whatever `left-panel.css` actually uses (open it and reuse the same tokens — do not invent new ones).

- [x] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [x] **Step 5: Done — tell the user Task 5 is ready to commit.**

---

### Task 6: Wire picker into left panel → workspace → API request

**Files:**
- Modify: `src/app/features/workspace/left-panel/left-panel.ts`
- Modify: `src/app/features/workspace/left-panel/left-panel.html`
- Modify: `src/app/features/workspace/workspace-page.ts` (`onGenerate`, ~line 283)
- Modify: `src/app/core/api/dtos.ts` (`CreateGenerationRequest`)
- Modify: `src/app/core/generations/generation-store.ts` (no code change expected — `create` posts the request object as-is; verify only)

**Interfaces:**
- Consumes: `StylePicker` (Task 5), `Prefs.defaultStyle` (Task 4), `styleById` (Task 1).
- Produces: `GenerateRequest.style: string | null`; `CreateGenerationRequest.style?: string`; `POST /generations` body carries `style` (Task 3 consumes it).

- [x] **Step 1: Left panel state + emit**

In `left-panel.ts`:

a) Import: `import { styleById } from '../../../core/catalog/style-presets';` and `import { StylePicker } from '../style-picker/style-picker';` — add `StylePicker` to the component `imports` array.

b) Extend `GenerateRequest`:

```ts
export interface GenerateRequest {
  family: ModelFamily;
  settings: GenerationSettings;
  prompt: string;
  /** Style preset id, null = none. Server appends the modifier. */
  style: string | null;
  /** Library generation used as edit source. */
  referenceId: string | null;
  /** Uploaded image (storage path) used as edit source. */
  referenceUploadId: string | null;
  referenceUrl: string | null;
  /** Outputs requested in this run. */
  batch: number;
  /** Total credit price for the whole batch (display/confirm only — server prices). */
  priceCredits: number;
}
```

c) Signal + pref restore (constructor already reads `prefs`; a persisted id no longer in the catalog resets to None silently):

```ts
  readonly style = signal<string | null>(null);
```

and in the constructor, after `this.settings.set(base);`:

```ts
    this.style.set(styleById(prefs.defaultStyle)?.id ?? null);
```

d) Selection handler (persist as pref, fire-and-forget like other pref writes):

```ts
  setStyle(id: string | null): void {
    this.style.set(id);
    void this.prefsService.update({ defaultStyle: id ?? '' });
  }
```

e) In `generate()`, add `style: this.mode() === 'image' ? this.style() : null,` to the emitted object.

- [x] **Step 2: Template**

In `left-panel.html`, between the Prompt field (`</div>` at line 73) and the Reference image field, add:

```html
    @if (mode() === 'image') {
      <app-style-picker [selected]="style()" (changed)="setStyle($event)"/>
    }
```

- [x] **Step 3: Workspace pass-through**

In `dtos.ts`, extend:

```ts
export interface CreateGenerationRequest {
  familyId?: string;
  op: GenerationOp;
  prompt: string;
  /** Style preset id — server validates and appends the modifier. */
  style?: string;
  settings: GenerationSettings;
  batch: number;
  parentId?: string;
  referenceUploadId?: string;
  maskPngBase64?: string;
}
```

In `workspace-page.ts` `onGenerate`, add to the `this.store.create({...})` object:

```ts
        style: req.style ?? undefined,
```

Verify `generation-store.ts` `create()` posts the request object unmodified (it does: `this.api.post('/generations', request)`) — no change needed.

- [x] **Step 4: Build + tests**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
Expected: build succeeds.

Run: `npm test`
Expected: PASS.

- [x] **Step 5: Done — tell the user Task 6 is ready to commit.**

---

### Task 7: Style chip in detail overlay

**Files:**
- Modify: `src/app/features/workspace/detail-overlay/detail-overlay.ts` (`settingsChips`, ~line 48)

**Interfaces:**
- Consumes: `styleById` (Task 1); `settings.style` persisted by Task 3.
- Produces: style name rendered as a settings chip in the generation detail view (existing chip UI — no template change).

- [x] **Step 1: Implement**

Import `styleById` in `detail-overlay.ts`:

```ts
import { styleById } from '../../../core/catalog/style-presets';
```

Extend `settingsChips`:

```ts
  settingsChips(item: GenerationItem): string[] {
    const s = item.settings;
    return [
      s.version ? `v${s.version}` : null,
      s.aspectRatio,
      s.resolution ?? null,
      s.quality ?? null,
      s.durationS ? `${s.durationS}s` : null,
      s.style ? (styleById(s.style)?.name ?? null) : null,
    ].filter((c): c is string => !!c);
  }
```

- [x] **Step 2: Build check**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
Expected: build succeeds. `npm test` PASS.

- [x] **Step 3: Done — tell the user Task 7 is ready to commit.**

---

### Task 8: Deploy `api` + live verification

**Files:** none (deploy + verify).

**Interfaces:**
- Consumes: Tasks 2–3 (synced `_shared/style-presets.ts`, endpoint changes).

- [x] **Step 1: Confirm sync is current**

Run: `npm run sync-shared && git status --short supabase/functions/_shared/`
Expected: no unexpected diff beyond files already staged for this feature.

- [x] **Step 2: Deploy**

Run: `supabase functions deploy api --project-ref bnorhcxhvxydkgvcxjad --no-verify-jwt`
(MCP deploy tool is broken for this function — CLI only. Deploy bundles all of `_shared/` including `style-presets.ts`.)
Expected: deploy succeeds, new version reported.

- [ ] **Step 3: Live smoke test**

Preferred: run the app (`npx ng serve` via the browser preview tooling), log in, pick a style (e.g. Oil painting), generate 1× on a cheap config (Nano Banana Fast 1K), then verify:
- generation succeeds; result clearly styled;
- detail overlay shows the user's clean prompt + an "Oil painting" chip;
- an unknown-style request is impossible from the UI (server guard exists for stale clients).

Also confirm via Supabase logs (api function) that no `invalid_style` or type errors appear.

- [x] **Step 4: Done — tell the user Task 8 is ready to commit.**

---

### Task 9: Thumbnail assets (20 × webp)

**Files:**
- Create: `scripts/gen-style-thumbs.mjs` (one-off generator, committed for reproducibility)
- Create: `public/styles/<id>.webp` × 20

**Interfaces:**
- Consumes: `STYLE_PRESETS` modifiers (Task 1); `GOOGLE_AI_API_KEY` exported in the local shell by the user (never written to the repo).
- Produces: the thumb paths the picker already references (`/styles/<id>.webp`). Until this task runs, tiles show broken images in dev — acceptable, this is the last task.

- [x] **Step 1: Ask the user for the key**

STOP. Ask the user to export `GOOGLE_AI_API_KEY` in the shell (paid-tier key — free tier has zero image quota). Do not proceed without it; never echo or store the key.

- [x] **Step 2: Write the generator script**

Create `scripts/gen-style-thumbs.mjs`:

```js
// One-off: renders the same base subject in each style preset via Gemini image
// generation (Nano Banana) and writes 512px PNGs to a temp dir.
// Usage: GOOGLE_AI_API_KEY=... node scripts/gen-style-thumbs.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node scripts/gen-style-thumbs.mjs <outDir>');
const key = process.env.GOOGLE_AI_API_KEY;
if (!key) throw new Error('GOOGLE_AI_API_KEY not set');
mkdirSync(outDir, { recursive: true });

// Keep in sync with src/app/core/catalog/style-presets.ts (ids + modifiers).
const { STYLE_PRESETS } = await import('../src/app/core/catalog/style-presets.ts');

const BASE_PROMPT =
  'a young woman with a red scarf holding a lantern in a misty forest clearing at dusk';
const MODEL = 'gemini-2.5-flash-image';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;

for (const style of STYLE_PRESETS) {
  const prompt = `${BASE_PROMPT}, ${style.modifier}`;
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  });
  if (!res.ok) throw new Error(`${style.id}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error(`${style.id}: no image in response`);
  writeFileSync(join(outDir, `${style.id}.png`), Buffer.from(part.inlineData.data, 'base64'));
  console.log(`generated ${style.id}.png`);
}
```

Note: the script imports a `.ts` file — run with Node 22.23.1 (`nvm use 22.23.1`), which strips types natively; if that errors, inline the id/modifier list into the script instead. If the model name 404s, list models via `GET /v1beta/models?key=...` and use the current Nano Banana image model id (check `supabase/functions/_shared/providers/` for the id the app itself uses).

- [x] **Step 3: Generate PNGs**

Run (scratchpad dir, not the repo):
`export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && node scripts/gen-style-thumbs.mjs <scratchpad>/style-thumbs`
Expected: 20 PNGs, `generated <id>.png` × 20. Eyeball each (Read the images) — regenerate any that look off-style.

- [x] **Step 4: Downscale to 128px webp**

Run:
`mkdir -p public/styles && for f in <scratchpad>/style-thumbs/*.png; do npx --yes sharp-cli --input "$f" --output "public/styles/$(basename "${f%.png}").webp" resize 128 128; done`
(If sharp-cli's flags differ, `npx sharp-cli --help` and adapt; any equivalent 128×128 webp conversion is fine.)
Expected: 20 webp files in `public/styles/`, ~10 KB each (`ls -la public/styles/`).

- [ ] **Step 5: Visual check**

Serve the app, open the style picker: every tile shows its thumbnail, trigger shows the selected thumb. Screenshot for the user.

- [x] **Step 6: Done — tell the user Task 9 is ready to commit. Feature complete.**
