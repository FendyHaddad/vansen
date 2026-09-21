# Provider capability record

Verified on: 2026-09-21 (documentation column)
Verified by: Claude — documentation half only. **Smoke column is UNVERIFIED and
must be filled by the user with the project's own API keys before any catalog
change in P3 Tasks 3–6.**

Every row is a claim the Vansen catalog makes to a paying customer. A row is
**verified** only when both columns are filled from a primary source: the
provider's current official documentation, and a live call on the Vansen
account that produced an output matching the claim. An unverified row is
removed from the catalog, not shipped with a caveat.

Sources read 2026-09-21:
- OpenAI API reference, `POST /images/generations` — developers.openai.com
- fal model API pages for `fal-ai/flux-pro/v1.1`, `fal-ai/flux-2`,
  `fal-ai/bytedance/seedream/v4/text-to-image`
- Google Gemini API image generation guide — ai.google.dev

---

## Cross-cutting finding: fal image families ignore `aspect_ratio`

`payloadFor` in `supabase/functions/_shared/providers/fal.ts:112` sends
`{ prompt, aspect_ratio }` for every non-persona image family. **No fal image
endpoint in this catalog accepts `aspect_ratio`.** FLUX 1.1 [pro], FLUX.2 and
Seedream v4 all take `image_size` (a preset enum or a `{width, height}` object).
An unrecognised key is dropped silently, so every FLUX and Seedream generation
has been produced at the endpoint default, regardless of the aspect ratio the
customer chose.

This is wider than the defect the plan describes: the resolution axis is dead
**and so is the aspect-ratio axis**, on both fal image families.

---

## Nano Banana (Google Gemini) — the control

| Catalog option | Provider model / parameter | Doc | Smoke result |
|---|---|---|---|
| version `fast` | `gemini-2.5-flash-image` — exists | ai.google.dev image-generation | |
| version `standard` | `gemini-3.1-flash-image` — exists | same | |
| version `pro` | `gemini-3-pro-image` — exists | same | |
| resolution `1K`/`2K`/`4K` | `imageConfig.image_size`, uppercase K. 3.1-flash: 512px/1K/2K/4K; 3-pro: 1K/2K/4K; 2.5-flash: 1K/2K/4K | same | |
| aspectRatio | `imageConfig.aspect_ratio` — 1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 | same | |
| reference image | `contents[].parts[].inline_data` — up to 14 refs on newer models | same | |

**Control holds.** All three model ids are real and both axes are real
parameters, which is why `google.ts` is the only adapter that honours them.

Two copy defects found in passing (P8, not this plan):
- The `fast` tooltip says 2.5-flash-image is "~1K output only". Docs say it
  supports 1K/2K/4K.
- `gemini-3.1-flash-lite-image` exists and is not in the catalog.

---

## GPT Image (OpenAI)

| Catalog option | Provider model / parameter | Doc | Smoke result |
|---|---|---|---|
| version `1` | `gpt-image-1` — exists | developers.openai.com `/images/generations` | |
| version `1.5` | `gpt-image-1.5` — **exists** | same | |
| version `2` | `gpt-image-2` — **exists** (also `gpt-image-2-2026-04-21`) | same | |
| resolution `1K` | `size: "1024x1024"` — supported by all GPT image models | same | |
| resolution `2K` (claimed v2-only) | `size` accepts arbitrary `WIDTHxHEIGHT` on gpt-image-2+ only. Both dims divisible by 16, AR between 1:3 and 3:1 | same | |
| resolution `4K` (claimed v2-only, 2.05× price) | same mechanism. **Max supported is 3840x2160**; above 2560x1440 is flagged experimental | same | |
| quality `low`/`medium`/`high` | `quality` — real, supported on all GPT image models | same | |
| reference image on **generate** | Not supported on `/images/generations`; a reference goes to `/images/edits` as `image` | same | |
| mask (`maskInput: true`) | `/v1/images/edits` `mask` — real | same | |

**Every GPT Image axis the catalog sells is real and wireable.** The defect is
entirely in the adapter: `openai.ts:11` hard-codes `const MODEL = 'gpt-image-1'`
and `sizeFor` reads only `aspectRatio`, so a customer paying the v2-at-4K price
(2.05× multiplier) receives a 1024px image from the oldest model.

Also note: the catalog tooltip says "up to 3840px", which matches the documented
3840x2160 ceiling only in the 16:9 direction. A 1:1 "4K" must be capped at
2160x2160 to stay inside the documented limit.

Newer models exist and are not in the catalog: `gpt-image-1-mini`,
`gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` (the 2.5 pair also add `xhigh`
and `max` quality levels).

