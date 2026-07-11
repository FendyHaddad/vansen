# java-migrate-plan — Scaling Vansen on Java + Postgres

**Status: brainstorming / future-planning only. Nothing in this document is scheduled,
approved, or implemented. The current stack (Supabase Edge Functions + Postgres) stays
exactly as-is until the triggers in §2 fire and the user explicitly green-lights a phase.**

Date: 2026-07-11. Author: spec drafted against the live Foundation/Phase-3b codebase.

---

## 1. Why this document exists

Vansen today runs its entire server side inside Supabase: Postgres (5 tables, RLS
deny-all, service-role-only RPCs), a single Hono gateway Edge Function (`api`, ~18
routes), a `stripe-webhook` function, pg_cron sweeps, Supabase Auth, and Supabase
Storage. `vansen.md` explicitly says *"No separate Java/Spring backend"* — and that
remains the right call at current scale.

But Edge Functions have a ceiling, and we want the escape route designed **before** we
need it, not during an outage. This spec is that escape route: a detailed map from every
current component to a Java + Postgres architecture, a migration sequence that never
requires a big-bang rewrite, and the scaling machinery (pooling, queues, caching,
observability) that a JVM backend unlocks.

Key insight that shapes everything below: **we are already on Postgres.** Supabase *is*
Postgres. The migration is therefore primarily a **compute migration** (Deno isolates →
JVM services), not a data migration. The database can stay put through most of the plan,
which removes the single riskiest step from the critical path.

### Non-goals

- No code, no build config, no dependencies added now.
- Not a proposal to leave Supabase Auth/Storage on day one — those detach in late,
  optional phases.
- Not a microservices manifesto. Target is a **modular monolith** that can split later.

---

## 2. Migration triggers — when to actually do this

Do **not** migrate on vibes. Any one of these is a signal; two or more is a green light:

| # | Trigger | Why Edge Functions break here |
|---|---------|-------------------------------|
| T1 | Sustained > ~50 req/s on `api` or p95 latency > 1.5s from isolate cold starts | Per-invocation isolates, no warm connection pool, CPU-time caps per request |
| T2 | Provider fan-out needs true background workers (retry queues, priority lanes, per-provider concurrency caps) | Edge Functions have wall-clock limits; today fal jobs are polled by the *client* hitting `GET /jobs` — that pattern collapses under load |
| T3 | Video generation (Phase 4b) ships and jobs run minutes, not seconds | Long-lived orchestration doesn't fit request-scoped isolates |
| T4 | Ledger reads slow down (balance = `SUM()` over an ever-growing `ledger_entries`) | Fixable in SQL alone (§6.3), but usually co-occurs with T1 |
| T5 | Compliance/enterprise asks: audit exports, SOC2 controls, VPC peering, data residency | Easier with owned infra |
| T6 | Supabase pricing or Edge Function limits become the dominant cost line | Pure economics |
| T7 | Team grows and wants typed, testable, debuggable server code with real profilers | JVM tooling advantage |

**Anti-triggers** (do *not* migrate for these): wanting Java for its own sake; a single
slow endpoint (optimize it); Realtime hiccups (client polls today anyway).

---

## 3. Current-state inventory (what must be reproduced)

Everything the Java backend must replicate, from the live system:

### 3.1 Data (Postgres, stays in place)

- `profiles` — 1:1 with `auth.users` via FK + `handle_new_user()` trigger; `strikes`,
  `prefs` jsonb (≤4 KB check), `stripe_customer_id UNIQUE`.
- `ledger_entries` — append-only money ledger, `numeric(10,2)` USD, signed amounts,
  types `topup|generate|edit|upscale|studio_fee|trial_credit|promo|refund`,
  `stripe_ref UNIQUE` (double-credit guard), partial unique index `ledger_refund_once`
  on `note` where `type='refund'` (refund exactly once per generation).
- `generations` — library rows; status `pending|done|failed`; `parent_id` version
  chains (Studio edits); `media_path` into private Storage; prompt ≤2000 chars,
  settings ≤4 KB.
- `jobs` — provider work tickets (`google|openai|fal`), `provider_ref`, `attempts`,
  `error`; partial index for pending sweep.
- `subscriptions` — one per user, plan `studio|studio_pro`, Stripe sub id, period end.
- `models` — kill-switch rows (`enabled` boolean) per family + per edit tool.
- `moderation_events` — appeal evidence (prompt, quarantined upload path, category
  scores, `resolution`).
- `webhook_events` — Stripe event dedupe.

