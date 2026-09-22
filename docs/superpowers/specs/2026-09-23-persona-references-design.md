# Persona as saved references — design

Date: 2026-09-23. Status: approved; plan `docs/superpowers/plans/2026-09-23-persona-references.md`.

## Why

Today a persona is a FLUX.1 LoRA trained on fal (`flux-lora-portrait-trainer`,
350 credits, then `fal-ai/flux-lora` at 6 credits per image). That has three
problems:

- **Deletion never finishes.** The LoRA file lives at fal. Nothing deletes it, so
  every account closure with a persona stops at `processing`.
- **The model is old.** It is built on FLUX.1 [dev] weights, which carry a
  non-commercial licence.
- **Training is slow and costly.** The frontier models now keep a face from a
  handful of reference photos with no training at all.

The new persona is a saved set of 5 photos. Generating with it sends those
photos to Google Nano Banana Pro at its highest settings. Nothing is trained,
and no provider keeps a file for us.

## Decisions

| Topic | Decision |
|---|---|
| Model | Google Nano Banana Pro (`gemini-3-pro-image`) only. It is one catalog entry, so the model can be swapped later. |
| Why not GPT Image 2.5 Sunburst | It leads the public leaderboards (Arena edit Portraits 1527 vs 1373). But it costs about 3–4× per image (~$0.78–0.97 vs ~$0.26) and takes 108 s vs 17 s. It has no documented same-person mode, and Google documents up to 5 people for character consistency. Nobody has measured likeness from 5 photos for either model. |
| Photos | Exactly 5 guided slots: front, left ¾, right ¾, left profile, right profile. This matches Google's documented limit of 5 character images. |
| Output | Fixed: 4K, all 5 photos (Gemini offers no PNG option). Nano Banana Pro has no quality or effort control, and thinking is always on. |
| User choices | Prompt, aspect ratio, and batch size of 1–4. Nothing else. |
| Creating a persona | Free. Slots stay by plan: Studio 2, Pro 5, Owner 5. |
| Keeping photos | The photos stay with the persona until the user deletes it. Any slot can be replaced. |
| Old LoRA personas | Deleted. No refund: the system is not public yet. |
| Architecture | Repoint the hidden `persona` catalog family to Nano Banana Pro. It keeps its own `models` kill switch and its own price rule. |

## 1. Data and removal of the old pipeline

**`personas` table**

- Kept: `id`, `user_id`, `name`, `client`, `created_at`, `deleted_at`.
- Added: `photos jsonb`, an object with exactly the keys `front`,
  `left_three_quarter`, `right_three_quarter`, `left_profile` and
  `right_profile`. Each value is an upload path or null. A check constraint
  rejects any other key.
- Added: `consent_attested_at timestamptz not null`. `POST /personas` already
  requires `attested === true`; now the time is stored.
- `status` becomes `draft` or `ready` only. It is `ready` exactly when all 5 slots
  are non-null.
- Removed: `photo_paths`, `lora_url`, `trigger_word`, `provider_ref`,
  `charged_plan`, `charged_pack`, `error`, `training_started_at`, `trained_at`.

**Photos**

- Uploads use purpose `persona-photo`. `persona-manager.ts` currently omits the
  purpose, which lets persona photos slip past the purpose check. The resolver
  must require `persona-photo` and `allowed` moderation.
- A photo is owned by its persona slot. Replacing a slot, or deleting the
  persona, queues the old object through `fn_enqueue_deletions`.

**Slot counting.** Count `draft` and `ready` personas that have not been
deleted, and take a lock so that concurrent creates cannot exceed the plan
limit. This replaces today's count, which includes failed personas and takes no
lock (`app.ts` `POST /personas`, `GET /personas` `used`).

**Removal migration** (one migration, next free number)

1. Delete every existing persona, and queue its photos and the
   `persona-zips/{user}/{id}.zip` objects for deletion.
2. Close every open `provider_artifact_deletions` row as `unsupported`, with
   `last_error = 'pre-launch test data: LoRA pipeline retired'`.
3. Drop `training_jobs`, `fn_reserve_training`, `fn_settle_training`, the
   training claim and lease functions, `fn_charge_persona`, `fn_fail_persona`,
   and the `reconcile_stale_trainings` cron. `fn_reserve_persona` is kept and
   rewritten: it is already the locked, idempotent slot check that
   `caps_concurrency.sh` proves, and `POST /personas` switches to calling it.
4. Keep `training_provider_expenses` and past `persona_training` ledger entries.
   Money records are retained.
