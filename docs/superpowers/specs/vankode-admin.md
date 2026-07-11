# Vankode Backoffice — admin.vankode.com

**Status: planning spec, ready to paste into the `vankode-backoffice` repo as its
product document. Nothing implemented yet. Supersedes the earlier draft of this file
(which assumed a third Supabase project — no longer possible) and narrows
`docs/vankode-backoffice.md`'s client-portal plan to a later phase.**

Date: 2026-07-11. Owner: Fendy / Vankode.

## 0. What this is

One private console at **admin.vankode.com** where Vankode runs itself. Three
concerns, one login:

1. **Vankode (software house)** — clients, projects, todos, invoices, expenses, and
   **consolidated finances across Vankode + Vansen + Algawth for tax**, since all
   three funnel into the same Vankode account.
2. **Vansen** — user administration (inspect, ban, invite), coupons/credit grants,
   moderation appeals, kill switches, KPIs, and **overseer** (uptime + error-log
   monitoring of the live service).
3. **Algawth** — the entire `algawth-admin` dashboard scope absorbed as a module:
   user table, ban/unban, delete, username change, password reset, gift
   subscription, user cap, world map, audit log. No finance yet (app is free).

Not public. No self-signup, no SEO, no marketing pages. The old client-portal idea
(client.vankode.com, visual change requests) is **out of scope here** — it remains a
possible later product on its own timeline.

---

## 1. The hard constraint that shapes everything

**Two Supabase projects exist and no third can be created without paying:
`algawth` and `vansen`.** So the backoffice cannot have its own Supabase project.

Decision: **the backoffice backend lives inside the Algawth Supabase project**, in
its own Postgres schema, with its own Edge Function gateway.

Why Algawth and not Vansen:

- **Monitoring independence for the money product.** Vansen is the revenue-critical
  service. A watcher must live outside the thing it watches — if backoffice ran in
  the Vansen project, a Vansen-project outage would take the monitor down with it.
  From the Algawth project, the backoffice pings Vansen's `/health` externally.
- Vansen already carries heavy load (media storage, generation jobs, Stripe,
  crons). Algawth is a light free app with headroom.
- Algawth's admin needs are *local* to that project anyway — its module can use
  same-project RPCs with zero cross-project secrets.

Accepted trade-offs (name them now, not during an incident):

- Algawth-project outage takes the console down. Mitigation: Vansen keeps working
  (console is not in Vansen's request path — it's a client of it), and a reverse
  ping (§7.4) means Vansen alerts on Algawth being down.
- Admin identity shares Supabase Auth with Algawth app users. Mitigation in §4:
  admin status is NEVER inferred from having an account — only from the
  `backoffice.admins` table, checked server-side on every request.
- Free-tier quotas (500 MB DB, 500K function invocations/mo) are shared with the
  Algawth app. Backoffice usage is tiny (§11 budget), but monitor it.

Isolation rules inside the Algawth project:

```
schema public      → Algawth app tables (untouched, existing RLS)
schema backoffice  → all console tables (§6). RLS deny-all, no policies.
                     Only the backoffice-api gateway (service_role) reads/writes.
functions/
  backoffice-api   → new Hono gateway, same pattern as vansen's `api`
  (existing algawth functions untouched)
```

---

## 2. Architecture

```
apps (browser)
  vankode-backoffice SPA  ──login──▶  Algawth Supabase Auth (admin account, MFA)
        │ JWT
        ▼
  backoffice-api (Edge Function, Algawth project)
        │  verifies JWT → backoffice.admins → role
        │  writes backoffice.audit_log on every mutation
        ├──▶ backoffice.* tables        (Vankode ops, finance, monitoring, audit)
        ├──▶ Algawth public.* via same-project security-definer RPCs (Algawth module)
        └──▶ Vansen `api` /admin/* routes, service-token auth (Vansen module)
```

### 2.1 Frontend

- **Angular** (latest LTS), standalone components, signals, spartan/ui + Tailwind —
  the exact house stack of `vansen` and `algawth-admin`. Components, conventions,
  and the panel design language (sectioned rails, uppercase micro-titles) copy over.
- Separate `.ts` / `.html` / `.css` files per component. Never inline.
- Vanrot (the earlier backoffice-repo choice) is deliberately NOT used here: this
  console wants boring, proven velocity, and two of three Vankode frontends are
  already Angular. Vanrot stays the candidate for the future client portal.