### 3.2 Invariants (the actual product, in rule form)

1. **Balance is always `SUM(ledger_entries.amount_usd)`** — never a stored number.
2. **Charge is atomic and race-free**: `fn_charge_and_generate` takes
   `pg_advisory_xact_lock(hashtext(user_id))`, checks balance, writes debit + pending
   generation rows in one transaction. Concurrent submits cannot double-spend.
3. **Refund exactly once**: `fn_fail_job` flips `pending→failed` and inserts a refund
   guarded by the `ledger_refund_once` unique index + `ON CONFLICT DO NOTHING`.
4. **Moderation before charge, charge before provider**: flagged prompt/upload → zero
   ledger writes, zero provider calls, strike recorded; 2 strikes = suspension (429).
5. **Stripe webhook is the only `topup` writer**; signature-verified, deduped via
   `webhook_events` + `stripe_ref UNIQUE`.
6. **Kill switch**: `models.enabled=false` → 503 on dispatch, no charge.
7. **Stale jobs die**: cron every 5 min fails jobs pending >10 min (→ single refund).
8. **Lapse purge**: daily cron deletes `generations` 30 days after a lapsed period
   ends; ledger rows are never purged.
9. **Provider keys never leave the server**; requests carry hashed `safety_identifier`,
   never raw user ids.
10. **Gateway-only data path**: clients have zero direct table/RPC access (RLS
    deny-all + `REVOKE EXECUTE`); supabase-js is used for **auth only**.

### 3.3 API surface (the contract to preserve verbatim)

From `supabase/functions/api/index.ts` (Hono, JWT-authenticated except webhooks):

```
GET    /profile              GET  /ledger            GET  /generations
PATCH  /profile              GET  /models            GET  /jobs        (fal poll pump)
DELETE /profile              PUT  /prefs
POST   /generations          (moderate → charge → dispatch; op: generate|edit|upscale)
POST   /uploads              (moderated reference/mask uploads → private bucket)
POST   /edits/save           (moderated $0 "Studio Edit" version, Studio-gated 403)
POST   /library/import       DELETE /generations/:id
POST   /billing/checkout     POST /billing/portal    POST /billing/reconcile
```
Plus the separate `stripe-webhook` function. Error contract: typed error strings the
Angular app switches on (`insufficient_balance`, `studio_required`, `flagged`,
`suspended`, `model_disabled`, …) with 4xx/5xx codes — these strings are frozen API.

### 3.4 Shared catalog

Angular is the master for enums + `model-families.ts` (pricing, capabilities,
`EDIT_TOOLS` fixed retail prices); `npm run sync-shared` copies into
`supabase/functions/_shared/`; vitest guards drift. Any Java plan needs an equivalent
single-source story (§10).

### 3.5 Platform services in use

Supabase Auth (email/password + Google; session cap policy), Storage (private `media`
+ `uploads` buckets, 7-day signed URLs), pg_cron (2 sweeps), Edge Function secrets
(Stripe ×3, provider keys ×3). Realtime is in the product spec but the shipped flow is
client polling of `GET /jobs`.

---

## 4. Target stack (recommendation + rationale)

### 4.1 Language & framework

**Recommendation: Java 25 LTS + Spring Boot 4.x (Spring Framework 7), virtual threads
on.**

- Java 25 is the current LTS (Sept 2025); virtual threads (stable since 21) make
  thread-per-request scale to tens of thousands of concurrent connections — ideal for
  our I/O-bound broker workload (we mostly wait on OpenAI/fal/Google/Stripe).
- Spring Boot 4 / Framework 7: mainstream hiring pool, first-class Postgres/Stripe/
  OAuth2 ecosystems, `RestClient` for provider calls, Actuator for ops. Boot 3.5 is the
  conservative fallback if a critical dependency lags Boot 4.
- Considered and rejected for v1: **Quarkus/Micronaut** (great cold-start/native-image
  story, but we're building long-running services where JIT throughput wins and Spring's
  ecosystem depth matters more); **Kotlin** (fine language, but "Java backend" was the
  stated direction and mixed-language adds onboarding cost — revisit if the team
  prefers it).

### 4.2 Architecture shape: modular monolith

One deployable (`vansen-api`) with enforced internal module boundaries
(Gradle multi-module or Spring Modulith):

