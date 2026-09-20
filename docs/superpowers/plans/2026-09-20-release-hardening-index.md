# Release Hardening — Plan Index and Sequencing

**Written 2026-09-20.** These nine plans implement the non-mobile portion of `2026-09-17-release-readiness-review-and-implementation-plan.md`. Nothing here has been executed; they are documents to work from.

The mobile findings (**R03**, **R14**, **R19**, **R20**, **R22**, and the mobile halves of **R21** and **R26**) belong to the vansen-mobile project and are not covered here.

---

## The nine plans

| Plan | File | Review tasks | Closes | Size |
|---|---|---|---|---|
| **P1** | `2026-09-20-release-hardening-p1-gateway-and-input-integrity.md` | T01, T02 | R01, R10, R28 (gateway half), R09 (validation half), R27 (test seam, 204) | 8 tasks |
| **P2** | `...-p2-billing-fulfillment.md` | T03 | R02, R21 (server half), D1 | 8 tasks |
| **P3** | `...-p3-catalog-and-provider-contract.md` | T05 | R04, R28 (adapter half) | 7 tasks |
| **P4** | `...-p4-job-settlement.md` | T06 | R05, R08 | 7 tasks |
| **P5** | `...-p5-durable-dispatch.md` | T07 | R06, R07, R09 (limits half); unblocks D3, D6 | 5 tasks |
| **P6** | `...-p6-durable-deletion.md` | T08 | R11, D2 | 5 tasks |
| **P7** | `...-p7-web-client-correctness.md` | T09, T10, T13, T14 | R12, R13, R16, R17, R18 | 6 tasks |
| **P8** | `...-p8-product-truth-and-recovery.md` | T12, T17, T18 | R15, R23, R24, R25, R26; D4, D5 | 6 tasks |
| **P9** | `...-p9-release-gates.md` | T19 | R27, D7; verifies applicable Gates A–D | 8 tasks |

Review tasks **T04**, **T11**, **T15** and **T16** are mobile and appear in the vansen-mobile plan instead.

---

## Every finding, and where it is addressed

| Finding | Plan | Task in that plan |
|---|---|---|
| R01 upload references not ownership-checked | P1 | 6 |
| R02 billing markers and grants not one transaction | P2 | 2–5 |
| R03 mobile purchases before verification | *mobile* | — |
| R04 selectors, prices and requests disagree | P3 | 1–7 |
| R05 success reported after storage failure | P4 | 5 |
| R06 background jobs need an open client | P5 | 4 |
| R07 submission neither atomic nor idempotent | P5 | 1–2 |
| R08 cancel and transient failures refund wrongly | P4 | 1–2, 5 |
| R09 limits and setting validation incomplete | P1 (validation), P5 (limits) | P1/8, P5/2 |
| R10 moderation fails open | P1 | 4–5 |
| R11 deletion leaves stored content | P6 | 2–4 |
| R12 logout cleanup depends on where you log out | P7 | 1 |
| R13 edit ops can mutate a newly opened image | P7 | 2, including async apply, worker cancellation, stale masks and save identity |
| R14 mobile edit buffer reuse | *mobile* | — |
| R15 retry loses operation context | P8 | 1–2 |
| R16 library truncates and overfetches | P7 | 3 |
| R17 editing and video memory unbounded | P7 (editor), P4 (video) | P7/5–6, P4/5 |
| R18 ML loading lacks a recovery contract | P7 | 4–6 |
| R19 mobile video contract | *mobile* | — |
| R20 mobile push is a no-op | *mobile* | — |
| R21 billing lane from device locale | P2 (server), *mobile* (client) | P2/6 |
| R22 mobile release configuration | *mobile* | — |
| R23 sales copy contradicts the code | P8 | 4 |
| R24 no password recovery | P8 | 6 |
| R25 video reference slots change meaning | P8 | 3 |
| R26 assets, accessibility, localization | P8 | 5 |
| R27 release automation and telemetry | P9 | 1–7 |
| R28 upload-as-reference rejected | P1 (gateway), P3 (adapters) | P1/7, P3/3 |

---

## Decisions and where each is resolved

| Decision | Resolved in | How |
|---|---|---|
| D1 launch promo grant | **P2 Task 4** | Code made to match the decided spec: full plan credits on launch-coupon invoices |
| D2 retention policy | **P6 Task 1** | Blocking spec the user fills in; enforced by `0021` |
| D3 background-completion promise | **P5 Task 5**, **P9 Task 6** | Restore only for a deployed, verified capability; notification wording additionally depends on D6 |
| D4 launch locales | **P8 Task 4, Step 7** | Blocking choice: English-only, or fund the localization work as its own plan |
| D5 library video references | **P8 Task 3, Step 5** | Uploads only for the first release, said plainly in the composer |
| D6 completion notifications | **P4 Task 6**, **P5 Task 5**, mobile **MT-04**, **P9 Task 6** | Backend delivery and client receipt must pass before notifications are advertised on either platform; leases are an implementation detail, not a replacement decision |
| D7 video live state | **P9 Task 2**, **Task 7, Step 10** | Inventory the existing deployment before changes, then verify the manifest and dashboard after rollout |