- Hosting: static deploy (Vercel/Netlify/Cloudflare Pages free tier) on
  `admin.vankode.com`. The SPA holds no secrets — only the admin's own session.

### 2.2 The one rule that keeps products safe

**The console never holds a product's `service_role` key and never writes product
tables directly across projects.** Vansen is reached ONLY through a new `/admin/*`
route group on Vansen's existing `api` gateway (§8), so every write goes through
Vansen's own invariants (advisory-lock charges, refund-once, append-only ledger,
moderation gates). The Algawth module, being same-project, uses narrow
security-definer RPCs (`fn_admin_*`) instead of raw table access — same discipline,
zero network hop.

Cross-project auth (backoffice → Vansen): one long random bearer token stored as
`ADMIN_API_TOKEN` in BOTH projects' Edge Function secrets (never in either repo).
`backoffice-api` attaches it plus `x-acting-admin: <email>` headers; Vansen's
`/admin/*` middleware verifies the token with a constant-time compare and logs the
acting admin. Rotate by setting a new secret in both projects.

---

## 3. Modules (what you actually see)

Left nav: **Dashboard · Vankode · Vansen · Algawth · Finance · Monitor · Audit ·
Settings**.

### 3.1 Dashboard (cross-company)

- Tiles per entity: Vankode (unpaid invoices, active projects, open todos),
  Vansen (revenue 7d/30d, active users, job failure rate, open incidents,
  new `app_errors` in 24h), Algawth (users, cap %, signups this week).
- Alert strip: down monitors, overdue invoices, error spikes, failed webhooks.

### 3.2 Vankode ops (software house)

- **Clients**: company, contacts, notes, linked projects/invoices. CRUD.
- **Projects**: name, client, status (lead → quoted → active → maintenance →
  done), rate/fixed price, start/end, notes, linked todos + invoices.
- **Todos**: lightweight tasks; title, product/project link, status, priority,
  due date. Kanban + list views. This is your working memory, not Jira.
- **Invoices**: numbered `VK-YYYY-NNN`, client, line items (description, qty,
  unit price), currency, tax field, status draft → sent → paid → overdue →
  void. PDF generated client-side (print stylesheet or pdfmake) — no server
  dependency. Payments recorded manually (bank transfer reference, date).
  Payment-provider automation is post-MVP.
- **Expenses**: date, entity (vankode|vansen|algawth), category (hosting, API
  keys, Apple dev, domains, tools…), **amount in MYR as actually charged on the
  bank/card statement** (optional original USD amount kept for reference), note,
  optional receipt upload (Algawth-project Storage, private bucket).

### 3.3 Vansen module

Reached via Vansen `/admin/*` (§8). Tabs:

- **Users**: search (email/id/Stripe customer), detail page — profile, strikes,
  suspension, subscription + period end, balance, ledger history, generation
  metadata, moderation events. Actions (all reason-required, all audited):
  suspend/unsuspend (explicit flag, §8.3), adjust strikes, revoke sessions,
  resolve appeals, delete account (typed-confirmation).
- **Invites**: create invite codes/links (new small Vansen feature, §8.7) for
  controlled onboarding or comped access; list redemptions.
- **Coupons & credits**: Stripe-native coupons/promotion codes managed via the
  Stripe API (create, expire, redemption counts) + **direct credit grants**
  (`promo` ledger entries) with campaign tags. Campaign registry with budget
  caps lives in `backoffice.coupon_campaigns`.
- **Safety**: moderation appeal queue, evidence viewer (short-lived signed URL,
  itself audited), resolution workflow.
- **Ops**: kill switches (`models.enabled` toggles), job queue stats,
  **`app_errors` browser** — the table shipped 2026-07-11 (filter by code/route/
  time, expandable stack traces, requestId lookup). This replaces reading it in
  the Supabase SQL editor.
- **Catalog**: absorb `/admin/pricing` + `/admin/compare` from the consumer app,
  auth-gated at last; delete them from the Vansen public app afterwards.

### 3.4 Algawth module

Same-project RPCs. Implements the `algawth-admin` spec's scope:

- Dashboard: total/active/banned users, cap progress (`user_limits`), signups
  chart, users by country (Leaflet + OpenStreetMap world map), subscription mix.
- Users table: search/sort/filter, detail sheet (profile, location, preferences,
  subscription).