```
vansen-api
├── module: gateway      (REST controllers, auth filter, rate limiting, error mapping)
├── module: accounts     (profiles, prefs, account deletion, strikes/suspension)
├── module: ledger       (balance, charge/refund services — owns ALL money writes)
├── module: generation   (dispatch orchestration, jobs, kill switch, catalog)
├── module: providers    (adapter SPI: google | openai | fal — port of _shared/providers/)
├── module: moderation   (omni-moderation client, strike policy, evidence store)
├── module: billing      (Stripe checkout/portal/reconcile + webhook consumer)
├── module: media        (storage abstraction: Supabase Storage now, S3 later)
└── module: sweeps       (scheduled jobs: stale-job fail, lapse purge)
```

A second tiny deployable, `vansen-worker`, runs the queue consumers (§7) so web and
worker scale independently — but it's the same codebase/image with a different profile.
Split into real microservices only if/when a module's scaling profile demands it
(realistically: `providers`/`generation` workers first, everything else likely never).

### 4.3 Postgres

**Stay on the existing Supabase Postgres instance through Phases 0–3.** Supabase
Postgres is vanilla Postgres with extensions; a JVM service connects to it like any
other PG. Moving the data (to RDS / Cloud SQL / Aurora / Neon / self-managed) is
**Phase 5, optional**, and only justified by cost, residency, or needing extensions/
versions Supabase won't run. This decouples "rewrite compute" risk from "move data"
risk permanently.

Connection topology once Java arrives: HikariCP in-app pool → Supabase's pooler
(PgBouncer/Supavisor, transaction mode) or, when self-hosting PG, our own PgBouncer.
Budget: `pool_size = cores × 2` per instance; Postgres `max_connections` guarded by the
pooler, not by hope.

### 4.4 Supporting infrastructure (introduced only when its phase needs it)

| Concern | Choice | Notes |
|---|---|---|
| Job queue | **Postgres-backed queue** (`FOR UPDATE SKIP LOCKED`) via JobRunr or hand-rolled | No new infra; the DB we trust is the queue. Kafka/SQS only if >1k jobs/s someday |
| Cache / rate limits | Redis (managed) | Token-bucket rate limits, hot catalog cache, balance cache (§6.3) |
| Scheduling | Spring `@Scheduled` + ShedLock (PG-backed) | Replaces pg_cron; ShedLock stops N replicas from double-running sweeps |
| HTTP client | Spring `RestClient` + Resilience4j | Timeouts, retries with jitter, circuit breaker **per provider** |
| Observability | OpenTelemetry → Grafana stack (or Datadog) | Traces across gateway→ledger→provider; RED dashboards; ledger-invariant alerts |
| Deploy | Docker on Fly.io/Render/ECS first; K8s only at real multi-service scale | Region **ap-southeast-1 / Singapore** to sit next to the DB |
| CI/CD | GitHub Actions: build, Testcontainers-PG test suite, deploy | Contract tests from §11 gate every deploy |
| Secrets | Platform secret store (Fly/ECS secrets) or Vault | Same keys as today; never in repo (unchanged rule) |

---

## 5. Component mapping — old world → new world

| Today (Supabase) | Target (Java) | Migration phase |
|---|---|---|
| `api` Edge Function (Hono, 18 routes) | `gateway` module — same paths, same JSON, same error strings | 2–3 |
| JWT check via Supabase Auth in gateway | Spring Security resource server validating **Supabase JWTs** (JWKS from the project; HS256 legacy secret supported if needed) | 2 |
| `fn_charge_and_generate` RPC | Keep the PL/pgSQL function initially, called via JDBC (fastest, zero behavior drift). Later inline as a `@Transactional` service using the same `pg_advisory_xact_lock` (§6.2) | 3 → 4 |
| `fn_fail_job`, `fn_increment_strike`, `fn_balance`, `fn_delete_account` | Same pattern: call-through first, port later. The unique-index refund guard stays in the DB **forever** — DB constraints outlive app bugs | 3 → 4 |
| `_shared/providers/*` adapters | `providers` module behind a `ProviderAdapter` SPI (`submit`, `poll`, `fetchResult`); config still lives in `models`/catalog rows — "new model = data, not code" rule survives | 3 |
| Client-driven fal polling via `GET /jobs` | Server-side queue workers poll/receive webhooks; `GET /jobs` remains but becomes a cheap DB read; later SSE push (§8) | 4 |
| `stripe-webhook` function | `billing` webhook endpoint, `stripe-java` SDK, same signature verify + `webhook_events` dedupe + `stripe_ref UNIQUE` | 3 |
| pg_cron `fail_stale_jobs` (5 min) | `sweeps` scheduled task + ShedLock (pg_cron kept as belt-and-braces until Phase 4 sign-off) | 4 |
| pg_cron `purge_lapsed_libraries` (daily) | Same treatment; purge gains Storage-object deletion (today's SQL cron can't delete files — this is a **latent gap the Java sweep fixes**) | 4 |
| Supabase Storage buckets + signed URLs | `media` module behind a `MediaStore` interface: `SupabaseStorageStore` first (its S3-compatible endpoint), `S3Store` later. 7-day signed URL semantics preserved | 3 (interface), 5 (S3 move, optional) |
| Supabase Auth | **Keep** as identity provider indefinitely; Java only *verifies* tokens. Full auth migration (Keycloak / Spring Authorization Server) is Phase 6, only if forced — it's the highest-risk, lowest-reward move (password hashes, sessions, OAuth registrations, `auth.users` FK) | 6 (optional) |
| `handle_new_user()` trigger | Keep while Supabase Auth remains master; if auth ever moves, replaced by provisioning in the signup flow | 6 |
| `npm run sync-shared` (Angular → Deno) | OpenAPI-first contract (§10): Java publishes spec, both Angular client types and catalog schema generated from shared JSON | 2 |
| supabase-js in Angular (auth only) | Unchanged until Phase 6 | — |