5. Update `fn_track_persona_objects`, `fn_reap_persona` and `fn_delete_persona`
   for the new `photos` shape. They no longer track a ZIP, and they never insert
   a `provider_artifact_deletions` row.
6. Drop the `persona_training` limits from the config table. Keep the slot
   limits.

**Code removed:** `submitPersonaTraining`, `checkPersonaTraining`,
`TRAINER_SLUG`, `PERSONA_TRIGGER`, the `fal-ai/flux-lora` branch in `fal.ts`,
`_shared/jobs/training.ts`, the training claim in `job-worker/handler.ts`,
`POST /personas/:id/train`, and the ZIP building in `app.ts`.

## 2. Creating a persona

**Manager flow** (`features/workspace/persona-manager`)

1. The user enters a name (up to 40 characters).
2. The user ticks the consent checkbox: "This is me, or someone who gave me
   permission." It is required and is saved.
3. Five labelled slots are shown. Each empty slot shows the guide photo for its
   angle.
4. Tapping a slot opens the file picker. The upload fills that slot at once.
5. When all 5 slots are filled, the status becomes `ready`. There is no train
   button and no charge.
6. A ready persona shows its 5 photos. Replacing a slot is a single action.

**API**

- `POST /personas` takes `{ name, attested }` and creates a `draft`.
- `PUT /personas/:id/photos/:slot` takes `{ uploadId }` and sets a single slot.
  It validates ownership, purpose `persona-photo`, `allowed` moderation and the
  minimum size, then queues the photo it replaced.
- `GET /personas` returns each persona's status, its 5 slot thumbnails (signed,
  1 hour) and `slots { used, max }`.
- `DELETE /personas/:id` behaves as today.

**Photo checks**

- **Client** (`core/personas/photo-prep.ts`): reject a photo whose short edge is
  under 1024 px ("Use a sharper, higher-resolution photo"). Otherwise downscale
  to 2048 px on the long edge and save as JPEG at quality 0.92.
- **Server:** the existing upload checks (type, 10 MB, 50 MP) apply, plus a
  1024 px minimum short edge for `persona-photo`, plus moderation.
- There is no automatic face or angle detection.

**Guide photos**

- `scripts/generate-persona-guides.mjs` is run by the owner once. Using Nano
  Banana, it draws one fictional adult in the 5 slot angles with neutral
  lighting and background. The front image is generated first and used as the
  reference for the other four.
- The output goes to `public/personas/guides/{slot}.jpg` (Gemini returns JPEG;
  the script refuses any other type). At 1K it costs under $1.
- Until the files exist, every slot shows a neutral silhouette.

## 3. Generating with a persona, and pricing

**Composer** (`left-panel`)

