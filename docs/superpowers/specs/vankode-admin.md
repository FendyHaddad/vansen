# vankode-admin — Consolidated Vankode Administration Console

**Status: brainstorming / planning only. Nothing here is implemented, scheduled, or
approved. This spec exists so that when the user is ready, the new `vankode-admin`
project can be created from a settled design instead of from scratch.**

Date: 2026-07-11. Scope: one admin console overseeing **Vansen** (this repo) and
**Algawth** (separate repo in the same GitHub account), extensible to any future
Vankode product. Pillars named by the owner: management, user blocking, finance,
coupon giving, and overall business oversight.

> **Access note:** the Algawth repository could not be read while drafting this
> (session repo access is scoped to `vansen`). Everything Algawth-specific is
> therefore expressed as a pluggable connector plus an intake checklist (§4) to be
> filled in before Phase D. The architecture is deliberately shaped so this gap
> changes nothing structural.

---

## 1. Why a separate admin project

What "admin" looks like today, honestly inventoried:

- `/admin/pricing` and `/admin/compare` are routes **inside the consumer Angular app**
  (`src/app/features/pricing`, `features/compare`) — and they carry **no `authGuard`**:
  anyone who knows the URL loads the pricing calculator UI. They're client-side tools
  over static catalog data, so nothing sensitive leaks *yet*, but it's admin surface
  squatting in a public app.
- Every real administrative act on Vansen — inspecting a user, resolving a moderation
  appeal (`moderation_events.resolution`), toggling a `models.enabled` kill switch,
  fixing a ledger issue — is done by hand in the Supabase dashboard or via SQL. No
  audit trail, no roles, no second pair of eyes, easy to fat-finger.
- Algawth presumably has its own equivalent ad-hoc situation.

A consolidated console fixes all of this once: **one login, one audit log, one RBAC
model, N products**. The consumer apps get *smaller* (embedded admin routes move out),
and dangerous power stops living in database dashboards.

### Non-goals

- Not a rewrite of either product's backend. Products keep their own databases, their
  own invariants, their own gateways. The console is a **client of admin APIs**, never
  a second writer to product tables.
- Not a public-facing app. No SEO, no marketing pages, no self-signup.
- Not (initially) a data warehouse. KPI snapshots come first; real analytics
  infrastructure is a later phase (§10, Phase E).

---

## 2. Product requirements (the five pillars, made concrete)

### 2.1 Business oversight ("overlooking the business")

- **Home dashboard**: per-product tiles — revenue today/7d/30d, active users, paying
  users, generation volume, job failure rate, provider spend vs revenue (live margin),
  open moderation appeals, alerts.
- **Ops view (Vansen)**: job queue depth, stale-job sweep activity, per-provider error
  rates and latency, kill-switch states, Storage growth.
- **Catalog management (Vansen)**: the existing pricing calculator and model-compare
  tools move here (finally auth-gated), extended to write real state: toggle
  `models.enabled`, edit prices/margins once the catalog lives in the DB (per
  `vansen.md` §1 — the console becomes the admin UI that plan always implied).
- **Safety view (Vansen)**: moderation event stream, strike leaderboard, appeal queue
  with the quarantined evidence, resolution workflow (`upheld` / `overturned: note`).

### 2.2 User management & blocking

- Global user search (email / id / Stripe customer id), per-product.
- User detail page: profile, strikes, suspension state, subscription + period end,
  balance (sum of ledger), full ledger history, generations (metadata — see privacy
  note §7.4), moderation events, sessions/devices.
- Actions (all audited, all role-gated):
  - **Suspend / unsuspend** — Vansen today infers suspension from `strikes >= 2`;
    the console needs an explicit override both ways (block a bad actor at 0 strikes;
    reinstate after appeal without deleting evidence). Requires a small product-side
    addition: an explicit suspension flag or admin strike adjustment (§8).
  - Revoke sessions (force logout everywhere — pairs with the account-sharing policy).
  - Resolve moderation appeals (writes `resolution`).
  - Delete account (existing `fn_delete_account` path, admin-invoked, two-person rule).
  - Adjust strikes (with mandatory reason → audit log).

