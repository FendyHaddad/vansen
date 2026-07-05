# Vansen Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Vansen workspace around model families with native per-provider settings, a dedicated mask-capable editor route, a full settings suite, and a ledger-backed stub data layer.

**Architecture:** New `model-families` catalog (capability schema + cost functions) drives a fixed settings rail where unsupported option groups grey out. A `LedgerService` signal store becomes the single money source-of-truth. Three authGuarded routes: `/app` (generate + library + detail overlay), `/app/edit/:id` (canvas editor), `/app/settings` (4 tabs). Landing/plans pages sync to the 6-provider launch set.

**Tech Stack:** Angular 22 (standalone, signals, zoneless, OnPush), spartan/ui (helm), Tailwind v4, vitest (`ng test`), localStorage stubs.

## Global Constraints

- **NEVER run `git commit`, `git branch`, or `git push` — user commits personally, single branch.** Plan steps therefore end at "build/test green", never at commit.
- Every Angular component: separate `.ts` + `.html` + `.css` files. No inline templates/styles. Prefer stylesheet classes over `style` attributes.
- User price everywhere: `providerCost / (1 − 0.33)` (`PAYG_MARGIN = 0.33` from `src/app/features/pricing/model-catalog.ts`).
- Build command: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
- Test command: same prefix + `npx ng test --watch=false`
- Old flat `MODEL_CATALOG` stays exported (admin pages depend on it). Mark deprecated, do not delete.
- Dark theme via CSS vars (`--border`, `--card`, `--muted-foreground`, `--primary`, `--warn`, `--loss`, `--radius`); follow existing class patterns in `workspace-page.css`.
- Preview verification per UI task: server `vansen` on port 4200, viewport 1280×800, screenshots break when scrolled — verify scrolled content via DOM eval.

---

### Task 1: Model families catalog

**Files:**
- Create: `src/app/core/catalog/model-families.ts`
- Test: `src/app/core/catalog/model-families.spec.ts`
- Modify: `src/app/features/pricing/model-catalog.ts` (add `@deprecated` JSDoc on `MODEL_CATALOG` only)

**Interfaces:**
- Consumes: `PAYG_MARGIN` from `../../features/pricing/model-catalog`
- Produces (all later UI tasks depend on these exact names):

```typescript
export type ModelKind = 'image' | 'video';
export type AxisId = 'version' | 'aspectRatio' | 'resolution' | 'quality' | 'duration';

export interface FamilyOption {
  value: string;
  label: string;
  tooltip: string;
}

export interface GenerationSettings {
  version?: string;
  aspectRatio: string;
  resolution?: string;
  quality?: string;
  durationS?: number;
}

export interface ModelFamily {
  id: string;
  name: string;
  provider: string;
  logo: string;               // '/logos/google.svg'
  kind: ModelKind;
  blurb: string;
  capabilities: {
    versions?: FamilyOption[];
    aspectRatios: string[];
    resolutions?: FamilyOption[];
    qualities?: FamilyOption[];
    durations?: number[];
    audio?: boolean;
    imageInput: boolean;
    maskInput: boolean;
  };
  providerCost(settings: GenerationSettings): number;
}

export const MODEL_FAMILIES: ModelFamily[];
export const UPSCALER = { id: 'magnific', name: 'Magnific Precision v2', providerCost: 0.25, providerCostAbove4k: 1.5 };
export function familyById(id: string): ModelFamily | undefined;
export function defaultSettings(family: ModelFamily): GenerationSettings;
export function userPriceUsd(family: ModelFamily, s: GenerationSettings): number; // cost/(1-PAYG_MARGIN)
export function upscaleUserPriceUsd(above4k?: boolean): number;
```

- [ ] **Step 1: Write failing tests**