---

## 6. Data-layer design for scale

### 6.1 Schema stays; access pattern changes

No destructive schema changes required for the compute migration. Additive items:

- `jobs.status` explicit enum column (today status is inferred from
  `error`/`provider_ref`/generation status) — needed for queue semantics:
  `queued|submitted|polling|done|failed`.
- `jobs.locked_at`/`locked_by` **or** adopt a queue library's table — worker leasing.
- `outbox` table for the transactional outbox pattern (§7.2).
- `ledger_balances` snapshot table (§6.3) — only when T4 fires.
- Money representation: DB stays `numeric(10,2)`; Java uses `BigDecimal` end-to-end
  (scale 2, `RoundingMode` fixed policy, no doubles anywhere). A move to integer cents
  is a nice-to-have, **not** worth a ledger rewrite.

### 6.2 Concurrency: preserving the no-double-spend guarantee

The advisory-lock pattern ports 1:1 — same lock key so Java and the RPC can even
coexist mid-migration:

```java
@Transactional
public List<Generation> chargeAndGenerate(UUID user, BigDecimal amount, ...) {
  jdbc.query("select pg_advisory_xact_lock(hashtext(?::text))", user);
  BigDecimal balance = ledgerRepo.sumBalance(user);
  if (balance.compareTo(amount) < 0) throw new InsufficientBalance();
  ledgerRepo.insertDebit(user, amount, type, familyId, note);
  return generationRepo.insertPending(user, items);
}
```

Rules: identical lock key expression (`hashtext(uuid::text)`); all money writes go
through the `ledger` module only; `SERIALIZABLE` not needed (the per-user lock
serializes the only contended path); the DB-level guards (`stripe_ref UNIQUE`,
`ledger_refund_once`, CHECK constraints) are never removed — they are the last line
against any future app bug, exactly as designed.

### 6.3 Ledger at scale (T4)

`SUM()` per balance read is O(entries). Plan, in escalation order:

1. **Covering index** (exists) + Postgres is fine to ~10⁵ rows/user. Do nothing early.
2. **Snapshot table**: `ledger_balances(user_id pk, balance, last_entry_at)` refreshed
   transactionally on every ledger write (`INSERT … ON CONFLICT … DO UPDATE
   SET balance = ledger_balances.balance + EXCLUDED.delta`). Balance read = 1 row.
   Invariant check job: nightly `snapshot == SUM(entries)` assertion, alert on drift.
   The append-only ledger remains the source of truth; the snapshot is a cache.
3. **Partitioning** `ledger_entries` and `generations` by month (`created_at` range)
   once tables pass ~50–100M rows; old partitions to cheap storage. Purge cron becomes
   partition-drop-fast.
4. Read replicas for `GET /ledger`, `GET /generations`, admin analytics — never for
   balance-before-charge reads (must hit primary inside the lock).

### 6.4 Other scale items

- `generations` list endpoints: keyset pagination (`created_at, id` cursor), never
  OFFSET.
- `prefs`/`settings` jsonb size checks stay in DB; Java validates earlier for nicer
  errors.
- `moderation_events`: retention policy decision needed (legal evidence vs GDPR) —
  open question §13.