### 2.3 Finance

- **Revenue & reconciliation**: topups vs Stripe (surfacing the existing
  `/billing/reconcile` self-heal per user, plus a batch view), webhook event log,
  failed/duplicate payment triage.
- **Ledger operations**: manual credit/debit **adjustments** — a new, admin-only
  ledger entry type (`adjustment`, §8) with mandatory reason and audit linkage; goodwill
  credits; correcting entries (never edits — the ledger stays append-only, corrections
  are new signed entries, same philosophy as the product).
- **Margin reporting**: per-model revenue vs provider cost (the pricing engine's math,
  fed by real ledger data instead of hypotheticals), per-user unit economics, Stripe
  fee amortization actuals.
- **Exports**: CSV/Sheets export for accounting and tax (date-ranged ledger, revenue
  by type, subscription MRR).
- Algawth finance: same page templates, populated via its connector once §4 is filled.

### 2.4 Coupons & promotions

- Vansen's decided policy is *"promo codes = Stripe-native coupons, zero code"* — keep
  that. The console doesn't reinvent coupons; it becomes the **management UI over
  Stripe**: create/expire coupons and promotion codes via the Stripe API, see
  redemption counts, tie codes to campaigns.
- **Direct credit grants**: separate from Stripe — pick user(s), grant N dollars of
  balance as a `promo` ledger entry (type already exists in the schema) with a campaign
  tag. Use cases: support goodwill, influencer seeding, beta rewards.
- **Campaign registry** (admin DB, §6): name, product, mechanism (stripe-coupon |
  credit-grant), budget cap, redemptions, owner — so marketing spend is visible and
  capped, not scattered.

### 2.5 Multi-product consolidation

- Product switcher in the shell; identical page templates per product where concepts
  align (users, finance, coupons), product-specific tabs where they don't (Vansen
  safety/jobs; Algawth's own specifics TBD via §4).
- Cross-product user linking (same email across products) — read-only correlation
  first; shared Vankode identity is explicitly out of scope (§12 open question).

---

## 3. Architecture

### 3.1 Shape: one new repo, console + thin admin backend

```
vankode-admin (new repo)
├── apps/console          Angular 22 admin SPA (same stack DNA as vansen:
│                         standalone components, signals, zoneless, spartan/ui + Tailwind,
│                         separate .ts/.html/.css files — reuse the house conventions)
└── supabase/             dedicated Supabase project "vankode-admin"
    ├── functions/admin-api   Hono gateway (same pattern as vansen's `api`):
    │                         auth, RBAC, audit writes, connector fan-out
    └── migrations/           admin schema (§6)
```

Rationale:

- **Same stack as vansen on purpose** — one set of conventions, components copyable
  between repos, and the team already knows the Supabase + Hono gateway pattern cold
  (RLS deny-all, service-role-only RPCs, gateway as sole data path). The admin project
  reuses the exact security posture that's already proven here.
- **Dedicated Supabase project** for the console (admin users, audit log, campaigns,
  KPI snapshots). Admin identity must not live inside a product's user pool — a Vansen
  auth bug must never mint an admin session, and admins must survive any one product
  being migrated/rebuilt (see java-migrate-plan).
- If/when the Java migration happens, `admin-api` is one more Hono gateway to port —
  or the admin module simply becomes part of the Java modular monolith. Nothing in
  this spec fights that plan; §11 aligns them.

### 3.2 The connector pattern (heart of the console)

Mirror vansen's provider-adapter philosophy: **adding a managed product = a connector
implementation + registry config, zero console-core changes.**

```ts
interface ProductConnector {
  id: 'vansen' | 'algawth' | ...;
  searchUsers(q): AdminUserSummary[];
  getUser(id): AdminUserDetail;          // profile, balance, subs, flags
  listLedger(id, cursor): LedgerPage;    // or product-equivalent money history
  suspendUser(id, reason): void;
  unsuspendUser(id, reason): void;
  revokeSessions(id): void;
  grantCredit(id, amount, campaign, reason): void;   // if product has balances
  listModerationEvents(...)/resolveAppeal(...)       // capability-flagged
  getKpis(range): KpiSet;
  // capabilities descriptor drives which console tabs render per product
}
```

