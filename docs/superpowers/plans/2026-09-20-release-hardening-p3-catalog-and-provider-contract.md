# Release Hardening P3 — Catalog and Provider Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the model option a customer picks, the price they are charged, the request that reaches the provider, and the file that comes back all describe the same thing — and delete every selector the adapter cannot actually honour.

**Architecture:** A new `normalizeGenerationRequest(family, op, settings)` turns a validated request into a versioned `NormalizedRequest` carrying the exact provider model id and the exact axis values the adapter will transmit. `quote(normalized)` prices that same object. `SubmitCtx` gains the normalized request, and each adapter reads it instead of re-deriving the model and size from raw settings. Where the catalog offers an axis no provider call honours, the axis is either wired or removed — the capability record written in Task 1 decides which, per option, against current official documentation.

**Tech Stack:** TypeScript (Angular master catalog + Deno `_shared` copy), Deno, `deno test`, vitest, `scripts/sync-shared.mjs`.

**Source spec:** `docs/superpowers/plans/2026-09-17-release-readiness-review-and-implementation-plan.md` — this plan implements **T05**, closing **R04** and the adapter half of **R28**. It supplies the catalog export the mobile plan's **MT-03** consumes and the capability truth **T17** (P8) needs before it can rewrite sales copy.

## Global Constraints

- **Never commit, branch, or push.** Every task ends with "user commits". No `git commit` steps.
- **No nested if statements.** Guard clauses and early returns only.
- **The Angular file is the master.** Edit `src/app/core/catalog/model-families.ts`, then run `npm run sync-shared`. Never hand-edit `supabase/functions/_shared/model-families.ts` — `src/app/core/shared-sync.spec.ts` asserts the copies match and will fail.
- **Provider keys only in Edge Function secrets.** No keys in the repo. Unit tests never call a provider; the one place a real call happens is the Task 1 smoke, run by the user against their own account.
- **Never advertise an option the adapter does not request.** If a smoke cannot prove an axis reaches the provider and changes the output, the axis comes out of the catalog in this plan, not later.
- **The client never supplies the charge.** `quote()` runs server-side; the price the composer shows is advisory and must be recomputed on the server.
- **Redeploying `api` must bundle every `_shared/` file including `providers/`.** No deploys happen in this plan, but the note carries into P9.
- **Tests:** Angular → `npm test -- --watch=false`. Edge → `cd supabase/functions && deno test --allow-all _shared api stripe-webhook appstore-webhook`. Build → `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`.
- **Baseline after P2:** 134 deno tests, 242 vitest tests. Each task states the new expected count.

---

## The defect in one paragraph

`src/app/core/catalog/model-families.ts` prices GPT Image by `version` and `resolution`, but `supabase/functions/_shared/providers/openai.ts:11` hard-codes `const MODEL = 'gpt-image-1'` and `sizeFor` (lines 14–19) reads only `aspectRatio`. A customer who picks version 2 at 4K and one who picks version 1 send **byte-identical** requests and receive identically sized images, while being charged 73 and 28 credits. FLUX has the same shape: the catalog sells 1MP/2MP/4MP at $0.03/$0.06/$0.12, and `fal.ts:112` builds `{prompt, aspect_ratio}` with no size field at all. Seedream sells 1K/2K/4K while `providerCost` returns a flat `0.03` and no resolution is transmitted. Nano Banana is the control: `google.ts` picks the model from `version` and sends `image_size`, so its selectors are real.

---

## File Structure

**New:**
- `docs/superpowers/specs/2026-09-20-provider-capability-record.md` — the verified, dated record of what each provider option actually is. Every later task cites it.
- `supabase/functions/_shared/generation-request.ts` + `_test.ts` — `normalizeGenerationRequest`, `quote`, `QUOTE_VERSION`.
- `supabase/functions/_shared/providers/openai_test.ts`, `google_test.ts`, `fal_image_test.ts` — adapter contract tests asserting the outgoing request.
- `supabase/functions/_shared/providers/testing/capture.ts` — a `fetch` capture harness for adapter tests.
- `scripts/export-catalog.mjs` — emits `catalog.json` + the Dart fixture for the mobile repo.
- `src/app/core/catalog/catalog-version.spec.ts` — fails when the catalog changes without a version bump.

**Modified:**
- `src/app/core/catalog/model-families.ts` — catalog version constant; axes corrected or removed per Task 1.
- `supabase/functions/_shared/providers/types.ts` — `SubmitCtx.normalized`.
- `supabase/functions/_shared/providers/openai.ts`, `google.ts`, `fal.ts` — consume the normalized request.
- `supabase/functions/api/app.ts` — normalize once, quote from the normalized request, pass it to `submit`.
- `scripts/sync-shared.mjs` — also emit the Dart fixture.

---

## Task 1: The provider capability record

**Files:**
- Create: `docs/superpowers/specs/2026-09-20-provider-capability-record.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the authoritative table every later task reads. Tasks 3–6 must not guess a model id, a size string or a parameter name that is not in this file.

**This is a blocking research task and it needs the user.** Two of its steps require live provider calls with the project's own API keys, which only the user can run. Do the documentation half yourself, then hand the user the exact commands for the smoke half and wait for the output. Do not substitute a plausible-looking model id for a verified one: a wrong `gpt-image-2` guess silently reintroduces exactly the defect this plan exists to fix.

- [ ] **Step 1: Write the record skeleton with every claim the catalog currently makes**

Create `docs/superpowers/specs/2026-09-20-provider-capability-record.md`:

```markdown
# Provider capability record

Verified on: <DATE>
Verified by: <NAME>

Every row is a claim the Vansen catalog makes to a paying customer. A row is
**verified** only when both columns are filled from a primary source: the
provider's current official documentation, and a live call on the Vansen
account that produced an output matching the claim. An unverified row is
removed from the catalog, not shipped with a caveat.

## Nano Banana (Google Gemini) — the control

| Catalog option | Provider model / parameter | Doc link | Smoke result |
|---|---|---|---|
| version `fast` | `gemini-2.5-flash-image` | | |
| version `standard` | `gemini-3.1-flash-image` | | |
| version `pro` | `gemini-3-pro-image` | | |
| resolution `1K` / `2K` / `4K` | `imageConfig.image_size` | | |
| aspectRatio | `imageConfig.aspect_ratio` | | |
| reference image | `contents[].parts[].inline_data` | | |

## GPT Image (OpenAI)

| Catalog option | Provider model / parameter | Doc link | Smoke result |
|---|---|---|---|
| version `1` | | | |
| version `1.5` | | | |
| version `2` | | | |
| resolution `1K` | `size` | | |
| resolution `2K` (claimed v2-only) | | | |
| resolution `4K` (claimed v2-only, 2.05× price) | | | |
| quality `low`/`medium`/`high` | `quality` | | |
| reference image on **generate** | | | |
| mask (`maskInput: true`) | `/v1/images/edits` `mask` | | |

## FLUX (fal / Black Forest Labs)

| Catalog option | Provider model / parameter | Doc link | Smoke result |
|---|---|---|---|
| slug `fal-ai/flux-pro/v1.1` | | | |
| blurb claims "FLUX.2 [pro]" | | | |
| resolution `1MP` / `2MP` / `4MP` | | | |
| aspectRatio | `aspect_ratio` or `image_size`? | | |
| reference image | `image_url` | | |

## Seedream (fal / ByteDance)

