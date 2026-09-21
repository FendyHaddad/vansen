# Release Hardening — Plan Audit (2026-09-21)

> **Follow-up verification and plan corrections, 2026-09-21:** The original audit below is preserved as the pre-correction record. Most findings are valid; X4/X5 need qualification, and the structural verdict overlooks stale index references. See the verified disposition at the end. P1–P9 and the index have now been edited; application code has not been implemented or deployed.

Ten parallel read-only audits, one per plan plus one for the index, each comparing the plan against the review tasks it claims (`2026-09-17-release-readiness-review-and-implementation-plan.md`). Nothing in the plans was edited.

**Structural verdict: CONSISTENT.** Every plan implements exactly the T-tasks it claims. Every R01–R28 finding and D1–D7 decision resolves to the right plan. Migration numbering 0017–0024 agrees across all files. The spec's section 5 pointer table matches the index.

**Content verdict: DRIFT FOUND in P1, P2, P4, P5, P6, P7, P8, P9. P3 ALIGNED WITH NOTES.** The items below are the ones that would break execution or leave a spec requirement unmet. Fix them before dispatching any implementer.

---

## Cross-plan contract breaks (fix these first — they fail more than one plan)

| # | Break | Where |
|---|---|---|
| X1 | **`uploads` schema disagrees.** P1's `0017` creates `path, bytes, mime` with NOT NULL `purpose, width, height`. P6 and P8 read `object_path, byte_size, content_type`. P6's `fn_delete_account` and SQL test 4 cannot run. | P1:2004–2015 vs P6:169,197,327,596,1355; P8 uploads seed |
| X2 | **`fn_paid_unfulfilled` arity.** P2 defines `fn_paid_unfulfilled(p_since timestamptz)`; P9's `fn_check_alerts` calls it with no args. The production cron would error every 5 minutes. | P2:361 vs P9:448 |
| X3 | **`failure_code` has no writer.** P8 says "P4's `fn_settle_job` writes it"; P4 never mentions the column. P8 adds the column but nothing populates it, and `library-grid.html:83` / `generation-store.ts:128–138` are never changed to read it — the R15 "Cancelled → Generation failed after reload" bug survives. | P8:516–521, P4 (absent) |
| X4 | **`store.ts` / `storeUrlResult` undefined.** P5's worker imports `_shared/jobs/store.ts`; P4 keeps `storeVideoResult` inside `app.ts` and no plan creates `store.ts`. P5's `_shared/jobs/dispatch.ts` also imports `../../api/services/job-settlement.ts`, which is outside the worker bundle. | P5:1104,1308,1334,1392 vs P4:47,1268 |
| X5 | **Cron guards assumed but absent.** P9's CI database job relies on "guarded `do` blocks" around `cron.schedule`; P5 and P6 use bare `cron.schedule`. CI on a plain Postgres image fails on the first `cron.schedule`. | P9:646–686,836 vs P5:544,1712; P6:413,473 |
| X6 | **P4 → P3 dependency unstated.** Both modify `providers/types.ts`; P4's header claims dependency on P1 only. | P4:11,55; index:90 |
| X7 | **`--check` flag for `sync-shared.mjs` does not exist.** P9 wires `node scripts/sync-shared.mjs --check` in verify-all and CI; P3 defines the drift guard as a vitest spec plus `export-catalog`. The Dart fixture is never checked. | P9:142,629 vs P3 Task 7 |
| X8 | **`scripts/run-sql-tests.mjs` defined nowhere** but referenced by P9 verify-all and CI. | P9:145,173,673 |

---

## Per-plan findings

### P1 — gateway and input integrity · DRIFT FOUND
1. `fakeModeration()` in Task 1 is `{flagged}`-shaped; Task 5 tests call `moderation.next({ state: 'unavailable' })`. Task 5 never touches `fakes.ts`. Tests will not type-check. (P1:934–955 vs 1324,1369,1387)
2. Task 7's veo `reference_unsupported` test is unreachable: the branch is guarded by `!video`, and veo is video. (P1:2359–2382 vs 2433)
3. Evidence and strike recorded even when the quarantine copy fails — spec:541 says record only after quarantine succeeds. (P1:1517–1519, 1385–1399)
4. Spec T01 integration-DB / RLS-denial tests (spec:504,542) entirely absent; plan has in-memory fakes only.
5. Pending/video parent returns 409; spec R01 says readable 400. (P1:2260) Scratch cleanup has no `try/finally` (spec:220). Nested ifs at 2249–2264, 2419–2448, 2767–2779.