```typescript
// src/app/core/catalog/model-families.spec.ts
import { describe, expect, it } from 'vitest';
import {
  MODEL_FAMILIES, defaultSettings, familyById, upscaleUserPriceUsd, userPriceUsd,
} from './model-families';

describe('model families', () => {
  it('has 5 image and 5 video families', () => {
    expect(MODEL_FAMILIES.filter((f) => f.kind === 'image').length).toBe(5);
    expect(MODEL_FAMILIES.filter((f) => f.kind === 'video').length).toBe(5);
  });

  it('nano banana v1 flat cost, v2 priced by resolution', () => {
    const nb = familyById('nano-banana')!;
    expect(nb.providerCost({ version: '1', aspectRatio: '1:1' })).toBeCloseTo(0.039);
    expect(nb.providerCost({ version: '2', aspectRatio: '1:1', resolution: '1K' })).toBeCloseTo(0.067);
    expect(nb.providerCost({ version: '2', aspectRatio: '1:1', resolution: '4K' })).toBeCloseTo(0.151);
  });

  it('gpt image priced by version x quality, v2 4K doubles', () => {
    const gpt = familyById('gpt-image')!;
    expect(gpt.providerCost({ version: '2', aspectRatio: '1:1', quality: 'high', resolution: '1K' })).toBeCloseTo(0.211);
    expect(gpt.providerCost({ version: '1', aspectRatio: '1:1', quality: 'low', resolution: '1K' })).toBeCloseTo(0.011);
    expect(gpt.providerCost({ version: '2', aspectRatio: '1:1', quality: 'low', resolution: '4K' })).toBeCloseTo(0.0123);
  });

  it('video cost scales with duration', () => {
    const veo = familyById('veo')!;
    const base = veo.providerCost({ version: 'standard', aspectRatio: '16:9', resolution: '1080p', durationS: 4 });
    const longer = veo.providerCost({ version: 'standard', aspectRatio: '16:9', resolution: '1080p', durationS: 8 });
    expect(longer).toBeCloseTo(base * 2);
  });

  it('defaultSettings picks first option of each supported axis', () => {
    const gpt = familyById('gpt-image')!;
    const s = defaultSettings(gpt);
    expect(s.version).toBe('2');
    expect(s.quality).toBe('medium');
    expect(s.aspectRatio).toBe(gpt.capabilities.aspectRatios[0]);
  });

  it('user price applies 33% margin', () => {
    const nb = familyById('nano-banana')!;
    expect(userPriceUsd(nb, { version: '1', aspectRatio: '1:1' })).toBeCloseTo(0.039 / 0.67);
    expect(upscaleUserPriceUsd()).toBeCloseTo(0.25 / 0.67);
  });

  it('every family has logo, blurb, and tooltips on every option', () => {
    for (const f of MODEL_FAMILIES) {
      expect(f.logo).toMatch(/^\/logos\//);
      expect(f.blurb.length).toBeGreaterThan(10);
      for (const opts of [f.capabilities.versions, f.capabilities.resolutions, f.capabilities.qualities]) {
        for (const o of opts ?? []) expect(o.tooltip.length).toBeGreaterThan(10);
      }
    }
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL** (`npx ng test --watch=false` → cannot resolve `./model-families`)

- [ ] **Step 3: Implement `model-families.ts`**

Full data. Cost tables (provider USD, from spec §3 — "(verify)" values marked in comments):

```typescript
import { PAYG_MARGIN } from '../../features/pricing/model-catalog';
// ... interfaces exactly as in Produces block above ...

const AR_IMAGE = ['1:1', '3:4', '4:3', '16:9', '9:16'];
const AR_VIDEO = ['16:9', '9:16', '1:1'];

const RES_TOOLTIPS = {
  '1K': 'Output size ~1024px. Resolution is pixel count — not detail effort.',
  '2K': 'Output size ~2048px. Sharper for print/zoom; same content quality.',
  '4K': 'Output size ~3840px. Largest files, highest cost.',
};
const GPT_QUALITY_TOOLTIPS = {
  low: 'Minimal compute — fast drafts and thumbnails. Same resolution, less detail.',
  medium: 'Balanced compute. Good default for finals.',
  high: 'Maximum compute per image — best textures and text rendering. Not a resolution setting.',
};

// GPT provider cost (square, ~1K) by version & quality; v2 4K multiplies ×2.05 (Runway credit ratio — verify exact token math)
const GPT_COST: Record<string, Record<string, number>> = {
  '2':   { low: 0.006, medium: 0.053, high: 0.211 },
  '1.5': { low: 0.009, medium: 0.034, high: 0.133 },
  '1':   { low: 0.011, medium: 0.042, high: 0.167 },
};