| Catalog option | Provider model / parameter | Doc link | Smoke result |
|---|---|---|---|
| slug `fal-ai/bytedance/seedream/v4/text-to-image` | | | |
| resolution `1K` / `2K` / `4K` | | | |
| flat $0.03 at every resolution | | | |
| reference → `/edit` slug, `image_urls` | | | |

## Decisions

For each unverified row: **wire** (the parameter exists and the adapter will
send it) or **remove** (the option leaves the catalog for this release).

| Row | Decision | Rationale |
|---|---|---|
```

- [ ] **Step 2: Fill the documentation column**

Read each provider's current official documentation and fill the model/parameter and doc-link columns. Two specific questions the review flagged and this record must answer plainly:

1. Do fal's FLUX and Seedream image endpoints take `aspect_ratio`, `image_size`, or both? The current `payloadFor` sends `aspect_ratio` for FLUX and nothing else. If the endpoint expects `image_size`, every FLUX generation has been ignoring the aspect-ratio control too, not only the resolution control.
2. Does the OpenAI image model the catalog calls "2" exist under a distinct model id with distinct `size` support? If there is no such model, versions `1.5` and `2` are selling a difference that cannot exist, and the price multiplier on them is unearned.

- [ ] **Step 3: Give the user the smoke commands**

The user runs these against their own keys. Print them and wait.

```bash
# GPT Image — does the 4K claim produce a 4K file?
curl -s https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-1","prompt":"a red square","size":"1024x1024","quality":"medium","n":1}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=Buffer.from(JSON.parse(s).data[0].b64_json,"base64");require("fs").writeFileSync("/tmp/gpt.png",b);console.log("bytes",b.length)})' \
  && file /tmp/gpt.png
```

```bash
# FLUX — does a resolution/size parameter change the output dimensions?
curl -s -X POST https://queue.fal.run/fal-ai/flux-pro/v1.1 \
  -H "Authorization: Key $FAL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"a red square","aspect_ratio":"1:1"}'
```

```bash
# Seedream — same question at 2K.
curl -s -X POST https://queue.fal.run/fal-ai/bytedance/seedream/v4/text-to-image \
  -H "Authorization: Key $FAL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"a red square","aspect_ratio":"1:1"}'
```

```bash
# Nano Banana control — 2K must come back larger than 1K.
curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent" \
  -H "x-goog-api-key: $GOOGLE_AI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"a red square"}]}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":{"image_size":"2K","aspect_ratio":"1:1"}}}'
```

For each fal call, poll the returned `status_url` and download the result, then run `file` on it to read the real dimensions. A resolution option is verified only when two different values produce two different output sizes.

- [ ] **Step 4: Record the decisions and get them approved**

Fill the Decisions table. Present the **remove** list to the user before writing any code — removing a selector changes what the product sells, and the copy changes in P8 depend on this list. Wait for approval.

- [ ] **Step 5: Commit the record**

The record is the deliverable of this task. Nothing else in this plan may cite a model id or parameter name that is not in it. User commits.

---

## Task 2: The normalized request and the quote

**Files:**
- Create: `supabase/functions/_shared/generation-request.ts`, `supabase/functions/_shared/generation-request_test.ts`
- Modify: `src/app/core/catalog/model-families.ts` (add `CATALOG_VERSION`), then `npm run sync-shared`

**Interfaces:**
- Consumes: `familyById`, `editToolById`, `creditCost`, `ModelFamily`, `GenerationSettings` from the catalog; the capability record (Task 1).
- Produces:
  ```ts
  export const QUOTE_VERSION = 1;
  export interface NormalizedRequest {
    quoteVersion: number;
    catalogVersion: string;
    familyId: string;
    op: string;
    /** The EXACT provider model id the adapter will call. */
    providerModel: string;
    /** The EXACT axis values the adapter will transmit, already in provider spelling. */
    providerSettings: Record<string, string | number | boolean>;
    /** The catalogued settings this was derived from, for storage and retry. */
    settings: GenerationSettings;
    hasReference: boolean;
    hasMask: boolean;
  }
  export function normalizeGenerationRequest(
    family: ModelFamily, op: string, settings: GenerationSettings,
    ctx: { hasReference: boolean; hasMask: boolean },
  ): NormalizedRequest;
  export function quote(n: NormalizedRequest, family: ModelFamily):
    { credits: number; providerCostUsd: number };
  ```

**The invariant this exists to enforce:** two requests that produce the same `providerModel` + `providerSettings` must produce the same `credits`. A price difference with no request difference is the bug.

- [ ] **Step 1: Add `CATALOG_VERSION` to the Angular master**

At the top of `src/app/core/catalog/model-families.ts`, after the existing header comment:

```ts
/**
 * Catalog version. Bump on ANY change to a family's id, options, prices or
 * provider mapping. Clients send it back with a request so the server can tell
 * a stale composer's quote from a current one, and the Dart fixture in the
 * mobile repo pins it. `catalog-version.spec.ts` fails if the catalog content
 * hash changes without a bump.
 */
export const CATALOG_VERSION = '2026-09-20.1';
```

Then:

```bash
cd /Users/user/IdeaProjects/vansen && npm run sync-shared
```

- [ ] **Step 2: Write the failing test**

Create `supabase/functions/_shared/generation-request_test.ts`:

```ts
import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { familyById } from './model-families.ts';
import { normalizeGenerationRequest, quote, QUOTE_VERSION } from './generation-request.ts';

function norm(familyId: string, settings: Record<string, unknown>, op = 'generate') {
  const family = familyById(familyId)!;
  return normalizeGenerationRequest(family, op, settings as never, {
    hasReference: false,
    hasMask: false,
  });
}

Deno.test('THE BUG: gpt-image v1 and v2-at-4K must not send the same request', () => {
  const v1 = norm('gpt-image', { aspectRatio: '1:1', version: '1', quality: 'medium', resolution: '1K' });
  const v2 = norm('gpt-image', { aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '4K' });
  const family = familyById('gpt-image')!;
  const priceV1 = quote(v1, family).credits;
  const priceV2 = quote(v2, family).credits;

  assertNotEquals(priceV1, priceV2, 'precondition: the catalog prices these differently');
  assertNotEquals(
    JSON.stringify({ m: v1.providerModel, s: v1.providerSettings }),
    JSON.stringify({ m: v2.providerModel, s: v2.providerSettings }),
    'two prices must mean two different provider requests',
  );
});

Deno.test('THE BUG: flux resolutions must not send the same request', () => {
  const one = norm('flux', { aspectRatio: '1:1', resolution: '1MP' });
  const four = norm('flux', { aspectRatio: '1:1', resolution: '4MP' });
  const family = familyById('flux')!;
  assertNotEquals(quote(one, family).credits, quote(four, family).credits);
  assertNotEquals(
    JSON.stringify(one.providerSettings),
    JSON.stringify(four.providerSettings),
  );
});

Deno.test('THE BUG: seedream resolutions must not send the same request', () => {
  const one = norm('seedream', { aspectRatio: '1:1', resolution: '1K' });
  const four = norm('seedream', { aspectRatio: '1:1', resolution: '4K' });
  const family = familyById('seedream')!;
  const samePrice = quote(one, family).credits === quote(four, family).credits;
  const sameRequest = JSON.stringify(one.providerSettings) === JSON.stringify(four.providerSettings);
  // Either the resolutions differ in the request, or they differ in nothing at
  // all — selling three identical options at one price is what this forbids.
  assertEquals(
    samePrice && sameRequest,
    true,
    'seedream must be flat-priced AND flat-requested, or be wired per resolution',
  );
});