- pgvector/search, if the library ever gets semantic search — another reason to stay
  on Postgres for everything.

---

## 7. Async job architecture (the biggest win of the migration)

### 7.1 Today's shape and its limits

`POST /generations` moderates, charges, inserts `pending`, and dispatches inline;
fal jobs rely on the **client** calling `GET /jobs` to pump polling; a 5-minute cron
sweeps stragglers. Works at boutique scale; fails when clients disconnect, when video
jobs run 5+ minutes, and when providers need backpressure.

### 7.2 Target: transactional outbox + PG queue workers

```
POST /generations (gateway)
  └─ TX: moderate → advisory lock → debit → generations(pending) → jobs(queued) → outbox
Worker pool (vansen-worker, per-provider concurrency caps):
  └─ lease job (FOR UPDATE SKIP LOCKED) → adapter.submit()
       ├─ inline providers (openai, google): result → store media → done
       └─ queue providers (fal): provider_ref → scheduled poll loop (server-side)
            └─ webhook receiver (preferred, fal supports it) short-circuits polling
Failure at any point → fn_fail_job semantics: status=failed + refund-once (same index)
```

- Queue = Postgres table, `SKIP LOCKED` leases, visibility timeout via `locked_at`;
  `attempts` capped with exponential backoff; poison jobs → `failed` + refund + alert.
- Outbox row written in the charge transaction guarantees no charged-but-never-
  dispatched orphans even if the process dies between commit and submit (today's
  inline dispatch has a small window here; the sweep covers it — outbox closes it
  properly).
- Per-provider **circuit breakers**: fal down → its lane pauses, others unaffected;
  kill switch (`models.enabled`) checked at lease time too, not just submit time.
- Rate limiting per user at the gateway (Redis token bucket) — ports the RPC-enforced
  per-user limits and the dispatch concurrency guard from the org-ban policy.
- Video (Phase 4b) drops into this unchanged: longer visibility timeout, webhook-first.

## 8. Realtime / job-status push

Phase-4 option once workers exist: gateway offers `GET /jobs/stream` (SSE — simpler
than WebSocket through proxies, fits "status changed" semantics). Workers `NOTIFY`
Postgres channel on status flip; gateway instances `LISTEN` and fan out to subscribed
SSE clients. Angular falls back to today's polling automatically if the stream drops.
Supabase Realtime is thereby never a hard dependency to unwind.

---

## 9. Security posture mapping

Unchanged principles, new enforcement points:

- **Gateway-only data path survives**: Java connects with a dedicated PG role
  (not `service_role`) granted exactly the tables/functions it needs; RLS deny-all
  stays on so a leaked anon/authenticated key still reads nothing.
- Moderation gate order (moderate → charge → provider) is enforced in one orchestrator
  method with tests, not by convention across routes.
- Strikes/suspension: same policy (2 strikes → 429 on generate/upload); evidence to
  `moderation_events` unchanged.
- `safety_identifier` = same hash function as today (verify exact algorithm during
  Phase 3 port so provider-side reputations carry over).
- Secrets: env-injected, rotated per provider; Stripe live-key flip unaffected.
- New surface to harden: worker → provider egress (allowlist), actuator endpoints
  (internal network only), SSE auth (JWT on connect).
- Session cap / impossible-travel heuristics stay on Supabase Auth data while it
  remains IdP.

---

## 10. Contract & shared-catalog strategy

Replace the copy-script model with a spec-first one:

1. **OpenAPI 3.1 document** for the entire `api` surface, written in Phase 0 by
   transcribing the Hono routes (this is also the parity-test oracle, §11).
2. Java: springdoc generates/validates against it. Angular: `openapi-ts` generates the
   client types — deleting hand-maintained request/response interfaces.
