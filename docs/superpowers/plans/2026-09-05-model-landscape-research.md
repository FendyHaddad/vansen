# Model landscape research — 2026-09-05

Sources: ai.google.dev model list + pricing + omni docs, developers.openai.com models +
video guide, fal.ai model gallery + endpoint pages, docs.dev.runwayml.com models + pricing.
Kling official API docs are JS-rendered and would not fetch; Kling data is from fal.

## Video

| Model | Provider | Access | Price (USD/s) | Duration | Res | Audio | Notes |
|---|---|---|---|---|---|---|---|
| **Gemini Omni Flash 1.1** `gemini-omni-1.1-flash` | Google | Gemini Interactions API (preview); also fal `google/gemini-omni-flash/v1.1/*` | 0.03 (360p) / 0.10 (720p) / 0.15 (1080p) / 0.30 (4K) | 3–10 s, extend to 40 s | 360p–4K | native | Conversational multi-turn edit (`previous_interaction_id`), extend, keyframe, reference-to-video. Not `generateContent`. |
| Veo 3.1 `veo-3.1-generate-preview` | Google | Gemini API | 0.40 (720/1080p) / 0.60 (4K) | 4/6/8 | up to 4K | native | Already in catalog. |
| Veo 3.1 Fast | Google | Gemini API | 0.10 (720p) / 0.12 (1080p) / 0.30 (4K) | 4/6/8 | up to 4K | native | Catalog says 720p/1080p only, flat 0.10 — stale. |
| **Veo 3.1 Lite** `veo-3.1-lite-generate-preview` | Google | Gemini API | 0.05 (720p) / 0.08 (1080p) | — | 720/1080p | native | New budget tier. |
| Sora 2 / Sora 2 Pro | OpenAI | OpenAI API | not shown on page (prior: 0.10 / 0.30 / 0.50) | 4/8/12 + 16/20; extend to 120 s | 720p; 1080p Pro | yes | `input_reference` = image-to-video. Remix → edits endpoint. |
| **Kling 3.0 Pro** | Kuaishou | fal `fal-ai/kling-video/v3/pro/{text,image}-to-video` | 0.112 (no audio) / 0.168 (audio) / 0.196 (voice) | 3–15 s | AR from start image | native | Multi-prompt, elements, end frame. Catalog is 2.5 Turbo Pro @ 0.07 — stale. |
| Kling O3 Native 4K | Kuaishou | fal `fal-ai/kling-video/o3/4k/video-to-video/*` | 0.42 | — | native 4K | — | Video-to-video only; skip. |
| **Seedance 2.5** | ByteDance | fal `bytedance/seedance-2.5/{text,image,reference}-to-video`; Runway `seedance2` | 0.2205 (480p) / 0.473 (720p) | 4–30 s single shot | 480/720p | native, lip-sync | Catalog is Seedance 1.0 Pro 720/1080p @ 0.054/0.124 — stale, and 2.5 is 4–9× dearer. |
| Runway Gen-4.5 `gen4.5` | Runway | Runway API ($0.01/credit) | 0.12 | 5/10 | — | — | Matches catalog. HDR/ProRes outputs. |
| Runway Aleph 2 `aleph2` | Runway | Runway API | ≥0.28 | — | — | — | Video-to-video edit; skip for launch. |
| Wan 3.0 Prime | Alibaba | fal `alibaba/wan-3.0-prime/*` | 0.068 / 0.14 / 0.28 | ≤30 s | 480–1080p | yes | Cheap mid-tier. |
| MiniMax H3 Max / Turbo | MiniMax | fal `minimax/h3-max/*` | 0.05 (480p) / 0.08 (768p) list; 75% promo to Sep 7 | adjustable | 480/768p | yes | Cheapest; 2K on plain H3. |
| Grok Imagine Video 1.5 | xAI | fal `xai/grok-imagine-video/v1.5/*` | 0.08 / 0.14 / 0.25 | flexible | 480–1080p | yes | Charged even when refused by xAI ToS. |
| FLUX 3 (video) | BFL | fal `blackforestlabs/flux-3/image-to-video` | 0.17 (720p) / 0.29 (1080p) | auto | 720/1080p | none listed | Image-to-video only. |
| LTX-2.5 fast | Lightricks | fal | — | — | — | — | Not fetched. |

## Image

| Model | Provider | Access | Price/image | Res | Notes |
|---|---|---|---|---|---|
| Nano Banana 2 `gemini-3.1-flash-image` | Google | Gemini API | 0.045 (512) / 0.067 (1K) / 0.101 (2K) / 0.151 (4K) | ≤4K | In catalog as "Latest". |
| **Nano Banana 2 Lite** `gemini-3.1-flash-lite-image` | Google | Gemini API | ~0.034 (1K) | — | New; cheaper than 2.5-flash-image (0.039). Swap for "Fast" tier? |
| Nano Banana Pro `gemini-3-pro-image` | Google | Gemini API | 0.134 (1K/2K) / 0.24 (4K) | ≤4K | In catalog. |
| Imagen 4 | Google | — | — | — | Deprecated. |
| GPT Image 2 `gpt-image-2` | OpenAI | OpenAI API; fal | 0.006–0.401 by res×quality | ≤3840×2160 | In catalog. fal shows 1920×1080 / 2560×1440 / 3840×2160 tiers we do not expose. |
| **Seedream 5.0 Pro** | ByteDance | fal `bytedance/seedream/v5/pro/*` | 0.0675 (≤1536²) / 0.135 (≤2048²) | ≤2K, no 4K | Catalog is 4.0 @ 0.03 flat with 4K option — stale. Also 5.0 Lite, 4.5. |
| FLUX.2 [pro] | BFL | fal | per MP | — | In catalog. No FLUX 3 text-to-image seen on fal gallery. |
| Meta Muse Image | Meta | fal `meta/muse-image/*`; Runway | 0.01 | 2048×1152 | New, cheap, text/QR accurate. |
| Qwen Image 3 | Alibaba | fal | — | — | Not fetched. |
| Recraft V4 Style / Pro | Recraft | fal | — | — | Vector-capable. |
| Bria FIBO Gen/Edit 1.5 | Bria | fal | — | — | Bria = license-banned in our engine policy (RMBG); API use is separate but skip. |
| Grok Imagine Pro (image) | xAI | fal; Runway | — | — | — |
| Krea 2 Turbo | Krea | fal | — | — | — |