### P2 — billing fulfillment · DRIFT FOUND
1. **Entitlement upsert breaks.** `jsonb_populate_record` insert yields explicit NULL `id`/`created_at` (defeats defaults, fails on first Apple purchase); `plan = excluded.plan` unconditionally, and the clawback patch omits `plan` → NOT NULL violation → 500 → Apple retries forever. (P2:320–336 vs 1480,1507)
2. Pack credits read from Stripe `session.metadata.pack_credits`, contradicting plan line 19 and spec:552 "never trust client-provided grant values". Use `packCredits(usd, plan)`. (P2:1111)
3. No expired/revoked-receipt guard: `applyIapTransaction` sets `active` even when `expiresDate` is past (spec:568). (P2:1430–1450)
4. No failure-injection or retained old-defect test despite line 37's claim (spec:566–567).
5. `billing_transactions` lacks attempts/last_error; no `webhook_events` retention (spec:109). `amount_paid <= 0 → null` grant is a new decision not in the spec (100%-coupon renewals get nothing). `IapOutcome` declared with `retry_later` but defined without; `/iap/verify` leaks `ignored` as 200.

### P3 — catalog and provider contract · ALIGNED WITH NOTES
1. `t.credits` should be `t.creditCost` (`model-families.ts:417`) — fingerprint and export emit `undefined`. (P3:1380,1448)
2. `normalizeGenerationRequest` silently defaults (`?? NANO_MODELS.standard`, `?? GPT_MODELS['1']`, `?? table['1K']`), contradicting spec:136 "never replace an unsupported selection silently". (P3:425,485,492)
3. Seedream test asserts flat pricing, which fails if Task 1 chooses to wire resolution. (P3:284–297)
4. No output-metadata validation (returned dimensions/model) and no quote-version-mismatch test (spec:591–592,138).
5. `sync-shared.mjs` listed as modified but never touched; `tsx`/`vite-node` toolchain undecided (P3:1487–1490).

### P4 — job settlement · DRIFT FOUND
1. `drainOutbox` is select-then-update with no claim / `for update skip locked` / conditional `sent_at is null` — two concurrent drains double-send, failing its own exit criterion. (P4:1520–1580 vs 1650)
2. `/edits/save` and `/library/import` fix targets the upload (already checked today); the real ignored result is the final `media_path` update (spec:144). No route tests for either (spec:606). (P4:1370–1385)
3. Truncated video undetected: observed length never compared to a non-zero declared `Content-Length` (spec:310). (P4:1262–1277)
4. `sendPush` signature disagrees three ways: real `push.ts:111` is 3-arg; plan calls with 4; test fake is `(userId, _tokens, event)`. (P4:1435,1500,1548)
5. Plan line 7 and spec:603 promise an "expected state" parameter on `fn_settle_job`; the signature hardcodes `pending`. `retryAfterSeconds` defined but never consumed (spec:192 back off on throttling). fal `check` rewrite elided (`// ... existing status parsing ...`). Cancel enqueues a `generation_failed` push for a user-initiated cancel. Nested if at 348–353.

### P5 — durable dispatch · DRIFT FOUND
1. **`fn_reserve_generation` never inserts into `submissions`** — idempotency is inert; SQL test 1 and the gateway replay test would fail. (P5:378–446 vs 589–595, 1440–1458)
2. **`fn_claim_jobs` sets `state='leased'` on every claim**, so `runJob`'s poll branch (`state === 'submitted'`) can never fire on a real row → every claimed job resubmits every tick. Ambiguous submits are released with no `providerRef`, so the "next tick reconciles by asking the provider" comment is false — they resubmit too. The `release_expired_leases` cron resets to `ready` with the same hazard. (P5:489,545,1113,1134,1154–1159)
3. Persona slot atomicity (spec R09:47,53; T07:68) has no implementing task; rehearsal row expects it. (P5:1746)
4. Provider expense inserted per item but `v_cost` already multiplied by batch → over-recorded ×batch. `provider` default `'unknown'` violates `jobs_provider_check`. (P5:373,432,1581)
5. D3: Task 5 heading says "restore the promise" while body and index say gate on deployed+verified. The currently live copy in `pending-video-card.html:11` is never removed. Re-sign test body elided; `resolvePayload` never written; `dispatch_test` `deps()` supplies `storageFor` not `finish`. Nested ifs in plpgsql 379–405 and TS 1113–1124.