export const MODEL_FAMILIES: ModelFamily[] = [
  {
    id: 'nano-banana', name: 'Nano Banana', provider: 'Google', logo: '/logos/google.svg',
    kind: 'image', blurb: 'Fast, cheap, great all-rounder. The default choice.',
    capabilities: {
      versions: [
        { value: '2', label: '2', tooltip: 'Gemini 3.1 Flash Image — current generation, up to 4K.' },
        { value: '1', label: '1', tooltip: 'Gemini 2.5 Flash Image — cheapest, ~1K only.' },
      ],
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1K', label: '1K', tooltip: RES_TOOLTIPS['1K'] },
        { value: '2K', label: '2K', tooltip: RES_TOOLTIPS['2K'] },
        { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] },
      ],
      imageInput: true, maskInput: false,
    },
    providerCost: (s) => s.version === '1' ? 0.039
      : ({ '1K': 0.067, '2K': 0.101, '4K': 0.151 }[s.resolution ?? '1K'] ?? 0.067),
  },
  {
    id: 'nano-banana-pro', name: 'Nano Banana Pro', provider: 'Google', logo: '/logos/google.svg',
    kind: 'image', blurb: 'Gemini 3 Pro Image — top fidelity, complex scenes, text.',
    capabilities: {
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '2K', label: '1K–2K', tooltip: 'Same price for 1K and 2K on Pro.' },
        { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] },
      ],
      imageInput: true, maskInput: false,
    },
    providerCost: (s) => (s.resolution === '4K' ? 0.24 : 0.134),
  },
  {
    id: 'gpt-image', name: 'GPT Image', provider: 'OpenAI', logo: '/logos/openai.svg',
    kind: 'image', blurb: 'Quality dial for compute effort; v2 adds true 4K and masked edits.',
    capabilities: {
      versions: [
        { value: '2', label: '2', tooltip: 'Latest. Any resolution up to 3840px, masked editing.' },
        { value: '1.5', label: '1.5', tooltip: 'Previous gen, ~1K output.' },
        { value: '1', label: '1', tooltip: 'Original GPT Image, ~1K output.' },
      ],
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1K', label: '1K', tooltip: RES_TOOLTIPS['1K'] },
        { value: '2K', label: '2K', tooltip: RES_TOOLTIPS['2K'] + ' (GPT Image 2 only)' },
        { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] + ' (GPT Image 2 only)' },
      ],
      qualities: [
        { value: 'low', label: 'Low', tooltip: GPT_QUALITY_TOOLTIPS.low },
        { value: 'medium', label: 'Medium', tooltip: GPT_QUALITY_TOOLTIPS.medium },
        { value: 'high', label: 'High', tooltip: GPT_QUALITY_TOOLTIPS.high },
      ],
      imageInput: true, maskInput: true,
    },
    providerCost: (s) => {
      const base = GPT_COST[s.version ?? '2']?.[s.quality ?? 'medium'] ?? 0.053;
      const mult = s.version === '2' && s.resolution === '4K' ? 2.05 : 1;
      return base * mult;
    },
  },
  {
    id: 'flux', name: 'FLUX', provider: 'Black Forest Labs', logo: '/logos/bfl.svg',
    kind: 'image', blurb: 'FLUX.2 [pro] — photoreal detail, priced per megapixel.',
    capabilities: {
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1MP', label: '1MP', tooltip: '~1024×1024 pixels. FLUX bills per megapixel.' },
        { value: '2MP', label: '2MP', tooltip: '~1448×1448 pixels equivalent.' },
        { value: '4MP', label: '4MP', tooltip: '~2048×2048 pixels equivalent.' },
      ],
      imageInput: true, maskInput: false,
    },
    providerCost: (s) => ({ '1MP': 0.03, '2MP': 0.06, '4MP': 0.12 }[s.resolution ?? '1MP'] ?? 0.03),
  },
  {
    id: 'seedream', name: 'Seedream', provider: 'ByteDance', logo: '/logos/bytedance.svg',
    kind: 'image', blurb: 'Seedream 4.0 — strong aesthetics at a low flat price.',
    capabilities: {
      aspectRatios: AR_IMAGE,
      resolutions: [
        { value: '1K', label: '1K', tooltip: RES_TOOLTIPS['1K'] },
        { value: '2K', label: '2K', tooltip: RES_TOOLTIPS['2K'] },
        { value: '4K', label: '4K', tooltip: RES_TOOLTIPS['4K'] + ' (verify fal 4K rate)' },
      ],
      imageInput: true, maskInput: false,
    },
    providerCost: (s) => (s.resolution === '4K' ? 0.06 /* verify */ : 0.03),
  },
  // ---- video ----
  {
    id: 'veo', name: 'Veo', provider: 'Google', logo: '/logos/google.svg',
    kind: 'video', blurb: 'Veo 3.1 — cinematic clips with native audio.',
    capabilities: {
      versions: [
        { value: 'standard', label: 'Standard', tooltip: 'Full quality, audio, up to 4K.' },
        { value: 'fast', label: 'Fast', tooltip: 'Quicker + cheaper, 720p/1080p.' },
      ],
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: 'HD output.' },
        { value: '1080p', label: '1080p', tooltip: 'Full-HD output.' },
        { value: '4K', label: '4K', tooltip: 'Standard tier only.' },
      ],
      durations: [4, 6, 8], audio: true,
      imageInput: false, maskInput: false,
    },
    providerCost: (s) => {
      const perS = s.version === 'fast' ? 0.1 : s.resolution === '4K' ? 0.6 : 0.4;
      return perS * (s.durationS ?? 4);
    },
  },
  {
    id: 'sora', name: 'Sora', provider: 'OpenAI', logo: '/logos/openai.svg',
    kind: 'video', blurb: 'Sora 2 — strong physics and coherent motion.',
    capabilities: {
      versions: [
        { value: 'standard', label: 'Standard', tooltip: '720p, best value.' },
        { value: 'pro', label: 'Pro', tooltip: 'Higher fidelity, unlocks 1080p.' },
      ],
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: 'HD output.' },
        { value: '1080p', label: '1080p', tooltip: 'Pro tier only.' },
      ],
      durations: [4, 8, 12],
      imageInput: false, maskInput: false,
    },
    providerCost: (s) => {
      const perS = s.version === 'pro' ? (s.resolution === '1080p' ? 0.7 : 0.3) : 0.1; // verify per-second rates
      return perS * (s.durationS ?? 4);
    },
  },
  {
    id: 'kling', name: 'Kling', provider: 'Kuaishou', logo: '/logos/kuaishou.svg',
    kind: 'video', blurb: 'Kling 2.5 Turbo Pro — best value for smooth motion.',
    capabilities: {
      aspectRatios: AR_VIDEO, durations: [5, 10],
      imageInput: false, maskInput: false,
    },
    providerCost: (s) => 0.07 * (s.durationS ?? 5),
  },
  {
    id: 'runway', name: 'Runway', provider: 'Runway', logo: '/logos/runway.svg',
    kind: 'video', blurb: 'Gen-4.5 — director-grade control and consistency.',
    capabilities: {
      versions: [
        { value: 'gen45', label: 'Gen-4.5', tooltip: 'Flagship quality.' },
        { value: 'gen4-turbo', label: 'Gen-4 Turbo', tooltip: 'Fastest and cheapest Runway.' },
      ],
      aspectRatios: AR_VIDEO, durations: [5, 10],
      imageInput: false, maskInput: false,
    },
    providerCost: (s) => (s.version === 'gen4-turbo' ? 0.05 : 0.12) * (s.durationS ?? 5),
  },
  {
    id: 'seedance', name: 'Seedance', provider: 'ByteDance', logo: '/logos/bytedance.svg',
    kind: 'video', blurb: 'Seedance 1.0 Pro — crisp 1080p clips at fal prices.',
    capabilities: {
      aspectRatios: AR_VIDEO,
      resolutions: [
        { value: '720p', label: '720p', tooltip: 'HD output. (verify fal 720p rate)' },
        { value: '1080p', label: '1080p', tooltip: 'Full-HD output.' },
      ],
      durations: [5, 10],
      imageInput: false, maskInput: false,
    },
    providerCost: (s) => (s.resolution === '720p' ? 0.062 : 0.124) * (s.durationS ?? 5),
  },
];

