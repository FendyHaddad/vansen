# Catalog refresh — provider costs audited against published sources

Checked 2026-09-22. Every figure below was read from the provider's own page on
that date, and the source is named. Where I could not read a published figure I
have written **unverified** rather than an estimate — three earlier numbers in
this session turned out to be repeated from files instead of checked against the
running system, and that is the habit this document exists to break.

Our figures come from `providerCost` in `src/app/core/catalog/model-families.ts`
and the slugs from `supabase/functions/_shared/provider-capabilities.json`.

---

## 1. What we actually call

| Family | Provider | Model slug in our code |
|---|---|---|
| `nano-banana` | Google direct | `gemini-3.1-flash-image` (standard), `gemini-3-pro-image` (pro), `gemini-2.5-flash-image` (fast) |
| `gpt-image` | OpenAI direct | `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1` |
| `flux` | fal | `fal-ai/flux-2` |
| `seedream` | fal | `fal-ai/bytedance/seedream/v4/text-to-image` |
| `kling` | fal | `fal-ai/kling-video/v3/pro/*` |
| `seedance` | fal | `bytedance/seedance-2.5/*` |
| `veo`, `omni` | Google direct | — |
| `runway` | **nothing** | adapter exists; `RUNWAY_API_KEY` never set; family `enabled = false` |
| `upscaler`, `persona`, `edit-*` | fal | — |

## 2. Our cost versus the published cost

Source **G** = `https://ai.google.dev/gemini-api/docs/pricing`
Source **F** = the model's own page on `https://fal.ai/models/...`
Source **O** = `https://platform.openai.com/docs/guides/image-generation`

| Family / tier | Ours | Published | Src | |
|---|---|---|---|---|
| veo standard + audio, 720p/1080p | $0.40/s | $0.40/s | G | ✅ |
| veo standard + audio, 4K | $0.60/s | $0.60/s | G | ✅ |
| veo fast, 720p / 1080p / 4K | $0.10 / $0.12 / $0.30 | $0.10 / $0.12 / $0.30 | G | ✅ |
| veo lite, 720p / 1080p | $0.05 / $0.08 | $0.05 / $0.08 | G | ✅ |
| nano standard 1K / 2K / 4K | $0.067 / $0.101 / $0.151 | $0.067 / $0.101 / $0.151 | G | ✅ |
| nano pro 1K-2K / 4K | $0.134 / $0.24 | $0.134 / $0.24 | G | ✅ |
| nano fast | $0.039 | **model deprecated** | G | ⚠️ §3 |
| seedream | $0.03/image | "$0.03 per image" | F | ✅ |
| kling audio off / on / voice | $0.112 / $0.168 / $0.196 per s | $0.112 / $0.168 / $0.196 | F | ✅ |
| seedance 480p / 720p | $0.2205 / $0.4730 per s | $0.2205 / $0.4730 | F | ✅ |
| flux 1 / 2 / 4 MP | $0.03 / $0.06 / $0.12 | fal bills **$0.012 per megapixel** = $0.012 / $0.024 / $0.048 | F | ⚠️ §4 |
| gpt-image v2 low / med / high | $0.006 / $0.053 / $0.211 | OpenAI bills **per token**, not per image | O | ❓ §5 |
| upscaler, persona, `edit-*` | $0.04 / $0.035 / $2.00 / $0.05 | not checked | — | ❓ |

**Nine of eleven checkable values are exactly right.** Veo's nine-way rate
table, both current Nano Banana tiers, Seedream, Kling and Seedance match their
published rates to the last digit. Whoever built this table did it carefully.

## 3. Urgent: `nano-banana` fast points at a model Google shuts down on 2026-10-02

Google's pricing page carries this warning verbatim on `gemini-2.5-flash-image`:

> deprecated and will be shut down on October 2, 2026; migrate to Gemini 3.1
> Flash Image or Gemini 3.1 Flash Lite Image to avoid service disruption

That is **ten days from today**, and `nano-banana` is enabled in production. On
that date every request on the `fast` tier starts failing. The refund path will
catch it and customers will be made whole, but they will see a model that
simply stops working.