3. Catalog/enums: one JSON schema + data file (`model-families.json`) as the single
   master; Angular imports it, Java loads it (and eventually it *is* the `models` table
   content, completing vansen.md's "model = DB row" goal). `sync-shared` + drift vitest
   retire.

## 11. Testing & parity strategy (Phase 0 deliverable, valuable even if we never migrate)

- **Golden contract suite**: black-box HTTP tests (request → expected status/body/error
  string) recorded against the live Edge Function, replayed against the Java gateway.
  A route may cut over only when green.
- **Ledger invariant property tests**: concurrent charge/refund/topup storms against
  Testcontainers-Postgres asserting: balance == sum, never negative post-charge,
  refund ≤ 1 per generation, `stripe_ref` dedupe holds.
- **Moderation drills** (port of the live drills): flagged prompt → zero ledger rows,
  zero provider calls, strike recorded; 2nd strike → 429s.
- **Provider adapters**: WireMock fixtures from real captured provider responses
  (success, content-policy refusal, timeout, malformed).
- **Load test** (k6/Gatling): submit storm at 10× current peak; assert p95 and zero
  double-spends.

---

## 12. Phased migration plan (strangler fig)

Each phase independently shippable, independently abortable. DB shared throughout —
Edge Functions and Java can serve interleaved routes indefinitely.

- **Phase 0 — Contract capture (no Java yet, ~days).** OpenAPI spec, golden contract
  suite, invariant tests against a shadow DB. *Pays for itself today as regression
  armor for the existing stack.*
- **Phase 1 — Skeleton + shadow reads (~1–2 wks).** `vansen-api` deployed in
  ap-southeast-1, Supabase JWT verification, read-only routes (`/profile`, `/ledger`,
  `/generations`, `/models`, `/jobs`) implemented and compared against Edge Function
  responses in shadow mode (no traffic cut).
- **Phase 2 — Read cutover (~days).** Angular gains a per-route base-URL map (config,
  not code); read routes flip to Java. Rollback = flip URLs back. Money and dispatch
  still 100% Edge Functions.
- **Phase 3 — Writes & money (~2–3 wks).** Port dispatch orchestration calling the
  *existing RPCs* via JDBC (zero behavior drift), provider adapters, uploads,
  edits/save, billing endpoints + Stripe webhook (Stripe dashboard: add second webhook
  endpoint, verify dedupe makes double-delivery harmless, then remove old). Cut over
  route-by-route behind the URL map.
- **Phase 4 — Async backbone (~2 wks).** `vansen-worker`, outbox + PG queue,
  server-side fal polling/webhooks, ShedLock sweeps (pg_cron disabled after 2 clean
  weeks), purge sweep gains storage-object deletion, optional SSE. Inline RPC logic
  may now be ported into `@Transactional` services (DB constraints stay).
- **Phase 5 — Optional data/storage moves.** Only on cost/residency/enterprise
  triggers: PG via logical replication to new primary (minutes of write-freeze, not
  hours — rehearsed twice on a clone first); media via dual-write + background copy +
  read-through, then bucket retirement.
- **Phase 6 — Optional auth move.** Explicitly discouraged unless forced. If forced:
  OIDC-compatible IdP, dual-token acceptance window, password-hash export (bcrypt
  compatible) or reset-on-first-login, session-cap logic reimplemented.
- **Decommission.** Edge Functions deleted only after 30 days of zero invocations
  (logs prove it). `vansen.md` stack section updated — with user approval — at that
  moment, not before.

### Rollback rules

Every phase's rollback is configuration (URL map / webhook endpoint / cron re-enable),
never a data restore, because the DB never forked. That property is the whole reason
for this plan's shape — protect it in every future decision.

---

## 13. Open questions (decide before Phase 0 starts)

1. **Hosting**: Fly.io / Render (fast start) vs AWS ECS (heavier, enterprise-ready)?
   Must be ap-southeast-1-adjacent while the DB stays in Supabase Singapore.
2. **Team**: who writes/reviews Java? Solo-maintainability argues for Spring's
   beaten path and against exotic choices.
3. **Realtime ambition**: is SSE push a product priority or does polling stay fine?
4. **`moderation_events` retention** vs privacy law (PDPA/GDPR) — evidence keeps
   appeals honest but is user content.
5. **Admin plane**: does `/admin/pricing` move server-side with real authz roles
   during Phase 3, or stay a client tool until later?
6. **Budget line** for the parallel-run period (Edge Functions + JVM + Redis + observability
   running simultaneously for ~2 months).
7. **Video (Phase 4b product) timing** vs this migration — if video lands first on
   Edge Functions, T3 pressure rises and Phase 4 (workers) should be prioritized over
   Phase 2–3 ordering above.

## 14. Cost sketch (order-of-magnitude, revisit at trigger time)

Parallel-run steady state: 2× small JVM instances (~1 vCPU/2 GB) + 1 worker + managed
Redis + observability ≈ low hundreds USD/month, on top of the existing Supabase
project (which continues to carry DB + Auth + Storage). Post-migration the Supabase
bill shrinks toward DB-only tiers. The dominant cost line remains provider API spend —
the migration's economics are about **headroom and reliability**, not saving money.

---

*End of brainstorming spec. No implementation authorized by this document.*