---

## Order, and why it is this order

```
P1 ──┬── P2 ──┐
     │        │
     ├── P3 ──┼── P4 ── P5 ──┬── P6 ──┐
     │        │              │        │
     └────────┴── P7 ────────┴── P8 ──┴── P9
```

**P1 first, always.** It extracts `createApp(deps)` from the 2,059-line `api/index.ts` and builds the fake database every later plan's tests import. Without it, nothing after it is testable, and every later plan's route tests have nowhere to run.

**P2 and P3 can run in parallel** once P1 lands. They touch different files: P2 is the webhooks and the billing migration, P3 is the catalog and the provider adapters.

**P4 needs P3.** Settlement classifies provider errors, and the classification lives with the adapters P3 rewrites.

**P5 needs P4.** The reservation creates jobs that the worker settles through `fn_settle_job`, which P4 introduces.

**P6 needs P5.** Deleting a pending generation has to cancel its job first, which needs the job lifecycle P5 defines.

**P7 Task 1–2 can start after P1.** Finish P4/P5 before integrating thumbnails and the read-only job lifecycle. P7 Task 5–6's resource limits and real-tool/device evidence are required before release; they are not post-release optimization.

**P8 needs P3 and P7.** Retry re-quotes through P3's `quote()`, and its dialogs use the `ConfirmService` P7 builds.

**P9 is last, and only P9 touches production.** Everything before it is code and local verification.

---

## Migration numbering

The highest migration file on disk is `0016_video.sql`; its deployed state is **unverified**. Two files share the `0008_` prefix (`0008_age_gate.sql`, `0008_credit_plans.sql`), but disk names do not prove what ran. Reuse the read-only inventory required by P1 Task 6 and expanded in P9 Task 2 before assigning new versions. The numbers below are proposed until that inventory confirms they are available. Never rename or rewrite a migration proven applied; record any historical mapping explicitly. Inventory access is read-only and may happen before P9.

| Migration | Plan | Contents |
|---|---|---|
| `0017_upload_registry.sql` | P1 | `uploads` table, ownership for references |
| `0018_billing_fulfillment.sql` | P2 | `billing_transactions`, `fn_apply_fulfillment` |
| `0019_job_settlement.sql` | P4 | `notification_outbox`, `fn_settle_job` |
| `0020_durable_dispatch.sql` | P5 | `submissions`, `provider_expenses`, job leases, `fn_reserve_generation` |
| `0021_durable_deletion.sql` | P6 | `deletion_outbox`, rewritten `fn_delete_account`, `fn_purge_lapsed` |
| `0022_thumbnails.sql` | P7 | `thumb_state`, image thumbnails |
| `0023_request_snapshots.sql` | P8 | `request_snapshots`, `failure_code` |
| `0024_release_telemetry.sql` | P9 | `alerts`, `fn_check_alerts`, `fn_schema_version` |

Apply them in order, one at a time, verifying after each. They are additive apart from one forward-only change: P6 makes `ledger_entries.user_id` nullable so financial history can survive an account deletion in anonymised form.

---

## Blocking work the user must decide or provide

These stop a plan dead until answered. Surface them early rather than at the step that needs them.

| What | Needed by | Why it blocks |
|---|---|---|
| A local Supabase stack (`$VANSEN_LOCAL_DB`) | P2 Task 1 | Every SQL test in P2, P4, P5, P6 and P9 runs against it. Never point these at the production project. |
| Provider capability record filled from real smokes | P3 Task 1 | Guessing a model id silently reintroduces the exact defect P3 fixes |
| Retention policy numbers | P6 Task 1 | The migration encodes them and the customer-facing copy states them |
| Launch locale decision | P8 Task 4 | Either `vansen.md` changes or a separate localization plan is funded |
| Trend thumbnails: generate or hide | P8 Task 5 | Twelve assets 404 today; shipping either way is a decision, not a default |
| Production credentials, secrets, the R2 bucket | P9 Task 7 | Every production change in this work is the user's to approve, one at a time |

---

## What these plans deliberately do not do

- **No commits.** Every task ends with "user commits". The user owns git, on one branch.
- **No mobile work.** That is the vansen-mobile plan.
- **No production changes before P9.** P1 through P8 are code and local verification only.
- **No localization.** If P8's decision funds it, it becomes its own plan.
- **No unrelated performance expansion.** The review's T14 and sections 4/6 are mandatory implementation and qualification work, owned by P7 Tasks 5–6 and P9 Task 6. Record timings, memory and real-tool results before release. A failed or untested exposed tool blocks its release; a deferred tool must be unavailable and removed from sales claims.

## Alignment checks before execution

- P7 Task 2 retains the original A→B async-operation regression, not only delayed image loading.
- P7 Tasks 4–6 distinguish cached model bytes from live inference, image and undo/redo memory.
- P9 Task 6 carries the source spec's authenticated browser, device, commercial and operational gates; passing CI alone cannot close them.
- D1–D7 retain the meanings in the source spec. Notification claims depend on both backend and mobile/client evidence.
- Deployment facts carry a dated read-only source. Missing evidence stays unknown rather than becoming an applied/unapplied assertion.