- Actions: ban/unban (`is_active`), delete (storage avatar → rows → `delete-user`
  function), change username, send password reset, gift subscription. Each via
  `fn_admin_*` RPC that also writes the audit log.
- No finance tab until Algawth charges money.

### 3.5 Finance (consolidated — the tax view)

- **Currency policy (decided 2026-07-11)**: the books are **MYR**. Vankode
  invoices are MYR-only. Vansen income is USD at retail but is recorded at the
  **Stripe-settled MYR value** — pulled from Stripe **balance transactions**
  (each carries the converted amount, the exchange rate applied at charge time,
  and the Stripe fee), so the P&L equals what actually flows into the bank, not
  a spot-rate approximation. Product-side USD numbers (ledger, prices) stay USD
  for unit economics; conversion happens only at the finance layer.
- **Revenue ingestion**:
  - Vansen: nightly pull via `/admin/kpis` + ledger aggregates (topups, studio
    fees, refunds) for USD unit economics, **plus Stripe balance-transaction
    pull (proxied through Vansen `/admin/*`, since the Stripe key lives there)**
    for settled MYR gross, fees, and net — both land in
    `backoffice.finance_snapshots`; reconciliation view compares the two.
  - Vankode: paid invoices (§3.2) are already local, already MYR.
  - Algawth: zero for now; slot exists.
- **Expense side**: manual expenses (§3.2) + Vansen provider-spend aggregate
  (from its ledger/jobs data, via admin API) so margin is real.
- **Views**: monthly P&L per entity and consolidated, all in MYR; year selector;
  MRR (Vansen Studio subs, shown USD and settled-MYR); outstanding receivables
  (unpaid invoices).
- **Tax exports**: date-ranged CSV in MYR — consolidated income, per-entity
  breakdown, expense list by category, invoice register, Stripe settlement
  detail (gross/fee/net per balance transaction) as the audit trail for the
  Vansen line.
- Numbers are **snapshots + local records**, not live queries against Vansen —
  dashboards stay fast and the products stay unloaded.

### 3.6 Monitor (overseer — replaces UptimeRobot)

Runs where the watcher belongs: outside Vansen.

- `checks` registry: URL, method, expected status, interval, enabled.
  Seed rows: Vansen `GET /functions/v1/api/health` (expects `200`, checks db
  flag), Vansen landing page, Algawth external APIs if desired.
- **pg_cron every 5 min** in the Algawth project + `pg_net` HTTP GET → insert
  into `check_results` (status, latency ms, ok boolean).
- **Incidents**: 2 consecutive failures open an incident; first success closes
  it with duration. Open incidents show on the Dashboard.
- **Alerting**: Resend (free 100/day) email on incident open/close, called from
  a small `monitor-alert` function triggered by the cron logic.
- **Error-spike rule**: nightly + hourly count of Vansen `app_errors` via admin
  API; alert when count(1h) > threshold from `alert_rules`.
- **Reverse ping** (§7.4): Vansen's existing cron infrastructure gets one tiny
  job pinging an Algawth-project health endpoint, emailing on failure — so the
  watcher is also watched.
- Retention: `check_results` purged after 90 days (same cron pattern as
  `purge_app_errors`).

### 3.7 Audit

Every mutation in every module lands in `backoffice.audit_log`: acting admin,
module, action, target, mandatory reason, payload jsonb, timestamp. Append-only —
no UPDATE/DELETE grants to anyone, owner included. Filterable UI + CSV export.

---

## 4. Authentication & authorization

- Login = Supabase Auth **of the Algawth project** (email/password; enable TOTP
  MFA for the admin account). No self-signup: signups for backoffice don't exist —
  admin rows are inserted manually (SQL) by the owner.
- **`backoffice.admins` is the only source of admin truth**: `user_uuid` (auth
  FK), email, role, status. The gateway resolves the JWT → looks up this table →
  rejects anyone absent. An ordinary Algawth app account gets 403 forever.
- Roles, small and boring (solo-founder reality, schema ready for more):

| Role | Read all | Vankode ops | User actions | Finance | Coupons | Kill switch | Admin mgmt |
|---|---|---|---|---|---|---|---|
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| support | ✅ | todos only | suspend/appeals | — | grants ≤ cap | — | — |
| viewer | ✅ | — | — | — | — | — | — |

- Destructive ops (account deletion, adjustments over threshold): typed-reason +
  typed-target confirmation now; `pending_actions` table exists from day one so a
  real two-person rule can switch on when the team grows.