The fix is one line in `provider-capabilities.json`: repoint `fast` to
`gemini-3.1-flash-lite-image` (Nano Banana 2 Lite), then re-check its rate,
bump `CATALOG_VERSION`, `npm run sync-shared`, and redeploy `api`. **This should
happen before anything else in this document.**

## 4. FLUX: a deliberate 2.5× markup, not an error

fal's `fal-ai/flux-2` page states: "Your request will cost $0.012 per
megapixel." Our tiers charge as though the provider cost were $0.03/$0.06/$0.12
— 2.5× the real rate — and then apply the 40% margin on top of that.

This is **intentional and documented**: `provider-capabilities.json` says "fal
quotes $0.012 per megapixel on the flux-2 model page… Retail does NOT track it;
the flat tiers below are the deliberate price."

So it is not a defect. But it is exactly the decision the owner deferred on
2026-09-22, and it should be settled knowingly: at the true provider cost, a 1MP
FLUX image would be 2 credits instead of 5.

## 5. GPT Image: the one table whose shape is wrong

OpenAI no longer prices image models per image. `gpt-image-2.5-sunburst` and
`-flare` bill per token — $30.00/1M image output, $8.00/1M image input,
$5.00/1M text input — and the token count varies by quality and size. A flat
per-image table cannot express that.

Measured from OpenAI's own calculator, GPT Image 2.5 at 1024×1024:

| Quality | Output tokens | Cost |
|---|---|---|
| low | 196 | $0.00588 |
| medium | 439 | $0.01317 |
| high | 1,756 | $0.05268 |
| xhigh | 3,122 | $0.09366 |
| max | 7,024 | $0.21072 |

Our `gpt-image` v2 row reads $0.006 / $0.053 / $0.211 for low / medium / high.
Those are, to three decimal places, GPT Image **2.5's** low / **high** / **max**.
That may be coincidence, or our "medium" may be charging four times what medium
actually costs. **I could not load `gpt-image-2`'s own token table to settle it,
so this stays unverified.** It needs one real generation with `usage` read back
from the response — which is the only way to know, and costs about a cent.

Also: **GPT Image 2.5 exists and we do not offer it.** It is on OpenAI's own
pricing page, so no third party is involved.

## 6. Runway, compared honestly

Runway Dev is a **model router** reselling other providers at $0.01/credit
(`https://docs.dev.runwayml.com/guides/pricing/`). We have never had a key, so
none of this is in use.

| Model | Ours, direct | Runway | Verdict |
|---|---|---|---|
| Veo 3.1 standard + audio | $0.40/s (Google) | 40 cr/s = $0.40/s | identical |
| Veo 3.1 fast + audio | $0.10/s (Google) | 15 cr/s = $0.15/s | **Google 33% cheaper** |
| Gemini Omni Flash | $0.10/s, $0.15 at 1080p | 10 cr/s = $0.10/s flat | Runway cheaper at 1080p only |
| Nano Banana Pro 1K | $0.134 (Google) | `gemini_image3_pro` 20 cr = $0.20 | **Google 33% cheaper** |
| Seedream | $0.03 (fal, v4) | `seedream5_pro` 5 cr = $0.05 | fal cheaper (different version) |
| Kling 3.0 Pro | $0.112–0.196/s (fal) | not offered | fal only |
| Seedance 2.5 480p | $0.2205/s (fal) | 20 cr/s = $0.20/s | Runway 9% cheaper |
| Seedance 2.5 720p | $0.4730/s (fal) | 30 cr/s = $0.30/s | **Runway 37% cheaper** |
| Seedance 2.5 1080p | $1.164/s (fal) | 68 cr/s = $0.68/s | **Runway 42% cheaper** |

**Conclusion: do not switch.** Going direct beats the reseller everywhere except
Seedance. That single exception is real and large, and I cannot explain it —
a reseller undercutting its own supplier by 42% is either a subsidy, a different
underlying tier, or a difference in what "per second" counts (Runway bills
output seconds plus input and reference seconds, with an 80-credit minimum).
It would need a real invoice on both sides to settle, and it only matters if
video is ever switched on. Not worth acting on now.