- Selecting a persona hides the model, version, resolution, quality and
  reference controls. What remains is the prompt, the aspect ratio (the
  persona family's list) and the batch size, 1–4.
- A chip reads "Persona · Nano Banana Pro · 4K". The price is shown as per-image
  credits × batch, for example "46 cr × 4 = 184 cr".

**Server** (`POST /generations` with `personaId`)

- The persona must be owned by the user and `ready`. The user must have an
  active Studio or Pro plan. The `persona` model row must be enabled.
- The family is `persona`, with provider `google`, model `gemini-3-pro-image`,
  image size `4K`. The aspect ratio comes from the request, and
  the reference paths are the persona's 5 photos, resolved on the server.
- The prompt is wrapped on the server: `Images 1–5 are the same person (front,
  left three-quarter, right three-quarter, left profile, right profile). Keep
  their face and identity exactly. {styled user prompt}`.
- Moderation still runs on the user's prompt before the charge and before any
  provider call. The stored prompt is the user's own text, following the same
  approach as style presets.
- Each image in a batch is its own generation and charge, as with other models.
- On retry, the persona is resolved again. If it has been deleted or is a
  `draft`, the retry is refused with `persona_unavailable`.

**Worker and adapter**

- `jobs/payload.ts` signs the 5 photo paths.
- `providers/google.ts` sends 5 inline image parts, each preceded by a text part
  naming its angle, then the wrapped prompt. The image config requests `4K` and
  the aspect ratio. No PNG option exists: `ImageConfig` has only `aspectRatio`
  and `imageSize`, and the only output-type field (`responseFormat.image.mimeType`)
  offers JPEG alone (ai.google.dev/api/generate-content, checked 2026-09-23). So
  nothing is sent and the output is whatever Google returns.
- The adapter logs `usageMetadata` from the response, including thinking
  tokens, as an `google_usage` log line alongside the existing `openai_usage`.
- A failure refunds once, through the existing path.

**Price for the `persona` family**

| Component | Tokens | Rate | Cost |
|---|---|---|---|
| 4K output | 2,000 | $120/1M | $0.2400 |
| 5 photos (5 × 560) + prompt allowance (800) | 3,600 | $2/1M | $0.0072 |
| Thinking, provisional allowance | 2,000 | $12/1M | $0.0240 |
| Total | | | $0.2712 |
| Credits at the 40% margin × `PERSONA_PREMIUM` (1.0) | | | **46** |

Rates are from ai.google.dev/gemini-api/docs/pricing, checked 2026-09-23.
`PERSONA_PREMIUM` starts at 1.0 and is raised only if the likeness test shows a
gain.

**Catalog fixes shipped with this work**

- `NANO_REFERENCE_TOKENS` changes from 1,120 to 560, Google's documented count
  per input image.
- `GenerationInput` gains `referenceCount`, and the input cost multiplies by it.
  `hasReference` stays as `referenceCount > 0` for endpoint choice. This applies
  to Nano Banana and GPT Image, so a request with several references can never
  be billed as one.
- Nano Banana Pro gains `NANO_PRO_THINKING_TOKENS = 2000` at $12/1M until the
  `google_usage` logs replace it with a measured figure. The normal Nano Banana
  Pro price changes from 23 to 27 credits at 1K/2K and from 41 to 45 at 4K.
- Bump `CATALOG_VERSION`, run `sync-shared` and `export-catalog`, and update the
  fingerprint.

## 4. Deletion, legal copy, testing, rollout

**Deletion**

- Deleting a persona, replacing a slot, closing an account and the lapse purge
  all remove only objects we hold. No `provider_artifact_deletions` row is
  created, so a closure can reach `completed`.
- Photos sent to Google travel inside the request and are not stored as files
  we would have to chase afterwards.

**Legal copy** (draft; the formal legal review stays on the checklist)

- `privacy-page.html`: persona photos are face images the user provides. They
  are kept until the persona or the account is deleted. They are sent to Google
  only to generate the requested images. Before this line is published, check
  that Google's paid-tier API terms rule out using the data for training, and
  cite them.
- `terms-page.html` and `acceptable-use-page.html`: a persona may only be of the
  user, or of an adult who gave consent. Never a minor, and never used to
  impersonate or deceive.

**Tests**

- SQL: the 5-slot constraint; `ready` exactly when complete; slot counting under
  concurrency (drafts count, the limit holds); replacing a photo queues the old
  object; the removal migration deletes personas and closes artifact rows;
  deleting a persona creates no artifact row.
- Deno: persona routing (ownership, `ready`, plan, kill switch); the wrapped
  prompt; fixed 4K and 5 photos; price 46 × batch; `referenceCount`
  pricing on Nano Banana and GPT Image; the Google adapter sends 5 labelled
  parts and logs usage; a retry is refused with `persona_unavailable`; the
  removed routes return 404.
- Web: manager slots with guides and fallback silhouettes; the minimum-size
  rejection; single-slot replacement; the composer hides controls and shows
  price × batch.
- Run `npm run verify` against a fresh local reset.

**Rollout**

1. Owner commits. Then `./deploy.sh` (functions) first, then `supabase db push --linked` immediately after. Before either, `select count(*) from public.jobs where family_id = 'persona' and state <> 'done'` must return 0: an old fal persona job would otherwise be polled by the Google adapter forever. Migration-first breaks the currently deployed job-worker tick, which calls the `fn_claim_training_jobs` that 0032 drops; functions-first only makes the persona routes 503 until 0032 lands.
   0032 ships the persona kill switch off. The gateway's modelGate has no
   owner bypass, so enable it first with
   `update public.models set enabled = true where id = 'persona';`, then run
   the live persona smoke, and if it fails set it back with
   `update public.models set enabled = false where id = 'persona';`.
2. **Likeness test** (owner-run, ~$0.52):
   `scripts/persona-likeness-test.mjs` makes two 4K images from the same prompt.
   One uses the 5 persona photos plus the identity wrapper; the other uses only
   the front photo and the plain prompt. The owner compares them, and the
   result sets `PERSONA_PREMIUM` (a catalog bump).
3. **Guide photos** (owner-run, under $1): run
   `scripts/generate-persona-guides.mjs`, then commit the images.

## Out of scope

- A general saved-references library for all models.
- GPT Image or any other persona model.
- Automatic face or angle detection.
- Extra non-persona references (scene or outfit) alongside a persona.
- The mobile client.