- Sessions: default Supabase expiry; console auto-locks UI after inactivity.
  Optional IP allowlist enforcement in the gateway (secret-stored list).

---

## 5. Algawth study (grounding, from repo reading 2026-07-11)

- Flutter iOS app (prayer times, Quran, Hadith, Qibla, Hijri calendar, member
  cards), Supabase backend, Malaysia/Singapore focus. Free; premium tier exists
  in schema (`subscriptions`, `users.subscription_id`, default Free).
- Tables: `users` (serial id + auth uuid, `is_active` = ban flag), `preferences`
  (auto-created by trigger), `locations` (one row per user), `subscriptions`,
  `user_limits` (signup cap, trigger-maintained count).
- Existing Edge Functions: `delete-user` (auth deletion, reusable), `quran-proxy`.
- The separate `algawth-admin` Angular repo/spec defined the dashboard + 5 admin
  actions + `admin_audit_log` table. **This module supersedes that repo** — build
  once here, retire the standalone dashboard plan. Its `admin_audit_log` design
  folds into `backoffice.audit_log` (product column distinguishes).

---

## 6. Backoffice data model (`backoffice` schema, Algawth project)

```
admins            id, user_uuid FK auth.users, email, role, status, created_at
audit_log         id, admin_email, product (vankode|vansen|algawth|backoffice),
                  action, target_type, target_id, reason NOT NULL, payload jsonb,
                  created_at            -- append-only, no UPDATE/DELETE grants
pending_actions   id, requested_by, action jsonb, status, approved_by, timestamps

clients           id, name, contact_name, email, phone, notes, status, created_at
projects          id, client_id FK, name, status, pricing_mode, amount, currency,
                  starts_on, ends_on, notes, created_at
todos             id, title, body, product, project_id FK NULL, status, priority,
                  due_on, done_at, created_at
invoices          id, number UNIQUE (VK-YYYY-NNN), client_id FK, project_id NULL,
                  status, issued_on, due_on, tax_rate, notes, created_at
                  -- MYR only (decided); no currency column until a non-MYR
                  -- client actually exists
invoice_items     id, invoice_id FK, position, description, qty, unit_price
payments          id, invoice_id FK, paid_on, amount, method, reference, created_at
expenses          id, entity, category, amount_myr, spent_on, note,
                  original_amount NULL, original_currency NULL,  -- e.g. USD API bill
                  receipt_path NULL, created_at
                  -- amount_myr = what the bank/card statement actually charged,
                  -- same settled-value principle as Vansen revenue

finance_snapshots product, day, metrics jsonb        -- nightly pull per connector
coupon_campaigns  id, product, name, mechanism (stripe-coupon|credit-grant),
                  stripe_coupon_id NULL, budget_usd, granted_usd, status,
                  created_at
kpi_snapshots     product, day, metrics jsonb
alert_rules       id, product, metric, threshold, window, channel, enabled

checks            id, name, url, method, expected_status, interval_min, enabled
check_results     id, check_id FK, checked_at, ok, http_status, latency_ms, error
incidents         id, check_id FK, opened_at, closed_at, fail_count, notified
```

Hardening habits copied from Vansen: RLS enabled deny-all on every table, size
CHECKs on jsonb columns, mandatory `reason` on mutating gateway routes, purge
crons for `check_results` (90d) and stale `pending_actions`.

---

## 7. Security posture

1. **Blast-radius isolation**: console compromise ≠ Vansen compromise. The only
   cross-project credential opens Vansen's deliberately narrow `/admin/*` group —
   it cannot run SQL, read Storage wholesale, or mint user sessions.
2. **Admin ≠ app user**: `backoffice.admins` gate on every request; JWT alone
   grants nothing.
3. **Everything audited** with acting admin + reason, in backoffice AND in the
   product's own logs (`x-acting-admin` header → Vansen `app_errors`-style admin
   log or route logs).
4. **Reverse monitoring**: Vansen pings the Algawth project (a public
   `backoffice-api/health` route) so watcher-down is also alerted. Both directions
   covered with zero third-party services.
5. **Privacy**: user content (prompts, media) visible only in the safety/appeal
   flow via short-lived signed URLs, each view audited. User pages show metadata.