export const UPSCALER = { id: 'magnific', name: 'Magnific Precision v2', providerCost: 0.25, providerCostAbove4k: 1.5 } as const;

export function familyById(id: string): ModelFamily | undefined {
  return MODEL_FAMILIES.find((f) => f.id === id);
}

export function defaultSettings(family: ModelFamily): GenerationSettings {
  const c = family.capabilities;
  return {
    version: c.versions?.[0]?.value,
    aspectRatio: c.aspectRatios[0],
    resolution: c.resolutions?.[0]?.value,
    quality: c.qualities ? 'medium' : undefined,
    durationS: c.durations?.[0],
  };
}

export function userPriceUsd(family: ModelFamily, s: GenerationSettings): number {
  return family.providerCost(s) / (1 - PAYG_MARGIN);
}

export function upscaleUserPriceUsd(above4k = false): number {
  return (above4k ? UPSCALER.providerCostAbove4k : UPSCALER.providerCost) / (1 - PAYG_MARGIN);
}
```

Note: `defaultSettings` for gpt-image must yield `quality: 'medium'` (test asserts) — qualities list order is low/medium/high, so hardcode `'medium'` default as above, not `[0]`.

- [ ] **Step 4: Run tests → PASS.** Add `/** @deprecated superseded by core/catalog/model-families — kept for admin pages */` above `MODEL_CATALOG`. Build green.

---

### Task 2: LedgerService + PreferencesService + GenerationStore

**Files:**
- Create: `src/app/core/ledger/ledger-service.ts`, `src/app/core/preferences/preferences-service.ts`, `src/app/core/generations/generation-store.ts`
- Test: `src/app/core/ledger/ledger-service.spec.ts`
- Modify: `src/app/core/auth/auth-service.ts` (drop balance; keep identity+studio), `src/app/features/workspace/workspace-page.ts` (debit via ledger — minimal edit, UI unchanged until Task 4)

**Interfaces:**
- Produces:

```typescript
// ledger-service.ts
export type LedgerType = 'topup' | 'generate' | 'edit' | 'upscale' | 'studio_fee';
export interface LedgerEntry { id: string; at: string; type: LedgerType; familyId?: string; amountUsd: number; note?: string; }
@Injectable({ providedIn: 'root' }) export class LedgerService {
  readonly entries: Signal<LedgerEntry[]>;
  readonly balanceUsd: Signal<number>;          // computed sum, rounded 2dp
  add(e: Omit<LedgerEntry, 'id' | 'at'>): void; // persists localStorage 'vansen.ledger'
  charge(type: LedgerType, amountUsd: number, familyId?: string, note?: string): boolean; // false if balance < amount; adds negative entry
  seedIfEmpty(): void;                           // first top-up $20: +20 topup, −5 studio_fee
  reset(): void;
}

// preferences-service.ts
export interface Prefs { defaultMode: 'image' | 'video'; defaultImageFamily: string; defaultVideoFamily: string; defaultAspect: string; confirmOverUsd: number; }
@Injectable({ providedIn: 'root' }) export class PreferencesService {
  readonly prefs: Signal<Prefs>;
  update(patch: Partial<Prefs>): void;           // persists 'vansen.prefs'
}
// defaults: { defaultMode: 'image', defaultImageFamily: 'nano-banana', defaultVideoFamily: 'veo', defaultAspect: '1:1', confirmOverUsd: 2 }