Deno.test('CONTROL: nano-banana already maps version and resolution', () => {
  const fast = norm('nano-banana', { aspectRatio: '1:1', version: 'fast', resolution: '1K' });
  const pro = norm('nano-banana', { aspectRatio: '1:1', version: 'pro', resolution: '4K' });
  assertEquals(fast.providerModel, 'gemini-2.5-flash-image');
  assertEquals(pro.providerModel, 'gemini-3-pro-image');
  assertEquals(fast.providerSettings.image_size, '1K');
  assertEquals(pro.providerSettings.image_size, '4K');
});

Deno.test('the same provider request always prices the same', () => {
  const a = norm('nano-banana', { aspectRatio: '1:1', version: 'standard', resolution: '2K' });
  const b = norm('nano-banana', { aspectRatio: '1:1', version: 'standard', resolution: '2K' });
  const family = familyById('nano-banana')!;
  assertEquals(
    JSON.stringify({ m: a.providerModel, s: a.providerSettings }),
    JSON.stringify({ m: b.providerModel, s: b.providerSettings }),
  );
  assertEquals(quote(a, family).credits, quote(b, family).credits);
});

Deno.test('every normalized request carries its versions', () => {
  const n = norm('flux', { aspectRatio: '1:1', resolution: '1MP' });
  assertEquals(n.quoteVersion, QUOTE_VERSION);
  assertEquals(typeof n.catalogVersion, 'string');
});

Deno.test('a reference is recorded on generate, not only on edit', () => {
  const family = familyById('gpt-image')!;
  const n = normalizeGenerationRequest(
    family,
    'generate',
    { aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '1K' } as never,
    { hasReference: true, hasMask: false },
  );
  assertEquals(n.hasReference, true);
});

Deno.test('the credit price equals the catalog creditCost for the same settings', () => {
  for (const familyId of ['nano-banana', 'gpt-image', 'flux', 'seedream']) {
    const family = familyById(familyId)!;
    const settings = {
      aspectRatio: family.capabilities.aspectRatios[0],
      version: family.capabilities.versions?.[0]?.value,
      resolution: family.capabilities.resolutions?.[0]?.value,
      quality: family.capabilities.qualities?.[0]?.value,
    };
    const n = normalizeGenerationRequest(family, 'generate', settings as never, {
      hasReference: false,
      hasMask: false,
    });
    const { credits, providerCostUsd } = quote(n, family);
    assertEquals(providerCostUsd, family.providerCost(settings as never));
    assertEquals(credits > 0, true, `${familyId} must have a positive price`);
  }
});
```

- [ ] **Step 2b: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/generation-request_test.ts
```

Expected: FAIL — `Module not found "file:///.../_shared/generation-request.ts"`.

- [ ] **Step 3: Write `_shared/generation-request.ts`**

Fill the `PROVIDER_MODELS` and `providerSettingsFor` bodies from the Task 1 record. The structure is fixed; the values are not guessable.

```ts
// One description of "what we will actually ask the provider for", built once
// per request and used by BOTH the quote and the adapter.
//
// Before this module the two were derived independently: the catalog priced by
// version and resolution while openai.ts hard-coded one model and one size
// table keyed only on aspect ratio, so a customer paid 73 credits for the same
// request that cost another 28. Deriving them from one object makes that class
// of drift a type error instead of a billing incident.
//
// Every model id and parameter name below is copied from
// docs/superpowers/specs/2026-09-20-provider-capability-record.md. Do not add
// one that is not recorded there.
import {
  CATALOG_VERSION,
  creditCost,
  type GenerationSettings,
  type ModelFamily,
} from './model-families.ts';

export const QUOTE_VERSION = 1;

export interface NormalizedRequest {
  quoteVersion: number;
  catalogVersion: string;
  familyId: string;
  op: string;
  providerModel: string;
  providerSettings: Record<string, string | number | boolean>;
  settings: GenerationSettings;
  hasReference: boolean;
  hasMask: boolean;
}

/** Nano Banana version → Gemini image model id (record §Nano Banana). */
const NANO_MODELS: Record<string, string> = {
  fast: 'gemini-2.5-flash-image',
  standard: 'gemini-3.1-flash-image',
  pro: 'gemini-3-pro-image',
};

/** GPT Image version → OpenAI model id (record §GPT Image). Fill from Task 1. */
const GPT_MODELS: Record<string, string> = {
  '1': 'gpt-image-1',
  '1.5': '<from record>',
  '2': '<from record>',
};

/** GPT Image (aspectRatio, resolution) → `size` (record §GPT Image). */
function gptSize(aspectRatio: string, resolution: string): string {
  const portrait = aspectRatio === '9:16' || aspectRatio === '3:4';
  const landscape = aspectRatio === '16:9' || aspectRatio === '4:3';
  const table: Record<string, { square: string; portrait: string; landscape: string }> = {
    '1K': { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
    '2K': { square: '<from record>', portrait: '<from record>', landscape: '<from record>' },
    '4K': { square: '<from record>', portrait: '<from record>', landscape: '<from record>' },
  };
  const row = table[resolution] ?? table['1K'];
  if (portrait) return row.portrait;
  if (landscape) return row.landscape;
  return row.square;
}

/** FLUX resolution → fal `image_size` (record §FLUX). */
const FLUX_SIZES: Record<string, string> = {
  '1MP': '<from record>',
  '2MP': '<from record>',
  '4MP': '<from record>',
};

function nanoSettings(s: GenerationSettings): Record<string, string> {
  const out: Record<string, string> = {};
  if (s.resolution) out.image_size = String(s.resolution);
  if (s.aspectRatio) out.aspect_ratio = String(s.aspectRatio);
  return out;
}

function gptSettings(s: GenerationSettings): Record<string, string> {
  return {
    size: gptSize(String(s.aspectRatio ?? '1:1'), String(s.resolution ?? '1K')),
    quality: String(s.quality ?? 'medium'),
  };
}

function fluxSettings(s: GenerationSettings): Record<string, string> {
  const out: Record<string, string> = { aspect_ratio: String(s.aspectRatio ?? '1:1') };
  const size = FLUX_SIZES[String(s.resolution ?? '1MP')];
  if (size) out.image_size = size;
  return out;
}

function seedreamSettings(s: GenerationSettings): Record<string, string> {
  // Seedream is flat-priced. If Task 1 verified a real resolution parameter,
  // add it here AND give the family a per-resolution providerCost; if not, the
  // resolution option is removed from the catalog in Task 6 and this stays as
  // aspect ratio alone.
  return { aspect_ratio: String(s.aspectRatio ?? '1:1') };
}

export function normalizeGenerationRequest(
  family: ModelFamily,
  op: string,
  settings: GenerationSettings,
  ctx: { hasReference: boolean; hasMask: boolean },
): NormalizedRequest {
  const base = {
    quoteVersion: QUOTE_VERSION,
    catalogVersion: CATALOG_VERSION,
    familyId: family.id,
    op,
    settings,
    hasReference: ctx.hasReference,
    hasMask: ctx.hasMask,
  };
  if (family.id === 'nano-banana') {
    return {
      ...base,
      providerModel: NANO_MODELS[String(settings.version ?? 'standard')] ?? NANO_MODELS.standard,
      providerSettings: nanoSettings(settings),
    };
  }
  if (family.id === 'gpt-image') {
    return {
      ...base,
      providerModel: GPT_MODELS[String(settings.version ?? '2')] ?? GPT_MODELS['1'],
      providerSettings: gptSettings(settings),
    };
  }
  if (family.id === 'flux') {
    return { ...base, providerModel: 'fal-ai/flux-pro/v1.1', providerSettings: fluxSettings(settings) };
  }
  if (family.id === 'seedream') {
    const slug = ctx.hasReference
      ? 'fal-ai/bytedance/seedream/v4/edit'
      : 'fal-ai/bytedance/seedream/v4/text-to-image';
    return { ...base, providerModel: slug, providerSettings: seedreamSettings(settings) };
  }
  // Video families and edit tools keep their existing adapter-side mapping for
  // now; they are normalized in P5 alongside durable dispatch.
  return { ...base, providerModel: family.id, providerSettings: {} };
}

export function quote(
  n: NormalizedRequest,
  family: ModelFamily,
): { credits: number; providerCostUsd: number } {
  return {
    credits: creditCost(family, n.settings),
    providerCostUsd: family.providerCost(n.settings),
  };
}
```