6. **Secrets** only in Edge Function secrets of the respective project:
   `ADMIN_API_TOKEN` (both), `STRIPE_SECRET_KEY` (already in Vansen; coupon
   management calls Stripe FROM Vansen's `/admin/*`, so the backoffice never
   holds Stripe keys at all), `RESEND_API_KEY` (Algawth project). Nothing in repos.
7. Remove the ungated `/admin/pricing` + `/admin/compare` routes from the Vansen
   consumer app the moment the Catalog tab ships (they carry no authGuard today).

---

## 8. Required Vansen-side additions (small, additive)

1. `/admin/*` route group on the existing `api` Edge Function: constant-time
   bearer check middleware, `x-acting-admin` propagation, routes — user search/
   detail, ledger list, suspend/unsuspend, strike adjust, session revoke, appeal
   resolve, credit grant (`promo`), adjustment, kill-switch toggle, KPI/error
   aggregates (`app_errors` reader), Stripe coupon CRUD proxy.
2. Ledger type **`adjustment`** added to the `ledger_entries.type` CHECK.
3. **Explicit suspension**: `profiles.suspended_at timestamptz` + `suspended_reason`,
   checked alongside `strikes >= 2` — ban at 0 strikes, reinstate without erasing
   evidence.
4. `moderation_events.resolved_by text`.
5. Session revocation via Supabase Auth admin API (gateway-invoked).
6. Reverse-ping cron (one `pg_cron` + `pg_net` job hitting backoffice health).
7. **Invites**: `invites` table (code, grants, max_uses, expires_at) + redemption
   at signup — the one genuinely new product feature on the list.

Algawth-side additions: `fn_admin_*` security-definer RPCs wrapping the 5 admin
actions + gift subscription, so even the same-project module never raw-writes.

---

## 9. Phasing (each phase ships alone and is useful)

- **Phase A — Scaffold + Vankode ops.** Repo, Angular shell, auth + admins gate,
  audit skeleton, `backoffice` schema, gateway. Clients / projects / todos /
  invoices / expenses fully working. Zero product dependencies — immediate
  daily-driver value.
- **Phase B — Monitor.** Checks, cron pinger, incidents, Resend alerts, reverse
  ping. Kills the UptimeRobot question for good.
- **Phase C — Vansen read-only.** `/admin/*` GET routes, user search/detail,
  ledger, KPIs, `app_errors` browser, dashboard tiles.
- **Phase D — Vansen actions + money.** Suspension/appeals/invites/kill switches,
  `adjustment` type, credit grants, Stripe coupon management, campaign registry.
  Migrate pricing/compare tools in; delete them from the consumer app.
- **Phase E — Finance consolidation.** Snapshots, P&L, reconciliation, tax
  exports.
- **Phase F — Algawth module.** RPCs + users/actions/map/audit; retire the
  standalone `algawth-admin` plan.

---

## 10. Free-tier budget sanity (Algawth project)

- Monitor: 288 pings/day × ~3 checks ≈ 26K function-adjacent pg_net calls/mo —
  pg_cron/pg_net run in Postgres, not against the 500K function-invocation quota.
- Console usage: one admin, hundreds of gateway calls/day ≈ <20K/mo. Safe.
- DB: backoffice tables are KB-scale; `check_results` at 90d retention ≈ tens of
  MB worst case. Within 500 MB shared budget; the purge cron keeps it flat.
- Watch: Supabase dashboard usage page monthly; alert rule at 80% is itself a
  `alert_rules` row once Phase B lands.

## 11. Open questions (decide before Phase A)

1. ~~Invoice currency~~ **Decided 2026-07-11**: invoices MYR-only; Vansen income
   recorded at Stripe-settled MYR from balance transactions (§3.5). Remaining
   sub-question: SST/tax line on invoices — schema has `tax_rate`, confirm rate
   or leave 0.
2. MFA enrollment for the admin account — do it at project setup (recommended).
3. IP allowlist for the gateway: on from day one or after go-live?
4. Domain/auth config: `admin.vankode.com` redirect URLs registered in the
   Algawth Supabase Auth settings early.
5. Vansen invites (§8.7): exact grant semantics (free credits? Studio trial?) —
   product decision, not console decision.
6. When Vansen's Java migration (java-migrate-plan) reaches writes, `/admin/*`
   joins the golden contract suite and ports with everything else — nothing here
   blocks it.

---

*Next step when ready: paste this into the `vankode-backoffice` repo as its product
doc (replacing the client-portal-era `docs/vankode-backoffice.md` scope), then start
Phase A.*
