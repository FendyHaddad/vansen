# Vansen Release Readiness Review and Implementation Plan — Web and Backend

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Observe a focused failing test before each fix, then a passing regression test. Checkboxes below are execution tracking, not claims of completed fixes. Do not commit, branch, push, deploy, charge customers, or mutate production data as part of this review.

> **Companion document:** every Flutter/iOS/Android finding, task, and release gate lives in the mobile repository at `~/StudioProjects/vansen-mobile/docs/superpowers/plans/2026-09-17-mobile-release-readiness-review-and-implementation-plan.md`. This document keeps only the backend halves of mobile-facing contracts (billing lanes, IAP fulfillment, push send, DTO shape) and cross-references the mobile document as **M-xx** findings and **MT-xx** tasks.

**Goal:** Make the Angular web application and the Supabase backend safe, accurate, recoverable, and supportable for a paid public release.

**Architecture:** Retain Angular, Supabase/Hono/Postgres, and the existing provider adapters. Introduce explicit transactional boundaries for billing and job settlement; move background work off client polling; isolate edit sessions by user and image; derive capabilities and commercial promises from one authoritative contract. Preserve the established visual composition.

**Tech stack:** Angular 22, TypeScript 6, Vitest, Deno, Hono, Supabase Auth/Storage/Postgres, Stripe, Apple App Store Server API (backend half), Cloudflare R2, ONNX Runtime Web.

**Spec:** This document's findings, tool matrix, and release acceptance criteria are the implementation requirements. `vansen.md` supplies product intent; current source takes precedence over historical "complete" labels. Where `vansen.md` and the code disagree, section 3a lists the conflict and who decides.

**Reviewed:** 17 September 2026, Asia/Kuala_Lumpur. **Re-verified:** 17 September 2026 — every finding below was re-checked line by line against HEAD `5bbc041`; each finding carries a **Verification** line stating the outcome, corrected line references, and any additional defect found in the same code path.

**Scope:** Web and backend readiness. This deliverable is a review and implementation plan. Application fixes have **not** been applied.

## 1. Release decision

**Do not release the current checkout as a broadly available paid product.** The blockers include incorrect model/price fulfillment, a broken upload-as-reference path for every image model, recoverability gaps in paid operations, an unchecked private-upload reference, unreliable job completion without an active client, and editor state crossing image boundaries. Mobile has its own blockers (see the companion document).

The UI and unit-test coverage are a useful foundation. Replacing the app or redesigning its interface is not necessary. The highest-value work is to repair the behavior behind the existing controls and establish trustworthy end-to-end release gates.

A smaller image-only web release is possible **after** the shared security, billing, job, editor, and commercial-copy blockers are fixed. Hiding video alone does not resolve the image-generation or billing findings. Mobile can release separately once its own gates pass.

### Priority and evidence labels

- **P1 — release blocker:** Fix before releasing the affected capability, or keep that capability unavailable and remove its sales claims.
- **P2 — required hardening:** Complete before a broad rollout, with an explicit bounded pilot exception if necessary.
- **P3 — deliberate follow-up:** Can ship later if the product accurately describes what is available.
- **Reproduced:** Executed against current source with isolated fakes or a focused test; no paid provider requests.
- **Source-confirmed:** A concrete failure chain is visible in current code. Production occurrence has not been established.
- **Release gate:** A capability or deployment cannot be signed off with the evidence available.

A severity is about release impact, not an assertion that an exploit or customer loss has already happened in production.

## 2. Checkout and verification evidence

| Surface | Reviewed state |
|---|---|
| Web/backend | `/Users/user/IdeaProjects/vansen`, branch `main`, HEAD `5bbc041af94a98fa51d290b35e5e8cca968a8417`; clean apart from this document |
| Mobile | `/Users/user/StudioProjects/vansen-mobile`, HEAD `87ee43079d4bf02fcefcb70331373c64d53369b6`, with uncommitted local changes — see the companion document |
| Live backend | Public `/health` returned `{"ok":true,"db":true,...}`. This proves gateway/database reachability only. |
| Deploy state | Current deployed bundle, migration ledger, cron executions, billing secrets, R2 configuration, and store-console setup were not inspected. `vansen.md` says `api` v41 was deployed 2026-08-14 and that Video (`0016_video.sql`, R2 secrets, redeploy) is still not rolled out as of 2026-09-06; treat both as historical notes until checked against the dashboard. |

### Checks actually run

| Check | Result (initial review) | Result (re-verification) |
|---|---|---|
| `npm test -- --watch=false` through Angular, Node 22.23.1 | 239 passed, 42 files | **239 passed, 42 files** |
| `npm run build`, production configuration | Passed; initial 567.38 kB raw / 133.94 kB transfer | **Passed; initial total 567.70 kB raw / 133.95 kB transfer** |
| `deno test --allow-all _shared` from `supabase/functions` | 40 passed | **40 passed** |
| `deno check api/index.ts stripe-webhook/index.ts appstore-webhook/index.ts` | Passed | **Passed** |
| Local browser | Landing, pricing, and login inspected; public pricing contradictions confirmed in rendered UI | Copy re-confirmed in source (`plans-page.html:15`, `plans-page.ts:118,150,168`, `landing-page.html:132–133`, `landing-page.ts:107–109,124`) |
| Isolated web edit-session reproduction | New session B retained identity B but received A's pixel `10` instead of `200` and became dirty | Code path re-confirmed at `edit-session.ts:105–116` |
| Isolated IAP transient-failure reproduction | Retry returned `granted=false`; only one grant attempt occurred because the failed transaction's marker remained | Code path re-confirmed at `iap-grants.ts:28–50` |
| Isolated GPT adapter reproduction | v1/4K/high = 28 credits; v2/4K/high = 73 credits; identical `gpt-image-1` / `1024x1024` request | Recomputed from the catalog: 0.167/0.6 → 28; 0.211×2.05/0.6 → 72.09 → 73 |
| Isolated moderation outage reproduction | HTTP 503 produced `{flagged:false,categories:{}}` | `moderation.ts:29–33` re-confirmed |
| Isolated media-cache quota reproduction | Successful fetch followed by cache write failure rejected the blob operation | `media-cache.ts:23–33` re-confirmed |

The existing Deno suite contains ten test files, all under `_shared/`: billing lanes, IAP notifications/products, push, video rules, R2 storage, and four **video-only** adapter tests (`fal_test.ts` covers Kling/Seedance slugs, check, and cancel; `google-omni_test.ts`, `google-video_test.ts`, `runway_test.ts`). There are no tests for `openai.ts`, `google.ts` (Nano Banana), the FLUX/Seedream image branches of `fal.ts`, `moderation.ts`, `iap-grants.ts`, either webhook, or any gateway route.

The sandbox initially aborted Angular processes with exit 134 and blocked Flutter SDK-cache writes. The same checks succeeded when allowed to run normally. Those initial environment failures are **not app defects**.

No live generation, persona training, purchase, account creation/deletion, or deployment was performed. Authenticated editing, actual ONNX inference quality, actual payment fulfillment, and background execution remain unverified. No claim of production readiness follows from the green unit suites.

### Global implementation constraints

- Never commit, branch, or push from automation; the owner manages Git history.
- Preserve the current visual design.
- Use TDD for behavior changes: focused RED → minimal implementation → focused GREEN → proportionate regression checks.
- Keep Angular templates and styles in their existing separate files.
- Follow project guard-clause conventions and readable errors/logs.
- Do not expose provider/service-role credentials to the client.
- Do not silently alter existing credit balances or historical transactions to repair future behavior.
- Apply additive migrations only after checking actual deployed migration history. Do not renumber already-applied migrations blindly.
- Tests use synthetic media, fake adapters, and sandbox billing. Real paid verification needs an explicit test account and spending scope at execution time.
- Preserve commercial-safe model restrictions in `CLAUDE.md`; pin and document exact weight artifacts before shipping them.

## 3. Findings register

### R01 — Private image upload references are not ownership checked

**P1 · Source-confirmed · Backend security**

**Evidence:** `supabase/functions/api/index.ts:1160–1163` takes `referenceUploadId` and calls the service-role storage client's `createSignedUrl` directly. `referenceUploadId` is a **raw storage path**, not a database id: `POST /uploads` returns `uploadId: path` where `path = ${userId}/${uuid}.${ext}` (`index.ts:1667,1687`), and there is no `uploads` table. Unlike video `referencePaths` (`index.ts:949–956`: `UPLOAD_PATH` shape check, count check via `referenceRule(mode)`, `startsWith(\`${userId}/\`)` prefix check, sign-error handling, re-moderation at `995–999`) and persona `photoUploadIds` (`1833–1836`, prefix-checked), the image reference has no shape check, no prefix check, no error check, and no re-moderation at use time.

