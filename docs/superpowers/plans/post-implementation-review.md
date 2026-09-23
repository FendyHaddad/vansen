# Vansen P1–P9 implementation and release review

Reviewed 2026-09-22, Asia/Kuala_Lumpur. Checkout: `/Users/user/IdeaProjects/vansen`, `main`, `ebdcbe2`, clean. The review made no application-code or production changes. This document preserves that dated assessment; its test results and deployment observations are not a new verification run. Video enablement and switching Stripe to live mode are excluded from the remaining-work assessment. Fixing billing correctness and exercising test-mode fulfillment are not excluded.

## Verdict

Substantial implementation, but not all spec acceptance criteria are met. The architecture and automated coverage are materially improved; they do not establish a qualified paid release or that the implementation surpassed its acceptance requirements. Several prior correctness findings remain reproducible, and P7/P9 explicitly retain uncompleted runtime gates.

The governing requirements are the September 17 release-readiness review, the September 20 P1–P9 plans, and the recorded owner decisions. Product-intent items in `vansen.md` that were deliberately deferred or superseded are not silently reintroduced as new implementation requirements. Mobile remains a separate release scope.

## Phase assessment

| Phase | Assessment |
|---|---|
| P1: gateway/input integrity | Substantial implementation: dependency-injected gateway, fail-closed moderation, owned references, validation and route coverage. No additional P1 blocker established in this review; this is not blanket runtime certification. |
| P2: fulfillment | Incomplete. Late-invoice ordering, refund compatibility/error handling, and durable receipt capture have concrete gaps below. The signed-provider test-mode billing matrix is still unrecorded. |
| P3: provider/catalog contract | Normalized requests, drift checks and current cost/size tests are present. Current catalog is `2026-09-22.3`. Actual output/cost smokes remain incomplete, and FLUX's enabled state conflicts with its deferred pricing decision. |
| P4/P5: settlement/dispatch | Transactional reservation/settlement and a deployed worker are significant improvements. Crash recovery and unresolved-work escalation remain defective. |
| P6: deletion | Durable registry, queue, confirmation and account-closure machinery are implemented and tested. The evidence log records 21 production orphan deletions. That dated result is not a fresh end-to-end account/lapse/provider-artifact rehearsal in this review. |
| P7: client correctness | Session epochs, bounded editor history, model integrity/lifetimes and pagination are implemented. Real-weight tool outputs, browser/device performance and evidence-based resource limits remain open. |
| P8: product truth/recovery | Recovery routes, snapshots/retry, capability-driven copy and assets are present. Authenticated recovery/account-state/accessibility qualification and D4 locale decision remain open. |
| P9: release gates | Automated runner, CI configuration, telemetry and manifest exist. Deployment completeness, effective stuck-job detection, manual qualification and recovery rehearsal are not complete. Staging and alert delivery have recorded owner waivers; these are accepted risks, not passed gates. |

## Concrete correctness gaps

### 1. Late Stripe invoices can refill the current credit bucket — release blocker

`supabase/functions/stripe-webhook/handler.ts:126–148` retrieves the current subscription and uses its current plan/period to fulfill an older invoice. The SQL stale-period guard therefore receives the wrong period and cannot protect the current bucket. The isolated regression again observed September's invoice being labeled December. The prior rollback-only SQL reproduction showed 1,100 spent-down credits returning to 1,500; that SQL probe was not rerun against a current-schema database this turn.

Derive the invoiced entitlement/period from the paid invoice, then keep current-subscription mirroring separate. Retain an old-distinct-invoice-after-new-cycle regression, not merely identical invoice replay.

### 2. A saved provider reference does not recover a submitting job — release blocker

`supabase/functions/_shared/jobs/dispatch.ts:219` ignores `job.provider_ref` during reconciliation. Production's `job-worker/index.ts:41` reconciliation function always returns `pending`. A crash after `fn_record_provider_ref` but before release leaves a reference-bearing job reconciling indefinitely. The regression observed zero provider polls after repeated worker ticks.

Recover known pollable requests without resubmitting them. Unknown submissions must remain non-duplicating, with an actual operator resolution path.

### 3. A crashed save claim prevents completion under a replacement lease — release blocker

`supabase/functions/_shared/jobs/store.ts:190–200` only downloads when `claimed_at` is null. P5 removes the old schedule that cleared old save claims; `fn_expire_leases` clears lease fields, not `claimed_at`. The regression gave a replacement lease a years-old save claim and observed no download. Fence saving by current lease ownership and make abandoned save work reclaimable.

### 4. Apple refunds miss old grants and acknowledge lookup failures — correctness gap