Connectors run **server-side only** (inside `admin-api`), because they hold product
credentials. The console SPA never talks to product infrastructure directly.

### 3.3 How connectors reach the products — admin APIs, not databases

**Rule: the console never gets a product's `service_role` key and never writes product
tables directly.** Direct DB access would bypass every invariant the products enforce
(advisory-lock charges, refund-once index, moderation-before-charge, Stripe dedupe)
and would couple the console to product schemas forever.

Instead, each product exposes a small **`/admin/*` route group on its existing
gateway** (for Vansen: new routes on the `api` Edge Function; equivalents for Algawth
TBD), authenticated service-to-service:

- `admin-api` holds one secret per product (long random bearer or, better, short-lived
  JWTs signed with a per-product shared key; scoped headers carry the acting admin's
  id + role so product-side logs know *which human* acted).
- Product-side `/admin/*` middleware verifies the token, checks an allowlist, rejects
  everything else — same trust model the Stripe webhook already uses (verify, then act).
- Product-side admin routes reuse the product's own RPCs/invariants (e.g. a credit
  grant is a normal `promo` ledger insert; suspension flips the product's own flag) —
  the product remains the sole guardian of its data rules.

Rejected alternatives, for the record:
- *Console → product DB directly*: fast to build, catastrophic coupling, bypasses
  invariants, spreads `service_role` keys. No.
- *One shared mega-database for all products*: destroys product isolation, makes the
  java-migrate-plan's "DB never forks" property impossible. No.
- *Read replicas for console reads + APIs for writes*: viable later purely for
  analytics (Phase E), not for the operational console.

### 3.4 Admin authentication & authorization

- Supabase Auth on the **admin project**: email/password + TOTP MFA **mandatory**,
  Google SSO restricted to the `@vankode.com` domain. No self-signup — admins are
  provisioned by an owner.
- **RBAC**, small and boring:

| Role | Read | User actions | Finance/adjustments | Coupons | Catalog/kill switch | Admin mgmt |
|---|---|---|---|---|---|---|
| viewer | ✅ | — | — | — | — | — |
| support | ✅ | suspend/appeals/sessions | — | credit grants ≤ cap | — | — |
| finance | ✅ | — | ✅ | ✅ | — | — |
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

- **Two-person rule** for irreversible/expensive ops (account deletion, adjustments
  over a threshold, mass actions): second admin approves in-app before execution.
  With a team of ~1–2 today this can start as a confirm-with-typed-reason speed bump,
  but the data model supports real dual approval from day one (§6 `pending_actions`).
- Session policy: short sessions (e.g. 12h), IP change re-auth, optional IP allowlist.

---

## 4. Algawth intake checklist (fill before Phase D)

The connector needs these answers; each maps to a §3.2 method:

1. Stack & hosting (Supabase too? Own backend? DB engine?).
2. Where is the users table / identity provider, and is there a suspension concept?
3. Money model: balances? subscriptions? Stripe account (same Vankode Stripe org or
   separate)? Ledger-like history or mutable balances?
4. What does "blocking a user" operationally mean there (auth ban, feature flag,
   API key revocation…)?
