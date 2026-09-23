# Monitoring operating procedure (no-paging)

Owner-accepted reduction, decided 2026-09-22 (see `2026-09-20-release-evidence.md`
Gate D and `2026-09-20-release-runbook.md` §2): alert delivery is database rows
only. No outbox, no worker, no webhook. Nothing pages anyone. This doc is the
"accountable operating procedure" `post-implementation-review.md` says manual
monitoring needs if retained.

## 1. What this replaces, and its limits

- Replaces: a paging/notification pipeline that was never built for `public.alerts`.
- The table exists, fires correctly (`0025_release_telemetry.sql`,
  `0026_review_recovery.sql`, `0032_persona_references.sql` — 11 assertions in
  `supabase/tests/alerts.sql`), and resolves itself when a condition clears. No
  destination reads it automatically.
- **Detection latency in the worst case equals the check interval.** `check_alerts`
  runs every 5 minutes and keeps an incident open until someone looks, but a
  human runs the daily check once a day (see §2). A critical incident (paid,
  not fulfilled; deletion abandoned) can sit open for up to ~24h before a human
  sees it. There is no faster path today.
- An alert only *resolves* when a complete `fn_check_alerts()` run finds the
  condition clear (`fn_resolve_checked_alerts`). If cron stops running
  entirely, alerts stay open forever — which is correct (silence is not
  all-clear) but means "cron itself is dead" is a failure mode this system
  cannot self-report. That is why the daily check includes cron health, not
  just open alerts.

## 2. Cadence

| Check | When | Who | Time |
|---|---|---|---|
| Daily check | once a day, any time convenient | owner (solo operator, no on-call) | ~5 min |
| Post-deploy check | right after every `api`/migration/functions deploy | owner | ~2 min (steps 1–3 only) |

## 3. Daily check

Run from repo root. Each command is `supabase db query --linked "<sql>"`, read-only.