`supabase/functions/_shared/iap-grants.ts:115–122` looks up only `apple:<transactionId>`, while historical grants use `iap:<transactionId>`. Refunds for those purchases return 200 without clawback. Separately, a failed database lookup is treated as a missing grant and also returns 200; that error-swallowing behavior predates these commits but remains unresolved by hardening. Both cases reproduced. Apple client qualification is outside the web-only release, but the deployed backend still contains these paths.

### 5. The verified billing receipt inbox has no runtime writer — required hardening

`billing_deliveries` exists in SQL, but runtime fulfillment (`supabase/functions/_shared/billing-fulfillment.ts:41`) calls the money transaction without first persisting a verified receipt. Searches found no runtime writer. A failed verified payment leaves no inbox row; the regression reproduced this. `fn_paid_unfulfilled` therefore cannot report that class of paid-but-unfulfilled purchase. Implement the durable receipt boundary promised by P2, including retry/error/resolution state.

### 6. Repeated reconciliation can evade both escalation mechanisms — required hardening

The dispatcher (`dispatch.ts:244`) calculates reconciliation attempts from submit/poll counts, neither of which increases during reconciliation. Twelve ticks produced no promised alert.

P9 adds a second blind spot: `supabase/migrations/0025_release_telemetry.sql:144–155` alerts only if `updated_at` is old. `fn_claim_jobs` and `fn_release_job` refresh that timestamp every tick. Thus a job that keeps being retried without making progress can remain stuck indefinitely without satisfying the database alert condition either. Use distinct progress/uncertainty age and reconciliation-attempt tracking. This SQL failure chain is source-confirmed; not run against a current local schema this turn.

## Additional omissions and qualification gaps

### Deployment coverage and manifest scope

`deploy.sh:250` deploys only `api`; line 261 deploys the web Cloudflare worker. It does not deploy `job-worker`, `cleanup-worker`, or either billing webhook. Those components need explicit deployment/version checks whenever their code or shared dependencies change. `WORKER_VERSION` is stamped from the API version, not the job worker version.

Fresh production observations:

- API manifest: revision `ebdcbe2`, schema `0025`, catalog `2026-09-22.3`, `workerVersion=v59`.
- Function inventory: API v59, job-worker v14, cleanup-worker v13, Stripe webhook v26, App Store webhook v16. Independent function version numbers need not match; the gap is absent component revision evidence.
- Downloaded job-worker bundle contains catalog `2026-09-21.1`.
- Important qualification: the downloaded OpenAI/Google adapter and finalizer files match current source, and the worker consumes the normalized provider model/settings stored by the API. The old embedded catalog alone does NOT prove current requests use old model IDs. This is a deployment-coverage/attestation gap, not a claim of a reproduced wrong-model request.

### Commercial and abuse controls

- The live manifest has `flux: true`, while `vansen.md:318` still says its retail price is undecided and must be decided before enabling it. Resolve that mismatch explicitly.
- Dispatch rate limiting is still listed as unstarted (`vansen.md:326–327`) and no generation-route limiter was found. The global/provider spend caps do exist; they are not a substitute for request-rate protection, especially for pre-charge uploads/moderation. The source release review requires request/spend controls before public paid rollout. Session-sharing heuristics are a separate deferred product policy.

### Runtime qualification still owed

- `docs/verification/editor-tool-results.md:75–103`: no recorded real-weight output qualification for heal, smart select/erase, cutout, bokeh, upscale or AI Sharpen; no peak memory/FPS/cold/warm measurements. The 40 MP input, 80 MP output and 192 MB history limits are provisional.
- Enabled image providers, paid edits and persona need scoped end-to-end smokes: actual requested model/size/quality, stored media, spend, deliberate failure and exactly-once refund. Recent catalog research/tests do not replace actual outputs.
- Authenticated free/Studio/Pro/owner/suspended/lapsed account workflows, recovery links, cross-account teardown, keyboard/accessibility flows and Safari/lower-memory checks remain pending in the release record.
- Stripe test-mode checkout/renewal/upgrade/downgrade/cancel/replay/reconciliation remains unrecorded. This is required independently of the later live-key switch.
- D4 needs an explicit English-only launch decision or completed en/ms localization. Legal/policy review remains outstanding.
- Backup restoration and rollback rehearsals are not recorded. No-staging and database-only alert delivery were owner-approved reductions, but neither becomes successful rehearsal or reliable paging. Manual monitoring needs an accountable operating procedure if retained.
- D3 deployed offline completion and D6 notification receipt are not closed by worker deployment alone. Keep unsupported promises hidden.

## Verification recorded during the review

