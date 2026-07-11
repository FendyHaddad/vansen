# Observability — reading errors & health

Server errors land in the `app_errors` table (30-day retention, purged by the
`purge_app_errors` cron). Written by the `api` Edge Function only; RLS deny-all,
so it is invisible to clients — read it from the Supabase SQL editor or by
asking Claude (MCP).

## What gets logged

| code | meaning |
|---|---|
| `unhandled` | Exception no route caught — a bug. Client saw a 500 with a `requestId`. |
| `charge_failed` | `fn_charge_and_generate` RPC errored (not insufficient balance — that's a normal 402). |
| `provider_submit_failed` | Provider rejected a generation at submit (bad key, quota, outage). Job auto-refunded. |
| `provider_check_failed` | Polling a queued fal job blew up. Job auto-refunded. |
| `checkout_failed` / `portal_failed` / `reconcile_failed` | Stripe call failed. |
| `delete_failed` | Stripe subscription cancel during account deletion failed. |

Each row: `created_at, route, method, code, message, stack, user_id, request_id`.
No prompts, no request bodies, no headers — by design.

## Daily read (SQL editor → New query)

```sql
-- Last 24h, newest first
select created_at, code, route, message, request_id, user_id
from app_errors
where created_at > now() - interval '24 hours'
order by created_at desc;

-- What's breaking most this week
select code, count(*), max(created_at) as last_seen
from app_errors
where created_at > now() - interval '7 days'
group by code order by count(*) desc;

-- Full detail for one error (stack included) — paste this row to AI
select * from app_errors where request_id = 'PASTE_ID_HERE';
```

## The paste-to-AI workflow

1. User reports "something went wrong" → ask for the `requestId` shown in the
   error (or note the time it happened).
2. Run the third query above (or filter by time window).
3. Paste the whole row — `code`, `route`, `message`, `stack`, `created_at` —
   into Claude. The stack points at the exact line in `api/index.ts` or a
   provider adapter.
4. Cross-reference if needed: `select * from jobs where user_id = '…' order by
   created_at desc limit 5;` and `generations` for the same window.

Or skip the SQL entirely: in a Claude Code session say **"check app_errors for
the last day"** — Claude queries via the Supabase MCP and reads the stacks
directly.

## Health endpoint

`GET https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/health`

- No login, no key needed — the function is deployed with `verify_jwt` off
  because the gateway does its own token auth on every data route (anonymous
  requests get 401 from the auth middleware; verified after deploy).
- `200 {"ok":true,"db":true}` = gateway up + database reachable; `503` = DB down.
- Point a free pinger at it (UptimeRobot, Better Stack) → email/push when down.

## What this does NOT cover

- **Browser crashes** (Angular errors on the user's device) — the server never
  sees them. Add Sentry's Angular SDK when it matters.
- **Alerting on error spikes** — the table is passive; check it, or wire a cron
  later that notifies when `count(last hour) > N`.
- **stripe-webhook function** — has its own logs; Stripe dashboard alerts on
  delivery failures. Can adopt `logError` later.