---

## FLUX (fal / Black Forest Labs)

| Catalog option | Provider model / parameter | Doc | Smoke result |
|---|---|---|---|
| slug `fal-ai/flux-pro/v1.1` (what the code calls) | Real. Takes `image_size` = enum (`square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9`) or `{width, height}`. **No `aspect_ratio`. No megapixel parameter.** | fal.ai flux-pro/v1.1 api | |
| blurb claims "FLUX.2 [pro]" | `fal-ai/flux-2` is a **different, real** endpoint, priced **per megapixel** ($0.012/MP quoted on the model page). `image_size` = same preset enums or `{width, height}` in **512–2048** px. No reference-image parameter on this endpoint | fal.ai flux-2 api | |
| resolution `1MP`/`2MP`/`4MP` | Not a parameter on either endpoint. Achievable only via `image_size: {width, height}` — and on `flux-2` the 512–2048 ceiling puts 4MP at exactly 2048×2048 | both pages | |
| aspectRatio | **Not accepted by either endpoint.** Must be expressed through `image_size` | both pages | |
| reference image | `image_url` is not in the documented `flux-2` schema; v1.1 has no reference either. A reference needs a different slug (kontext / image-to-image variant) | both pages | |

**The catalog sells a model the code does not call.** The blurb, the per-megapixel
price story and the MP axis all describe FLUX.2; the adapter calls FLUX 1.1 [pro]
and sends it a parameter it does not accept.

---

## Seedream (fal / ByteDance)

| Catalog option | Provider model / parameter | Doc | Smoke result |
|---|---|---|---|
| slug `fal-ai/bytedance/seedream/v4/text-to-image` | Real | fal.ai seedream v4 api | |
| resolution `1K`/`2K`/`4K` | **Wireable**: `image_size` accepts `auto`, `auto_2K`, `auto_4K` plus the preset enums, or `{width, height}`. Total pixels must be between 960×960 and 4096×4096 | same | |
| flat $0.03 at every resolution | Not stated on the model page; **must be confirmed by smoke**, since 4K output at a flat rate is the assumption the margin formula rests on | same | |
| aspectRatio | **Not accepted.** Same silent-drop as FLUX | same | |
| reference → `/edit` slug, `image_urls` | v4 is described as unified generation+editing; a separate `/edit` slug is not documented on this page. Needs confirming before the edit path is trusted | same | |

---

## Decisions

For each unverified row: **wire** (the parameter exists and the adapter will
send it) or **remove** (the option leaves the catalog for this release).

**Owner-approved 2026-09-21** for the two open questions: move FLUX to
`fal-ai/flux-2`, and drop the FLUX reference-image claim. The remaining rows stay
**provisional until the smoke column is filled** — an axis that a smoke cannot
prove reaches the provider and changes the output comes out of the catalog.

| Row | Proposed | Rationale |
|---|---|---|
| gpt-image version 1 / 1.5 / 2 | **wire** | All three model ids are real. Map `version` → `gpt-image-1` / `gpt-image-1.5` / `gpt-image-2`. |
| gpt-image resolution 1K/2K/4K | **wire** | `size` takes arbitrary WxH on v2+. Cap at the documented 3840×2160; compute WxH from aspect ratio and cap, both dims divisible by 16. Keep 2K/4K gated to v2. |
| gpt-image quality | **wire** (already sent) | Real parameter; already transmitted correctly. |
| gpt-image reference on generate | **remove** from generate | `/images/generations` has no reference input. Either route a reference to `/images/edits` or stop advertising it on generate. Carry-forward from P1. |
| flux — which endpoint | **APPROVED: move to `fal-ai/flux-2`** | Owner decision 2026-09-21. This is what the blurb and the per-megapixel price story already describe. `slugFor` in `fal.ts` changes with it. |
| flux resolution 1MP/2MP/4MP | **wire via `image_size: {width,height}`** | 512–2048 ceiling means 4MP = 2048×2048 exactly; 1MP = 1024×1024; 2MP = 1448×1448. Dimensions derive from the chosen aspect ratio at the target megapixel count, clamped to 512–2048. |
| flux aspectRatio | **wire via `image_size`** | Currently dead on both endpoints. Derive WxH from ratio × target megapixels. |
| flux provider cost | **re-derived — OWNER WANTS THIS REVISITED** | Catalog assumes $0.03/$0.06/$0.12. FLUX.2 quotes $0.012/MP → $0.012/$0.024/$0.048. The margin formula is being fed a cost ~2.5× too high. |
| flux reference image | **APPROVED: remove** | Owner decision 2026-09-21. `fal-ai/flux-2` documents no reference parameter, so `capabilities.imageInput` becomes `false` for FLUX and the composer stops offering a reference on that family. P8 owns the copy change. |
| seedream resolution 1K/2K/4K | **wire** | `auto_2K` / `auto_4K` are real enum values. |
| seedream aspectRatio | **wire via `image_size`** | Currently dead. |
| seedream flat $0.03 | **confirm by smoke** | If 4K costs more, the flat cost is wrong and 4K is sold below cost. |
| nano-banana (all) | **keep as is** | Verified correct. Fix the `fast` tooltip copy in P8. |