// generation-store.ts
export interface GenerationItem {
  id: string; at: string; kind: ModelKind; familyId: string; familyName: string;
  op: 'generate' | 'edit' | 'upscale' | 'variation';
  prompt: string; settings: GenerationSettings; priceUsd: number;
  status: 'pending' | 'done'; mediaUrl: string; parentId?: string;
}
@Injectable({ providedIn: 'root' }) export class GenerationStore {
  readonly items: Signal<GenerationItem[]>;      // newest first, persisted 'vansen.generations'
  byId(id: string): GenerationItem | undefined;
  add(item: Omit<GenerationItem, 'id' | 'at' | 'status'>): string; // returns id, status 'pending', auto-'done' after 1400ms
  remove(id: string): void;
  placeholderFor(seed: number): string;          // Unsplash pool (6 verified URLs from workspace-page.ts)
}
```

- [ ] **Step 1: Failing tests** — ledger: `balanceUsd` sums entries; `charge` refuses overdraft and returns false; `seedIfEmpty` yields balance 15 and is idempotent; persists/restores from localStorage (jsdom provides it — call `localStorage.clear()` in `beforeEach`).

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { LedgerService } from './ledger-service';

describe('LedgerService', () => {
  beforeEach(() => localStorage.clear());
  it('seeds first topup once', () => {
    const l = new LedgerService();
    l.seedIfEmpty(); l.seedIfEmpty();
    expect(l.balanceUsd()).toBeCloseTo(15);
    expect(l.entries().length).toBe(2);
  });
  it('charge debits and refuses overdraft', () => {
    const l = new LedgerService();
    l.seedIfEmpty();
    expect(l.charge('generate', 0.1, 'nano-banana')).toBe(true);
    expect(l.balanceUsd()).toBeCloseTo(14.9);
    expect(l.charge('generate', 999)).toBe(false);
    expect(l.balanceUsd()).toBeCloseTo(14.9);
  });
  it('restores from localStorage', () => {
    const a = new LedgerService(); a.seedIfEmpty(); a.charge('generate', 1);
    const b = new LedgerService();
    expect(b.balanceUsd()).toBeCloseTo(14);
  });
});
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement all three services.** Signal stores; `crypto.randomUUID()` ids; JSON round-trip guarded by try/catch → `[]` on corrupt. GenerationStore `add` uses `setTimeout(1400)` to flip status (same stub pattern as current workspace).
- [ ] **Step 4: Slim `AuthService`** — `SessionUser { email: string; studioActive: boolean }`; remove `balanceUsd`, `debit`, `topUp`; on `signIn` call `ledger.seedIfEmpty()` (inject). Update `workspace-page.ts` minimally: `balanceUsd` from LedgerService, `generate()` uses `ledger.charge('generate', price, familyId)`, generations via GenerationStore. UI unchanged.
- [ ] **Step 5: Tests + build green.** Preview: login still works, balance shows 15.00, generation debits.

---

### Task 3: Spartan installs + hint tooltip + profile menu

**Files:**
- Create: `src/app/shared/hint/hint.{ts,html,css}`, `src/app/shared/profile-menu/profile-menu.{ts,html,css}`
- Generated by CLI: `libs/ui/tooltip`, `libs/ui/dialog`, `libs/ui/tabs`, `libs/ui/menu` (spartan names — check `ng g @spartan-ng/cli:ui --help` list; dropdown menu ships as `menu`)

**Interfaces:**
- Produces: `<app-hint [text]="...">projected trigger</app-hint>` — wraps spartan brain tooltip; `<app-profile-menu />` — avatar button + dropdown (balance row + Top up button emitting `(topUp)`, Settings routerLink `/app/settings`, Sign out emitting `(signOut)`).

- [ ] **Step 1:** `ng g @spartan-ng/cli:ui tooltip` (+ `dialog`, `tabs`, `menu`) — non-interactive now that `components.json` exists. Verify `libs/ui/*` created and tsconfig paths updated.
- [ ] **Step 2:** Implement `app-hint`:

```typescript
// hint.ts — imports HlmTooltipImports (check libs/ui/tooltip export names), BrnTooltipImports
@Component({ selector: 'app-hint', templateUrl: './hint.html', styleUrl: './hint.css', changeDetection: ChangeDetectionStrategy.OnPush, imports: [...] })
export class Hint { readonly text = input.required<string>(); }
```

```html
<!-- hint.html -->
<hlm-tooltip>
  <span hlmTooltipTrigger class="hint-trigger"><ng-content /></span>
  <span *brnTooltipContent class="hint-content">{{ text() }}</span>
</hlm-tooltip>
```

(Exact spartan tooltip API: read generated `libs/ui/tooltip/src/index.ts` first and adapt — directive names differ across versions. `.hint-trigger { cursor: help; }`.)

- [ ] **Step 3:** Implement `app-profile-menu` with spartan menu (`HlmMenuImports`, `BrnMenuTrigger`): avatar circle = first letter of `auth.user()?.email`, dropdown items per Interfaces. CSS: `.avatar-btn { width:32px; height:32px; border-radius:999px; background:var(--muted); font-weight:650; }`.
- [ ] **Step 4:** Build green. Preview: tooltip hover works on a temporary usage; remove temp usage.

---

### Task 4: Generate page rebuild — settings rail

**Files:**
- Create: `src/app/features/workspace/option-group/option-group.{ts,html,css}`, `src/app/features/workspace/settings-rail/settings-rail.{ts,html,css}`
- Modify: `src/app/features/workspace/workspace-page.{ts,html,css}` (header gains `<app-profile-menu />`; left rail replaced by `<app-settings-rail />`)

**Interfaces:**
- Consumes: Task 1 catalog, Task 2 services, Task 3 hint.
- Produces:

```typescript
// option-group.ts — ONE axis with fixed position, grey-out, tooltips
@Component({ selector: 'app-option-group', ... })
export class OptionGroup {
  readonly label = input.required<string>();            // 'Quality'
  readonly axisTooltip = input<string>('');             // group-header ⓘ
  readonly options = input<FamilyOption[] | null>(null); // null/empty = unsupported → greyed
  readonly selected = input<string | undefined>(undefined);
  readonly disabledReason = input<string>('');          // 'Not supported by Kling'
  readonly changed = output<string>();
}

// settings-rail.ts
@Component({ selector: 'app-settings-rail', ... })
export class SettingsRail {
  // owns: mode, familyId, settings (GenerationSettings), prompt, referenceId (library item id | null)
  readonly generateRequested = output<{ family: ModelFamily; settings: GenerationSettings; prompt: string; referenceId: string | null; priceUsd: number }>();
  readonly pickReferenceRequested = output<void>();     // parent opens library picker
  setReference(id: string | null): void;                // parent calls back
}
```

- [ ] **Step 1: `option-group` template** — group renders ALWAYS:

```html
<div class="og" [class.og-disabled]="!options()?.length">
  <span class="og-label">
    {{ label() }}
    @if (axisTooltip()) { <app-hint [text]="axisTooltip()">ⓘ</app-hint> }
  </span>
  @if (options()?.length) {
    <div class="og-chips">
      @for (o of options()!; track o.value) {
        <app-hint [text]="o.tooltip">
          <button type="button" class="og-chip" [class.og-active]="selected() === o.value" (click)="changed.emit(o.value)">{{ o.label }}</button>
        </app-hint>
      }
    </div>
  } @else {
    <app-hint [text]="disabledReason()"><span class="og-na">Not available</span></app-hint>
  }
</div>
```

CSS: `.og-disabled { opacity: 0.4; pointer-events: auto; }` (keep hover for tooltip), chips reuse `.aspect-btn` pattern from `workspace-page.css` (copy rules, rename `.og-chip`/`.og-active`).

- [ ] **Step 2: `settings-rail`** — structure: mode toggle → model cards (logo img, name, blurb, `from ${{minPrice}}` = min over option combos ≈ providerCost(defaultCheapest); compute as `userPriceUsd(f, cheapestSettings(f))` helper: version=last, resolution=first, quality='low', duration=min) → option groups in FIXED order:

```html
<app-option-group label="Version"  [options]="family().capabilities.versions ?? null" ... />
<app-option-group label="Aspect ratio" [options]="aspectOptions()" ... />   <!-- map strings to FamilyOption -->
<app-option-group label="Resolution" [options]="resolutionOptions()" ... />
<app-option-group label="Quality"  axisTooltip="Compute effort the model spends — detail and text fidelity, not pixels." ... />
<app-option-group label="Duration" [options]="durationOptions()" ... />
```

Special rules coded in computed signals: GPT resolutions 2K/4K only when `version === '2'` (filter list, and settings-effect resets `resolution` to '1K' when switching to 1/1.5); `veo` 4K removed when `version === 'fast'`; selecting a new family runs `defaultSettings(family)`. Reference slot: dropzone div — file input (`FileReader.readAsDataURL` → store as mediaUrl for stub) + "Pick from library" button emitting `pickReferenceRequested`; greyed via `.og-disabled` when `!family().capabilities.imageInput`; when set, thumbnail + ✕. Audio row for Veo: static badge "Audio included" when `capabilities.audio`.
Price: `readonly priceUsd = computed(() => userPriceUsd(this.family(), this.settings()))`. Generate button label `Generate · ${{ priceUsd() | number:'1.2-2' }}`; disabled when prompt empty or `priceUsd() > ledger.balanceUsd()`; over-threshold confirm handled by parent (Task 8 wires prefs).

- [ ] **Step 3: workspace-page integration** — header: replace sign-out button with `<app-profile-menu (signOut)="signOut()" (topUp)="topUp()" />`; keep balance chip + studio badge. Rail swapped for `<app-settings-rail (generateRequested)="onGenerate($event)" ... />`; `onGenerate` = `ledger.charge(...)` + `store.add({... op: referenceId ? 'edit' : 'generate', parentId: referenceId ?? undefined})`.
- [ ] **Step 4: Build green + preview:** switch families → groups grey correctly (Kling: Version/Resolution/Quality greyed, Duration live); GPT v1 hides 4K; tooltips show on hover (DOM eval `.og-chip` + dispatch mouseenter); generate debits.

---

### Task 5: Library grid + filters + quick actions

**Files:**
- Create: `src/app/features/workspace/library-grid/library-grid.{ts,html,css}`
- Modify: `src/app/features/workspace/workspace-page.{ts,html}` (right side = `<app-library-grid />`)

**Interfaces:**
- Produces:

```typescript
@Component({ selector: 'app-library-grid', ... })
export class LibraryGrid {
  readonly items = input.required<GenerationItem[]>();
  readonly pickMode = input(false);                 // true → click emits picked, no overlay
  readonly filter = signal<'all' | 'image' | 'video' | 'edit' | 'upscale'>('all');
  readonly opened = output<string>();               // item id → parent opens detail overlay
  readonly picked = output<string>();
  readonly download = output<string>();
  readonly upscale = output<string>();
  readonly variation = output<string>();
  readonly edit = output<string>();                 // parent routes /app/edit/:id
}
```

- [ ] **Step 1:** Template: filter chip row (`All / Images / Videos / Edited / Upscaled` — filter fn: image→`kind==='image' && op==='generate'`, edit→`op==='edit'`, upscale→`op==='upscale'`); card grid = current `.gen-card` pattern + hover overlay:

```html
<div class="qa-overlay">
  <button class="qa" (click)="download.emit(item.id); $event.stopPropagation()">↓</button>
  <button class="qa" (click)="upscale.emit(item.id); $event.stopPropagation()">Upscale {{ upscalePrice }}</button>
  <button class="qa" (click)="variation.emit(item.id); $event.stopPropagation()">Variation</button>
  <button class="qa" (click)="edit.emit(item.id); $event.stopPropagation()">Edit</button>
</div>
```

`.qa-overlay { position:absolute; inset:0; display:flex; gap:6px; align-items:flex-end; justify-content:center; padding:10px; opacity:0; background:linear-gradient(transparent 55%, rgb(0 0 0 / .7)); transition:opacity .15s; } .gen-thumb:hover .qa-overlay { opacity:1; }`. Video items hide Upscale/Edit (image-only ops). Edited items get corner badge `edited`; upscaled `upscaled`.

- [ ] **Step 2:** Parent handlers: `upscale` → `ledger.charge('upscale', upscaleUserPriceUsd(), 'magnific')` + `store.add({op:'upscale', parentId, prompt: parent.prompt, mediaUrl: parent.mediaUrl, ...})`; `variation` → recharge same price, new item `op:'variation'` (shows under Images filter; new placeholder seed); `download` → `<a download>` on mediaUrl (create anchor, click, remove).
- [ ] **Step 3:** Build + preview: filters count right, hover actions fire, upscale/variation appear + debit correctly.

---

### Task 6: Detail overlay

**Files:**
- Create: `src/app/features/workspace/detail-overlay/detail-overlay.{ts,html,css}`
- Modify: `src/app/features/workspace/workspace-page.{ts,html}`

**Interfaces:**

```typescript
@Component({ selector: 'app-detail-overlay', ... })
export class DetailOverlay {
  readonly item = input.required<GenerationItem>();
  readonly parent = input<GenerationItem | null>(null);   // provenance
  readonly closed = output<void>();
  readonly download/upscale/variation/edit/deleted = output<string>();  // one output each, id payload
}
```

- [ ] **Step 1:** Use spartan brain dialog if API is simple after reading `libs/ui/dialog`; otherwise hand-rolled overlay (fixed inset-0, backdrop `rgb(0 0 0 / .7)`, Esc via `@HostListener('document:keydown.escape')`, backdrop click closes). Hand-rolled acceptable — record choice in code comment.
- [ ] **Step 2:** Layout: `grid-template-columns: minmax(0,1.6fr) 1fr;` — image left (`max-height: 80vh; object-fit: contain`); right column: prompt (full), chips (family, version, resolution/quality/duration values, aspect), `price paid`, date, provenance row `@if (parent())` with 48px thumb + "Edited from" linking `opened` on parent… simpler: clicking provenance emits `edit`-style output `openParent = output<string>()`; wire in parent. Action row: Download / Upscale $ / Variation / Edit → / Delete (destructive style `.loss-text`, `confirm()` native ok for stub).
- [ ] **Step 3:** Deleting parent keeps children (store.remove only that id); overlay for child of deleted parent shows "(deleted)" when `parent()` null but `item().parentId` set.
- [ ] **Step 4:** Build + preview: open, Esc, provenance chain after an edit exists (create edit via rail reference first).

---

### Task 7: Editor route + mask canvas

**Files:**
- Create: `src/app/features/editor/editor-page.{ts,html,css}`, `src/app/features/editor/mask-canvas/mask-canvas.{ts,html,css}`
- Modify: `src/app/app.routes.ts`

**Interfaces:**

```typescript
// mask-canvas.ts
@Component({ selector: 'app-mask-canvas', ... })
export class MaskCanvas {
  readonly imageUrl = input.required<string>();
  readonly enabled = input(false);                 // false → pointer-events none on canvas
  readonly brushSize = signal(40);
  readonly tool = signal<'brush' | 'eraser'>('brush');
  clear(): void;
  hasMask(): boolean;
  exportMaskPng(): string | null;                  // base64 data URL or null if empty
}
```

- [ ] **Step 1: mask-canvas implementation** — template: wrapper div, `<img>` + `<canvas>` absolutely stacked. Canvas sized to rendered img via `ResizeObserver`. Pointer events (pointerdown/move/up): draw circles `ctx.globalCompositeOperation = tool()==='brush' ? 'source-over' : 'destination-out'; ctx.fillStyle='rgba(120,80,255,0.5)'; ctx.arc(x, y, brushSize()/2, 0, 2π)` with line interpolation between move points (`ctx.lineTo` with `lineWidth=brushSize(), lineCap='round'`). `exportMaskPng`: offscreen canvas at natural size, draw mask scaled, return `toDataURL('image/png')`. `hasMask`: `getImageData` any alpha > 0 (sample every 16th pixel for speed).
- [ ] **Step 2: editor-page** — route param id → `store.byId`; missing → `router.navigate(['/app'])`. Layout: left rail (fixed-panel pattern): tool-model picker = `MODEL_FAMILIES.filter(f => f.capabilities.imageInput)`; mask section (brush/eraser toggle, size range input, Clear) — wrapped in `.og-disabled` + hint when `!family().capabilities.maskInput` ("{{name}} edits semantically from your prompt — no mask needed. Masking is available on GPT Image."); option groups (reuse `app-option-group`); edit prompt; `Apply edit · $X` → `ledger.charge('edit', ...)` + `store.add({op:'edit', parentId: current.id, mediaUrl: current.mediaUrl /* reuse parent img — provenance visible */})` → editor loads new version. Version chain top bar: walk parentId links both ways (store helper `chainFor(id)` — add to GenerationStore: ancestors via parentId + descendants via items whose parentId in chain), chips v1/v2/v3 navigate `router.navigate(['/app/edit', vId])`. Toolbar: Upscale (charge + add), Download, Back to workspace.
- [ ] **Step 3: routes** — add above wildcard:

```typescript
{ path: 'app/edit/:id', canActivate: [authGuard], loadComponent: () => import('./features/editor/editor-page').then((m) => m.EditorPage) },
```

- [ ] **Step 4:** Build + preview: draw mask on GPT (canvas gets strokes — verify via `exportMaskPng() !== null` through component debug hook or visual), switch to Nano Banana → mask section greys, Apply edit creates v2 + chain renders, deep-link `/app/edit/<id>` reload works (localStorage store), bad id redirects.

---

### Task 8: Settings suite

**Files:**
- Create: `src/app/features/settings/settings-page.{ts,html,css}` + `profile-tab/`, `billing-tab/`, `usage-tab/`, `preferences-tab/` (each `.ts/.html/.css`)
- Modify: `src/app/app.routes.ts`, `src/app/core/auth/auth-service.ts` (add `displayName` + `updateProfile`), `settings-rail` parent wiring for `confirmOverUsd`

**Interfaces:** tabs are dumb components over services; settings-page = shell with left nav (spartan tabs if API fits, else routerless signal tab switch — record choice).

- [ ] **Step 1: shell + route** `{ path: 'app/settings', canActivate: [authGuard], loadComponent: ... }`. Left nav column (Profile/Billing/Usage/Preferences), `activeTab` signal, content area swaps via `@switch`.
- [ ] **Step 2: Profile tab** — avatar (initial), email (readonly), display name input + Save → `auth.updateProfile({displayName})` (persisted in session), member since (from first ledger entry date). Danger zone card: Delete account → `confirm()` → `ledger.reset()`, `store` clear (add `clear()`), `auth.signOut()`, navigate `/`.
- [ ] **Step 3: Billing tab** — balance card (big number + Top up $20/$50/$100 buttons → `ledger.add({type:'topup', amountUsd: n})`); Studio card (Active since/renews +30d stub, Cancel → confirm dialog text: "Studio lapses at period end. 30-day grace to download, then your library is permanently deleted." → sets `studioActive=false` in auth; Reactivate button when off); ledger table: date · type badge · family · note · amount (+green/−default, `.profit-text` for credits). Newest first.
- [ ] **Step 4: Usage tab** — current-month entries: total spend, ops count; per-type rows (generate/edit/upscale) with CSS bar widths (`[style.width.%]` allowed — data-driven, exempt from inline-style rule; note comment); per-family counts from `familyId`.
- [ ] **Step 5: Preferences tab** — selects for default mode/image family/video family/aspect + number input `confirmOverUsd` → `prefs.update(...)`. Generate flow reads prefs: workspace-page initializes rail defaults from prefs; before charging, if `priceUsd > confirmOverUsd` → `confirm()` dialog "This generation costs $X. Continue?".
- [ ] **Step 6:** Build + preview all tabs; prefs survive reload; threshold triggers.

---

### Task 9: Landing + plans sync

**Files:**
- Modify: `src/app/features/landing/landing-page.ts` (providers array → 6: Google, OpenAI, ByteDance, Black Forest Labs, Kuaishou, Runway; services copy: "Nano Banana, GPT Image, Seedream, FLUX" / video: "Veo, Sora, Kling, Runway Gen-4.5, Seedance"), `src/app/features/plans/plans-page.ts` (examplePrices → launch families via new catalog: Nano Banana 1K $0.10, GPT Image medium $0.08, Seedream $0.04, FLUX 1MP $0.04, Kling 5s $0.52, Sora std 4s $0.60, Runway Gen-4.5 5s $0.90, Veo standard 4s $2.39 — compute via `userPriceUsd`, don't hardcode), `src/app/shared/site-footer/site-footer.html` (models column matches launch set)

- [ ] **Step 1:** Landing providers/copy edit. Carousel still loops smoothly with 6 logos (duplicated track unchanged).
- [ ] **Step 2:** Plans page examplePrices switch to catalog imports: `userPriceUsd(familyById('nano-banana')!, {...})` per row.
- [ ] **Step 3:** Footer models column sync.
- [ ] **Step 4:** Build + preview landing (6 logos load), pricing page numbers match workspace prices exactly.

---

### Task 10: Verification pass + polish

- [ ] **Step 1: Cost verify (spec §3 "(verify)" rows)** — fetch current fal pages for Seedream 4K & Seedance 720p rates, OpenAI docs for Sora per-second, Google for Veo Lite/Fast; update `model-families.ts` numbers + remove "(verify)" comments. If a page is unreachable, keep number, leave comment, report to user.
- [ ] **Step 2:** Full regression: `npx ng test --watch=false` green; build green; preview walk: login → generate (image+video) → edit w/ mask → upscale → variation → detail overlay provenance → settings 4 tabs → landing/pricing/compare/admin pages all render.
- [ ] **Step 3:** Update `vansen.md`: §4 note that model catalog is now family-based in `core/catalog/model-families.ts`; §5 already PAYG-pending — add one line "workspace UI implements PAYG stub with ledger mirror of future transactions table".

---

## Self-review notes

- Spec coverage: §3→T1, §8→T2, tooltips→T3/T4, §4→T4/T5, §5→T6, §6→T7, §7→T8, §9→T9, §13 edge cases → embedded (overdraft T2, threshold T8, deleted parent T6, bad editor id T7, video ops hidden T5). Gaps: none found.
- No git steps anywhere (user rule).
- Type names consistent: `GenerationItem.op` values used by T5 filters and T7 chain; `FamilyOption`/`GenerationSettings` shared from T1.