The `<from record>` placeholders are deliberate: they are the values Task 1 produces. **A tree containing them must not be committed.** Replace every one before running Step 4.

- [ ] **Step 4: Run the tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && grep -rn "from record" _shared/generation-request.ts && echo "PLACEHOLDERS REMAIN — fill them from the Task 1 record before continuing" || deno test --allow-all _shared/generation-request_test.ts
```

Expected: no `from record` matches, then `8 passed | 0 failed`. User commits.

---

## Task 3: OpenAI adapter — real model, real size, reference on generate

**Files:**
- Modify: `supabase/functions/_shared/providers/types.ts`, `supabase/functions/_shared/providers/openai.ts`
- Create: `supabase/functions/_shared/providers/testing/capture.ts`, `supabase/functions/_shared/providers/openai_test.ts`

**Interfaces:**
- Consumes: `NormalizedRequest` (Task 2).
- Produces: `SubmitCtx.normalized?: NormalizedRequest`. Optional for one release so video adapters keep compiling; the image adapters require it and throw a clear error when it is absent.

**Two defects fixed here:**
1. R04 — the model and size come from `normalized`, so a version and resolution the customer paid for actually reach OpenAI.
2. R28 adapter half — `openai.ts:40` gates the reference on `op === 'edit' || op === 'upscale'`. After P1 the gateway delivers `referenceUrl` on `op = 'generate'` too, and this adapter silently drops it. The rule becomes: **any** reference means the edits endpoint.

- [ ] **Step 1: Write the fetch capture harness**

Create `supabase/functions/_shared/providers/testing/capture.ts`:

```ts
// Adapter contract tests assert on the request that LEAVES the process. This
// swaps globalThis.fetch for a recorder that answers with a canned provider
// response, so a test can prove "the 4K selection reached the wire" without a
// network, a key, or a bill.
export interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  jsonBody: Record<string, unknown> | null;
  formBody: Map<string, string | { name: string; type: string; size: number }> | null;
}

export interface CaptureHandle {
  calls: Captured[];
  restore(): void;
}

export function captureFetch(respond: (call: Captured) => Response): CaptureHandle {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k] = k.toLowerCase() === 'authorization' ? '<redacted>' : v;
    });
    let jsonBody: Record<string, unknown> | null = null;
    let formBody: Captured['formBody'] = null;
    if (typeof init?.body === 'string') jsonBody = JSON.parse(init.body);
    if (init?.body instanceof FormData) {
      formBody = new Map();
      for (const [k, v] of init.body.entries()) {
        if (typeof v === 'string') formBody.set(k, v);
        if (v instanceof File) formBody.set(k, { name: v.name, type: v.type, size: v.size });
      }
    }
    const call: Captured = { url, method: init?.method ?? 'GET', headers, jsonBody, formBody };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A 1×1 PNG, base64, for canned provider responses. */
export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
```

- [ ] **Step 2: Write the failing adapter test**

Create `supabase/functions/_shared/providers/openai_test.ts`:

```ts
import { assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert';
import { familyById } from '../model-families.ts';
import { normalizeGenerationRequest } from '../generation-request.ts';
import { openaiAdapter } from './openai.ts';
import { TINY_PNG_B64, captureFetch } from './testing/capture.ts';
import type { SubmitCtx } from './types.ts';

function ctx(settings: Record<string, unknown>, over: Partial<SubmitCtx> = {}): SubmitCtx {
  const family = familyById('gpt-image')!;
  const op = String(over.op ?? 'generate');
  return {
    familyId: 'gpt-image',
    op,
    prompt: 'a red square',
    settings,
    safetyId: 'sha-test',
    normalized: normalizeGenerationRequest(family, op, settings as never, {
      hasReference: !!over.referenceUrl,
      hasMask: !!over.maskPngBase64,
    }),
    ...over,
  } as SubmitCtx;
}

function respondImage(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }), { status: 200 });
}

Deno.test('the selected version reaches the wire as a distinct model', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx({ aspectRatio: '1:1', version: '1', quality: 'medium', resolution: '1K' }));
  await openaiAdapter.submit(ctx({ aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '1K' }));
  cap.restore();
  assertNotEquals(cap.calls[0].jsonBody?.model, cap.calls[1].jsonBody?.model);
});

Deno.test('the selected resolution reaches the wire as a distinct size', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx({ aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '1K' }));
  await openaiAdapter.submit(ctx({ aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '4K' }));
  cap.restore();
  assertNotEquals(cap.calls[0].jsonBody?.size, cap.calls[1].jsonBody?.size);
});

Deno.test('the selected quality reaches the wire', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx({ aspectRatio: '1:1', version: '2', quality: 'high', resolution: '1K' }));
  cap.restore();
  assertEquals(cap.calls[0].jsonBody?.quality, 'high');
});

Deno.test('R28: a reference on GENERATE uses the edits endpoint and sends the image', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch((call) =>
    call.url.includes('/images/') && call.method === 'POST'
      ? respondImage()
      : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })
  );
  await openaiAdapter.submit(
    ctx({ aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '1K' }, {
      op: 'generate',
      referenceUrl: 'https://fake.storage/uploads/u/1.png',
    }),
  );
  cap.restore();
  const apiCall = cap.calls.find((c) => c.url.includes('api.openai.com'))!;
  assertEquals(apiCall.url, 'https://api.openai.com/v1/images/edits');
  assertEquals(typeof apiCall.formBody?.get('image'), 'object');
});

Deno.test('no reference still uses the generations endpoint', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx({ aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '1K' }));
  cap.restore();
  assertEquals(cap.calls[0].url, 'https://api.openai.com/v1/images/generations');
});

Deno.test('the safety id is always attached', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await openaiAdapter.submit(ctx({ aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '1K' }));
  cap.restore();
  assertEquals(cap.calls[0].jsonBody?.user, 'sha-test');
});

Deno.test('a provider error surfaces its status', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response('rate limited', { status: 429 }));
  await assertRejects(
    () => openaiAdapter.submit(ctx({ aspectRatio: '1:1', version: '2', quality: 'medium', resolution: '1K' })),
    Error,
    '429',
  );
  cap.restore();
});