**1. Open alerts** (combined — run this first; if it's empty, severity detail below barely matters):

```bash
supabase db query --linked "select kind, severity, first_seen_at, last_seen_at, detail from public.alerts where resolved_at is null order by severity desc, first_seen_at;"
```
Healthy: zero rows. Any row is an open incident — go to §4.

**2. Cron health, last 24h:**

```bash
supabase db query --linked "select j.jobname, jrd.status, count(*) as n, max(jrd.start_time) as last_run from cron.job_run_details jrd join cron.job j on j.jobid = jrd.jobid where jrd.start_time > now() - interval '24 hours' group by 1,2 order by 1,2;"
```
Healthy: every active job (`advance_account_deletions`, `check_alerts`,
`drive_cleanup_worker`, `drive_job_worker`, `reap_deleted_content`,
`reconcile_stale_jobs`, plus the three daily 03:xx jobs when they've run) shows
only `status = 'succeeded'`, and `check_alerts`'s `last_run` is within the last
10 minutes. Any `failed` rows, or a `last_run` older than ~15 minutes for a
`*/5 * * * *` job, means the scheduler or the function is broken — cron
failures don't raise a `public.alerts` row, this is the only place they show up.

**3. Stuck jobs:**

```bash
supabase db query --linked "select count(*) as stuck from public.jobs where state in ('submitting','reconciling') and (progress_at < now() - interval '10 minutes' or reconcile_attempts >= 10);"
```
Healthy: 0. (This mirrors the `jobs_stuck` alert condition directly — a
non-zero count here with no `jobs_stuck` row in step 1 means `check_alerts`
itself didn't run recently; cross-check step 2.)

**4. Provider spend, last 24h and last hour (alert fires above $50/hour):**

```bash
supabase db query --linked "select coalesce(sum(coalesce(actual_usd, reserved_usd)),0) as usd_24h from public.provider_expenses where incurred_at > now() - interval '24 hours';"
supabase db query --linked "select coalesce(sum(coalesce(actual_usd, reserved_usd)),0) as usd_1h from public.provider_expenses where incurred_at > now() - interval '1 hour';"
```
Healthy: `usd_1h` well under 50; `usd_24h` in line with recent days. Video
families are all `enabled = false` today, so `VIDEO_DAILY_CAP_USD` ($40/day)
doesn't currently bind — this becomes load-bearing again once a video family
is turned on.

**5. Moderation / appeals backlog:**

```bash
supabase db query --linked "select count(*) as unreviewed from public.moderation_events where resolution is null and created_at > now() - interval '7 days';"
supabase db query --linked "select count(*) as suspended from public.profiles where strikes >= 2;"
```
Healthy: `unreviewed` low and trending down (these are appeal-worthy events
awaiting a human `resolution` — `null` = unreviewed, `'upheld'` /
`'overturned: <note>'` = decided); `suspended` matches what you expect from
recent strikes — a jump you didn't cause means the gate broke open (also
covered by the `moderation_surge` alert at >100 events/hour).

**6. Deletion backlog:**

```bash
supabase db query --linked "select count(*) as pending, count(*) filter (where attempts >= 5 or not_before < now() - interval '24 hours') as stuck, min(not_before) as oldest from public.deletion_outbox where completed_at is null;"
```
Healthy: `pending` near 0 and draining (`reap_deleted_content` runs every 5
min); `stuck` is 0 (that count matches the `deletion_stuck` alert condition —
a legal exposure, not a performance issue).

**7. App errors, last 24h:**

```bash
supabase db query --linked "select code, count(*) as n from public.app_errors where created_at > now() - interval '24 hours' group by 1 order by n desc limit 10;"
```
Healthy: empty, or a small trickle of known/expected codes. A new or spiking
`code` is worth reading the `message`/`stack` for
(`select * from public.app_errors where code = '<code>' order by created_at desc limit 5;`).
Purged automatically after 30 days (`purge_app_errors` cron).

## 4. Per-alert-kind response

| Kind | Severity | Means | First action | Kill switch when | Resolves |
|---|---|---|---|---|---|
| `paid_unfulfilled` | critical | Charged in the last 24h, entitlement never granted | `select * from public.fn_paid_unfulfilled(now() - interval '1 day');` then read the affected rows; check `stripe-webhook` logs and the fulfillment path | if a specific family/provider is the cause | auto, once `fn_paid_unfulfilled` returns 0 |
| `done_without_media` | critical | Generation marked `done`, `media_path` empty, in the last 7 days | `select id,user_id,family_id,created_at from public.generations where status='done' and coalesce(media_path,'')='' and created_at > now() - interval '7 days';` — check provider/storage logs for that family | yes, that family, if it's one provider/family causing it | auto, once the count is 0 |
| `jobs_stuck` | warn | A job stuck in `submitting`/`reconciling` >10 min or ≥10 reconcile attempts | inspect `drive_job_worker` / `reconcile_stale_jobs` cron output; check the provider's status page | if one provider is consistently the cause | auto, once no job matches |
| `deletion_stuck` | critical | An object queued for deletion, ≥5 attempts or >24h overdue | `select * from public.deletion_outbox where completed_at is null and (attempts>=5 or not_before < now() - interval '24 hours');` — check the backend (`supabase` storage or R2) named in the row for an outage or bad credential | not applicable (deletion path, not a generation family) | auto, once cleared |
| `notifications_dead` | warn | A notification outbox row hit `dead_letter_at` with no `sent_at` | `select * from public.notification_outbox where dead_letter_at is not null and sent_at is null;` — customer-visible only if the product surfaces this; usually safe to just note and move on | no | manual — nothing re-attempts a dead-lettered row; resolves next `check_alerts` pass since the row stays matched (treat as informational, confirm it's not growing) |
| `provider_burn` | warn | >$50 in provider spend in the trailing hour | `select provider, sum(coalesce(actual_usd,reserved_usd)) from public.provider_expenses where incurred_at > now() - interval '1 hour' group by 1;` to find which provider/family | yes, immediately, for the family driving it — this is the fast-moving-money case | auto, once the trailing hour drops under $50 |
| `moderation_surge` | warn | >100 moderation events in the trailing hour | check `categories` distribution on recent `moderation_events` rows for a pattern; confirm the moderation gate (OpenAI omni-moderation) is actually running before charge | if the gate looks bypassed for a family, kill that family | **manual only** — `fn_resolve_checked_alerts` (0026) never auto-closes `moderation_surge`; an operator must confirm it's clear (there's no separate "clear" RPC — closing it is a manual `update public.alerts set resolved_at = clock_timestamp() where kind = 'moderation_surge' and resolved_at is null;` after you've verified the gate is intact) |
| `trainings_stuck` | warn | Legacy — persona training was removed in `0032_persona_references.sql` (`training_jobs` table dropped). `fn_check_alerts()` no longer raises this kind. If an old row is somehow still open, it self-resolves on the next `check_alerts` run. | none needed | no | auto |

## 5. Escalation (solo operator)

- **Kill-switch one family**: `update public.models set enabled = false where id = '<family>';`
  (runbook §8 "Rollback"). Use this the moment an alert traces to one specific
  provider/family — it refuses new submissions, work in flight settles and
  refunds normally. This is a write and is outside this doc's read-only
  scope — run it yourself in the SQL editor or via `supabase db query
  --linked`, it is not something to script around.
- **Disable everything**: only for a systemic issue (e.g. moderation gate
  bypassed, or Stripe/webhook signature failing broadly) — set `enabled =
  false` for every row in `public.models`, or worse case, `db diff` /
  redeploy the previous function version. Rollback path and specifics: runbook
  §8.
- **Record an incident**: add one line to `2026-09-20-release-evidence.md`
  under Gate D (that file is owned by another editing pass right now — do it
  the next time you have write access to it, or note it in your own log in
  the meantime). Include: date, alert kind(s), family affected, action taken,
  resolution time.
- **When to worry even with zero open alerts**: cron health (§3.2) shows
  failures, or `check_alerts`'s own `last_run` is stale. A quiet
  `public.alerts` table does not mean healthy if the thing that populates it
  stopped running.

## 6. Record of checks

Convention: one dated line per daily check, appended below. Format:
`YYYY-MM-DD — alerts:<n> cron:<ok/fail> stuck:<n> spend1h:$<n> modq:<n> susp:<n> del:<n> errs:<n> — note`.
Counts only, no user data.

- 2026-09-23 — alerts:0 cron:ok(9/9 succeeded, check_alerts last_run <10min) stuck:0 spend1h:$0 spend24h:$0 modq:0 susp:0 del_pending:0 del_stuck:0 errs24h:0 — baseline run, all healthy, video families disabled so spend is expected at $0

## 7. Open items for the owner

- Alert delivery (paging/webhook) could be revisited later if the volume of
  incidents ever exceeds what a once-daily human check can catch in time —
  no design proposed here.