- 535 Deno tests passed; six Edge entry points type-check.
- 574 web tests passed; production build passed.
- 72 script tests passed; migration filename inventory, shared/catalog checks and 12 trend-asset presence checks passed.
- Nine automated runner checks passed. `npm run verify` correctly exited 1 because SQL integration was skipped without `VANSEN_LOCAL_DB`.
- The available local `vansen-test-db` lacks `fn_schema_version`; it is not the current P9 schema. I did not upgrade/reset it or run current SQL tests against that stale baseline.
- All seven isolated prior-review regressions failed with the expected behavioral mismatches, not environment errors. File: `/tmp/vansen-review-regressions_test.ts`; output: `/tmp/vansen-current-regressions.log`.
- Baseline output: `/tmp/vansen-p1-p9-verify.log`. Initial sandbox runs failed on local IPC and image-codec network access; permitted reruns removed those environmental failures.
- No purchases, generation requests, production writes, deployment, account changes, or browser/device qualification were performed. Main checkout remained clean. Existing mobile changes were left untouched; its readiness is not included.

Recommended order: retain/fix the failing money and crash-recovery regressions; correct escalation and deployment coverage; settle FLUX/locale decisions and request-rate controls; then close the image-only browser/provider/billing/recovery matrix against an exact candidate revision. Video and Stripe live activation can remain deferred throughout.

## Retained reproduction summary

The temporary harness and logs above are local review artifacts, not committed regression coverage. Preserve these cases in the permanent suite when implementing fixes; temporary files may disappear.

| Case | Required result | Observed result |
|---|---|---|
| Recovered submitting job with a provider reference | Resume checking the known remote request | Zero provider polls after repeated ticks |
| Unknown submission after twelve reconciliation ticks | Escalate after the configured threshold | No stuck-reconciliation alert |
| Replacement lease with an abandoned save claim | Resume downloading/storing the result | No download |
| Old Stripe invoice delivered after a newer period | Retain the invoiced period; prevent current-period refill | September invoice labeled with December period |
| Apple refund lookup outage | Retriable failure, not successful acknowledgment | HTTP 200 |
| Refund of a historical `iap:` grant | Apply one matching clawback | No fulfillment call |
| Verified payment whose fulfillment fails | Retain a durable unresolved receipt | No `billing_deliveries` row |

## Closeout checklist

Remaining work only, in the order to do it. Everything else from this review is
fixed, committed and deployed (`c16b7fd`, attested 2026-09-22 — see
`2026-09-20-release-evidence.md` §10).

- [ ] **Recovery email.** Supabase dashboard: redirect allowlist for `/reset` and `/confirm`, templates, sender, recovery/resend rate limits, link lifetime ≤ 30 min. Then send one real email. See `2026-09-20-recovery-verification-log.md`.
- [x] **Schema drift.** Dropped `public.admins` and `profiles.monthly_budget` (`0033_drop_schema_drift.sql`, applied 2026-09-23). The diff now shows no table or column differences.
- [ ] **Rehearsals and records.** Done 2026-09-23: rollback rehearsed on the local stack (runbook §8; functions can only roll back to `73cd5cb` or later on schema `0033`), monitoring procedure written (`2026-09-23-monitoring-procedure.md`). Left: backup restore — production has **no backups** on the Free plan, so it waits for the Pro upgrade; legal/policy review. The legal review must also settle, before the persona privacy wording is published: (a) Google's paid-tier retention of prompts and images for abuse monitoring, which persona photos pass through; (b) whether persona face photos count as biometric data.
- [ ] **Leaked-password protection.** Enable after the Supabase Pro upgrade.
- [x] **Mobile catalog fixture.** Superseded 2026-09-23 by `GET /catalog` (`2026-09-23-server-driven-catalog.md`). `contracts/catalog/` and `export-catalog` are retired; mobile bundles `npm run catalog:mobile` output and refreshes from `/catalog`.
- [ ] **Clean-code revamp.** A maintainer without AI assistance can read and change the code. Hot spots: `supabase/functions/api/app.ts` (~4,100 lines), `workspace-page.ts`, `canvas-viewport.ts`, `tool-options.ts`, `model-families.ts`, `edit-session.ts`. Split by route group and feature, guard clauses over nesting, a short "how this module works" header per file. Behaviour must not change. Goes before MCP so the MCP tools land on a split `api`.
- [ ] **MCP connection.** Let a signed-in user connect the AI assistant of their choice (Claude, ChatGPT, other MCP clients) to their Vansen account and generate through it. Likely shape: a remote MCP server with OAuth sign-in whose tools call the existing `api`, so pricing, moderation, rate limits and the ledger stay in one place. Design spec first.
- [ ] **Website revamp.** Visual redesign of `features/landing`, `features/plans`, `features/legal`, `features/auth`; keep the capability-driven copy from P8.
- [ ] **Left toolbar glow-up.** Redesign `features/workspace/left-panel` around the sectioned-rail language: uppercase micro-titles, muted labels, grouped controls, less visible state at once.
- [ ] **Persona as saved references.** Deployed 2026-09-22 (`73cd5cb`, 0032 applied; release evidence §10). The `persona` family is off. Left: enable it with `update public.models set enabled = true where id = 'persona';`, run one persona generation and a Nano Banana reference edit (the Google adapter now sends the prompt after the images for every request), and set it back to `false` if the smoke fails. Then run `npm run persona:guides` (< $1) and `npm run persona:likeness -- <dir>` (~$0.52), and set `PERSONA_GEN.premium`. Mobile (`2026-09-23-mobile-personas.md`) reads the same switch from `/catalog` `flat.persona.enabled` and shows "Personas are temporarily unavailable." until it is on; guide JPEGs from `npm run persona:guides` are also what the phone's slot tiles load from the web origin (silhouette until then).
- [ ] **Smokes.** Each enabled image provider, paid edits, persona (~$0.27 per 4K persona image), analytics, offline completion, and Stripe test-mode checkout/renewal/upgrade/downgrade/cancel/replay.
- [ ] **Manual qualification.** Six account states, recovery links, cross-account teardown, keyboard and screen-reader flows, Safari, a low-memory device, and real editor model outputs with measured memory and FPS. Set the 40 MP / 80 MP / 192 MB limits from those numbers.