---

## Smoke commands (Task 1 Step 3) — for the user to run

Run each against your own keys and paste the output. A resolution option is
verified only when **two different values produce two different output sizes**.

```bash
# 1. GPT Image — is gpt-image-2 real on this account, and does a 4K size come back 4K?
for SZ in 1024x1024 2048x2048; do
  curl -s https://api.openai.com/v1/images/generations \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"gpt-image-2\",\"prompt\":\"a red square\",\"size\":\"$SZ\",\"quality\":\"medium\",\"n\":1}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.error)return console.log("ERR",j.error.message);const b=Buffer.from(j.data[0].b64_json,"base64");require("fs").writeFileSync("/tmp/gpt.png",b);console.log("bytes",b.length)})'
  file /tmp/gpt.png
done
```

```bash
# 2. GPT Image — confirm gpt-image-1.5 is callable (distinct model, not an alias error).
curl -s https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-1.5","prompt":"a red square","size":"1024x1024","n":1}' \
  | head -c 300
```

```bash
# 3. FLUX.2 — does image_size change the output, and what does it cost?
curl -s -X POST https://queue.fal.run/fal-ai/flux-2 \
  -H "Authorization: Key $FAL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"a red square","image_size":{"width":1024,"height":1024}}'
# then the same with {"width":2048,"height":2048}
# Poll the returned status_url, download the result, and run `file` on both.
```

```bash
# 4. Seedream — does auto_4K differ from the 1K default, and does the price change?
curl -s -X POST https://queue.fal.run/fal-ai/bytedance/seedream/v4/text-to-image \
  -H "Authorization: Key $FAL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"a red square","image_size":"auto_4K"}'
# repeat with "image_size":"square_hd"; compare `file` output AND the billed amount
# on the fal dashboard for the two requests.
```

```bash
# 5. Nano Banana control — 2K must come back larger than 1K.
for SZ in 1K 2K; do
  curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent" \
    -H "x-goog-api-key: $GOOGLE_AI_API_KEY" -H 'Content-Type: application/json' \
    -d "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"a red square\"}]}],\"generationConfig\":{\"responseModalities\":[\"IMAGE\"],\"imageConfig\":{\"image_size\":\"$SZ\",\"aspect_ratio\":\"1:1\"}}}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const p=j.candidates?.[0]?.content?.parts?.find(x=>x.inlineData);if(!p)return console.log("ERR",JSON.stringify(j).slice(0,300));const b=Buffer.from(p.inlineData.data,"base64");require("fs").writeFileSync("/tmp/nb.png",b);console.log("bytes",b.length)})'
  file /tmp/nb.png
done
```

Paste the outputs here and the smoke column gets filled, the decisions get
finalised, and P3 Tasks 2–6 can proceed.


---

## OPEN: revisit the FLUX price before release

**Raised by the owner 2026-09-21.** P3 re-derived FLUX's provider cost from
fal's published $0.012/MP, on the assumption that the old flat
$0.03/$0.06/$0.12 tiers were a stale guess. **The owner believes those numbers
may have been deliberate** — a margin buffer, a different endpoint's rate, or a
negotiated price — not an error.

What the change did, so it can be judged or undone in one place:
- `providerCost` for `flux` now returns `FLUX_USD_PER_MP x actual megapixels`,
  using `FLUX_DIMS` in `src/app/core/catalog/model-families.ts`.
- 1MP square: 5 credits -> 3. "4MP" 16:9: 20 credits -> 5.
- Price now varies by aspect ratio within one resolution label, because the
  512-2048 clamp means only 1:1 reaches 4MP.

To restore the old behaviour: set `providerCost` back to the flat
`{'1MP': 0.03, '2MP': 0.06, '4MP': 0.12}` table, revert the expectation in
`src/app/core/catalog/model-families.spec.ts`, bump `CATALOG_VERSION`, and
re-run `npm run sync-shared` + `npm run export-catalog`. The wiring work (the
request actually carrying the size) is independent and stays either way.

**Decide before the P9 release gate.**