## Decisions (2026-09-05, user)

- **Video — not interested:** Wan 3.0 Prime, MiniMax H3 Max, Grok Imagine 1.5, FLUX 3 video.
- **Image — not interested:** Imagen 4 (deprecated anyway), Bria FIBO (license-banned vendor), Meta Muse Image.
- **Nano Banana fast tier:** swap `gemini-2.5-flash-image` → `gemini-3.1-flash-lite-image`
  (Nano Banana 2 Lite). Google marks 2.5 Flash Image as legacy and "strongly recommend[s]
  that customers transition to Nano Banana 2 Lite". Lite = Gemini 3.1 generation, 1K only,
  ~$0.034/image (vs 0.039), wider aspect ratios (adds 3:2/2:3/4:5/5:4/21:9), no Search
  grounding, no character-consistency references. No published head-to-head benchmark.
- **Video launch set (option A, six):** Veo 3.1 Std/Fast/Lite (Google direct), Gemini Omni
  Flash 1.1 (Google), Sora 2 / 2 Pro (OpenAI direct), Kling 3.0 Pro (fal), Runway Gen-4.5
  (Runway direct), Seedance 2.5 (fal).

## Competitor check: Higgsfield (2026-09-05, higgsfield.ai/pricing + help center)

Plans: Starter $15/mo → 200 cr ($0.075/cr). Plus $49/mo or $39/mo annual → 1000 cr
($0.049 / $0.039 per cr). Ultra 3000 cr ("$1 = 31 cr" → ≈$97/mo), Team 2000 cr pooled
("$1 = 33 cr"), Scale 12500 cr; Ultra/Team/Scale prices not printed on page. Credits expire
monthly; credit packs 100–25 000 cr, 90-day expiry, need active sub. "Unlimited" models
(Kling 3.0 7-day, Seedance 2.0, Nano Banana Pro/2, ElevenLabs, 15+) on Plus and up: standard
queue with dynamic throttling, web only (MCP/CLI/Canvas always burn credits). Concurrent
video jobs Starter 2 / Plus 6 / Ultra 8 / Team 16 / Scale 32.

Per-clip credits (their table): Veo 3.1 29 cr/4s (720p = 1080p), Veo 3.1 Fast 11 cr/4s,
Kling 3.0 1080p 8 cr/5s (720p 7, 4K 30), Sora 2 720p 10 cr/4s, Sora 2 Pro 1080p 50 cr/4s,
Seedance 2.0 720p 22 / 1080p 45 cr/5s, Nano Banana Pro 2 cr/img. No Veo Lite, no Runway
Gen-4.5, no Gemini Omni.

Head-to-head, USD per clip (Vansen credits = ceil(cost/0.6×100); Pro $0.008/cr, Studio $0.01/cr):

| Clip | API list cost | Vansen Studio $15 | Vansen Pro $30 | Higgsfield Starter $15 | Higgsfield Plus $49 |
|---|---|---|---|---|---|
| Veo 3.1 Std 1080p 8 s | 3.20 | 5.34 (534 cr) | 4.27 | 4.35 (58 cr) | 2.84 |
| Veo 3.1 Fast 1080p 8 s | 0.96 | 1.60 (160 cr) | 1.28 | 1.65 (22 cr) | 1.08 |
| Kling 3.0 Pro 5 s no audio | 0.56 | 0.94 (94 cr) | 0.75 | 0.60 (8 cr) | 0.39 (unlimited) |
| Sora 2 720p 4 s | 0.40 | 0.67 (67 cr) | 0.53 | 0.75 (10 cr) | 0.49 |
| Sora 2 Pro 1080p 4 s | 2.00 | 3.34 (334 cr) | 2.67 | 3.75 (50 cr) | 2.45 |
| Seedance 720p 5 s (ours 2.5 / theirs 2.0) | 2.37 | 3.95 (395 cr) | 3.15 | 1.65 (22 cr) | 1.08 (unlimited) |
| Nano Banana Pro image | 0.134 | 0.23 (23 cr) | 0.18 | 0.15 (2 cr) | 0.10 |

Read: at $15 Vansen Studio ≈ parity with Higgsfield Starter on Veo/Sora, loses on Kling +
images. At $30–49 Higgsfield Plus undercuts Vansen Pro on every shared model — Higgsfield
sells Veo 3.1 and Kling 3.0 at or below public API list price (wholesale deals or loss
leader), so a list-price-plus-40 % catalog cannot beat them per clip. Vansen edges: Veo Lite
/ Runway Gen-4.5 / Omni Flash (not on Higgsfield), free local Studio edit tools, no
throttled "unlimited" queue, per-second pricing. Decision: keep Pro 3750 cr and margin 0.4
(option C); do not raise video margin (B) or cut Pro credits (A) — both widen the gap.
Revisit after launch usage data; wholesale/volume pricing with Google/Kuaishou is the only
real lever.