Deno.test('a context with no normalized request is refused, not silently defaulted', async () => {
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const bare = {
    familyId: 'gpt-image', op: 'generate', prompt: 'x',
    settings: { aspectRatio: '1:1' }, safetyId: 'sha-test',
  } as SubmitCtx;
  await assertRejects(() => openaiAdapter.submit(bare), Error, 'normalized');
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/openai_test.ts
```

Expected: FAIL — `normalized` is not a property of `SubmitCtx`; the version and resolution tests report identical `model` and `size`.

- [ ] **Step 4: Add `normalized` to `SubmitCtx`**

In `_shared/providers/types.ts`, add the import and the field:

```ts
import type { NormalizedRequest } from '../generation-request.ts';
```

Inside `SubmitCtx`, after `settings`:

```ts
  /**
   * The versioned request the quote was computed from. Image adapters REQUIRE
   * it: deriving the model or size from raw settings is what let a customer pay
   * for a 4K v2 render and receive a 1K v1 one. Optional only so the video
   * adapters, which are normalized in P5, keep compiling.
   */
  normalized?: NormalizedRequest;
```

- [ ] **Step 5: Rewrite `openai.ts`**

```ts
// OpenAI GPT Image adapter — generate + edits (mask). Responds inline with a
// base64 image, so submit answers synchronously.
//
// The model id and the `size` string come from the normalized request, never
// from a table in this file: the quote is computed from the same object, so a
// price the customer paid cannot describe a request we did not send.
import { CheckResult, ProviderAdapter, SubmitCtx } from './types.ts';

function key(): string {
  const k = Deno.env.get('OPENAI_API_KEY');
  if (!k) throw new Error('OPENAI_API_KEY missing');
  return k;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function urlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reference fetch ${res.status}`);
  return await res.blob();
}

export const openaiAdapter: ProviderAdapter = {
  provider: 'openai',

  async submit(ctx: SubmitCtx) {
    const n = ctx.normalized;
    if (!n) throw new Error('openai: normalized request is required');
    const model = n.providerModel;
    const size = String(n.providerSettings.size);
    const quality = String(n.providerSettings.quality);

    // Any reference means the edits endpoint. Gating this on op === 'edit'
    // made an uploaded reference on a plain generate vanish between the
    // gateway and OpenAI, after the customer had already been charged.
    if (ctx.referenceUrl) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', ctx.prompt);
      form.append('size', size);
      form.append('quality', quality);
      form.append('user', ctx.safetyId);
      form.append('image', await urlToBlob(ctx.referenceUrl), 'source.png');
      if (ctx.maskPngBase64) {
        const maskBytes = base64ToBytes(ctx.maskPngBase64.replace(/^data:image\/\w+;base64,/, ''));
        form.append('mask', new Blob([maskBytes as BlobPart], { type: 'image/png' }), 'mask.png');
      }
      const res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}` },
        body: form,
      });
      if (!res.ok) throw new Error(`openai edit ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const bytes = base64ToBytes(data.data[0].b64_json);
      return { providerRef: 'inline', inline: { state: 'done', bytes, contentType: 'image/png' } };
    }

    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: ctx.prompt, size, quality, user: ctx.safetyId, n: 1 }),
    });
    if (!res.ok) throw new Error(`openai generate ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const bytes = base64ToBytes(data.data[0].b64_json);
    return { providerRef: 'inline', inline: { state: 'done', bytes, contentType: 'image/png' } };
  },

  async check(_ref: string): Promise<CheckResult> {
    return { state: 'running' };
  },
};
```

**The mask branch:** it is now reachable, because the gateway sends `maskPngBase64` with `op = 'edit'` on a `maskInput: true` family. If the Task 1 record shows the OpenAI model in use does **not** accept a mask, set `maskInput: false` on the gpt-image family in Task 6 and delete this branch instead of shipping a parameter the provider ignores.

- [ ] **Step 6: Run the tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/app.ts && deno test --allow-all _shared/providers/openai_test.ts
```

Expected: `8 passed | 0 failed`. User commits.

---

## Task 4: fal image branch — the size actually travels

**Files:**
- Modify: `supabase/functions/_shared/providers/fal.ts`
- Create: `supabase/functions/_shared/providers/fal_image_test.ts`

**Interfaces:**
- Consumes: `NormalizedRequest`.
- Produces: `payloadFor` merges `ctx.normalized.providerSettings` for the `flux` and `seedream` branches; `slugFor` reads `ctx.normalized.providerModel` for them.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/providers/fal_image_test.ts`:

```ts
import { assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { familyById } from '../model-families.ts';
import { normalizeGenerationRequest } from '../generation-request.ts';
import { falAdapter } from './fal.ts';
import { captureFetch } from './testing/capture.ts';
import type { SubmitCtx } from './types.ts';

function ctx(familyId: string, settings: Record<string, unknown>, over: Partial<SubmitCtx> = {}): SubmitCtx {
  const family = familyById(familyId)!;
  const op = String(over.op ?? 'generate');
  return {
    familyId,
    op,
    prompt: 'a red square',
    settings,
    safetyId: 'sha-test',
    normalized: normalizeGenerationRequest(family, op, settings as never, {
      hasReference: !!over.referenceUrl,
      hasMask: false,
    }),
    ...over,
  } as SubmitCtx;
}

function queued(): Response {
  return new Response(JSON.stringify({ request_id: 'req_1' }), { status: 200 });
}

Deno.test('flux: two resolutions produce two different payloads', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(ctx('flux', { aspectRatio: '1:1', resolution: '1MP' }));
  await falAdapter.submit(ctx('flux', { aspectRatio: '1:1', resolution: '4MP' }));
  cap.restore();
  assertNotEquals(
    JSON.stringify(cap.calls[0].jsonBody),
    JSON.stringify(cap.calls[1].jsonBody),
    '4MP costs four times 1MP and must not send the same request',
  );
});

Deno.test('flux: the aspect ratio travels under the name the record verified', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(ctx('flux', { aspectRatio: '16:9', resolution: '1MP' }));
  cap.restore();
  const body = cap.calls[0].jsonBody!;
  // Whichever the record verified, exactly one of these must carry the choice.
  assertEquals(
    body.aspect_ratio === '16:9' || typeof body.image_size === 'object' || typeof body.image_size === 'string',
    true,
  );
});

Deno.test('seedream: a reference switches to the edit slug', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(
    ctx('seedream', { aspectRatio: '1:1', resolution: '1K' }, {
      referenceUrl: 'https://fake.storage/uploads/u/1.png',
    }),
  );
  cap.restore();
  assertEquals(cap.calls[0].url.endsWith('/edit'), true);
  assertEquals((cap.calls[0].jsonBody!.image_urls as string[])[0], 'https://fake.storage/uploads/u/1.png');
});

Deno.test('seedream: no reference uses the text-to-image slug', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(ctx('seedream', { aspectRatio: '1:1', resolution: '1K' }));
  cap.restore();
  assertEquals(cap.calls[0].url.endsWith('/text-to-image'), true);
});

Deno.test('R28: a reference on GENERATE still reaches flux', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit(
    ctx('flux', { aspectRatio: '1:1', resolution: '1MP' }, {
      op: 'generate',
      referenceUrl: 'https://fake.storage/uploads/u/1.png',
    }),
  );
  cap.restore();
  assertEquals(cap.calls[0].jsonBody!.image_url, 'https://fake.storage/uploads/u/1.png');
});