**Verification:** CONFIRMED. Line reference corrected from 1150–1163 to 1160–1163 (the parent-lookup block above it, 1151–1159, **is** ownership-checked with `.eq('user_id', userId)`). Additional defects: (1) the image-parent lookup selects only `media_path` with no `kind`/`status` check, so a still-pending parent yields `signMedia(null) → ''` and an empty `image_url` is sent to fal **after** the charge; a video parent would hand a `media`-bucket path that actually lives in R2. (2) Because no shape check exists, any key in the `uploads` bucket (`quarantine/…`, `persona-zips/…`, another user's `{uid}/{uuid}`) is signable if known. (3) Practically, this path is currently unreachable for image models from the web client — see R28 — but the gateway itself enforces nothing.

**Failure:** A signed-in caller who knows another upload's path can submit it as their image reference. The service-role client bypasses storage RLS and supplies the private image to a provider. This also admits scratch/quarantine paths if known. Random UUIDs reduce discoverability; they are not authorization.

**Fix:** Store upload ownership, purpose, detected MIME, dimensions, and moderation status server-side. Resolve an opaque upload ID only for its owner and allowed purpose. For existing paths, require both a canonical path and an ownership lookup. Reject foreign/missing/unmoderated references before signing, charging, or provider dispatch. Validate image parents as owned, **completed image** rows with existing media on the expected backend.

**Acceptance:** Cross-user and quarantine references return a readable 403/404; signing, charging, and adapter call counts remain zero. A pending or video parent for an image edit returns a readable 400 before charge. Same-user valid references still work. Task T02.

### R02 — Billing event markers and credit grants are not one transaction

**P1 · Reproduced for IAP; source-confirmed for Stripe · Money integrity**

**Evidence:** `_shared/iap-grants.ts:28–31` inserts `{ id: 'iaptx:<transactionId>', type: 'iap_transaction' }` into `webhook_events` and returns `false` on **any** insert error; lines 33–50 then upsert the subscription and call `fn_cycle_reset` / `fn_grant_pack`, throwing on error with no marker cleanup. `webhook_events` is `id text primary key, type, received_at` (`0003_billing.sql:6–10`); dedupe is purely the primary key. `stripe-webhook/index.ts:97–100` and `appstore-webhook/index.ts:34–37` treat **every** insert error as "already processed" and return 200. No file in `supabase/functions` distinguishes Postgres unique-violation `23505` from operational errors. Stripe's catch (`stripe-webhook:173–177`) and Apple's catch (`appstore-webhook:42–45`) delete only their own **event-id** rows, never the inner `iaptx:` marker. `fn_cycle_reset(p_user, p_grant)` (`0008_credit_plans.sql:121–129`) snaps `plan_credits` to the grant with a `cycle_reset` ledger row that carries no `stripe_ref`; contrast `fn_grant_pack` (132–137) and `fn_iap_clawback` (`0012_iap.sql:12–17`) which use `stripe_ref UNIQUE … on conflict do nothing`. `POST /iap/verify` (`api/index.ts:1630–1651`) shares `applyIapTransaction`; on `false` it returns 200 `{granted:false}` so the client cannot tell "already granted" from "marker poisoned".

**Verification:** CONFIRMED; line references corrected (marker 28–31, work 33–50; Apple dedupe 34–37). **Worse than stated for Apple:** the outer catch deletes the `notificationUUID` row, but the `iaptx:` marker written inside `applyIapTransaction` survives, so Apple's retry passes the UUID check and then bounces on `iaptx:` → `false` → 200 with no grant. The grant is lost **without any crash**; a single RPC error suffices. Additional defects: `upsertIapSubscription` (line 34) runs **before** `fn_cycle_reset`, so an RPC failure leaves an `active` subscription row with zero granted credits; a `payment`-mode checkout whose `amount_subtotal` mismatches only logs (`stripe-webhook:120–122`) and returns 200, consuming the event id so a later reconcile cannot replay it; `webhook_events` has no purge policy and `0008_credit_plans.sql:7` once did `delete from public.webhook_events`, so any future truncation silently re-enables replay of every `iaptx:` grant (and `fn_cycle_reset` is snap-to-grant, so replay = refill).

**Failure:** A temporary database failure can permanently consume a purchase's dedupe marker without delivering credits. A database outage during marker insertion can be acknowledged with HTTP 200 so Stripe/Apple never retry. A lost response after a successful reset plus replay can also refill a balance if event-state recovery is not atomic.

**Reproduction:** First IAP attempt inserted its marker and failed `fn_cycle_reset`; the second returned false and did not retry the grant.

**Fix:** A service-role-only SQL transaction must atomically dedupe the business transaction, record the entitlement change, and apply its ledger movement. Distinguish unique conflicts (`23505`) from operational errors. Key cycle resets to the paid invoice/Apple transaction, not only the webhook delivery ID. Acknowledge a webhook only after durable processing. Track attempts and last error for reconciliation. Define a retention policy for `webhook_events` that never drops business-transaction identity.

**Acceptance:** Inject failure at each write; retry grants exactly once. Concurrent webhook/client verification does not lose or duplicate credits. A repeated invoice cannot replenish credits spent after its first fulfillment. `/iap/verify` distinguishes `applied`, `already_applied`, and `retry_later`. Task T03. Mobile client half: **M01 / MT-01**.

### R03 — Mobile completes purchases before verification

Moved to the companion document as **M01**. Backend dependency: T03 must land first so that the mobile purchase coordinator has an idempotent `verify` result to wait on.

### R04 — Model selectors, charged prices, and fulfilled requests disagree

**P1 · Reproduced · Core product correctness**

**Evidence:** The catalog is identical in `src/app/core/catalog/model-families.ts` and `_shared/model-families.ts` (sync is clean). Mapping status per family:

| Family (catalog lines) | Versions offered | Resolutions offered | Adapter maps version | Adapter maps resolution |
|---|---|---|---|---|
| nano-banana (139–179) | fast / standard / pro | 1K / 2K / 4K | Yes, `google.ts:8–13` | Yes, `google.ts:36–37` |
| gpt-image (180–217) | 1 / 1.5 / 2 (default 2) | 1K / 2K / 4K | **No** — `openai.ts:11` hardcodes `gpt-image-1` | **No** — `openai.ts:14–19` maps aspect only to 1024/1536 sizes |
| flux (218–236) | none | 1MP / 2MP / 4MP | n/a — `fal.ts:66` uses `fal-ai/flux-pro/v1.1` while the blurb (224) says "FLUX.2 [pro]" | **No** — `fal.ts:112` body is `{prompt, aspect_ratio}` |
| seedream (237–256) | none | 1K / 2K / 4K | v4 slug matches blurb | **No** — same body; flat $0.03 so no overcharge, selection silently ignored |

Charging: `api/index.ts:1123` `unitCredits = creditCost(family, settings)` where `settings` passes through `sanitizeSettings` (130–152) as free-form strings. `creditCost` (`model-families.ts:496–498`) = `ceil(providerCost / 0.6 × 100)`. GPT v1·high·1K → 28 credits; GPT v2·high·4K → 0.211 × 2.05 / 0.6 = 72.09 → 73 credits; both produce the identical OpenAI request. FLUX 4MP charges 20 credits versus 5 for 1MP for the same v1.1 call with no `image_size`. `openai.ts:40` sends a reference only when `op === 'edit' || op === 'upscale'`.

**Verification:** CONFIRMED for the mapping and price table. One part OVERSTATED: "uploaded references used with `generate` are omitted" is true of the adapter in isolation, but the web client never sends `generate` plus a reference — `workspace-page.ts:355–359` flips `op` to `Edit` whenever a reference is set. The actual customer-facing break is **R28** (upload references are rejected at the gateway). Additional defects: `sanitizeSettings` does not validate `version`/`resolution`/`quality` against the family, so unknown strings fall through to the `?? 0.053` default price (`model-families.ts:213`); `openai.ts:49–52` mask branch is dead code because mask senders (`edit-*` tools) route to fal (`providers/index.ts:17–20`); verify against fal's current schema whether `fal-ai/flux-pro/v1.1` and Seedream v4 accept `aspect_ratio` or require `image_size` — if the latter, aspect is also ignored for those two.

**Failure:** The user can pay different prices for the same request. An expensive-looking setting can change credits without changing output capability.

**Fix:** Define an executable adapter capability contract. Normalize and validate settings once against the selected family; the same normalized request determines displayed quote, reserved credits, and provider payload. Wire supported options against current vendor documentation/account access, or remove them from the catalog and marketing. Never replace an unsupported selection silently. Add image-adapter contract tests (openai, google, fal image branches), not only video-adapter tests. Remove or wire the dead OpenAI mask branch.

**Acceptance:** Every exposed model/version/resolution combination has a captured expected provider request and pricing fixture. The actual output's dimensions/model are checked in a bounded provider smoke. Task T05.

### R05 — Image completion can report success after storage failure

**P1 · Source-confirmed · Media/credit consistency**

**Evidence:** `api/index.ts:459–464` (image branch of `finishJob`): the `media` upload result is discarded; `generations.update({status:'done', media_path})` has no error destructuring and **no `.eq('status','pending')`**; then `notifySettled(..., 'generation_done')` fires. The video branch (511–535) does use `.eq('status','pending').select('id')` and handles errors. `fn_fail_job`'s current definition is `0008_credit_plans.sql:96–119` (supersedes 0004; 0016 does not redefine it): it reads status (104–105), returns if not pending (106), then `update … set status='failed' where id = v_gen` (107) with no status predicate, no `for update`, no advisory lock. `/edits/save` (1970) and `/library/import` (2032) ignore the final `media_path` update result (their media **upload** errors are checked at 1962–1969 and 2024–2031).

**Verification:** CONFIRMED. Line references corrected from 431–460 to 459–464. Additional: a failed image upload still marks the row `done` with a `media_path` pointing at nothing, and no refund is then possible (`fn_fail_job` returns early on non-pending). The cron stale sweep can fail-and-refund an image row that a still-running inline request then flips to `done`, yielding refund **plus** deliverable.

**Failure:** A charged "done" image can point to missing media. A concurrent timeout/cancellation and successful completion can disagree about status, delivered media, and refund.

**Fix:** Validate every storage/database result. Use one atomic settlement RPC for success/failure/cancel with expected state, generation/job identity, and idempotent ledger effects. Persist output only after upload success; retain a durable cleanup record if settlement loses a race. Emit completion through an outbox after settlement commits. Apply this to imported/saved edits too.

**Acceptance:** Storage failure never creates a successful DTO or completion event. Concurrent success/failure produces one terminal state with corresponding money behavior. Task T06.

### R06 — Background jobs depend on an open client

**P1 · Source-confirmed · Images, video, personas, push**

**Evidence:** `GET /jobs` (`api/index.ts:810–850`) calls `adapterFor(family).check(provider_ref)` then `finishJob` per job (830–833) — this is where outputs are downloaded and stored. `GET /personas` (1736–1765) settles training. The cron SQL (`0004:86–91`, `0013:96–100`, `0016:39–50`) only calls `fn_fail_job`/`fn_fail_persona` with `'timeout'`; none fetches results. Inline Google/OpenAI adapters return `providerRef:'inline'` and `finishJob` runs inside the `POST /generations` request (1229–1230). `supabase/functions/` contains only `api`, `stripe-webhook`, `appstore-webhook`, and `_shared` — there is no worker.

**Verification:** CONFIRMED. **Product-spec conflict:** `vansen.md` §7 promises "the user may leave the page — a notification fires on completion" and the UI copy reads "You can leave this page. We'll notify you when it's ready." That promise is false today: the completion push (`_shared/push.ts`, fired from `notifySettled`) is itself only triggered by a client poll. `vansen.md` §2 already records that polling replaced the Realtime/webhook design as a "deliberate simplification".

**Failure:** Closing the web tab stops productive polling. Paid provider work can finish yet never reach the library, then be refunded by the stale sweep after 10 minutes (images) or 30 minutes (video) even though the provider was paid. Push cannot reliably announce completion when it is itself triggered by polling. Inline batches also depend on one long HTTP request staying alive.

**Fix:** Create durable dispatch and completion processing: atomic reservation + job/outbox creation, a scheduled worker or verified provider callbacks, leased processing, bounded retries, and a recovery sweep. Clients read job state and can use polling for UI updates; they must not be required to execute the job lifecycle. Apply the same mechanism to persona training. Until this lands, remove the "you can leave this page" copy.

**Acceptance:** Submit, close every client, advance provider to complete, run worker, reopen: output/persona is ready and correctly charged. Worker restart recovers unfinished work. Task T07.

### R07 — Submission is neither fully atomic nor idempotent

**P1 · Source-confirmed · Paid retry/duplicate dispatch**

**Evidence:** `fn_charge_and_generate` (`0014_client_tracking.sql:16–66`) atomically charges and creates generation rows under `pg_advisory_xact_lock`, but jobs are inserted afterward at `api/index.ts:1206–1210` with `error` not destructured. `jobRow!.id` is dereferenced at 1225 (success), 1230 (inline finish), and 1240 (catch → `fn_fail_job`). `CreateGenerationRequest` (`src/app/core/api/dtos.ts:107–123`) and the RPC signature `(p_user, p_amount, p_type, p_family_id, p_note, p_items)` have no idempotency key.

**Verification:** CONFIRMED. Line reference corrected from 1208 to 1206–1210. Failure chain sharpened: if the insert fails, the `try` throws a TypeError at 1225, the `catch` throws again at 1240, the request 500s, and the generation stays `pending` and charged. The stale sweep joins `jobs`, so **a generation with no job row is never swept or refunded**.

**Failure:** A failed job insert leaves charged pending generations with no job and no refund path. Retrying after a lost submit response creates another charge and another provider request. Batch dispatch interrupted midway leaves partially launched work.

**Fix:** Create reservation, immutable request snapshot, generation rows, job rows, and dispatch outbox in one transaction, keyed by `(user_id, idempotency_key)`. Return existing records for the same key/body; reject the same key with a changed body. Recover provider-submit ambiguity using provider idempotency/status capabilities rather than blindly resubmitting.

**Acceptance:** Double tap, HTTP retry, worker crash, and lost response do not multiply charges or provider work. Every pending generation has a recoverable job. Task T07.

### R08 — Cancel and transient provider failures refund incorrectly

**P1 · Source-confirmed · Provider-spend exposure**

**Evidence:** fal `cancel()` returns normally when status is not `IN_QUEUE` (`fal.ts:177–193`, early return at 185). The cancel route (`api/index.ts:877–886`) logs any cancellation error and calls `fn_fail_job` with `'cancelled'` unconditionally; the follow-up status check (888–895) only detects a completion that has already landed. `GET /jobs` (834–838) fails and refunds on any thrown provider check; fal `check` maps `!statusRes.ok` (152), unknown status (159–161), `!resultRes.ok` (165–168), and missing image (172) to `state:'failed'`, which `finishJob` (450–454) turns into fail plus refund.

**Verification:** CONFIRMED. Additional: `fetchBytes` (`types.ts:64–69`, used at `fal.ts:173`) **throws** on a non-OK image download, and Runway `check` throws on a non-OK poll (`runway.ts:68`); both take the `GET /jobs` catch path, so a transient CDN or 5xx error permanently fails a healthy job.

**Failure:** A still-rendering paid fal request can be locally canceled/refunded without being canceled at the provider. A temporary 429/503/network failure can discard an otherwise valid output and refund a still-chargeable run.

**Fix:** Have adapters return typed cancellation outcomes (`cancelled`, `not_cancellable`, `already_terminal`, `retryable_error`) and distinguish temporary checks from terminal provider failure. Refund only under the explicit settlement policy. Back off on throttling and transient outages. Retain the provider reference until reconciliation finishes.

**Acceptance:** Running fal job returns readable 409 without refund; confirmed queued cancellation refunds once; 503 then success delivers once without refund. Task T06/T07.

### R09 — Limits and setting validation are incomplete

**P1 · Source-confirmed · Cost and abuse controls**

**Evidence:** `sanitizeSettings` (`api/index.ts:130–153`) checks types, lengths, and broad ranges (`version.length <= 20`, `resolution.length <= 10`, `0 < durationS <= 60`, `mode ∈ VIDEO_MODES`). `prepareVideo` reads pending count (964–972) and 24-hour spend (974–990) before the charge RPC (1193), outside its advisory lock. The spend calculation back-derives provider USD from retail credits, excludes `status='failed'` rows, and does not add the requested run (`video-rules.ts:19` compares `spentUsd < cap` only). Persona slot count (1789–1795) is read before insert (1796–1801) without a lock. The only `rate_limited` response is the client error-report endpoint (793).

**Verification:** PARTIALLY CONFIRMED — the claim should credit the existing family-level **mode** gate: `videoFamilySupports(family, mode)` (`model-families.ts:491–493`, called at 944) and `referenceRule` validate mode and reference counts. Duration, resolution, and version are **not** validated against the family: `veoRate`/`omniRate` (`model-families.ts:115–130`) fall through to a default for unknown resolutions, and `providerCost = rate × durationS` accepts any 0 < d ≤ 60. `vansen.md` already lists "dispatch rate limiting" and "session cap" as not started.

**Failure:** Concurrent requests can exceed the 3-video cap. A user just below the daily cap can submit a run exceeding it. Refunded-but-provider-billed requests disappear from the spend proxy. Unsupported duration/resolution/version values reach providers and pricing functions. Free uploads/moderation can be abused independently of credit balance.

**Fix:** Normalize against the selected family's supported combinations. Reserve capacity and estimated provider cost under the same user lock as charging. Track actual/reserved provider expense separately from customer credits and refunds. Enforce account-level and project-wide thresholds, rate limits, upload size/dimension limits, and persona slots atomically. Return 429 with a reliable retry/reset value.

**Acceptance:** Four concurrent submits admit at most three; current spend + next reservation cannot exceed cap; failed customer settlement does not erase incurred provider spend; invalid options cause no provider request. Task T02/T07.

### R10 — Mandatory moderation fails open

**P1 · Reproduced · Safety promise and operational correctness**

**Evidence:** `_shared/moderation.ts` returns unflagged on missing key (11–16), empty input (21), non-OK HTTP (29–33), and network exception (40–43); comments at 12–13 and 30–31 say "Fail OPEN". Of five call sites, three pass a possibly undefined image URL: `POST /uploads` (1674–1675, sign error discarded), `POST /edits/save` (1927–1929, scratch upload result **and** sign error ignored), and the import route (1992–1994, same pattern). The two safe sites are video reference paths (993–995, checks `error || !signed`) and the text-only prompt check (1137). `POST /generations/:id/thumb` (1689–1714) validates ownership, kind, status, size, and JPEG magic bytes, then stores the poster with no `moderate()` call.

**Verification:** CONFIRMED. Additional: at 1927 and 1992 a failed scratch write skips moderation and the bytes are **still** written to `media` (1959/2023) and become a library item; the quarantine `copy`/`remove` results (1678–1679, 1932–1933, 1997–1998) are unchecked, so `recordStrike(…, quarantine)` can reference evidence that does not exist.

**Failure:** "Moderated before dispatch/persistence" is not guaranteed during a configuration error or outage. A failed image signing step silently skips the image check. A user can upload an arbitrary JPEG as the poster of any finished video. Provider-native filters do not enforce the app's own strike/evidence policy.

**Fix:** Represent `allowed`, `blocked`, and `unavailable` distinctly. A required unavailable check returns readable 503 with no charge/dispatch and no strike. Require successful upload/signing before moderation; clean temporary objects in a reliable finally/outbox path. Validate response shape and quarantine writes. Document and implement a poster policy; prefer server-generated thumbnails from the already-vetted output if practical.

**Acceptance:** Missing key, 503, timeout, malformed response, and failed sign all block dispatch without charging/striking. Genuine flagged content is recorded once with existing quarantine evidence. Task T02.

### R11 — Account/library deletion does not reliably delete stored content

**P1 · Source-confirmed · Privacy and recurring storage cost**

**Evidence:** `fn_delete_account` (`0001_foundation_schema.sql:102–105`) deletes the profile; FK cascades remove ledger/generations/subscriptions/jobs/personas/devices rows. No migration touches `storage.objects`. The lapsed-library cron (`0013_personas.sql:103–115`, superseding `0003_billing.sql:16–27`) deletes `generations` and `personas` rows only. `deleteAccount` (`api/index.ts:634–661`) cancels Stripe subscriptions with `status:'active'` only (645–648), calls the RPC, deletes the auth user, and never enumerates Supabase Storage or R2 objects. `DELETE /generations/:id` (2035–2057) deletes the row first, then logs storage-delete failures and returns `{ok:true}`. Persona deletion (1806–1820) removes uploads with an un-awaited "best-effort cleanup" call. No deletion queue exists (`queue` appears in migrations only as `queue_position`).

**Verification:** CONFIRMED. Refinements: Stripe subscriptions in `trialing`, `past_due`, `unpaid`, or `paused` are **not** canceled and keep billing an orphaned customer — inconsistent with the webhook's own `alive` definition (`stripe-webhook:141,187`) which treats `trialing`/`past_due` as live. Apple: `deleteAccount` never touches `iap_original_transaction_id`; later App Store notifications for the deleted user hit "no user for iap transaction" (`appstore-webhook:74–79`) and are 200-acked, so refund clawbacks are silently dropped. Backend default mismatch: deletion defaults `storage_backend` to `'supabase'` (2047) while the thumb route defaults to `'r2'` (1708), guaranteeing an orphan for a null-backend row. **Product-spec conflict:** `vansen.md` §6 promises the lapse purge will "delete their Storage objects" with **no grace period**, while `CLAUDE.md` describes a 30-day grace; the code deletes rows only. The owner must choose one retention statement (section 3a).

**Failure:** Media, references, training ZIPs, and quarantine objects can outlive deleted accounts or library records. Failed object deletion loses its database pointer for retry. Existing signed links remain usable until expiry. Deleting a pending job can destroy the information needed to settle/refund it.

**Fix:** Introduce deletion tombstones/outbox entries before losing ownership/path information. Delete each backend's objects with retries and auditable completion. Define treatment for pending provider work and retained financial/moderation records; reconcile policy wording with actual retention. Account deletion must handle every live Stripe status and Apple subscriptions correctly. Never implement bulk production cleanup without a reviewed inventory/dry run.

**Acceptance:** Synthetic account deletion proves media/upload/R2 cleanup, bounded retries, and correct pending-job settlement; retained records match the approved policy. Task T08.

### R12 — Logout cleanup depends on where logout happens

**P1 · Source-confirmed · Shared-device privacy**

**Evidence:** `AuthService.signOut` (`auth-service.ts:58–60`) only calls Supabase sign-out. Four sign-out paths reset different state: workspace (`workspace-page.ts:819–830`) resets ledger, generation store, profile, notifications, edit session, ONNX caches, and media cache; settings (`settings-page.ts:88–91`) only signs out and navigates; profile deletion (`profile-tab.ts:82–96`) resets profile, ledger, and generation store but not notifications, edit session, ONNX caches, or media cache; onboarding (`onboarding-page.ts:84–88,99–101`) resets profile only. Sixteen `providedIn:'root'` services hold user state.

**Verification:** CONFIRMED with a wording correction: media object URLs **are** cleared on the workspace path (`media-cache.ts:57–64`) and only there. Additional gaps: `PersonaStore.reset()` (`persona-store.ts:65–70`) is never called anywhere and its training `setInterval` (74–81) survives sign-out; `JobPoller.stop()` (`job-poller.ts:41–44`) is never called on sign-out, so a pending-job timer keeps hitting `/jobs` after logout; `EditSession.smallBase` (`edit-session.ts:26`) is not cleared in `close()`; `PreferencesService` (`preferences-service.ts:39`) is never reset.

**Failure:** After logout from settings, onboarding, or account deletion, the previous user's profile/library/editor/notification/persona data can remain resident and briefly appear, or persist on a failed refresh, during the next login. In-flight requests and live pollers can repopulate state after a reset.

**Fix:** One session-lifecycle service handles explicit sign-out, auth expiry, account switch, and deletion. Stop pollers; invalidate a session epoch; close editors; reset every user-specific store including personas and preferences; revoke media URLs; clear owned snapshots. Bind request completions and persistence to the initiating UID/epoch.

**Acceptance:** A → sign out through every entry point → B while A's request is delayed: no A content/balance/notification is rendered or persisted under B. No timer started under A fires after sign-out. Task T09. Mobile counterpart: **M07 / MT-05**.

### R13 — Web edit operations can mutate a newly opened image

**P1 · Reproduced · Editor correctness/data loss**

**Evidence:** `EditSession.apply` (`edit-session.ts:105–116`) reads `this.engine.current` (109), awaits `run(op)` (110), then `this.engine.push(next)` (111) without an identity check — unlike `applyEngine` (178–180) and `applyHeal` (216/231), which do guard. `close()` (93–103) does not bump `previewToken` or `renderSeq`, so in-flight `refreshPreview` (326–335) and `previewOp` (126–132) repopulate signals after close. `open()` (63–75) has no latest-open token. In `tool-options.ts`, `runErase` (508–517) sizes a mask to a buffer captured before an await, and `selMask` (557–587) is consumed later with no dimension check and is not cleared on session change. The workspace auto-open effect (`workspace-page.ts:231–249`) calls `enterEdit` with no `dirty()` check. No `canDeactivate`/`beforeunload` exists; the only unsaved-edit protection is the `confirm()` in `exitEdit()` (556).

**Verification:** CONFIRMED. Additional and severe: `close()` calls `worker.terminate()` (101) while pending `dispatch` promises (288–308) are still listening on that worker; they never settle, and because `opQueue` (276–283) chains on them, **every subsequent operation on any later session hangs until page reload** and `busySig` stays true. If `close()` ran mid-`apply`, line 111 throws a TypeError on a null engine with no catch.

**Failure:** Closing/switching while a task runs can apply old pixels to the new image. Terminating a worker wedges the shared operation queue. A late image decode, preview, or AI result can overwrite newer work. Local edits made during an AI job's flight are silently discarded on auto-open.

**Reproduction:** Start an operation on A, close, open B, await A's operation: item is B, pixel is A's, dirty=true.

**Fix:** Increment a session epoch on every open/close. Capture engine + epoch for every operation and every decoded/rendered result. Discard stale results before mutation. Reject/drain terminated-worker requests, reset the queue, and track request IDs. Add dirty-navigation protection for route changes, reload, image switching, and AI auto-open. Freeze the saved revision while a save runs so a later edit is not incorrectly marked saved.

**Acceptance:** Delayed A work never changes B; close during a worker operation cannot wedge future edits; unsaved changes require an explicit save/discard decision. Task T10.

### R14 — Mobile reuses one image's edit buffer for another

Moved to the companion document as **M02 / MT-02**. No backend dependency.

### R15 — Retry/variation loses the original operation context

**P1 for exposed retry paths · Source-confirmed**

**Evidence:** `onRetry` (`workspace-page.ts:666–684`) sends `familyId, op, prompt, settings, batch:1, parentId`. Not restored: `maskPngBase64` (edit-tool retries hit "requires a mask" at `api/index.ts:1104–1106`); `referenceUploadId`/`referencePaths` (video i2v/ref2v/keyframes retries hit `bad_reference_count` at 940–947); style/persona/trend — the server stamps them into `settings` (1170–1172) but `sanitizeSettings` strips them on the way back in and the server reads them only from top-level fields (1031–1033). Persona items are stored with `familyId='persona'`, so retrying without `personaId` fails `invalid_family` (1113–1114). `onVariation` (519–534) sends no `parentId`. `toGenerationDto` (357–377) has no `error` field; `fn_fail_job` writes the error only to `jobs.error`.

**Verification:** CONFIRMED. Refinement: the client never displays error text; `library-grid.html:83` only tests `item.error === 'cancelled'`, populated locally by `generation-store.ts:128–138`. Concrete consequence: after reload, a cancelled video renders as "Generation failed … Retry" (88–107) instead of "Cancelled · Refunded". Also: variation of an `edit-*` item → 400 `invalid_op` (1103); of a persona item → `invalid_family`; of an i2v video → `bad_reference_count`.

**Failure:** Failed Fill/Remove retries omit the mask and fail again. Video i2v/keyframe retries omit references. Persona retries fail outright. "Variation" becomes unrelated text-to-image. A cancellation becomes a generic failure after reload.

**Fix:** Persist a versioned normalized request snapshot server-side, including owned reference identities and mask object identity, never expiring signed URLs. Add server retry/variation operations with explicit semantics and a fresh quote. Return safe failure code/message and cancellation status; keep raw provider errors internal. Disable retry/variation where the operation cannot mean what the control says and explain why.

**Acceptance:** Retry tests for every exposed operation prove identical intended inputs, new idempotent request identity, correct quote, and truthful failure/refund copy. Task T12.

### R16 — The library silently truncates history and overfetches media

**P2 · Source-confirmed · Scalability/usability**

**Evidence:** `GET /generations` `.limit(200)` (`api/index.ts:768`) and `/ledger` `.limit(100)` (757), no cursor/offset. `generation-store.ts:69–70` and `ledger-service.ts:33–34` set the arrays wholesale and persist them to local cache (75–77). Cards render the original via `<img [cachedSrc]="item.mediaUrl">` (`library-grid.html:147`); `thumbUrl` exists only for video posters (`api/index.ts:369`). `media-cache.ts` object-URL map (16) is pruned only by `evict(id)` and `clear()`; Cache Storage has no size/age logic.

**Verification:** CONFIRMED.

**Failure:** Older paid content/history becomes unreachable through the UI, parent chains appear incomplete, and a large library downloads/decodes many full-resolution images on entry.

**Fix:** Cursor pagination with stable `(created_at,id)` order, server-side filters, ID lookup for deep links/version chains, actual thumbnails, viewport-driven loading, bounded object-URL retention, and a user-scoped cache eviction policy. Preserve originals for edit/export only.

**Acceptance:** A 500-item seeded library exposes every item exactly once across pages, can open an old deep link, and does not fetch full originals for offscreen thumbnails. Task T13. Mobile counterpart: **MT-07**.

### R17 — Editing and video memory are insufficiently bounded

**P2 · Source-confirmed risk; device performance unmeasured**

**Evidence:** `edit-engine.ts:3` `MAX_HISTORY = 20`, enforced on `past` only (27–32); `future` is cleared only on push, so after 20 undos up to 20 past + present + 20 future = **41** full snapshots can be resident (at 4096² RGBA, 64 MiB each, about 2.6 GiB). `MAX_UPSCALE_PIXELS = 4096 × 4096` (`engine-status.ts:20`, checked at `upscale-engine.ts:35`); the output allocation (41–45) is 268 MB for a maximal input. `storeVideoResult` (`api/index.ts:472–497`) buffers the whole video with `arrayBuffer()` (495). `PreviewScheduler` (`preview-scheduler.ts:16–24`) coalesces only while a frame is queued; once the rAF fires, `run()` is fire-and-forget, so a second `schedule()` during a long run starts a concurrent run. Bokeh (`bokeh-engine.ts:72–98`) composites over the full-resolution buffer, and its preview (`tool-options.ts:525–546`) runs on `session.current()` rather than the ≤1100 px proxy.

**Verification:** PARTIALLY CONFIRMED. The video-buffering framing was wrong: buffering is **deliberate** — `_shared/storage/types.ts:6–7` documents `put(path, body: Uint8Array)` with "callers buffer first" because R2 S3 PutObject rejects chunked transfer encoding. The actual defects are the stale word "streams" in the comment at 476 and the absence of any `Content-Length`/size cap before `arrayBuffer()`. History undercount corrected (41, not 21).

**Fix:** Budget history by bytes across past and future, bound input/output dimensions before allocation, use latest-only preview backpressure with one active plus one replacement computation, move expensive CPU preprocessing off the UI thread, run bokeh preview on the proxy, and cap provider downloads by declared and observed size using a bounded transfer path (multipart or a file-backed worker) that is proven compatible with R2 signing. Add request deadlines and cancellation. Benchmark actual supported devices before choosing final limits.

**Acceptance:** Defined device matrix passes memory and responsiveness thresholds in section 6; a canceled/closed session releases retained resources. Video transfer is bounded and rejects oversize/truncated outputs before `done`. Task T14. Mobile counterpart: **M08 / MT-08**.

### R18 — ML loading/cache failures lack a reliable recovery contract

**P2 · Partly reproduced · Local tools**

**Evidence:** Every engine uses a mutable `/resolve/main/` weight URL (`heal-engine.ts:20`, `deblur-engine.ts:14`, `cutout-engine.ts:14`, `bokeh-engine.ts:15`, `select-engine.ts:14,16`, `upscale-engine.ts:13`). `model-loader.ts:15,32` memoizes sessions permanently (deleted only on failure, 28–31); up to seven ONNX sessions stay resident until reload. `caches.open()` at `model-loader.ts:54` is outside the `try` at 83–87, so a `SecurityError` in private/opaque contexts fails the engine load instead of falling back to network. The cache is keyed by the mutable URL (55, 84), so an upstream rotation is never re-fetched. `MediaCache.blob` (`media-cache.ts:23–33`) has unguarded `caches.open` and `cache.put`; a quota error rejects the whole call even after a successful fetch, which blocks `EditSession.open` (`edit-session.ts:66`) and download (`workspace-page.ts:483`, which then shows a misleading "link may have expired" notice), while `CachedSrc` (`cached-src.ts:26–33`) falls back for `<img>`.

**Verification:** CONFIRMED.

**Failure:** Storage-disabled/private/quota-limited devices can display an image but fail to edit or download it. Model updates can silently change the inference contract. First-use/offline failures and resource leaks are not covered by real-engine tests.

**Fix:** Best-effort caches that return fetched bytes even if persistence fails; versioned/hash-checked model manifests pinned to immutable revisions; validated tensor names/types/shapes; explicit CPU fallback and retry/cancel states; a session release/eviction API. Expose download sizes and progress. Keep the small licensed model variants already required by project rules.

**Acceptance:** Cached offline success, first-use offline failure, denied Cache Storage, corrupted download, GPU failure, and repeated enter/exit are tested; real inference uses approved fixture images. Task T14. Mobile counterpart: **M08 / MT-08**.

### R19 — Mobile cannot correctly consume the current video product

Moved to the companion document as **M03 / MT-03**. Backend dependencies: T05 (versioned shared catalog export including Dart) and T12 (DTO gains job/poster/failure metadata).

### R20 — Mobile push is wired to a no-op implementation

Moved to the companion document as **M04 / MT-04**. Backend note: the send half exists (`_shared/push.ts`, `POST/DELETE /devices`, `notifySettled`) but fires only from the polling path; T07's settlement outbox is the durable trigger the mobile client depends on.

### R21 — Billing routing uses device locale instead of store eligibility

**P1 · Source-confirmed · Mobile distribution (backend half)**

**Evidence:** `_shared/billing-lanes.ts:11–20` routes `android → 'A'`, `storefront === 'US' → 'A'`, EU set (6–9) → `'A'`, otherwise `laneBEnabled ? 'B' : 'C'`. Inputs are a two-value platform string and a caller-supplied country code; there is no entitlement/program/eligibility input. Tests (`billing-lanes_test.ts:4–30`) assert exactly this, including `laneFor('android','') → 'A'`. `GET /billing/lane` (`api/index.ts:1454–1459`) maps anything other than `'ios'` to `android` and defaults storefront to `''`, so a client that cannot determine its platform is routed to external checkout. `POST /billing/subscribe` (1252) and `/billing/pack` (1303) contain no lane/platform/storefront check — the lane is advisory only.

**Verification:** CONFIRMED for the backend. The device-locale defect is in the Flutter client (**M05**). Additional: no Angular consumer of `/billing/lane` exists; it is mobile-only.

**Fix:** Combine platform/storefront with a server-owned configuration of approved programs, entitlements, OS/app version, and supported billing rails. Enforce the lane server-side on `/billing/subscribe` and `/billing/pack` for mobile clients. Default unknown/ineligible cases to a safe non-purchasing state or supported store billing.

**Policy boundary:** Apple permits US external calls to action under current guidelines, but regional programs and EU requirements have additional conditions [S2–S3]. Google Play generally requires its billing system for digital goods except applicable exceptions/programs [S4]. This finding is about incorrect eligibility detection and missing enforcement, not a guarantee of store rejection.

**Acceptance:** Unknown platform or storefront is not treated as Android/US; server refuses a Stripe checkout for a client whose lane is B or C; actual signed binaries and store-console enrollment match every enabled lane (**MT-01 / MT-04**). Task T03/T04-backend.

### R22 — Mobile release configuration and auth capabilities need completion

Moved to the companion document as **M06 / MT-04**. Backend dependency: Supabase Auth redirect allow-list and Apple Sign-In configuration are release-checklist items in T19.

### R23 — Sales copy contradicts grants, entitlements, and catalog

**P1 · Browser/source-confirmed · Purchase expectations**

**Evidence:** `plans-page.html:14–15` reads "…for their first 60 days, full credit grant included"; `plans-page.ts:150` FAQ states "1,500 on Studio, 3,750 on Pro" with no promo caveat. `stripe-webhook/index.ts:59–65` `cycleGrant` computes `ratio = (subtotal − discount)/subtotal` and `round(PLAN_CREDITS[plan] × ratio)`: $10 Studio on $15 → 1,000; $25 Pro on $30 → 3,125 (the function's own doc comment at 52–54 states these numbers). `right-panel.ts:72–85` `PRO_TOOLS` locks select/upscale/aisharpen/bgremove/bokeh/enhance/levels/clone/retouch/perspective/liquify/erase behind `proLocked` (234), and the in-app Pro pitch (110) lists "Cut Out, Bokeh, Upscale, AI Sharpen, Magic Erase" as Pro. Contradicting copy: `plans-page.ts:118` (Studio perk) "Full on-device editing suite, free and unlimited"; `plans-page.ts:168` FAQ "cut out, bokeh, upscale … free and unlimited on every plan"; `landing-page.html:132–133` "full editing suite … included with every plan"; `landing-page.ts:107–109,124`. Sora remains at `plans-page.ts:134`, `login-page.html:14`, `site-footer.html:29`; `0016_video.sql:26` deletes the `sora` model row and the Angular catalog has no Sora family (guarded by `model-families.spec.ts:114–117`).

**Verification:** CONFIRMED. **Product-spec conflict:** `vansen.md` §5 states the decided promotion as "first 2 cycles $10 / $25 **with full credit grant**". The spec and the public copy agree; the **code** deviates. The original plan text recommended keeping the discount-scaled grants; that recommendation is withdrawn — the default should be to make the code match the decided spec, unless the owner explicitly re-decides the promotion (section 3a, decision D1).

**Fix:** Resolve D1 first. If the spec stands, change `cycleGrant` to grant the full plan credits for launch-coupon invoices while still scaling for other partial-payment cases, update the financial tests, and keep the copy. If the owner re-decides to scale grants, change the pricing copy and FAQ to exact numbers. Either way: list Studio vs Pro tools explicitly on pricing and landing, generate family lists from the enabled catalog, and remove Sora. Say "20% lower effective cost per credit" where that is what is meant; the job's numeric credit charge does not vary by plan.

**Acceptance:** Public pricing, checkout, account plan summary, actual grant, model selector, and tool access agree for Studio, Pro, launch promotion, renewal, downgrade, and lapse. Task T05/T17.

### R24 — Password recovery and confirmation recovery are missing

**P1 for email/password launch · Source-confirmed/browser-confirmed**

**Evidence:** `auth-service.ts:33–60` exposes `signInWithOAuth`, `signInWithPassword`, `signUp`, `updateUser({password})` (requires a live session; called only from `profile-tab.ts:71`), and `signOut`. There is no `resetPasswordForEmail`, `resend`, or `verifyOtp`. `app.routes.ts:7–58` has no reset/recovery/callback route. A repository-wide search of `src/app` and `api/index.ts` for reset, recovery, forgot, or resend returns nothing.

**Verification:** CONFIRMED.

**Failure:** Paying email/password users who forget their password cannot self-recover through the app. A lost confirmation email leaves signup recovery unclear.

**Fix:** Add reset request, recovery callback route, validated password update, expired-link/resend handling, generic anti-enumeration responses, rate limits, and clear successful return to sign-in. Use the auth vendor's supported token handling; never log recovery tokens.

**Acceptance:** Web verified flows for valid, expired, reused, and wrong-device links, without account-enumerating copy. Task T18. Mobile counterpart: **MT-06**.

### R25 — Video reference slots can change meaning when filled out of order

**P1 for keyframe mode · Source-confirmed**

**Evidence:** `reference-drop.ts:94–98` `place()` assigns `next[index] = slot` then emits `next.filter(Boolean)`; `clear()` (100–103) filters by index so clearing the first frame promotes the last frame to index 0. The UI relabels via `visible()` (43–51). Server semantics are positional: `types.ts:22` "keyframes: [first, last]"; `fal.ts:48–49` `image_url = refs[0]`, `tail_image_url = refs[1]`; `google-video.ts:33–34` `image = refs[0]`, `lastFrame = refs[1]`; the client emits `refSlots().map(s => s.path)` in array order (`left-panel.ts:455`).

**Verification:** Slot compaction CONFIRMED. The aspect claim was OVERSTATED: `left-panel.ts:263–266` hides the aspect control only for `i2v` and `keyframes`, exactly as `vansen.md` §7 specifies; ref2v/extend/edit still show it. The real gap is on the adapter side: Veo (`google-video.ts:47`), Omni (`google-omni.ts:33`), and Runway (`runway.ts:49`) send `aspectRatio` unconditionally in every mode, so on i2v a hidden and possibly stale value is still transmitted; only Kling/Seedance (`fal.ts:47`) gate it to t2v.

**Failure:** Filling the end-frame slot first moves it to the first-frame position. Clearing the first frame relabels the last as first. A hidden aspect value can be sent to Veo/Omni/Runway in modes where the input frame should dictate shape.

**Fix:** Use semantic fixed slots (`firstFrame`, `lastFrame`) or preserve null positions until serialization; validate completeness by mode. Build the final provider order explicitly. Make adapters omit `aspectRatio` in modes where the frame dictates it, per family capability. Decide whether library images should be selectable as video references and implement ownership-safe IDs if included (`vansen.md` records the "From library" picker as deliberately cut).

**Acceptance:** End-frame-first, clear-first, replace-last, and concurrent uploads retain correct roles. Adapter tests prove no `aspectRatio` is sent for i2v/keyframes on any family. Task T12.

### R26 — Assets, accessibility, and localization are incomplete

**P2, except absent promised locales may block the target market · Source-confirmed/release gate**

**Evidence:** `trend-presets.ts:23` binds `/trends/${id}.webp`; `trend-gallery.html:18` renders it; `public/` contains only `logos`, `styles`, and `favicon.ico`. `detail-overlay.html:1–3` is a plain backdrop/panel with no `role="dialog"`, `aria-modal`, or `aria-labelledby`; `detail-overlay.ts:67–69` handles Escape but never moves or restores focus. `library-grid.html:173–179` variation button has only an icon and no `aria-label` (its siblings Download/Delete/Edit do); the card container (63–67) is a `<figure>` with a click handler and no `tabindex`/`role`/keydown. No `@angular/localize` or i18n config exists in `package.json`/`angular.json`.

**Verification:** CONFIRMED. Context: six sibling dialogs (cancel-flow, plan-change, video-picker, persona-manager, credit-packs, tour-overlay) **do** declare `role="dialog" aria-modal="true"`, so detail-overlay is the inconsistent one. `vansen.md` already acknowledges both the missing trend thumbnails (`scripts/gen-trend-thumbs.mjs`, ~$0.50 OpenAI) and that i18n (en + ms) is "not started".

**Fix:** Supply licensed/approved trend assets or hide the unfinished surface behind a capability flag; add deterministic missing-asset checks and a visual fallback. Use accessible modal/focus primitives, keyboard-openable cards, meaningful labels, and clear async announcements. Decide the launch locale set (section 3a, D4); if en/ms remains promised, add language selection/locale loading, format numbers/dates/currency, and check text expansion. Preserve the current visual arrangement.

**Acceptance:** No broken asset requests; keyboard and screen-reader navigation through library/detail/editor; if promised, Malay selection actually changes text and persists. Task T17.

### R27 — Release automation, deployment reproducibility, and telemetry are incomplete

**P2 with mandatory release gates · Source-confirmed**

**Evidence:** No `.github/` directory; no `supabase/config.toml`; `0008_age_gate.sql` and `0008_credit_plans.sql` share a prefix; deployed database history was not compared. Existing Deno tests cover shared helpers and video adapters only (section 2). `ApiService.handle` (`api-service.ts:118`) always parses successful responses as JSON while `POST /errors` returns `c.body(null, 204)` (`api/index.ts:807`). `fetch` calls at `api-service.ts:103–114` and `postForm` (80–86) have no `AbortSignal.timeout`. `api/index.ts` is 2,059 lines.

**Verification:** CONFIRMED; the 204 impact is narrower than implied: `/errors` is the only 204 route and its sole caller (`error-reporter.ts:20–26`) swallows the rejection, so today the report is persisted and the client merely sees a spurious rejected promise. It remains a latent hazard for any future empty-success endpoint, and the 408/504 copy in `api-service.ts:35,42` is dead in practice.

**Fix:** Reproducible web/Deno CI, gateway/DB integration tests, catalog drift checks including the Dart export, fresh-database and existing-schema migration tests, deployment artifact/version manifest, staged rollout/rollback instructions, and dashboards/alerts for unfulfilled purchases, stuck jobs, provider expense, missing media, and deletion retries. Handle 204 explicitly and add deadlines without blindly retrying non-idempotent POSTs.

**Acceptance:** All release gates in section 8 run against the exact release revision; injected operational failures produce actionable request IDs/metrics. Task T01/T19.

### R28 — Upload-as-reference is rejected for every image model

**P1 · Source-confirmed (new in re-verification) · Core product correctness**

**Evidence:** `workspace-page.ts:355–359` sets `op = Edit` whenever `referenceId || referenceUploadId` is present. For an **uploaded** reference there is no `referenceId`, so `parentId` (371: `req.videoParentId ?? req.referenceId ?? undefined`) is `undefined`. The gateway then fails at `api/index.ts:1046–1048`: `if ((op === Edit || op === Upscale) && !parentId) return fail(c, 400, 'invalid_parent', …)`. The `referenceUploadId` signing branch (1160–1163) is therefore unreachable from the web client for image families; only library-image references (`referenceId` → `parentId`) work.

**Failure:** A user who uploads a photo as a reference for Nano Banana, GPT Image, FLUX, or Seedream gets a 400 before any charge. The feature is advertised in the composer and does nothing. This also explains why R01's unchecked path has had no traffic.

**Fix:** Decide the intended contract: either (a) an uploaded reference means `op = Generate` with an owned reference attachment, and adapters send it on generate (today only the OpenAI edit/upscale branch and fal edit tools consume `referenceUrl`), or (b) uploads are first imported as library items and then referenced by `parentId`. Implement one, remove the `invalid_parent` mismatch, and add a route test plus an adapter contract test per image family that proves the reference reaches the provider payload. Apply R01's ownership rules on the same change.

**Acceptance:** Uploading a reference and generating with each image family produces one charge and one provider request that contains the reference; the request is rejected with a readable message when the upload is foreign, missing, or unmoderated. Task T02/T05.

## 3a. Product-spec alignment and owner decisions

The findings above were checked against `vansen.md` (product spec) and `CLAUDE.md`. Where code, spec, and copy disagree, the owner must decide; the plan defaults are stated so work is not blocked.

| ID | Conflict | Where | Default in this plan |
|---|---|---|---|
| D1 | Launch promo credit grant: spec and pricing copy say **full grant**; `cycleGrant` scales to 1,000 / 3,125 | `vansen.md` §5; `plans-page.html:15`; `stripe-webhook:59–65` | Make code match spec (full grant on launch-coupon invoices). R23, T03/T17. |
| D2 | Lapse retention: `vansen.md` §6 says purge storage **with no grace**; `CLAUDE.md` says **30-day grace**; code deletes rows only, never objects | `vansen.md:152–163`; `CLAUDE.md:27`; `0013_personas.sql:103–115` | Keep the 30-day grace already implemented in the cron, add object deletion, and correct `vansen.md`. R11, T08. |
| D3 | "You can leave this page. We'll notify you" is promised but completion depends on an open client | `vansen.md` §7; workspace video waiting UX | Remove the copy until T07 ships a worker; then restore it. R06. |
| D4 | Localization: spec promises en + ms; web has no i18n; mobile bundles `ms.json` but hardcodes `en` | `vansen.md:254,285` | Owner chooses English-only launch (update spec and store listings) or funds T17 locale work. R26 / **M09**. |
| D5 | Library references for video slots: spec records the "From library" picker as cut; code has no ownership-safe ID for it | `vansen.md:288` | Keep uploads-only for first release; say so in the composer. R25, T12. |
| D6 | Push completion notifications: spec says shipped on the backend; mobile client is a no-op and the trigger is polling | `vansen.md:313–316` | Do not advertise notifications on either platform until T07 + **MT-04** pass. R06/R20. |
| D7 | Video rollout: `vansen.md` and `CLAUDE.md` say code-complete, nothing live; deployed state not inspected in this review | `vansen.md:268–276` | Treat as not live; Gate D confirms from the dashboard before enabling any family. |

Already acknowledged as open in `vansen.md` (no new decision needed, but they remain release work): trend thumbnails missing, persona live smoke never run, i18n not started, dispatch rate limiting not started, legal pages awaiting attorney review.

## 4. Tool and feature completeness matrix (web)

"Implemented" below means a source path exists. It does not mean visual quality has been certified on every device. The mobile column and mobile parity notes live in the companion document (section 4 there).

| Capability | Web | Required proof or correction |
|---|---|---|
| Crop/rotate/flip/straighten | Implemented (`ops/transform.ts`) | Non-square images, edge crops, orientation, masks after resize, correct session isolation |
| Adjust | Implemented with proxy previews | Preview/apply parity, alpha preservation, save baseline, stale results |
| Filters | 17 presets | Golden fixtures for endpoints/intensity; duotone colorA/colorB; clarity precompute |
| Sharpen/smooth | Implemented | Flat images, edge halos, alpha; do not confuse sharpen with ML deblur |
| Spot Heal | MI-GAN plus PatchMatch fallback | Masked-region-only changes, offline fallback quality, session cancellation |
| Dehaze/portrait smooth | Implemented | Halos/skin detail and zero-strength identity |
| Enhance/levels | Pro tools | Histogram/black-white-gamma behavior, entitlement copy |
| Clone/retouch/liquify | Pro tools | Brush coordinates under zoom/pan, one stroke = one undo, canceled strokes |
| Perspective | Pro tool | Output bounds, correct crop, preview/apply geometry |
| Smart Select/Magic Erase | SlimSAM + heal | Positive/negative clicks, correct mask orientation, old-image result rejection, mask/buffer dimension guard (R13) |
| Cut Out | ISNet fp16 | Hair/translucency/alpha fixtures, float16 contract, save/export alpha |
| Bokeh | Depth Anything V2 + blur | Correct focus coordinate after crop/zoom, depth fixture, preview on proxy not full-res (R17) |
| Local AI Upscale | Swin2SR 2× | Pixel ceiling, seam/edge fixtures, actual 2× dimensions, 268 MB output budget (R17) |
| AI Sharpen | NAFNet deblur | Real runtime fixture, no seams, CPU/GPU fallback, bounded model memory |
| AI Remove/Fill/Expand/Background | fal FLUX-fill + BiRefNet | Durable paid job, mask preservation on retry (R15), no premature success/refund |
| Image generation | Implemented | Repair model/version/resolution fulfillment (R04) and upload-reference path (R28) before paid release |
| Video generation/library | Current controls; not live | R06, R08, R09, R25; actual per-provider smoke before enabling any family |
| Persona training/generation | Implemented, client-polled | Durable training (R06), photo deletion (R11), slot races (R09), retry keeps persona (R15), actual paid smoke |
| Styles/trends | Implemented, trend assets missing | Missing assets (R26), prompt/request persistence (R15) |
| Notifications | Local notification store + polling-triggered push | Durable completion outbox (R06) before advertising |
| Password recovery | Missing | R24 |
| Denoise/Colorize | Intentionally deferred | P3; keep licensing gate |

## 5. Implementation sequence

Estimated size is planning guidance, not a delivery promise: **S** = contained change, **M** = several focused changes, **L** = subsystem work requiring integration tests. Most money/job tasks are L. Do not substitute a broad rewrite for these bounded repairs. Tasks that were mobile-only (former T04, T11, T15, T16) now live in the companion document as MT-01…MT-04; their backend prerequisites are listed inline below.

**Detailed implementation plans (written 2026-09-20).** Each task below is expanded into a step-by-step plan with complete code, exact commands and expected output. Start from the index, which carries the dependency graph, the migration numbering and the blocking decisions.

| Plan | Covers | File |
|---|---|---|
| Index | sequencing, findings map, decisions | `2026-09-20-release-hardening-index.md` |
| P1 | T01, T02 | `2026-09-20-release-hardening-p1-gateway-and-input-integrity.md` |
| P2 | T03 | `2026-09-20-release-hardening-p2-billing-fulfillment.md` |
| P3 | T05 | `2026-09-20-release-hardening-p3-catalog-and-provider-contract.md` |
| P4 | T06 | `2026-09-20-release-hardening-p4-job-settlement.md` |
| P5 | T07 | `2026-09-20-release-hardening-p5-durable-dispatch.md` |
| P6 | T08 | `2026-09-20-release-hardening-p6-durable-deletion.md` |
| P7 | T09, T10, T13, T14 | `2026-09-20-release-hardening-p7-web-client-correctness.md` |
| P8 | T12, T17, T18 | `2026-09-20-release-hardening-p8-product-truth-and-recovery.md` |
| P9 | T19 | `2026-09-20-release-hardening-p9-release-gates.md` |

P1 comes first in every case: it builds the test seam the other eight depend on. Only P9 changes production.

### T01 — Establish a testable gateway and release test harness (M)

**Covers:** R27; prerequisite for T02–T08 and T12.

**Files:** Modify `supabase/functions/api/index.ts`; create `api/app.ts`, `api/app_test.ts`, `api/testing/fakes.ts`; add `supabase/config.toml` and `supabase/tests/` only after checking the deployed migration inventory. Keep the bootstrap as environment composition + `Deno.serve`.

**Interface:** `createApp(deps: ApiDependencies)` produces a Hono app for `.request(...)`. Dependencies expose authenticated user resolution, data repository, object storage, provider registry, moderation, clock, and event sink. Production adapters wrap existing services. Test fakes expose call records and a named failure injection point. Keep the existing REST paths stable.

- [ ] Write route characterization tests: no token → 401; age-unconfirmed → 403 on protected operations; foreign generation → 404; malformed JSON → readable 400; empty successful response → client success.
- [ ] Run `deno test --allow-all api`; prove the new factory seam is missing (RED), then extract without changing business behavior.
- [ ] Add an integration database seeded only with synthetic users, balances, models, and jobs. Assert service-role-only RPC access and deny direct authenticated table reads.
- [ ] Make the characterization suite pass; rerun existing 40 shared tests and `deno check` on all entrypoints.

Example initial web regression in `api-service.spec.ts`:

```ts
it('accepts a successful empty response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  TestBed.configureTestingModule({
    providers: [{ provide: API_TOKEN_PROVIDER, useValue: async () => 'test-token' }],
  });
  await expect(TestBed.inject(ApiService).post('/errors', { message: 'test' }))
    .resolves.toBeUndefined();
});
```

**Exit:** Gateway routes can be tested without binding a server, using real handler logic and fake provider/storage boundaries; DB tests can prove transactions rather than mock them away.

### T02 — Enforce input ownership, moderation, and capability validation (M)

**Covers:** R01, R09 validation, R10, R28 contract decision.

**Files:** Create `api/services/reference-resolver.ts`, `api/services/request-validation.ts`, their `_test.ts` files, and a new additive upload-metadata migration. Modify `_shared/moderation.ts`, `_shared/providers/types.ts`, gateway upload/generation/import/save/thumb routes, and `workspace-page.ts:355–371` for the reference contract.

**Interfaces:** `resolveOwnedReference(userId, uploadId, purpose)` returns verified object identity/MIME/dimensions or a typed domain error. Moderation returns a discriminated result:

```ts
type ModerationDecision =
  | { state: 'allowed' }
  | { state: 'blocked'; categories: Record<string, number> }
  | { state: 'unavailable'; retryAfterSeconds: number };
```

- [ ] Write failing route tests for a second user's upload ID, quarantine path, missing object, pending/video parent on an image edit, unsupported settings combination, oversized mask, and invalid/decompression-heavy image dimensions. Assert zero charges and provider calls.
- [ ] Write a failing route test for upload-as-reference on each image family (R28): today it returns `invalid_parent`; after the fix it must charge once and reach the adapter with the reference.
- [ ] Add moderation tests for missing key, rejected fetch, 503, malformed JSON, missing image URL, failed scratch upload, and failed quarantine copy. These must return unavailable or fail closed, not allowed.
- [ ] Implement canonical reference resolution and metadata persistence, family-level validation of version/resolution/duration, pre-allocation dimension limits, and readable domain errors.
- [ ] Require moderation completion before a request can become dispatchable; failures do not create strikes. Record blocked evidence once, after the quarantine write succeeds. Add the poster policy.
- [ ] Run the new route/shared tests and DB ownership tests; confirm normal image/video/persona paths still accept valid owned references.

**Exit:** Every path from user content to provider/storage crosses the same ownership and moderation rules, and uploaded references work for image models.

### T03 — Make Stripe and Apple fulfillment transactional (L)

**Covers:** R02; R21 server-side lane enforcement; D1 grant rule. Prerequisite for **MT-01**.

**Files:** New additive billing transaction migration and `supabase/tests/billing_transactions.sql`; create `_shared/billing-fulfillment.ts` and `_test.ts`; modify both webhook entrypoints, `_shared/iap-grants.ts`, `/iap/verify`, `/billing/lane`, `/billing/subscribe`, `/billing/pack`.

**Interface:** A single fulfillment RPC consumes verified `source`, business transaction ID, user ID, product/plan, effective period, grant amount, and event timestamp. It returns `{applied, credits, entitlement}`. Event delivery markers and business transaction uniqueness are separate. Never trust client-provided grant values. `/iap/verify` returns `applied | already_applied | retry_later`.

Required state rules:

```text
BEGIN
  lock the user's billing state
  if business transaction already applied: return stored result
  validate entitlement period and transaction ordering
  apply ledger movement and entitlement update
  insert applied business transaction and processed event
COMMIT
```

- [ ] Reproduce the existing IAP "marker inserted, grant failed, retry skipped" defect as a retained test, including the Apple outer-catch path that deletes the UUID row but not the `iaptx:` marker.
- [ ] Add concurrent duplicate invoice/client/webhook cases and inject failure after every write, including between `upsertIapSubscription` and the grant. A repeated business transaction must never reset spent credits again.
- [ ] Add old/expired/revoked receipt and out-of-order renewal tests. A valid signature alone must not reactivate expired entitlement; stale events cannot overwrite a newer paid period.
- [ ] Distinguish `23505` from operational errors in both webhooks; return 5xx for retryable processing failure; only a known processed duplicate gets a successful duplicate response. A `payment`-mode amount mismatch must not consume the event id silently.
- [ ] Implement the D1 grant rule in `cycleGrant` with a test per case: launch coupon (full grant), proration, no discount.
- [ ] Enforce lane on `/billing/subscribe` and `/billing/pack` for mobile clients; unknown platform/storefront is not Android/US.
- [ ] Add a read-only reconciliation report for paid-unfulfilled transactions and document any proposed repair separately. Do not adjust historical balances automatically.
- [ ] Run SQL integration tests plus webhook signature/route tests. Verify test-mode checkout, renewal, pack, upgrade, downgrade, cancellation, restore, refund, and replay before live keys.

**Exit:** Exactly-once credit effects are proven under concurrency and process failure, not inferred from a unique event row.

### T04 — Mobile purchase delivery and billing lanes

Moved to the companion document as **MT-01**. Backend half is in T03.

### T05 — Align catalog, quotes, and provider requests (L)

**Covers:** R04, R28 adapter half; supplies **MT-03** and T17.

**Files:** Modify `src/app/core/catalog/model-families.ts`, `_shared/providers/openai.ts`, `fal.ts`, `google.ts`; create image-adapter contract tests (`openai_test.ts`, `google_test.ts`, fal image cases) and a versioned catalog schema/export script; extend `scripts/sync-shared.mjs` to emit a Dart fixture.

**Interface:** `normalizeGenerationRequest` yields a versioned normalized request containing provider model identity and supported settings. `quote(normalizedRequest)` returns integer credits and reserved estimated provider cost; adapter submit consumes that same normalized request. Clients receive a quote/capability version and cannot supply the authoritative charge.

- [ ] Retain the reproduction that GPT version 1 and 2/4K currently send identical requests but cost 28 vs 73 credits. Add FLUX resolution/model (v1.1 vs FLUX.2), Seedream resolution, and Nano Banana as the positive control.
- [ ] Verify each intended provider option against current official docs and account access (including whether fal FLUX/Seedream take `image_size` rather than `aspect_ratio`). Remove unsupported choices until they are genuinely wired and smoke-tested.
- [ ] Implement mappings, explicit reference routing for generate-with-reference, and provider output metadata validation. Remove the dead OpenAI mask branch or wire it. Do not advertise dimensions/model variants that the adapter does not request.
- [ ] Generate contract fixtures for all selectable combinations and expected credit/provider-cost values. Include malformed/unsupported options and quote-version changes.
- [ ] Run Angular catalog/drift tests, Deno image and video adapter tests, and the Dart catalog fixture test in the mobile repo.

**Exit:** User selection, displayed cost, reserved amount, outgoing model/settings, and output metadata agree.

### T06 — Unify job settlement, storage verification, and cancellation (L)

**Covers:** R05, R08. Depends on T01.

**Files:** Create `api/services/job-settlement.ts`, `_shared/providers/provider-errors.ts`, tests, and an additive settlement/outbox migration. Modify `finishJob`, `storeVideoResult`, cancel route, `fn_fail_job`, `/edits/save`, `/library/import`, and adapter cancellation/check contracts (fal, runway, `fetchBytes`).

**Interfaces:** Provider check returns `running`, `done`, `terminal_failure`, or `retryable_failure`. Cancellation returns an explicit outcome. Settlement RPC accepts expected generation state and records one terminal transition, ledger effects, cleanup work, and notification outbox together.

- [ ] Write failing storage-upload/update tests for the image branch, `/edits/save`, and `/library/import`; assert no `done` DTO or completion event after error.
- [ ] Race success vs failure/cancel in a real DB transaction test; assert one terminal state and one valid credit outcome. Include the cron-sweep-then-inline-done case.
- [ ] Make fal running cancellation return non-cancellable, and 429/503/CDN-download failures retryable in fal and runway. Never refund merely because cancel transport failed.
- [ ] Implement bounded output retrieval/storage with verified content type and size (declared and observed), keeping the R2-compatible buffered `put` but capping before `arrayBuffer()`; fix the stale "streams" comment.
- [ ] Test repeated settlement, lost DB response, cleanup failure, missing object, oversize/truncated video, and duplicate notification delivery.
- [ ] Run Deno route/shared tests and settlement SQL tests.

**Exit:** A successful generation always has retrievable media; canceled/failed jobs have truthful, once-only settlement.

### T07 — Add durable dispatch, reconciliation, and atomic limits (L)

**Covers:** R06, R07, R09; unblocks D3 and D6. Depends on T02, T05, T06.

**Files:** New job/reservation/outbox migration; create `supabase/functions/job-worker/index.ts`, `_shared/jobs/` dispatch/lease/retry services and tests; modify gateway creation/persona routes and cron setup. Modify web request DTOs and submission controller for idempotency keys (mobile: **MT-03**).

**Interface:** `(userId, idempotencyKey, normalizedBodyHash)` identifies one submission. Reservation transaction creates generation/job/outbox and records capacity/provider expense. Worker claims include lease token/expiry, attempt count, and next-run time; only the current lease can settle.

- [ ] Write a failing integration test: same key/body twice yields one reservation/job/provider submission; changed body with same key yields conflict. Include the "job insert fails → generation orphaned and never swept" case.
- [ ] Write transactional cap tests for four simultaneous videos, a run crossing remaining daily budget, concurrent persona slots, and global/provider budget exhaustion.
- [ ] Implement durable dispatch and return accepted jobs promptly. Handle ambiguous provider submit outcomes without duplicate dispatch.
- [ ] Implement worker progress for every asynchronous provider and persona training; convert inline generation into worker work where needed for bounded HTTP lifetime.
- [ ] Make GET endpoints read-only views of lifecycle state; UI polling can continue for freshness. Push send moves to the settlement outbox.
- [ ] Test closing all clients, killing/restarting a worker, lease expiry, delayed provider output, backoff, expired references, and exactly-once settlement.
- [ ] Keep the recovery sweep distinct from a simple timeout refund. Record provider expense even when customer credits are refunded.

**Exit:** A job completes correctly while every client is offline; limits hold under concurrency; the "you can leave this page" copy can be restored.

### T08 — Implement durable deletion and retention (L)

**Covers:** R11; D2. Depends on T06/T07 for pending jobs.

**Files:** New deletion-outbox migration; create `_shared/storage/deletion-service.ts` and tests plus a cleanup worker; modify account/generation/persona deletion and lapse cron; unify the `storage_backend` default; revise `vansen.md` §6 and privacy/help copy only to match the approved policy.

**Interface:** Deletion request stores owner, object backend/key, reason, not-before time, attempt count, and completion state before the source row disappears. Account closure has a visible requested/processing/completed lifecycle where necessary.

- [ ] Seed synthetic Supabase/R2 media, upload, ZIP, and quarantine records; assert current account deletion leaves objects behind (RED using fake object store).
- [ ] Define exact retention for financial records, moderation evidence, training artifacts, and provider-hosted artifacts. Record external-provider deletion limitations explicitly.
- [ ] Implement tombstones, retryable object cleanup, subscription reconciliation for every live Stripe status and for Apple original transactions, and pending-work settlement. Fail closed on unknown ownership.
- [ ] Test one storage backend failing, retries, repeated deletes, mid-flight output arrival, a null-backend legacy row, and a lapsed account.
- [ ] Produce dry-run inventory and counts before any actual production cleanup. Never recover scope from an unbounded prefix guess.

**Exit:** Deletion/retention promises have an auditable implementation, including failures.

### T09 — Centralize user-session teardown (M)

**Covers:** R12. Mobile counterpart: **MT-05**.

**Files:** Create `core/auth/session-lifecycle.ts` and `.spec.ts`; modify auth service, settings/workspace/profile-deletion/onboarding handlers, stores, media cache, `job-poller.ts`, `persona-store.ts`, `preferences-service.ts`.

**Interface:** A monotonic session epoch + UID accompanies user-bound async work. Teardown invalidates first, then stops work and clears user state. Model-weight caches may remain device-shared; personal media caches may not.

- [ ] Write tests for logout from settings, workspace, onboarding, deletion, expiry, and account switch, with an old delayed library/profile response and a live job/persona poller.
- [ ] Implement one teardown flow; make all four callers use it. Clear editor/persona/notification/preference state and stop both pollers, not only auth tokens.
- [ ] Namespace and invalidate media/blob caches; prevent a request begun as A from persisting as B.
- [ ] Run the affected web store/auth tests.

**Exit:** A new account cannot observe or overwrite prior account state through the current app session.

### T10 — Repair web editor lifetime, save state, and navigation (M)

**Covers:** R13. Depends on T09 session epoch.

**Files:** Modify `core/editing/edit-session.ts`, its tests, worker protocol (`dispatch`/`opQueue`), `tool-options.ts` mask handling, workspace page auto-open; add dirty-navigation guard tests.

Retain this focused regression using the existing TestBed seam:

```ts
it('does not commit an old operation into a new session', async () => {
  TestBed.configureTestingModule({providers: [provideZonelessChangeDetection()]});
  const session = TestBed.inject(EditSession);
  const pixels = (red: number) => ({
    width: 1, height: 1,
    data: new Uint8ClampedArray([red, 0, 0, 255]),
  });
  session.openWithBuffer({id: 'a'} as GenerationDto, pixels(10));
  const oldWork = session.apply('flip', 'h');
  session.close();
  session.openWithBuffer({id: 'b'} as GenerationDto, pixels(200));
  await oldWork;
  expect(session.current()?.data[0]).toBe(200);
  expect(session.dirty()).toBe(false);
});
```

- [ ] Observe RED for the regression; add delayed decode, PNG render, model inference, terminated-worker (queue must not wedge), and close-mid-apply (must not throw) variants.
- [ ] Add epoch/engine guards to every async mutation; bump `previewToken`/`renderSeq` on close; make worker termination settle pending operations and reset queue state.
- [ ] Guard `selMask`/erase masks against buffer dimension changes and clear them on session change.
- [ ] Track saved revision separately from current revision. Save completion must not mark newer edits clean.
- [ ] Add dirty decisions for routing, tab close, image change, and arriving AI result. Auto-open only when it cannot destroy local work.
- [ ] Verify undo/redo, preview/apply, mask coordinates, and repeated save in the browser after focused GREEN.

**Exit:** Editing is correct under image switching and asynchronous work, not only sequential unit calls.

### T11 — Scope the Flutter editor by user and image

Moved to the companion document as **MT-02**.

### T12 — Persist retry inputs and fix video reference semantics (M)

**Covers:** R15, R25; supplies **MT-03** DTO fields.

**Files:** Modify request/response DTOs, generation persistence migration, gateway retry/variation routes, `workspace-page.ts`, `reference-drop.ts/.spec.ts`, video adapters' aspect handling.

**Interface:** Immutable `GenerationRequestSnapshotV1` stores owned reference IDs, ordered semantic slots, mask object ID, persona/style/trend, operation, normalized settings, and quote version. `POST /generations/:id/retry` creates a new request after ownership/capability checks and repricing. `GenerationDto` gains `failure: {code, message, cancelled}` and job/poster metadata.

- [ ] Write failing end-frame-first and clear-first slot tests. Do not erase empty slot identity until validating/serializing the mode.
- [ ] Write mask-edit, persona, reference-image, i2v, keyframe, and parent-video retry tests; write variation tests that reject edit/persona/i2v sources with a readable reason.
- [ ] Implement persisted input snapshots and server reconstruction. Store object IDs, never signed URLs, and apply R02/R07 money/idempotency rules.
- [ ] Return safe structured failure/cancellation metadata and use it consistently after reload ("Cancelled · Refunded" survives reload).
- [ ] Make Veo/Omni/Runway adapters omit `aspectRatio` in i2v/keyframes; add adapter tests. Keep uploads-only for reference slots (D5) and say so in the composer.

**Exit:** Retry and variation mean what the controls say, including after a browser restart.

### T13 — Paginate the library and load appropriate media (M)

**Covers:** R16. Mobile counterpart: **MT-07**.

**Files:** Modify gateway generation/ledger queries, add ID/version-chain lookup routes; modify web `generation-store.ts`, `ledger-service.ts`, library-grid, media cache.

**Interface:** Responses add `nextCursor`; cursor encodes `(createdAt,id)`. Clients merge by immutable ID. Thumbnails and originals have distinct media identities/MIME/dimensions.

- [ ] Seed 500 generations with timestamp ties; failing tests must expose inaccessible records and broken old-ID deep links.
- [ ] Implement stable pagination, filter/query limits, ID lookup, and paginated version-chain access.
- [ ] Generate actual image thumbnails on completion, use them for cards, and fetch originals only for explicit viewing/edit/export.
- [ ] Add viewport loading and bounded object-URL/disk retention. Signed URL expiry should trigger a refresh for an owned item, not permanent broken media.
- [ ] Test concurrent new inserts while paging, deletion between pages, expired URLs, and recovery from quota/storage-disabled conditions.

**Exit:** Library size does not silently remove access to older customer content or download every original on entry.

### T14 — Budget editor resources and verify the real ML tools (L)

**Covers:** R17, R18; performance/quality matrix below. Mobile counterpart: **MT-08**.

**Files:** Modify `edit-engine.ts`, `preview-scheduler.ts`, `edit-session.ts`, `engines/model-loader.ts`, `bokeh-engine.ts` preview path, `upscale-engine.ts`, `media-cache.ts`. Create benchmark/fixture manifests and browser integration tests.

**Interface:** Editor resource policy defines `maxHistoryBytes` (past + future), `maxInputPixels`, `maxOutputPixels`, and model/session lifetime with a release API. Preview scheduler admits one active computation plus one replacement request; commits remain ordered separately. A model manifest specifies immutable URL/revision, SHA-256, tensor contract, license record, and download size.

- [ ] Write RED tests for quota-failure blob fallback, `caches.open` rejection fallback, history byte limit including redo stack, repeated model teardown, corrupt model download, and latest-only preview queue depth.
- [ ] Apply budgeted history and upscaler output limits before allocation; choose the largest safe limits only after measurements.
- [ ] Run bokeh preview on the proxy; separate CPU preprocessing/blur/export from UI work where measured long tasks require it. Preserve exact pixel behavior with fixtures.
- [ ] Pin/download/validate weights against immutable revisions, verify cache fallbacks, and expose honest progress/cancel/retry copy.
- [ ] Run every tool against the fixture/device matrix, record cold/warm timing and memory, inspect exported files, and tune only against measured regressions.

**Exit:** Tool quality, responsiveness, offline behavior, and resource lifetime are demonstrated on real supported runtimes.

### T15 — Mobile media/capability contract

Moved to the companion document as **MT-03**. Backend prerequisites: T05 (catalog export), T12 (DTO metadata), T13 (cursor pagination).

### T16 — Native push, auth capabilities, and release packaging

Moved to the companion document as **MT-04**. Backend prerequisites: T07 (settlement outbox drives push send), T19 (auth redirect allow-list).

### T17 — Make product promises, assets, accessibility, and language honest (M)

**Covers:** R23, R26; D1, D4. Depends on T05 capability truth and the D1 decision.

**Files:** Web pricing/landing/login/site-footer, tool entitlement copy, trend gallery/assets, detail overlay/library cards, locale infrastructure if D4 keeps en/ms. Add public-page and entitlement fixture tests.

- [ ] Write failing tests tying promo text to the D1 grant rule and tool lists to plan entitlement; remove Sora from generated family lists.
- [ ] Update pricing/FAQ/landing so Studio and Pro tool lists match `PRO_TOOLS`; separate effective monetary cost from numeric credits per job.
- [ ] Add approved trend assets and asset-existence checks, or hide the unfinished gallery using rollout configuration.
- [ ] Give detail-overlay the same `role="dialog" aria-modal` + focus entry/trap/restore as its six sibling dialogs; make cards keyboard-openable; label the variation button; add async announcements and accessible destructive confirmations.
- [ ] Per D4: either state English-only in spec and listings, or wire en/ms selection, persist preference, and audit truncation/locale formatting.
- [ ] Run public-page browser tests at desktop/mobile widths and perform keyboard/screen-reader checks without changing the established composition.

**Exit:** What users are sold is exactly what the release provides, and core navigation does not depend on a mouse.

### T18 — Add account recovery on web (M)

**Covers:** R24. Mobile counterpart: **MT-06**.

**Files:** Web auth service/routes/login plus new recovery page and tests; Supabase redirect/mail configuration documented in the release checklist.

**Interface:** `requestPasswordReset(email)` returns generic success; recovery callback establishes a limited valid recovery state, then `updateRecoveredPassword(password)` completes it using the auth vendor's supported flow.

- [ ] Write failing tests for forgot-password entry, generic email response, valid recovery link, expired/reused link, and confirmation resend.
- [ ] Implement web route and recovery page with readable retry states and password validation.
- [ ] Configure exact allowed redirect origins/schemes and real email delivery in staging. No token in logs, analytics, or persisted screenshots.
- [ ] Test cancellation/back navigation, email verification resumption, and existing signed-in user opening a recovery link.

**Exit:** A paying email/password user can recover their account through the web client.

### T19 — Enforce release gates and stage the rollout (M)

**Covers:** R27 plus all release acceptance criteria; D7.

**Files:** Create `.github/workflows/ci.yml` or the repository owner's actual CI equivalent, reproducible local/test setup, release runbook, and observability/reconciliation dashboards. Update README, `vansen.md`, and punchlist from verified results.

- [ ] Pin reproducible toolchains and lockfiles; run web tests/build, Deno check/shared/route tests, SQL integration tests, catalog drift (including the Dart export), and asset checks.
- [ ] Inventory actual deployed migrations and reconcile the duplicate `0008_*` prefixes without rewriting applied history. Test both empty DB bootstrap and upgrade from a production-shaped snapshot containing synthetic data only.
- [ ] Add deployment manifest: Git revision, schema version, catalog version, worker version, enabled capabilities.
- [ ] Add request deadlines and 204 handling, error IDs, durable telemetry/outbox delivery, and alerts for unfulfilled purchase, missing media, stale leases, deletion retries, and provider budget burn.
- [ ] Stage rollout with paid model flags initially disabled. Enable one family after its smoke and financial reconciliation pass; keep a fast per-family disable switch.
- [ ] Test rollback/forward recovery. Disable new submissions first; continue settling/refunding existing work; do not drop new columns while queued jobs depend on them.
- [ ] Complete section 8 and replace historical "code complete" claims in `vansen.md`/`CLAUDE.md` with the tested release revision and evidence links; record D1–D7 outcomes there.

**Exit:** Release readiness is repeatable evidence attached to a revision, not a manual recollection.

## 6. Performance and tool-quality acceptance matrix (web)

These are proposed release targets to measure and tune against representative devices; they are **not measured results from this review**.

| Area | Test cases | Release target |
|---|---|---|
| Slider preview | 2 MP and 4K images; continuous drag for 5 seconds | Latest value wins; one active + one replacement preview; no unbounded queue; warm proxy feedback preferably within 100 ms |
| Main thread/UI | Crop/zoom/brush/slider while models initialize | No repeated >100 ms stalls from CPU preprocessing during normal interaction; controls remain usable |
| Undo memory | 20+ operations then 20 undos at supported input sizes | Byte-based bound respected across past **and** redo stacks; oldest entries evicted visibly/consistently; active image retained |
| Upscale | Boundary-size image and one pixel above cap | Allowed result exactly 2× width/height; rejected size allocates no huge output; clear limit message |
| Model cold start | Clean cache on Wi-Fi and slow network | Size/progress visible, retry available, no corrupt cache retained, no apparent freeze |
| Model warm/offline | Valid cache then network offline | Supported cached local tools operate; unavailable first-use model explains required download |
| Storage denied | Private window / Cache Storage throws | Image opens for editing and downloads succeed via network-only path |
| GPU fallback | WebGPU unavailable, initialization fails, first inference fails | CPU fallback or an explicit actionable unsupported-device state; no silent wrong image |
| Video output | Largest allowed result, truncation, HTTP error | Transfer is bounded; final object validates; no `done` state for missing/partial media |
| Library | 500 synthetic items | Cursor access to all records; thumbnails on screen; no eager fetch of 500 originals |

### Visual fixtures for every relevant tool

Use synthetic/licensed fixtures: a color chart, checkerboard, non-square landscape, portrait with fine hair, transparent edges, a blurred image, flat-color image, large image, and noisy low-light image. Store expected dimensions and masks with each fixture.

- Zero-strength adjustments/filters are identity operations.
- Crop/rotate/flip/perspective have expected dimensions and pixel positions.
- Heal/clone/retouch preserve pixels outside the intended region except documented feathering.
- Selection/erase use the current image and correct click coordinates after zoom/crop.
- Cutout and PNG/WebP export preserve alpha; JPEG explicitly flattens on the chosen background.
- Upscale/deblur do not show tile seams; output alpha and edge pixels follow the documented contract.
- Bokeh keeps the selected depth in focus and avoids obvious background bleeding at subject boundaries.
- Preview and committed full-resolution output use the same parameters; a preview overlay is never accidentally saved as a tinted selection.
- Undo/redo reproduce prior outputs exactly; save/export refers to the intended committed revision.

Automation checks dimensions, selected pixel invariants, masking, and bounded numerical tolerances. Human inspection is still needed for ML quality. Unit tests with fake tensor outputs do not replace real-weight runtime proof.

## 7. Missing features versus intentional deferrals

### Required to repair existing promises

- Password/confirmation recovery.
- Reliable background completion, true retry, and recoverable payment fulfillment.
- Upload-as-reference for image models.
- Older-library access.
- Launch-promotion grant matching the decided spec (D1).
- Missing trend assets or an explicit hidden/deferred state.
- Accurate plan/model/tool copy.
- Completion notifications only once durable (D3/D6).

### Product decisions that can remain scoped

- **Video:** Defer all providers or release an individually verified subset. Do not enable five unproven providers at once.
- **Denoise/Colorize:** Keep deferred pending commercial-safe deployable weights; not a reason to block an accurately scoped launch.
- **Localization:** D4.
- **Library references for video slots:** D5.
- **Concurrent-session cap:** Add only with a defined product policy and recovery UX; do implement request/spend rate controls before public paid rollout.

No extra creative feature should outrank the money, ownership, and editor-correctness repairs.

## 8. Release checklist and sequencing

### Gate A — Shared backend integrity

- [ ] R01/R02/R04–R11/R28 closed with route + transaction regressions.
- [ ] Every job has a recoverable dispatch record and settles without clients.
- [ ] Duplicate requests/events cannot create extra credit movements or lost grants; `23505` is the only path to "already processed".
- [ ] Upload ownership and moderation unavailable states are enforced; posters have a policy.
- [ ] Cancellation and temporary provider errors have tested financial semantics.
- [ ] Account deletion and lapse cleanup have durable object-retention behavior matching D2.
- [ ] Billing lane is enforced server-side for mobile clients.
- [ ] Current deployed schema/functions/workers match the approved release manifest.

### Gate B — Web release

- [ ] R12/R13/R15/R23–R26 addressed for every exposed feature.
- [ ] Tests/build pass from a fresh dependency install using lockfile/toolchain pins.
- [ ] Authenticated browser checks: free, Studio, Pro, owner, suspended, lapsed users.
- [ ] Actual local tool matrix on Chrome, Safari, and a representative lower-memory device, including a private window.
- [ ] Successful generation/edit/import/export/delete; failed/canceled/refunded/retried operation; upload-as-reference on each image family.
- [ ] Signup/verification/login/logout/recovery and A→B account isolation through all four sign-out paths.
- [ ] Promotions, grants, plan tools, and billing return state match server truth and D1.
- [ ] No missing assets; keyboard dialog/card flows and the D4 locale decision verified.

### Gate C — Mobile release

Defined and tracked in the companion document. It depends on Gate A and on T05/T12/T13 for contract fields.

### Gate D — Operational and commercial launch

- [ ] Read current official provider docs and smoke every enabled version/mode under a defined budget.
- [ ] Confirm Stripe live products/prices/coupons/webhooks and Apple/Play production setup; never infer live mode from historical docs.
- [ ] Confirm from the Supabase dashboard which migrations are applied, that `0016_video.sql` state matches D7, cron/worker delivery, R2 bucket/CORS/limits, auth redirects, and required secrets by name/presence without dumping values.
- [ ] Verify real provider bill versus reserved cost and customer credit quote for the smoke sample.
- [ ] Legal/policy owner reviews Terms/Privacy/AUP and retention implementation against D2; no assertion of legal compliance from automated checks alone.
- [ ] Alerts exercised using synthetic failures; support can trace request/purchase/job IDs.
- [ ] Restore/backup and rollback runbook rehearsed against staging.
- [ ] Enable a small cohort, watch fulfillment/cost/error metrics, then increase availability per family/platform.

Suggested order: **D1–D7 decisions → T01 → T02/T03 → T05/T06 → T07/T08 → T09/T10/T12 → T13/T14/T17/T18 → T19 gates**, with MT-01…MT-09 in the mobile repo running after their listed backend prerequisites. Independent work may overlap only when ownership and interfaces are clear. No sub-agent execution is implied by this review.

## 9. Review evidence appendix

### Local commands to reproduce the baseline

Web:

```sh
cd /Users/user/IdeaProjects/vansen
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 22.23.1
NG_BUILD_MAX_WORKERS=2 npm test -- --watch=false
NG_BUILD_MAX_WORKERS=2 npm run build
```

Backend:

```sh
cd /Users/user/IdeaProjects/vansen/supabase/functions
deno test --allow-all _shared
deno check api/index.ts stripe-webhook/index.ts appstore-webhook/index.ts
```

Mobile commands are in the companion document.

Focused reproduction artifacts from the initial review were written only under `/tmp` and may have expired:

- `/tmp/vansen-release-review-repro.ts`: IAP failure/retry, GPT mapping/price discrepancy, moderation 503. Actual source modules; network stubbed; dummy key exists only in the process.
- `/tmp/vansen-edit-session-repro.cjs`: TypeScript-transpiled actual edit/media source with lightweight Angular signal/injection substitutes. Confirms async buffer corruption and cache quota failure; not a browser worker integration test.
- `/tmp/vansen-review-tests-verified.log`, `/tmp/vansen-review-deno.log`, `/tmp/vansen-review-edge-check.log`: baseline outputs.

The re-verification on 17 September 2026 re-ran every baseline command above (results in section 2) and re-read each cited code path; it did not re-run the `/tmp` reproduction scripts. Retain proper regression tests in the implementation tasks rather than relying on temporary files.

### External primary references checked for this review

These support specific purchase/policy boundaries. Recheck them when implementing/releasing; policy and SDK details can change. No external source was used to assert an untested provider feature works.

- **S2:** [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/uk/): regional purchase/link provisions and US storefront distinction.
- **S3:** [Apple External Purchase documentation](https://developer.apple.com/documentation/StoreKit/external-purchase): relevant regional entitlements/configuration.
- **S4:** [Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en): digital-goods billing requirements and applicable alternative-billing programs.

Mobile-plugin references (S1, S5) are in the companion document.

### What was deliberately not asserted

- No claim that live video deployment is still absent solely because September 6 notes say so (D7).
- No claim that CDK 21 / Angular 22 is broken solely from mixed version numbers; installed peer inspection exited successfully.
- No claim of measured FPS, peak memory, actual ML image quality, production provider compatibility, store approval, or legal compliance.
- No claim that these are the only possible defects. This is a broad code/baseline-test/public-UI review with explicit authenticated, paid, and device verification gates. The re-verification found one new P1 (R28) and about a dozen additional defects inside already-cited code paths; further reading of `api/index.ts` would likely find more.

## 10. Definition of done for executing this plan

The report is complete when delivered; the app is ready only after the applicable gates above pass. For each implemented task, record the exact revision, failing regression output before the fix, passing output after it, affected platform/provider, and remaining limitations. Keep a closed-findings table using R01–R28 (and M01–M09 in the mobile repo) and link each entry to its regression evidence. Record the D1–D7 outcomes in `vansen.md`. Mark deferred capabilities unavailable in both UI and marketing until their own gates pass.