### P6 — durable deletion · DRIFT FOUND
1. **Outbox has no bucket column** and `supabaseStorage.delete` hard-codes `media`. Persona photos, zips, uploads and quarantine live in the `uploads` bucket; Supabase `remove` of a missing key returns no error → worker marks `gone`, bytes stay. Silent false success on likeness data. (P6 schema; `storage/supabase.ts:4`)
2. See X1 — `uploads` column names.
3. Persona ZIPs (`persona-zips/`), quarantine objects, moderation evidence retention, and the provider-hosted LoRA (`lora_url` is a fal URL; plan's `lora_path` is written by nothing) are unaddressed (spec:232,640–641). Retention table has no moderation row.
4. Stripe non-active statuses and Apple original transactions left "exactly as is" despite spec:230,642.
5. `cancelJobForGeneration` calls `adapterFor(job.provider)` but the real signature is `adapterFor(familyId)`; `FAR_FUTURE` undefined; sets `state='done'` bypassing P5's lease. `fn_purge_lapsed` and `fn_delete_account` delete rows directly and never cancel jobs. `drop function fn_delete_account` appears after its `create or replace`. `storage_backend` default `?? 'r2'` at `api/index.ts:1708` never unified (spec:636). `vansen.md:163` "no grace period" never edited.

### P7 — web client correctness · DRIFT FOUND
1. `/ledger` pagination (`.limit(100)`, `ledger-service.ts`) omitted from Task 3 despite spec R16:290 / T13:722.
2. Immutable-revision pinning deferred to Task 6, which invalidates the `resolve/main` hashes measured in Task 4. Pin in Task 4. (P7:1305,1347 vs 1683)
3. AuthService spec assertions fail under the plan's own `SessionLifecycle` semantics: `whenReady()` settles with null, so `SIGNED_IN user-1` is a change and resets. (P7:346,356)
4. `JobPoller` has `stop()` not `reset()`; persona training interval never mapped — spec R12 acceptance "no timer started under A fires after sign-out" unmet. (P7:398–412)
5. Version-chain / deep-link lookup hedged "if it does not already exist"; no paging-under-mutation or timestamp-tie tests (spec:726,730). `unsavedChangesGuard()` called with zero args on a 4-param `CanDeactivateFn`. `StaleSessionError` undefined. `makeThumbnail` in Deno has no image library named. Nested if at 1476–1482.

### P8 — product truth and recovery · DRIFT FOUND
1. `STUDIO_TOOLS` does not exist (`right-panel.ts:60` is unexported `LOCAL_TOOLS`; `PRO_TOOLS` also unexported). `ENTITLEMENTS` keys include `rotate/flip/straighten` which are not `StudioTool` ids and omit `adjust/sharpen/portraitsmooth/mask`. Task 4's own specs cannot pass. (P8:774,785,836–841)
2. See X3 — `failure_code` writer and client bindings.
3. Landing page, footer, in-app pitch tool lists and "20% lower effective cost" on landing have no implementing step despite exit criterion 1292 (spec:360 "pricing and landing"). `this.availability.enabled()` service does not exist and the pricing page is unauthenticated.
4. Variation of persona/i2v items untested and unrefused (spec:711); no upscale or parent-video retry test; aspect-omission test covers 3 of 5 families (exit criterion says five).
5. Resend-confirmation has no UI/route; server-side rate limit and redirect-origin config absent; signed-in-user-opens-link and back-navigation cases missing from the manual table (spec:374,784–785). DTO shape `failureCode/failureMessage` deviates from spec T12's `failure: {code,message,cancelled}` that MT-03 consumes. `fn_reserve_generation` never updated to insert `request_snapshots`. Helpers `toolLabels/requiredPlanFor/toolsFor/familyByName/toolByLabel/requiredSlots/makeHost` used, never defined. Task 6 Step 3 page specs are prose only.

### P9 — release gates · DRIFT FOUND
1. See X2, X5, X7, X8.
2. Manifest test injects `testDeps({ gitRevision })` but the route reads `Deno.env.get('GIT_REVISION')` — first assertion cannot pass. (P9:300 vs 355)
3. Alerts have no delivery destination — `alerts` is a table nobody reads unless someone runs SQL; L743 requires "confirm alert delivery" with nothing configuring it. Error IDs are one prose sentence with no gateway code or test. (spec:797, Gate D:893)
4. `update models set enabled=false where id not in ('flux')` turns off google/openai/upscaler/edit-* that are live today — a customer-facing outage buried in a one-liner. Needs an explicit callout and decision. (P9:859)
5. Line 25 says MCP failures are unproven; line 810 says the MCP tool is broken. P1 Task 3 already implements 204 handling, so P9 Task 4's 204 test will not be RED. `v_n int` receives `sum(cost_usd)` numeric — truncates cents. Rollback rehearsed on local stack; spec Gate D says staging. `release-evidence.md` and the runbook each created in two tasks. Index still says R27 → P9 "1–7" after renumbering to 8.

### Index · MINOR MISMATCHES
1. index:90 "P4 needs P3" — P4:11 does not state it (see X6).
2. index:71 D6 "P4 Task 6" — P4 never mentions D6.
3. index:68 D3 → "P9 Task 6" — P9 Task 6 never names D3; only Step 4 alludes to it.
4. index:57 R27 → "P9 1–7" — stale after P9 renumbering; also P1 Tasks 1–3 own the seam/204 halves.
5. index:58 R28 → "P3/3" — Tasks 4–5 also close it.
6. index:88/96 parallelism claims conflict with P3:23 / P7:25 "baseline after Pn" test counts.
7. index:98 P8 also depends on P2 (D1).
8. index:129 SQL tests also run in P8 (applies 0023).
9. index:38 R08 → "P4 1–2, 5" — settlement is Tasks 3–4 too.

---

## House-rule violations (all plans)

- **Nested ifs** in code samples: P1 (3 sites), P2 (plpgsql ×2, nested ternaries ×2), P3 (`capture.ts`), P4 (fal `check`), P5 (plpgsql ×2, TS ×1), P7 (`loadModelBytes`). P6 and P8 clean.
- No `git commit` steps anywhere. P9:84 "Generate and commit a Deno lockfile" is wording only — change to "user commits".
- No secrets in code or migrations. P5/P6 crons read the service-role key from a DB GUC set by P9 — weaker than Vault; note for P9.

## Recommended order of repair

1. Resolve X1–X8 (cross-plan contracts) first, editing the *owning* plan and every consumer together.
2. P5 items 1–2 and P2 item 1 — these are "the feature does not work at all" defects, not gaps.
3. P6 item 1 (bucket blindness) — legal exposure disguised as success.
4. Everything else per plan, then re-run this audit.

---

## Verified disposition and corrections (2026-09-21)

Reviewed against the current worktree at base revision `dc2e361`, the September 17 source spec, all nine September 20 plans, their index, and the relevant gateway, migrations, provider/storage interfaces and Angular components. This is a plan correction, not proof that the planned application changes work at runtime.

### What was confirmed and what needed qualification

- The major blockers are real: incompatible upload columns, incomplete billing upserts, missing submission replay insertion, claim state destroying polling state, ambiguous resubmission, bucket-blind cleanup, missing persistent failure bindings and release checks that lacked their implementation/setup.
- **X4 is partly overstated:** P5 already instructed extraction of a shared store helper. It did not supply a consistent owning task, exported signature or worker-safe imports. P4 now owns shared settlement/store/notification modules and P5 consumes those exact contracts.
- **X5 is an inconsistent plan, not a missing recommendation:** P9 already required a full Supabase baseline in prose, while its database job and later cron wording contradicted it. The CI example now uses the full baseline, an explicit setup/bootstrap contract and an actual SQL runner; skipped schedules do not count as success.
- The current `ProviderAdapter` already has a `provider` property. P5 now uses its allowlisted backend identity and rejects unknown values; it does not require inventing a missing adapter property.
- P3's “aligned with notes” label understated executable defects: `creditCost`, unsupported-selection rejection, capability-dependent Seedream tests, output validation and both catalog checks needed corrections.
- The original “structurally consistent” verdict missed the index/dependency/task-reference issues listed by the audit itself. Those references have been updated.

### Owning-plan correction map

| Findings | Corrected plan contract / tasks |
|---|---|
| X1; P6.2; P8 upload fixtures | P1 remains the canonical upload schema (`path,bytes,mime,purpose,width,height`); P6 consumes it and separately stores backend/bucket/path locators; P8 fixtures supply required columns and adds an explicit mask purpose. |
| X2; P9.1 | P9 passes `p_since` to P2's reconciliation function. Overdue verified receipts are separated from valid zero-delta grants. |
| X3; P8.2 | P4/0019 owns and writes safe failure columns. P8 maps them to `failure:{code,message,cancelled}` and updates the generation store/library binding plus reload regression. |
| X4; P4.4 | P4 Tasks 4–6 own shared settlement, finishJob and notification delivery; P5 imports only bundled shared modules. Push uses the actual three-argument API and serializes notificationId. |
| X5, X7, X8; P9.1 | P3 Task 7 implements non-mutating sync/export checks and retained JSON/Dart fixtures. P9 defines the SQL runner and full Supabase bootstrap/CI setup, including schema/extension and failure checks. |
| X6; index 1/6/7 | P4 explicitly depends on P3; P8 dependencies include billing, settlement, reservation, deletion and client contracts. Execution baselines are measured, not inferred from predicted test counts. |
| P1.1–5 | Tasks 4–8 update the moderation fake with its new contract, reject video use of the image-reference field, require successful quarantine before evidence/strike, use scratch finally cleanup, add real DB/RLS tests and readable 400 parent rejection. |
| P2.1–5 | Explicit entitlement insert columns preserve defaults/required plan; packs derive from verified purchase/catalog inputs; receipts reject expiry/revocation/missing expiry; retained rollback/old-marker tests, delivery attempts, reconciliation and retention are specified. Discounted paid cycles retain the full D1 grant; successful/rejected/retryable outcomes are distinct. |
| P3.1–5 | Correct creditCost field, no unsupported version/size fallback, verified mapping input, conditional Seedream coverage, output/quote-version validation and an explicit pinned exporter toolchain. |
| P4.1–5 | Atomic notification claims and fenced acknowledgements; final save/import DB-write checks; bounded/truncation-checked downloads; correct push signature; expected-state/lease settlement, safe cancellation metadata and Retry-After handling. Provider examples retain fal's actual JSON queue-reference shape. |
| P5.1–5 | Reservation includes the submission row and server-derived charge attribution; lifecycle and lease are separate; uncertain acceptance stays in reconciliation; persona creation/training are atomic worker work; expenses record unit cost once; payload re-signing tests and default-off D3/D6 copy are explicit. |
| P6.1–5 | Exact backend/bucket/path deletion, artifact intent before writes, ZIP/scratch/quarantine/provider coverage, retention decisions, all subscription statuses, closure tombstones, lease-owned cancellation and full paginated inventory. No fake local LoRA path or row deletion that loses pending work. |
| P7.1–5 | Ledger and generation pagination, required ID/version-chain access, mutation/timestamp-tie tests, immutable pinning before hashing, corrected auth expectations, actual poller stop/reset behavior, named thumbnail runtime, cancellation type and correctly invoked Angular guard. |
| P8.1–5 | Actual exhaustive StudioTool IDs and shared labels, all sales surfaces/public capability loading, persistent cancellation, complete retry/variation and five-family reference tests, real slot test helpers, atomic snapshots, confirmation-resend UI/routes and recovery/redirect/rate-limit tests. |
| P9.2–5 | Injected manifest metadata; request IDs and a durable alert destination/delivery path; exact reviewed rollout flag scope; verified tooling statements; 204 retained as an existing regression; decimal expense totals; staging rollback; single ownership of evidence/runbook files. |
| Index 2–5/8/9 | D3/D6 named in owning tasks; R27 points to P1 and all eight P9 tasks, R28 to P3 Tasks 3–5, R08 to P4 Tasks 1–5; P8 SQL is included. |
| House rules | Revised TS/JS snippets use guard clauses without nested if statements. Worker credentials use Vault and dedicated secrets. Git remains the user's action. |

### Limits that remain explicit before execution/release

- The plan set still has **60 implementation tasks**: P1 8, P2 8, P3 7, P4 7, P5 5, P6 5, P7 6, P8 6, P9 8. The index is the tenth document.
- Provider account capability evidence, current migration/deployment inventory, D2 retention, D4 locale and trend-asset decisions are inputs to their owning tasks; this review did not invent those answers.
- Ambiguous remote acceptance without provider lookup cannot honestly promise automatic recovery or exactly-once remote dispatch. It remains tracked for verified recovery without a blind resubmit.
- Push delivery is at least once with a stable notification ID; duplicate-free user behavior requires receiving-client deduplication evidence. Exactly-once database settlement is a separate property.
- Provider-hosted deletion requires evidence or an explicit limitation; local object removal cannot prove a third party removed a LoRA.
- Video generation remains in scope. A testable release still requires the enabled provider, billing, storage, offline completion and real-browser gates in P9. Mobile readiness remains the companion plan's responsibility.

### Verification performed on the documents

- All 10 plan documents have balanced Markdown fences and sequential task numbering; total remains 60.
- Evaluated the SQL-runner example with nine synthetic cases: success, missing environment, remote URL, no SQL files, missing baseline, failed SQL, failed concurrency harness, spawn error and signal termination.
- Evaluated catalog generation/check examples for successful generation, valid checks, JSON drift, Dart drift and missing fixture; checks do not write files.
- Scanned TS/JS snippets structurally for nested if statements and checked SQL snippets for nested conditional blocks; none remained in those scans.
- Checked whitespace with `git diff --check`. These checks validate document structure and selected examples, not application type-checking, SQL migrations, provider behavior, payment fulfillment or deployment.