Deno.test('the edit tools and the upscaler are untouched by normalization', async () => {
  Deno.env.set('FAL_API_KEY', 'test-key');
  const cap = captureFetch(queued);
  await falAdapter.submit({
    familyId: 'edit-bg', op: 'edit', prompt: '', settings: {}, safetyId: 'sha-test',
    referenceUrl: 'https://fake.storage/media/a.png',
  } as SubmitCtx);
  cap.restore();
  assertEquals(cap.calls[0].url.endsWith('fal-ai/birefnet/v2'), true);
  assertEquals(cap.calls[0].jsonBody!.image_url, 'https://fake.storage/media/a.png');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/fal_image_test.ts
```

Expected: FAIL — the first test reports identical payloads for 1MP and 4MP.

- [ ] **Step 3: Wire the normalized request into the fal image branch**

In `fal.ts`, change `slugFor` so the two normalized families read their slug from the normalized request:

```ts
/** familyId (+ op/reference) → fal model slug. */
function slugFor(ctx: SubmitCtx): string {
  if (VIDEO_FAMILIES.has(ctx.familyId)) return videoSlugFor(ctx);
  if (ctx.familyId === 'upscaler' || ctx.op === 'upscale') return 'fal-ai/clarity-upscaler';
  if (ctx.familyId === 'edit-bg') return 'fal-ai/birefnet/v2';
  if (FILL_TOOLS.includes(ctx.familyId)) return 'fal-ai/flux-pro/v1/fill';
  if (ctx.familyId === 'persona') return 'fal-ai/flux-lora';
  // flux and seedream carry their slug on the normalized request, so the model
  // the customer was quoted is the model that gets called.
  if (ctx.familyId === 'flux' || ctx.familyId === 'seedream') {
    if (!ctx.normalized) throw new Error(`fal: normalized request is required for ${ctx.familyId}`);
    return ctx.normalized.providerModel;
  }
  throw new Error(`fal: no slug for ${ctx.familyId}`);
}
```

Replace the final block of `payloadFor` (currently lines 109–117) with:

```ts
  if (!ctx.normalized) throw new Error(`fal: normalized request is required for ${ctx.familyId}`);
  // Every axis the customer paid for, spelled the way the record verified.
  const body: Record<string, unknown> = { prompt: ctx.prompt, ...ctx.normalized.providerSettings };
  if (ctx.referenceUrl) {
    // Seedream's edit endpoint takes a list of reference images; others take one.
    if (ctx.familyId === 'seedream') body.image_urls = [ctx.referenceUrl];
    else body.image_url = ctx.referenceUrl;
  }
  return body;
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/fal_image_test.ts
```

Expected: `6 passed | 0 failed`. User commits.

---

## Task 5: Google adapter — keep the control honest

**Files:**
- Modify: `supabase/functions/_shared/providers/google.ts`
- Create: `supabase/functions/_shared/providers/google_test.ts`

**Interfaces:**
- Consumes: `NormalizedRequest`.
- Produces: `google.ts` reads `providerModel` and `providerSettings` instead of its own `modelFor`.

Nano Banana already behaves correctly. Moving it onto the same seam means a future catalog change cannot break it silently, and its tests become the positive control every other adapter test is measured against.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/providers/google_test.ts`:

```ts
import { assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert';
import { familyById } from '../model-families.ts';
import { normalizeGenerationRequest } from '../generation-request.ts';
import { googleAdapter } from './google.ts';
import { TINY_PNG_B64, captureFetch } from './testing/capture.ts';
import type { SubmitCtx } from './types.ts';

function ctx(settings: Record<string, unknown>, over: Partial<SubmitCtx> = {}): SubmitCtx {
  const family = familyById('nano-banana')!;
  const op = String(over.op ?? 'generate');
  return {
    familyId: 'nano-banana', op, prompt: 'a red square', settings, safetyId: 'sha-test',
    normalized: normalizeGenerationRequest(family, op, settings as never, {
      hasReference: !!over.referenceUrl, hasMask: false,
    }),
    ...over,
  } as SubmitCtx;
}

function respondImage(): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: TINY_PNG_B64 } }] } }],
    }),
    { status: 200 },
  );
}

Deno.test('each version calls a different model url', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await googleAdapter.submit(ctx({ aspectRatio: '1:1', version: 'fast', resolution: '1K' }));
  await googleAdapter.submit(ctx({ aspectRatio: '1:1', version: 'pro', resolution: '1K' }));
  cap.restore();
  assertNotEquals(cap.calls[0].url, cap.calls[1].url);
  assertEquals(cap.calls[0].url.includes('gemini-2.5-flash-image'), true);
  assertEquals(cap.calls[1].url.includes('gemini-3-pro-image'), true);
});

Deno.test('resolution and aspect ratio travel in imageConfig', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(respondImage);
  await googleAdapter.submit(ctx({ aspectRatio: '16:9', version: 'standard', resolution: '4K' }));
  cap.restore();
  const config = (cap.calls[0].jsonBody!.generationConfig as Record<string, unknown>);
  assertEquals(config.imageConfig, { image_size: '4K', aspect_ratio: '16:9' });
});

Deno.test('a reference is sent inline on generate', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch((call) =>
    call.url.includes('generativelanguage')
      ? respondImage()
      : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })
  );
  await googleAdapter.submit(
    ctx({ aspectRatio: '1:1', version: 'standard', resolution: '1K' }, {
      op: 'generate', referenceUrl: 'https://fake.storage/uploads/u/1.png',
    }),
  );
  cap.restore();
  const apiCall = cap.calls.find((c) => c.url.includes('generativelanguage'))!;
  const parts = (apiCall.jsonBody!.contents as { parts: Record<string, unknown>[] }[])[0].parts;
  assertEquals(parts.length, 2);
  assertEquals(typeof parts[1].inline_data, 'object');
});

Deno.test('a response with no image throws rather than storing nothing', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  const cap = captureFetch(() => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
  await assertRejects(
    () => googleAdapter.submit(ctx({ aspectRatio: '1:1', version: 'standard', resolution: '1K' })),
    Error,
    'no image',
  );
  cap.restore();
});

Deno.test('a context with no normalized request is refused', async () => {
  Deno.env.set('GOOGLE_AI_API_KEY', 'test-key');
  await assertRejects(
    () =>
      googleAdapter.submit({
        familyId: 'nano-banana', op: 'generate', prompt: 'x',
        settings: { aspectRatio: '1:1' }, safetyId: 'sha-test',
      } as SubmitCtx),
    Error,
    'normalized',
  );
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers/google_test.ts
```

Expected: FAIL — the last test passes a context with no `normalized` and `google.ts` happily defaults to `standard`.

- [ ] **Step 3: Move `google.ts` onto the normalized request**

Delete `modelFor` (lines 7–13) and replace the top of `submit`:

```ts
  async submit(ctx: SubmitCtx) {
    const n = ctx.normalized;
    if (!n) throw new Error('google: normalized request is required');
    const model = n.providerModel;
    const parts: unknown[] = [{ text: ctx.prompt }];
    const ref = await referenceInline(ctx.referenceUrl);
    if (ref) parts.push(ref);

    // Exactly the axes the quote was computed from — no re-derivation here.
    const imageConfig = n.providerSettings;
```

and the request body:

```ts
        generationConfig: {
          responseModalities: ['IMAGE'],
          ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
        },
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all _shared/providers
```

Expected: every provider test file passes, including the existing video adapter tests. User commits.

---

## Task 6: The gateway quotes what it will send, and the catalog stops overselling

**Files:**
- Modify: `supabase/functions/api/app.ts` (`POST /generations`), `src/app/core/catalog/model-families.ts`
- Create: `supabase/functions/api/quote_contract_test.ts`

**Interfaces:**
- Consumes: `normalizeGenerationRequest`, `quote` (Task 2); `validateSettings` (P1 Task 8).
- Produces: the gateway builds one `NormalizedRequest` per item, prices from it, stores `quoteVersion` and `catalogVersion` in `generations.settings`, and passes it to `submit`.

- [ ] **Step 1: Apply the Task 1 removals to the catalog**

For every row the Task 1 Decisions table marks **remove**, delete the option from `src/app/core/catalog/model-families.ts` and update the family's `providerCost` so the removed axis no longer appears in it. Bump `CATALOG_VERSION` to `2026-09-20.2`. Then:

```bash
cd /Users/user/IdeaProjects/vansen && npm run sync-shared && npm test -- --watch=false
```

Expected: the catalog drift spec passes. Any vitest failure here names a component that offered a removed option — fix the component, not the catalog.

Two specific corrections the review identified, applied regardless of what else the record says:

1. The FLUX family's `blurb` reads `'FLUX.2 [pro] — photoreal detail, priced per megapixel.'` while `slugFor` calls `fal-ai/flux-pro/v1.1`. Make the blurb name the model that is actually called, or change the slug. They cannot both stand.
2. Seedream's `providerCost` is `() => 0.03` flat while the family sells three resolutions. If the record did not verify a real resolution parameter, delete the `resolutions` array from the seedream family.

- [ ] **Step 2: Write the failing gateway test**

Create `supabase/functions/api/quote_contract_test.ts`:

```ts
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, TEST_USER, fakeAdapter, testDeps } from './testing/fakes.ts';
import { familyById } from './_shared/model-families.ts';
import { CATALOG_VERSION } from './_shared/model-families.ts';

const AUTH = { authorization: 'Bearer test-token' };

function ready(db: FakeDb, familyId: string) {
  db.tables.subscriptions = [
    { user_id: TEST_USER, plan: 'pro', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ];
  db.tables.models = [{ id: familyId, enabled: true, min_plan: 'studio' }];
  db.rpcHandlers.fn_charge_and_generate = (args) =>
    (args.p_items as Record<string, unknown>[]).map((item, i) => ({
      id: `g${i}`, user_id: TEST_USER, kind: item.kind, family_id: item.familyId,
      family_name: item.familyName, op: item.op, prompt: item.prompt,
      settings: item.settings, price_credits: item.priceCredits, status: 'pending', media_path: null,
    }));
}

async function submitOnce(familyId: string, settings: Record<string, unknown>) {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, familyId);
  const app = createApp(deps);
  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'generate', familyId, prompt: 'a cat', batch: 1, settings }),
  });
  const charge = db.rpcCalls.find((r) => r.name === 'fn_charge_and_generate')!;
  return { res, provider, charged: (charge.args.p_items as Record<string, unknown>[])[0] };
}

Deno.test('every selectable image combination charges what it sends', async () => {
  for (const familyId of ['nano-banana', 'gpt-image', 'flux', 'seedream']) {
    const caps = familyById(familyId)!.capabilities;
    const seen = new Map<string, number>();
    for (const version of caps.versions?.map((v) => v.value) ?? [undefined]) {
      for (const resolution of caps.resolutions?.map((r) => r.value) ?? [undefined]) {
        for (const quality of caps.qualities?.map((q) => q.value) ?? [undefined]) {
          const { res, provider, charged } = await submitOnce(familyId, {
            aspectRatio: caps.aspectRatios[0], version, resolution, quality,
          });
          assertEquals(res.status, 200, `${familyId} ${version}/${resolution}/${quality}`);
          const sent = provider.submits[0].normalized!;
          const key = JSON.stringify({ m: sent.providerModel, s: sent.providerSettings });
          const price = Number(charged.priceCredits);
          const before = seen.get(key);
          // Two identical provider requests must never carry two prices.
          if (before !== undefined) {
            assertEquals(before, price, `${familyId}: same request, two prices (${key})`);
          }
          seen.set(key, price);
        }
      }
    }
  }
});

Deno.test('the stored settings record the quote and catalog versions', async () => {
  const { charged } = await submitOnce('flux', { aspectRatio: '1:1', resolution: '1MP' });
  const settings = charged.settings as Record<string, unknown>;
  assertEquals(settings.quoteVersion, 1);
  assertEquals(settings.catalogVersion, CATALOG_VERSION);
});

Deno.test('the adapter receives the same normalized request the price came from', async () => {
  const { provider, charged } = await submitOnce('nano-banana', {
    aspectRatio: '1:1', version: 'pro', resolution: '4K',
  });
  const sent = provider.submits[0].normalized!;
  assertEquals(sent.providerModel, 'gemini-3-pro-image');
  assertEquals(sent.providerSettings.image_size, '4K');
  assertEquals(Number(charged.priceCredits) > 0, true);
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno test --allow-all api/quote_contract_test.ts
```

Expected: FAIL — `provider.submits[0].normalized` is `undefined`; the gateway does not build one.

- [ ] **Step 4: Wire normalize + quote into `POST /generations`**

In `app.ts`, add the import:

```ts
import { normalizeGenerationRequest, quote } from './_shared/generation-request.ts';
```

In the catalog-family branch, replace the `creditCost(family, settings)` call with a normalized request built **after** `validateSettings` (P1 Task 8) and **after** the reference is resolved, so `hasReference` is accurate:

```ts
      const invalid = validateSettings(family, settings);
      if (invalid) {
        return fail(c, 400, 'invalid_settings', `${family.name} does not offer ${invalid.field} ${invalid.value}.`);
      }
      // One object describes the price AND the request. Deriving them apart is
      // how a 73-credit charge came to send a 28-credit request.
      normalized = normalizeGenerationRequest(family, op, settings, {
        hasReference: !!referenceUrl,
        hasMask: !!maskPngBase64,
      });
      const priced = quote(normalized, family);
      priceCredits = priced.credits;
      providerCostUsd = priced.providerCostUsd;
```

Store the versions alongside the settings on the charge item:

```ts
        settings: { ...settings, quoteVersion: normalized.quoteVersion, catalogVersion: normalized.catalogVersion },
```

And pass it to the adapter at the `submit` call site:

```ts
      const submitCtx: SubmitCtx = {
        familyId, op, prompt: effectivePrompt, settings,
        normalized,
        referenceUrl, maskPngBase64, loraUrl,
        safetyId: safetyId(userId),
        mode, referenceUrls, parentVideoUrl, interactionId,
      };
```

- [ ] **Step 5: Run every suite**

```bash
cd /Users/user/IdeaProjects/vansen/supabase/functions && deno check api/index.ts api/app.ts && deno test --allow-all _shared api stripe-webhook appstore-webhook
```

Expected: `~160 passed | 0 failed` — the exact number depends on how many combinations survive the Task 1 removals. Record the number in the commit message.

- [ ] **Step 6: Angular suite and build**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build
```

Expected: vitest green, build succeeds. User commits.

---

## Task 7: Catalog version guard and the Dart export

**Files:**
- Create: `scripts/export-catalog.mjs`, `src/app/core/catalog/catalog-version.spec.ts`
- Modify: `scripts/sync-shared.mjs`, `package.json`

**Interfaces:**
- Produces: `npm run export-catalog` writes `dist/catalog/catalog.json` and `dist/catalog/model_catalog_fixture.dart`. The mobile repo copies the Dart file in; its **MT-03** test asserts the Flutter catalog matches it.

- [ ] **Step 1: Write the failing version-guard spec**

Create `src/app/core/catalog/catalog-version.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, MODEL_FAMILIES, EDIT_TOOLS, CREDIT_PACKS, PLAN_CREDITS } from './model-families';

/**
 * The catalog version is a promise to two other codebases: the Deno `_shared`
 * copy and the Flutter fixture. This fingerprint fails whenever the catalog's
 * shape changes without a bump, so a silent divergence becomes a red test on
 * the machine that caused it.
 */
function fingerprint(): string {
  const shape = {
    families: MODEL_FAMILIES.map((f) => ({
      id: f.id,
      kind: f.kind,
      versions: f.capabilities.versions?.map((v) => v.value) ?? null,
      resolutions: f.capabilities.resolutions?.map((r) => r.value) ?? null,
      qualities: f.capabilities.qualities?.map((q) => q.value) ?? null,
      aspectRatios: f.capabilities.aspectRatios,
      durations: f.capabilities.durations ?? null,
      modes: f.capabilities.modes ?? null,
      imageInput: f.capabilities.imageInput,
      maskInput: f.capabilities.maskInput,
    })),
    editTools: EDIT_TOOLS.map((t) => ({ id: t.id, credits: t.credits })),
    packs: CREDIT_PACKS,
    planCredits: PLAN_CREDITS,
  };
  let hash = 0;
  const json = JSON.stringify(shape);
  for (let i = 0; i < json.length; i += 1) {
    hash = (hash * 31 + json.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}

describe('catalog version', () => {
  it('matches the recorded fingerprint — bump CATALOG_VERSION and this value together', () => {
    // When this fails: you changed the catalog. Bump CATALOG_VERSION, re-run
    // `npm run sync-shared` and `npm run export-catalog`, hand the new Dart
    // fixture to the mobile repo, then paste the new fingerprint here.
    expect({ version: CATALOG_VERSION, fingerprint: fingerprint() }).toEqual({
      version: '2026-09-20.2',
      fingerprint: '<paste the value this test prints on first run>',
    });
  });
});
```

- [ ] **Step 2: Run it, read the actual fingerprint, paste it in**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false 2>&1 | grep -A6 "catalog version"
```

The failure prints the received object. Paste its `fingerprint` into the expectation and re-run.

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false
```

Expected: green.

- [ ] **Step 3: Write the export script**

Create `scripts/export-catalog.mjs`:

```js
// Emits the versioned catalog for consumers outside this repo: a JSON document
// for tooling and a Dart fixture the Flutter app's test pins itself against.
// The Angular TypeScript file stays the single master; this only reads it.
//
//   npm run export-catalog
//
// The Dart file is a FIXTURE, not an implementation: the mobile app keeps its
// own catalog, and its test asserts the two agree. A mismatch there means the
// phone would price or offer something the server does not.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'catalog');

const { CATALOG_VERSION, MODEL_FAMILIES, EDIT_TOOLS, CREDIT_PACKS, PLAN_CREDITS, STUDIO_MARGIN } =
  await import(join(root, 'src/app/core/catalog/model-families.ts'));

const catalog = {
  catalogVersion: CATALOG_VERSION,
  studioMargin: STUDIO_MARGIN,
  planCredits: PLAN_CREDITS,
  packs: CREDIT_PACKS,
  editTools: EDIT_TOOLS.map((t) => ({ id: t.id, name: t.name, credits: t.credits })),
  families: MODEL_FAMILIES.map((f) => ({
    id: f.id,
    name: f.name,
    kind: f.kind,
    provider: f.provider,
    capabilities: {
      versions: f.capabilities.versions?.map((v) => v.value) ?? null,
      resolutions: f.capabilities.resolutions?.map((r) => r.value) ?? null,
      qualities: f.capabilities.qualities?.map((q) => q.value) ?? null,
      aspectRatios: f.capabilities.aspectRatios,
      durations: f.capabilities.durations ?? null,
      modes: f.capabilities.modes ?? null,
      audio: f.capabilities.audio ?? null,
      imageInput: f.capabilities.imageInput,
      maskInput: f.capabilities.maskInput,
    },
  })),
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);

const dart = `// GENERATED by scripts/export-catalog.mjs in the vansen web repo.
// Do not edit. Regenerate and copy in whenever CATALOG_VERSION changes.
// ignore_for_file: prefer_single_quotes

const String kCatalogVersion = ${JSON.stringify(CATALOG_VERSION)};

const Map<String, dynamic> kCatalogFixture = ${JSON.stringify(catalog, null, 2)};
`;
writeFileSync(join(out, 'model_catalog_fixture.dart'), dart);

console.log(`catalog ${CATALOG_VERSION} written to dist/catalog/`);
```

Running a `.ts` file through `await import` needs a loader. Add the script to `package.json` with the project's existing TypeScript runner:

```json
    "export-catalog": "npx tsx scripts/export-catalog.mjs",
```

If `tsx` is not already a dependency, use `npx vite-node scripts/export-catalog.mjs` instead — `vite` is already present for the Angular build. Verify which one resolves before committing:

```bash
cd /Users/user/IdeaProjects/vansen && npx tsx --version || npx vite-node --version
```

- [ ] **Step 4: Run the export**

```bash
cd /Users/user/IdeaProjects/vansen && npm run export-catalog && cat dist/catalog/catalog.json | head -20 && ls -la dist/catalog/
```

Expected: both files exist and `catalogVersion` matches `CATALOG_VERSION`.

- [ ] **Step 5: Ignore the build output**

Add to `.gitignore` if `dist/` is not already ignored:

```
dist/catalog/
```

The Dart fixture is committed in the **mobile** repo, not this one.

- [ ] **Step 6: Final run of everything**

```bash
cd /Users/user/IdeaProjects/vansen && npm test -- --watch=false && npm run export-catalog && cd supabase/functions && deno test --allow-all _shared api stripe-webhook appstore-webhook
```

Expected: all green. User commits.

---

## Exit criteria for P3

- [ ] `docs/superpowers/specs/2026-09-20-provider-capability-record.md` exists with every row either verified against documentation **and** a live call, or explicitly removed from the catalog.
- [ ] No two selectable combinations of any image family produce the same provider request at two different prices — proven exhaustively by `api/quote_contract_test.ts`.
- [ ] The GPT Image version and resolution a customer picks appear in the outgoing request; so do FLUX's size and Seedream's slug.
- [ ] An uploaded reference on `op = generate` reaches OpenAI (edits endpoint), Google (inline part) and fal (`image_url` / `image_urls`) — completing R28 across all four image families.
- [ ] Every image adapter refuses a `SubmitCtx` with no `normalized` request rather than guessing a model.
- [ ] `CATALOG_VERSION` is stored on every generation and fails a test if the catalog changes without a bump.
- [ ] `npm run export-catalog` produces a JSON document and a Dart fixture carrying that version.
- [ ] `npm test -- --watch=false` and `deno test --allow-all _shared api stripe-webhook appstore-webhook` are green; `npx ng build` succeeds.

**Known carry-forward:** video families and edit tools still map model and settings inside `fal.ts` / the video adapters rather than through `normalizeGenerationRequest`; P5 moves them as part of durable dispatch. `SubmitCtx.normalized` stays optional until then.