5. Existing admin/maintenance scripts or dashboards to absorb.
6. Does it have coupons/promos today, and via what mechanism?
7. KPIs that matter for its dashboard tile (the Vansen set won't transfer 1:1).
8. Any compliance constraints (if Algawth is finance/trading-adjacent — the name
   suggests it might be — its admin actions may carry stricter audit requirements;
   the audit log in §6 is designed to be sufficient either way).
9. A service-auth story its backend can support (§3.3 pattern or equivalent).

Filling this checklist is itself the first task of Phase D and requires adding the
`algawth` repo to a session so the connector spec can be grounded in real code.

---

## 5. Console UX sketch

- **Shell**: left nav — Dashboard, Users, Finance, Coupons, Safety, Catalog, Ops,
  Audit, Settings. Product switcher (Vansen / Algawth / All) pinned top. Same
  spartan/ui "New York" look as vansen; dark-first.
- **Dashboard**: cross-product tiles (§2.1), alert strip (failed webhooks, job-queue
  anomalies, spend spikes — thresholds configurable).
- **Users**: search-first page; detail page = header (identity, flags, balance) +
  tabs (Ledger, Generations, Subscriptions, Moderation, Sessions, Audit). Every action
  button opens a reason-required dialog.
- **Finance**: revenue charts, reconciliation table, adjustments composer,
  export panel.
- **Coupons**: campaign list → campaign detail (mechanism, budget, redemptions) →
  create wizard (Stripe coupon | credit grant | both).
- **Safety** (Vansen tab): appeal queue with evidence viewer, resolve actions.
- **Audit**: filterable, immutable, exportable — every screen's actions land here.

---

## 6. Admin-project data model (its own Supabase Postgres)

```
admins            id (auth FK), display_name, role, status, mfa_enrolled, created_at
product_registry  id, name, base_url, capabilities jsonb, enabled, created_at
audit_log         id, admin_id, product_id, action, target_type, target_id,
                  reason text NOT NULL, payload jsonb, created_at   -- append-only,
                  RLS deny-all, no UPDATE/DELETE grants to anyone (owner included)
pending_actions   id, requested_by, action payload, status queued|approved|rejected,
                  approved_by, created_at, resolved_at              -- two-person rule
coupon_campaigns  id, product_id, name, mechanism, stripe_coupon_id, budget_usd,
                  granted_usd, status, owner_admin_id, created_at
kpi_snapshots     product_id, day, metrics jsonb                    -- nightly pull per
                  connector; dashboards read snapshots, not live product DBs
alert_rules       id, product_id, metric, threshold, channel, enabled
```

Same hardening habits as vansen: RLS deny-all + gateway-only access, size CHECKs on
jsonb, `reason` mandatory on anything that mutates a product.

---

## 7. Security posture

1. **Blast-radius isolation**: console compromise ≠ product compromise. The console's
   product credentials only open the deliberately narrow `/admin/*` routes; they can't
   run SQL, can't read Storage wholesale, can't mint user sessions.
2. **Every mutation audited** with acting admin, reason, and payload — in the admin DB
   *and* in the product's own logs (acting-admin header, §3.3).
3. **MFA mandatory, no self-signup, role least-privilege** (§3.4).
4. **Privacy inside the console**: admins see user *content* (prompts, generated
   media) only where operationally necessary — the safety/appeal flow — not as casual
   browsing on the user page. Generations tab shows metadata by default; media opens
   via short-lived signed URL fetched through the product admin API, and that view is
   itself audited. (Aligns with the moderation-evidence stance already in the product.)
5. **Secrets**: product admin tokens + Stripe keys live only in `admin-api` function
   secrets. The SPA holds nothing but the admin's own session. Never in either repo.
6. The two embedded vansen routes (`/admin/pricing`, `/admin/compare`) are **removed
   from the consumer app** once the console hosts them — closing today's ungated
   admin surface (§1).

---

## 8. Required product-side additions (Vansen) — future work list, not implemented

Small, additive, all consistent with existing patterns:

1. **`/admin/*` route group** on the `api` Edge Function: service-token middleware +
   routes for user search/detail, suspend/unsuspend, session revoke, ledger list,
   credit grant (`promo`), adjustment (`adjustment`), appeal resolve, kill-switch
   toggle, KPI aggregate. Each reuses existing RPCs or adds thin `security definer`
   ones following the `fn_*` conventions.
2. **Ledger type `adjustment`** added to the `ledger_entries.type` CHECK — admin
   corrections distinguishable from product-originated `promo`/`refund` forever.
3. **Explicit suspension override** — e.g. `profiles.suspended_at timestamptz` +
   `suspended_reason`, checked alongside the `strikes >= 2` rule, so blocking and
   reinstating stop being arithmetic on strikes.
4. **`moderation_events.resolved_by`** (text) — which admin resolved an appeal.
5. Session revocation path via Supabase Auth admin API (gateway-invoked).
6. Eventually: `/admin/pricing`'s catalog write-path lands here when the model catalog
   moves to the `models` table (already planned in `vansen.md`).

Equivalent list for Algawth falls out of the §4 checklist.

---

## 9. KPI catalog (Vansen connector, v1)

Finance: gross revenue (topups + studio fees), MRR, ARPU, margin per family
(price − provider cost from ledger + jobs), Stripe fees actual, refund rate.
Growth: signups, activation (first generation), DAU/WAU, paying conversion, churn
(subscription lapses), library size distribution.
Ops: generations/day by family, job success rate, median/p95 generation latency,
stale-sweep kills, provider spend per provider per day.
Safety: moderation flags/day, strikes issued, suspensions, appeal turnaround,
overturn rate.

All computable from existing tables (`ledger_entries`, `generations`, `jobs`,
`moderation_events`, `subscriptions`) — no product schema changes needed for v1 KPIs.

---

## 10. Phasing

- **Phase A — Read-only console (highest value, near-zero risk).** Admin project +
  auth + RBAC + audit skeleton; Vansen connector implementing only reads (user search/
  detail, ledger, KPIs); dashboard + users + finance pages read-only. No product
  writes at all yet.
- **Phase B — Safety & user actions.** Product-side §8 items 1/3/4/5; suspend/
  unsuspend, appeal resolution, session revoke; two-person rule live.
- **Phase C — Money & coupons.** `adjustment` type, credit grants, Stripe coupon
  management, campaign registry, exports. Migrate `/admin/pricing` + `/admin/compare`
  into the console and delete them from the consumer app.
- **Phase D — Algawth onboarding.** Intake checklist (§4) → its `/admin/*` surface →
  its connector → product switcher lights up.
- **Phase E — Analytics maturity (optional).** Nightly KPI snapshots grow into a real
  reporting store (or a read replica) once dashboard queries outgrow live aggregates.

Each phase ships alone; A is a complete, useful product by itself.

---

## 11. Relationship to java-migrate-plan

The two specs are designed not to collide:

- The console consumes products through **HTTP admin APIs** — it cannot tell whether
  a product's gateway is a Deno Edge Function or a Java service. When vansen's Java
  migration reaches Phase 3 (writes), the `/admin/*` group is just more routes in the
  golden contract suite and ports with everything else.
- The admin OpenAPI surfaces should join the same contract-first discipline
  (java-migrate-plan §10) from day one.
- If Vankode ends up on the Java modular monolith, `admin-api` itself is a candidate
  to fold in as an `admin` module — the connector interface survives as Java
  interfaces. Decision deferred; nothing blocks either order.

## 12. Open questions (decide before creating the repo)

1. **Algawth**: everything in §4 — the biggest unknown.
2. **Stripe topology**: one Vankode Stripe account for both products or separate?
   (Determines whether Finance is one reconciliation view or two.)
3. **Admin team size & roles now vs 12 months** — how much of RBAC/two-person to
   enforce on day one vs keep as schema-ready.
4. **Hosting the console**: same Supabase org (simplest) — any reason not to?
5. **Domain**: `admin.vankode.com`? Affects auth redirect config early.
6. **Shared Vankode user identity** across products — out of scope here, but coupon
   campaigns spanning products will eventually raise it.
7. **Monorepo temptation**: this spec assumes `vankode-admin` is its own repo (matches
   "create the new project"); a Vankode-wide monorepo is a different, bigger decision
   this spec deliberately does not make.
8. **i18n**: consumer apps are en/ms — is the admin console en-only (recommended)?

---

*End of brainstorming spec. No implementation authorized by this document. Next step
when ready: create the `vankode-admin` repo, grant a session access to `algawth`, fill
§4, then start Phase A.*