Video enablement and Stripe live activation remain out of scope. This document authorizes neither implementation nor deployment.

---

## Addendum 2026-09-22: re-check and omissions

Re-checked the same day against `main` at `ebdcbe2`. Every finding above still matches the code: `handler.ts` fulfills from the current subscription, `job-worker/index.ts` wires `reconcile` to a constant `pending`, `store.ts` claims only on `claimed_at is null`, `iap-grants.ts` looks up `apple:` only and returns on a null grant, no runtime file writes `billing_deliveries`, `dispatch.ts` counts `submit_attempts + poll_attempts`, `0025` alerts on `updated_at` only, and `deploy.sh` deploys `api` and the Cloudflare worker only. Nothing above needs correcting. One nit: the checkout was not clean at review time; `docs/superpowers/specs/2026-09-22-catalog-refresh.md` §13 was uncommitted.

### Not reported in the original review

1. **GPT reference images are sold below cost.** `POST /generations` charges `creditCost` only. A reference on `gpt-image` routes to `/images/edits`, which bills image input tokens at $8/1M on top of output. That surcharge is roughly $0.035–0.05 per reference, more than a 2.5 low/medium generation's whole provider cost. Measure `usage.input_tokens` on one live edit call, then price it. Source: catalog-refresh spec §13.
2. **Owner direction to drop `gpt-image` 1.5 and 2 is not applied.** `isDefault` still points at `'2'`. Five test files reference the two versions (`model-families.spec.ts`, `left-panel.spec.ts`, `request-validation_test.ts`, `generation-request_test.ts`, `openai_test.ts`).
3. **`moderation_unavailable` raises no alert row.** `app.ts:869` only logs to console. `0025` has eight alert kinds and this is not one of them, so a moderation outage that refuses every paid request is invisible to `public.alerts`. Needed before paid traffic.
4. **Account closure with a trained persona never finishes.** No provider exposes an artifact-deletion API, so nothing resolves a `provider_artifact_deletions` row and closure stops at `processing` with `providerArtifacts > 0`. Needs an owner decision: record fal's real capability or mark it `unsupported` and close anyway. See `2026-09-20-deletion-verification-log.md`.
5. **Password recovery has never sent a real email.** Code is complete, but the redirect allowlist for `/reset` and `/confirm`, email templates and sender, server-side recovery and resend rate limits, and a server link lifetime no longer than the 30-minute client grant are all unconfigured. See `2026-09-20-recovery-verification-log.md`.
6. **Dead RPCs still granted.** `fn_cycle_reset` and `fn_grant_pack` (`0008`) have zero callers since P2 but remain executable by `service_role`. Drop once no deployed function version calls them.
7. **Production schema drift.** `public.admins` and `profiles.monthly_budget` exist in production; no migration creates them and no code reads them. Dropped 2026-09-23 by `0033`.
8. **CI has no `deno cache` step.** On a cold runner the first `deno test` can fail three files fetching `jsr:@matmen/imagescript@1.3.1`. Warm runs pass, so this is intermittent.
9. **Analytics manual smoke not run** (punchlist #3, free). Persona live smoke (~$0.27 per 4K persona image) is mentioned above but the analytics one is not.
10. **`docs/superpowers/punchlist.md` is stale.** It says `api` v44 and `0025` unapplied; production is v59 with schema `0025`. Update or delete so two documents do not disagree.
11. **Mobile catalog fixture.** Superseded by `GET /catalog`: mobile renders the live catalog and ships `npm run catalog:mobile` output as its offline copy, so there is no fixture to hand over.
12. **Leaked-password protection** is off and gated to the Supabase Pro plan. Enable after the upgrade.