## 7. What is genuinely missing from the catalog

| | Status |
|---|---|
| GPT Image 2.5 (`sunburst`, `flare`) | on OpenAI directly; we offer 2 / 1.5 / 1 |
| Seedance 2.5 at 1080p | fal sells it at $1.164/s; we expose only 480p and 720p |
| Sora 2 / Sora 2 Pro video | OpenAI, $0.10–$0.70/s; not offered |
| Seedream 5 | exists (seen on Runway's list); we are on v4 — **unverified on fal** |
| FLUX 3 | on fal, but its blurb describes a **video** model, not an image one — **unverified**, do not assume it replaces FLUX.2 |
| MiniMax H3 / H3 Max | **declined by the owner, 2026-09-22** |

## 8. Recommended order

1. **Repoint `nano-banana` fast off the deprecated model.** Ten days. Everything else can wait.
2. Read `usage` from one real `gpt-image-2` generation and fix that table from measurement.
3. Add GPT Image 2.5 as a version on the existing `gpt-image` family.
4. Settle the FLUX price knowingly (owner deferred).
5. Verify Seedream 5 and what FLUX 3 actually is before touching either.

---

## 9. Applied 2026-09-22

| Change | Detail |
|---|---|
| `nano-banana` **fast** repointed | `gemini-2.5-flash-image` → `gemini-3.1-flash-lite-image`; cost $0.039 → **$0.0336** (1120 tokens at $30/1M, Google's published figure). Averts the 2026-10-02 shutdown |
| `gpt-image` **1 removed** | owner decision; the offer is now 1.5, 2, 2.5 Flare, 2.5 Sunburst |
| `gpt-image` **2.5 added** | `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`, costs measured from OpenAI's calculator: low $0.00588, medium $0.01317, high $0.05268 |
| `CATALOG_VERSION` | `2026-09-21.1` → `2026-09-22.1`; fingerprint `-1059c67b` → `-43a774f1` |

### One thing that had to be fixed to do this safely

`FamilyOption.tag` was doing two jobs: it rendered the badge on the chip **and**
`defaultSettings` picked the option tagged exactly `'Latest'` as the default.
Labelling 2.5 as the latest model therefore silently moved every new generation
onto it — a model with no smoke behind it, on a family that is live.

The two meanings are now separate: `tag` is display only, and a new `isDefault`
flag chooses the default. 2.5 Flare carries the `Latest` badge because it is;
version `2` carries `isDefault` because it is the one that has actually run in
production. When someone smokes a 2.5 generation, move the flag.

### Still open after this change

- The `gpt-image` **2** and **1.5** cost rows remain unverified (§5). One real
  generation with `usage` read back settles them.
- The 2.5 models' **4K/2K size rule is assumed**, carried over from
  `gpt-image-2`. Smoke a non-1K request before trusting it.
- Nano Banana 2 Lite's published figure covers **1K only**. Our `fast` tier is
  documented as 1K-only and charges flat, so this is consistent — but if `fast`
  is ever allowed above 1K the rate must be rechecked.
- `npm run verify` is green, but **this does not reach customers until `api` is
  redeployed**, and the new Dart fixture must be handed to the mobile repo.

## 10. Two defects shipped with the 2.5 addition, fixed 2026-09-22 (catalog `2026-09-22.2`)

Adding two versions to a family exposed two places that named a version by hand
rather than reading the catalog. Both shipped to production in `2026-09-22.1`.

**The 2.5 models were sold at 1K only.** `LeftPanel.resolutionOptions` filtered
with `f.id === 'gpt-image' && version !== '2'`, a literal written when `2` was
the only version that could exceed 1K. GPT Image 2.5 Flare and Sunburst both
take arbitrary sizes to 3840×2160 — the server already knew this, because
`gptMaxResolution` in `_shared/provider-capabilities.json` was updated — so the
composer withheld a capability the API would have served.

The per-version ceiling is now catalog data (`capabilities.versionResolutions`,
keyed by version, absent meaning unrestricted). The same move retired the three
other literals in that method, for Nano Banana Fast and Veo Fast/Lite.

**A 4K render on a 2.5 model was priced as 1K.** `providerCost` read
`version === '2' && resolution === '4K' ? 2.05 : 1`, so the 2.05× area
multiplier did not apply to the new versions. Combined with the first defect
the money was not actually at risk — the tier could not be selected — but
either fix alone would have left a live underpriced path. The multiplier now
applies to every version except `1.5`, which cannot render 4K at all.

The 2.05× figure is version 2's, and its application to the 2.5 models is
**assumed, not measured**, for the same reason §5 lists: the one real
generation with `usage` read back has still not been run.

Tests added: `model-families.spec.ts` pins the 4K multiplier on 2.5 and the
`versionResolutions` shape; `left-panel.spec.ts` asserts 2K/4K are offered on
`2`, `2.5-flare` and `2.5-sunburst`, that `1.5` caps at 1K and drags a stale 4K
selection down with it, and that Nano Banana Fast is still capped.

## 11. GPT Image 2 really is 4x GPT Image 2.5 — verified, plus two defects found proving it

Source: OpenAI's own output-token calculator on
`platform.openai.com/docs/guides/image-generation`, section "GPT Image 2.5 and
GPT Image 2 output tokens", read 2026-09-22, driven directly. Pricing page
(`platform.openai.com/docs/pricing`, same day) gives the rate.

### The rate is identical; the token counts are not

| model | image output rate |
|---|---|
| gpt-image-2.5-sunburst | $30.00 / 1M |
| gpt-image-2.5-flare | $30.00 / 1M |
| gpt-image-2 | $30.00 / 1M |
| gpt-image-1.5 | $32.00 / 1M |

The guide states it plainly: "The models can use different token counts for the
same quality setting and share the same price per image output token."

At 1024x1024:

| quality | GPT Image 2 | GPT Image 2.5 |
|---|---|---|
| low | 196 tok = $0.00588 | 196 tok = $0.00588 |
| medium | 1,756 tok = $0.05268 | 439 tok = $0.01317 |
| high | 7,024 tok = $0.21072 | 1,756 tok = $0.05268 |

**Our catalog is correct to the cent.** `GPT_COST['2']` = 0.006 / 0.053 / 0.211
and `GPT_COST['2.5-*']` = 0.00588 / 0.01317 / 0.05268 both match. The '1.5' row
(0.009 / 0.034 / 0.133) also reconciles: the earlier-model token table
(272 / 1056 / 4160 at 1024x1024) at $32/1M gives 0.0087 / 0.0338 / 0.1331.

This **retracts** the claim in §5 that the '2' and '1.5' rows are unverified and
that the table's shape is wrong. All three rows are now verified. The apparent
"shift" — 2's medium equalling 2.5's high — is real and intended: GPT Image
2.5 **high** and GPT Image 2 **medium** are both exactly 1,756 tokens. 2.5 is
strictly better value at every label, which is worth knowing before deciding
which version `isDefault` should point at.

### Defect A: the 2K tier is charged at the 1K price

`providerCost` multiplies only when `resolution === '4K'`. Token count tracks
pixels, not our tier names, so 2K is sold at the 1K cost. Measured tokens
against what we actually charge (margin 0.4, version 2):

| cell | real cost | our retail | margin |
|---|---|---|---|
| 1:1 2K low | $0.0119 | $0.01 | **-19%** |
| 1:1 2K medium | $0.1070 | $0.09 | **-19%** |
| 1:1 2K high | $0.4282 | $0.36 | **-19%** |
| 16:9 1K high | $0.1136 | $0.36 | +68% |
| 16:9 2K high | $0.1695 | $0.36 | +53% |
| 1:1 4K high | $0.4607 | $0.73 | +37% |

Every 1:1 2K generation on `gpt-image` is sold below cost — up to **-$0.068
per image** at high. This is pre-existing, not introduced by the 2.5 addition:
the `=== '2' && '4K'` multiplier has been there since the family shipped.

The flat multiplier is wrong in both directions. Realised margin swings from
-19% to +68% across a grid we sell at three prices, because the 4K/1K token
ratio is 1.90x at 16:9, 2.02x at 4:3 and 2.19x at 1:1 — not the 2.05x the code
applies everywhere.

### Defect B: two sizes we send are below OpenAI's minimum

The calculator refuses `1024x576` and `576x1024` with "Pixel budget must be at
least 655,360 pixels, inclusive." Both are 589,824 px. They are
`gptSizes['16:9:1K']` and `gptSizes['9:16:1K']` in
`_shared/provider-capabilities.json` — the sizes we send for an ordinary
16:9-at-1K request on the default version of a live family.

`1280x720` (921,600 px) is the smallest 16:9 pair that clears the floor and
keeps both edges divisible by 16; `720x1280` mirrors it. Measured tokens there:
106 / 947 / 3,787.

**Not yet observed against the live API.** This is a documentation finding: the
published rule says the size is invalid, and we have not made a real call to
see whether the endpoint enforces it. One 16:9 1K generation settles it.

### Recommended fix

Replace the multiplier with a measured token table keyed `aspectRatio:resolution`
per version — the shape `FLUX_DIMS` already uses, for the same reason: price
and request then come from one table and cannot drift. Both defects close
together, because the invalid sizes stop being expressible.

Deliberately not applied here: this changes live retail prices, which is the
owner's call, alongside the FLUX price decision.

## 12. Applied 2026-09-22 — catalog `2026-09-22.3`

Both §11 defects are fixed, and GPT Image 2.5's two extra quality settings are
now offered.

### Price is a measured token table, not a multiplier

`GPT_COST` and the `2.05x at 4K` rule are gone. `GPT_TOKENS` holds the image
output tokens for all fifteen `aspectRatio:resolution` cells at the five
quality steps OpenAI bills, read off its calculator one size at a time.
`GPT_QUALITY_STEP` says which steps each version's labels select — GPT Image 2
samples the same ladder at steps 0, 2 and 4, verified cell by cell rather than
assumed. `GPT15_TOKENS` is separate: a different generation, a different rate
($32/1M), and only three standard sizes.

An unknown version or quality now falls back to the **dearest** step, not the
cheapest. A bug upstream should not become a discount.

Retail moves both ways: **24 of 45 cells get cheaper, 11 get dearer.** The
cheapest cells were the overcharged ones (16:9 1K high drops 36 -> 19 credits);
the dearest were at or below cost (1:1 2K high goes 36 -> 72, which is what it
always cost us).

### xhigh and max, on the 2.5 models only

New `capabilities.versionQualities`, the same contract as `versionResolutions`.
`qualitiesFor(family, version)` joins `resolutionsFor(family, ratio, version)`
as a catalog helper, and **the composer and `validateSettings` both call them**,
so a chip that is hidden is also a request that is refused — before the charge,
not after the provider rejects it.

### The undersized sizes

`gptSizes['16:9:1K']` 1024x576 -> **1280x720** and `['9:16:1K']` 576x1024 ->
**720x1280**.

### Tests that would have caught all of this

- `generation-request_test.ts` now walks **every** entry in `gptSizes` and
  `gptStandardSizes` and asserts the four published rules, including the
  655,360 px floor. The old table had no test that compared it to the rules.
- `request-validation_test.ts` enumerated the family-wide option lists, which
  is precisely why it stayed green while 2.5 shipped at 1K only. It now
  enumerates **per version**, and separately asserts that xhigh/max on version
  2 and 2K/4K on 1.5 are refused.
- `model-families.spec.ts` pins the token arithmetic, the one-notch offset
  between the two ladders, that 2K costs more than 1K, and that an unknown
  quality is not priced as the cheapest.
- `left-panel.spec.ts` covers the chips and the clamp both ways.

### Still owed

The 655,360 px floor is still a documentation finding. No 16:9 1K generation
has been run against the live API, before or after the fix, so nothing here
proves the old size actually failed — only that it violated the published rule.
