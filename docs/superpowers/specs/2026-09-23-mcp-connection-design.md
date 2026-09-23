# MCP connection — design

Date: 2026-09-23. Checklist item "MCP connection" in `plans/post-implementation-review.md`.

**Goal.** A signed-in Vansen user connects the AI assistant of their choice (Claude custom connectors, ChatGPT connectors in developer mode, and other MCP clients) to their account and generates images through it. Pricing, moderation, rate limits, plan gates and the ledger stay in the existing `api` gateway; the assistant is just another client.

Research: `.superpowers/sdd/mcp/research-external.md` (MCP and OAuth landscape, client requirements) and the codebase survey in the session record.

## R. Revision (2026-09-23): our own authorization server

The final review's C1 was reproduced on the local stack (`.superpowers/sdd/mcp/c1-repro.md`, GoTrue v2.197.0). A token from Supabase's OAuth 2.1 server is a full GoTrue session. Whoever holds it can:
- set the account password, which silently adds one to a Google-only account;
- start an email change;
- enroll MFA;
- sign the user out everywhere;
- delete the user's other grants.

Nothing in GoTrue can scope it. **Owner decision:** the gateway issues its own opaque tokens that only `/mcp` accepts, so GoTrue never sees an assistant token.

This section overrides §0, decision 2 of §1, and §2, §3, §6, §7 and §9 wherever they talk about Supabase's OAuth server. Supabase's OAuth server is **never enabled**: remove `[auth.oauth_server]` from `config.toml`. The owner steps for the dashboard and ES256 are gone.

### R1. Shape

- **Issuer:** `https://vansen.vankode.com`, the web origin, which we control at the root. Its metadata is a static file served by the web Worker at `https://vansen.vankode.com/.well-known/oauth-authorization-server`. That satisfies RFC 8414 discovery without path insertion.
- **Endpoints:** the endpoints named in that metadata live in the `api` function, under `<api>/oauth/*`. The metadata may point to another host.
- **Local runs:** the `api` also serves the same JSON at `<api>/oauth/.well-known/oauth-authorization-server`, built from `MCP_ISSUER`. Locally, `MCP_ISSUER = <local api>/oauth`, and clients use the path-appended fallback as the Inspector did in the spike. On the hosted project `MCP_ISSUER` is unset and defaults to `https://vansen.vankode.com`.
- **Drift gate:** a Deno test asserts that the static file equals `buildAsMetadata("https://vansen.vankode.com", "https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api")`.
- **PRM:** `authorization_servers: [MCP_ISSUER]`, `scopes_supported: ["vansen"]`.
- **Static metadata file** (`public/.well-known/oauth-authorization-server`, exact content; `<api>` = `https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api`):

  ```json
  {
    "issuer": "https://vansen.vankode.com",
    "authorization_endpoint": "<api>/oauth/authorize",
    "token_endpoint": "<api>/oauth/token",
    "registration_endpoint": "<api>/oauth/register",
    "revocation_endpoint": "<api>/oauth/revoke",
    "response_types_supported": ["code"],
    "grant_types_supported": ["authorization_code", "refresh_token"],
    "code_challenge_methods_supported": ["S256"],
    "token_endpoint_auth_methods_supported": ["none"],
    "revocation_endpoint_auth_methods_supported": ["none"],
    "scopes_supported": ["vansen"]
  }
  ```

  A `public/_headers` rule gives it `Content-Type: application/json` and `Access-Control-Allow-Origin: *`. `angular.json` must copy `.well-known/` and `_headers` into `dist/vansen/browser`. A build gate fails if either is missing, because the SPA fallback would otherwise answer the metadata URL with `index.html` and a 200.

### R2. Storage (migration `0036_mcp_oauth.sql`)

All tables are RLS deny-all and accessed only by service_role. User FKs are `on delete cascade`, so account deletion ends every grant and token.

- `oauth_clients`:
  - `id text pk` (random, `vsn_client_…`)
  - `client_name text` (≤ 100)
  - `redirect_uris text[]` (1–5)
  - `created_at`
- `oauth_requests`, pending authorizations, expiring after 10 min:
  - `id uuid pk` (the `authorization_id`)
  - `client_id`
  - `redirect_uri`
  - `state`
  - `code_challenge`
  - `scope`
  - `resource`
  - `expires_at`
- `oauth_grants`:
  - `id uuid pk`
  - `user_id`
  - `client_id`
  - `created_at`
  - `last_used_at`
  - `revoked_at`
  - `unique (user_id, client_id)`
- `oauth_codes`:
  - `code_hash text pk`
  - `grant_id`
  - `request_id`
  - `redirect_uri`
  - `code_challenge`
  - `resource`
  - `expires_at` (5 min)
  - `used_at`
- `oauth_tokens`:
  - `token_hash text pk`
  - `grant_id`
  - `kind` (`access`/`refresh`)
  - `expires_at` (access 1 h, refresh 30 d)
  - `revoked_at`
  - `replaced_by text null`

Tokens and codes are 32 random bytes, base64url, prefixed `vsn_at_`, `vsn_rt_` and `vsn_ac_`. Only SHA-256 hashes are stored.

State transitions happen in `security definer` RPCs so every step is atomic:
- redeeming a code;
- rotating a refresh token;
- revoking a grant;
- resolving an access token, which returns `user_id`, `client_id` and `grant_id` only while the token is unexpired, unrevoked and its grant is active. It updates `last_used_at` at most once every 5 min.

A daily purge (a new cron job, or a step inside the existing purge function) deletes expired requests, codes and tokens older than 1 day.

### R3. HTTP contract

**Public endpoints.** These are registered before auth, like the PRM. They all return 503 `mcp_disabled` when `MCP_ENABLED` is off, except the metadata. Errors follow RFC 6749 and 7591 JSON (`invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_redirect_uri`, `invalid_client_metadata`). CORS is `*`, without credentials.

- `POST /oauth/register` (RFC 7591, JSON):
  - Accepts `client_name` and `redirect_uris`. `token_endpoint_auth_method` must be absent or `none`.
  - Each redirect URI must be one of:
    - `https:`;
    - `http:` on a loopback host;
    - a custom scheme not in `javascript|data|file|vbscript|about|blob`.
  - Returns 201 `{client_id, client_name, redirect_uris, token_endpoint_auth_method:"none", grant_types:["authorization_code","refresh_token"], response_types:["code"]}`.
  - Rate limit: 20 registrations per hour per client IP (hash of the first `x-forwarded-for` hop).
- `GET /oauth/authorize`:
  - Parameters: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state?`, `scope?`, `resource?`.
  - An unknown client or a `redirect_uri` that doesn't exactly match a registered one gets a 400 plain page, **never a redirect**.
  - Other errors redirect to `redirect_uri` with `error` and `state`.
  - `resource`, if present, must equal the MCP URL.
  - On success, stores an `oauth_requests` row and returns a 302 to `https://vansen.vankode.com/oauth/consent?authorization_id=<id>`. The web origin is the existing allowed-origin config.
- `POST /oauth/token` (form-urlencoded):
  - `grant_type=authorization_code`: `code`, `redirect_uri`, `client_id`, `code_verifier`, `resource?`. The code must be single-use, unexpired, and match its client, redirect and PKCE S256.
    - A second use of the same code revokes the whole grant.
    - Returns `{access_token, token_type:"Bearer", expires_in:3600, refresh_token, scope:"vansen"}`.
  - `grant_type=refresh_token`: `refresh_token`, `client_id`. Rotates, returning a new pair and marking the old one `replaced_by`.
    - Presenting an already-rotated refresh token revokes the grant (reuse detection).
- `POST /oauth/revoke` (RFC 7009): `token` and `client_id?`. Always 200.

**Session endpoints** (the app's Supabase session, through the normal middleware):

- `GET /oauth/requests/:id`:
  - Returns `{clientName, redirectUri, redirectHost, scope, alreadyGranted}`.
  - 404 `authorization_not_found` when unknown or expired.
  - `alreadyGranted` is true when the user has an active grant for that client.
- `POST /oauth/requests/:id/approve`:
  - Creates the grant (or reuses the active one), issues the code, and deletes the request.
  - Returns `{redirectUrl}`, which is `redirect_uri?code=…&state=…`.
- `POST /oauth/requests/:id/deny`: returns `{redirectUrl}` with `error=access_denied&state=…`.
- `GET /oauth/grants`: returns `{grants:[{clientId, clientName, redirectHost, createdAt, lastUsedAt}]}`, active grants only.
- `DELETE /oauth/grants/:clientId`: revokes the grant and all its tokens. Returns 204, or 404.
- These two grant endpoints stay available when `MCP_ENABLED` is off, so users can always revoke.

**`/mcp` authentication:**
- A bearer that starts with `vsn_at_` is resolved through the RPC. On success it sets `userId`, `oauthClientId` and `grantId`, then the age gate and suspension checks run as today.
- Anything else, including a Supabase session JWT, gets 401 plus `WWW-Authenticate` (with `error="invalid_token"` for an unknown, expired or revoked `vsn_at_`).
- A `vsn_` token on any other route fails `getUser` and gets the normal 401. Containment is now structural. The claim-based `client_id` middleware from §3 is deleted.
- `grantId` joins the tool log line.

### R4. Web changes

- **The consent page** drops `auth.oauth.*` and uses the session endpoints above.
  - `alreadyGranted` auto-approves.
  - Allow and Deny follow `redirectUrl` through the existing `navigateAway` scheme guard.
  - The unverified-app hint and the redirect-host emphasis stay.
- **The Connected tab** drops `listGrants`/`revokeGrant` from `AuthService` and uses `GET/DELETE /oauth/grants` through the app's api client.
- Sign-out keeps `{ scope: 'local' }`. It's harmless, and it keeps other devices signed in.

### R5. Tasks (parallel)

- **Task 5 — backend AS** (worktree `vansen-mcp-as`):
  - migration 0036 and the bootstrap manifest;
  - the RPCs and the purge;
  - `/oauth/*` routes in `api/routes/oauth.ts`, plus `api/oauth/*` split by concern;
  - `/mcp` opaque-token auth and removal of the claim middleware;
  - `MCP_ISSUER`, the PRM and the drift test;
  - removal of `config.toml` `[auth.oauth_server]`.

  Security tests:
  - PKCE mismatch;
  - code reuse revoking the grant;
  - redirect mismatch not redirecting;
  - refresh rotation, and reuse revoking the grant;
  - expired and revoked tokens;
  - a `vsn_at_` token refused on `/profile`;
  - a JWT refused on `/mcp`;
  - an OAuth token that cannot reach `/auth/v1` (it isn't a JWT);
  - register validation and rate limit;
  - `MCP_ENABLED` off returning 503 on issuance while the grant endpoints still work.

  Gates: `npm run verify`, plus the Inspector end to end against `functions serve`. Review: final review only, on the most capable model.
- **Task 6 — web** (worktree `vansen-mcp-web2`): R4, plus the static metadata file, `_headers`, the `angular.json` assets, and the build gate for them. Gates: `npm test`, `ng build`, and the dist assertion.

### R6. Rollout (replaces §9)

1. `db push --linked` for 0035 and 0036, after reading back the live `client` constraint names (final review, Minor 3).
2. `./deploy.sh --yes` with `MCP_ENABLED` unset, meaning off.
3. Read back:
   - the web metadata URL returns JSON;
   - the PRM names `https://vansen.vankode.com`;
   - `/mcp` returns 401 with `WWW-Authenticate`;
   - `/oauth/register` returns 503.
4. Owner (paid smoke, ask first): set `MCP_ENABLED=true`, connect Claude and ChatGPT, generate one image each, revoke, and confirm the next call fails. Then keep it on and add the FAQ entry, or turn it off.

## 0. Spike result (2026-09-23): GO with Supabase's OAuth 2.1 server — auth part superseded by §R

Full report: `.superpowers/sdd/mcp/spike-report.md`. The MCP Inspector, acting as the OAuth client, went end to end on the local stack:
a bare 401, then PRM discovery at the `/mcp` sub-path, DCR, PKCE, consent, token, and a tool call.

- **Config:** `[auth.oauth_server] enabled = true`, `authorization_url_path = "/oauth/consent"`, `allow_dynamic_registration = true` (CLI 2.114.0).
- **supabase-js 2.110.0:** `auth.oauth.getAuthorizationDetails`, `approveAuthorization`, `denyAuthorization`, `listGrants`, `revokeGrant({ clientId })`.
- **Claims:** the access token carries `client_id` and `scope`. `aud` is always `"authenticated"`, and `resource` is ignored, so **`client_id` containment is the binding** (§3). `admin.auth.getUser` accepts the token.
- **Revoke and deletion:** revoking a grant kills its refresh token, and the next `getUser` rejects its access token. Deleting the auth user cascades to the grants.
- **SDK:** `npm:@modelcontextprotocol/sdk@1.30.0`, `WebStandardStreamableHTTPServerTransport`, stateless (`sessionIdGenerator: undefined`), `enableJsonResponse: true`. `/mcp` answers `POST` only; `GET` and `DELETE` get 405, because a stateless `GET` would hold an open stream on the Edge worker.
- **Consent page:** it must handle an already-consented client, where `getAuthorizationDetails` returns a `redirect_url` instead of details. It follows the redirect at once.
- **Web sign-out:** `signOut()` defaults to global scope, which also revokes every assistant grant. Decision: web and mobile sign out with `{ scope: 'local' }`, and assistants are managed only in Connected assistants. Account deletion and password recovery still end everything.
- **Owner steps, added:**
  - Hosted JWT signing must use **asymmetric keys (ES256)**. ID tokens fail under HS256 when `openid` is requested.
  - Read-only curl of the hosted AS metadata at rollout. Locally the RFC 8414 URL returned 404 and clients fell back to the OIDC discovery URL.
- **Local stack:** `supabase/config.toml` gains the `[auth.oauth_server]` section above.

## 1. Decisions

1. **Protocol target: MCP 2025-06-18 / 2025-11-25.**
   - Transport: Streamable HTTP, stateless (no session id), JSON responses.
   - Auth: OAuth 2.1 with PKCE, Protected Resource Metadata (RFC 9728) and Dynamic Client Registration.
   - Neither Claude nor ChatGPT speaks the 2026-07-28 stateless revision (CIMD, no `initialize`) yet. We upgrade when they do.
2. **Authorization server: Supabase Auth's OAuth 2.1 server** (recommended), with the Cloudflare `workers-oauth-provider` as the fallback if the spike (Task 0) fails.
   - Why Supabase:
     - Its tokens are Supabase JWTs for the same user, so the gateway's existing `auth.getUser(token)` verifies them unchanged.
     - Account deletion already kills the user's grants.
     - DCR is built in, and there is no second token store to secure.
   - What it costs:
     - It's a newer Supabase feature. We host the consent page and the PRM ourselves.
     - It has only OIDC identity scopes, so authorization is ours, in the gateway (§3).
     - Enabling it is a Supabase dashboard change, which is an **owner step**.
   - Why the fallback, if needed: it needs no Supabase feature and supports CIMD. The cost is turning the asset-only web Worker into server code with its own token store (KV) and mapping its tokens to Supabase users.
3. **The MCP endpoint lives inside the `api` Edge Function**, as the route group `/mcp` (`api/routes/mcp.ts` plus `api/mcp/*`).
   - Its tools call the gateway's own services in-process (`submitGeneration`, the job and library readers, the catalog), not the api over HTTP. There is no token passthrough, no second hop, and one code path for every guardrail.
   - Public URL: `https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/mcp`. A friendly URL (`vansen.vankode.com/mcp`) needs server code in the web Worker and is a follow-up, not v1.
4. **Scope of v1 tools (YAGNI):** account and catalog reads, then generate, check, upscale, vary, cancel and list recent.
   - Out of v1: reference images from chat, personas, video, the Studio editor, billing, and the ChatGPT Deep Research `search`/`fetch` pair.
   - Why no reference images: assistants can't reliably forward chat attachments into tool arguments, and fetching URLs server-side is a new SSRF surface.
   - Why no billing: purchases stay in-app.
5. **Entitlement:** anyone can connect. Tools that spend credits hit the same plan and credit gates as the app (`subscription_required`, `pro_required`, `insufficient_credits`), and the messages say so plainly.

## 2. Flow

1. **Setup.** The user adds the connector URL in Claude or ChatGPT.
2. **Discovery.** The client's first call to `/mcp` gets 401 with `WWW-Authenticate: Bearer resource_metadata="<api>/mcp/.well-known/oauth-protected-resource"`. That PRM names:
   - the resource `<api>/mcp`;
   - the authorization server `https://bnorhcxhvxydkgvcxjad.supabase.co/auth/v1`;
   - the scopes `openid email`.
3. **Registration and sign-in.** The client discovers Supabase's AS metadata, registers itself (DCR), and sends the user to Supabase `/authorize` with PKCE.
4. **Consent.** Supabase redirects to our consent page `https://vansen.vankode.com/oauth/consent?authorization_id=…`.
   - A signed-out user signs in first (the existing login page, then return).
   - The page shows the client's name and redirect host and what it can do: "generate images, spend your credits, see your library and balance".
   - The user can Allow or Deny.
5. **Token.** Allow calls supabase-js `auth.oauth.approveAuthorization`. Supabase then redirects back to the client with a code, and the client swaps it for access and refresh tokens.
6. **Tool calls.** Every tool call carries `Authorization: Bearer <access token>`. The gateway runs its normal middleware (auth, age gate, request budget), and `/mcp` then dispatches the JSON-RPC call to a tool.

## 3. Token containment (the security core)

An OAuth access token is a full Supabase JWT for the user. Without containment it would unlock every api route, including billing, account deletion and personas.

- **The rule:** a token whose JWT carries a `client_id` claim (an OAuth grant) is accepted **only** on `/mcp`. Any other route refuses it with 403 `token_not_allowed`. A token without `client_id` (the app's own session) is refused on `/mcp` with 401 plus the `WWW-Authenticate` header, so a client never uses a browser session.
- **Where it's enforced:** one middleware in `lib/middleware.ts`, right after `getUser`. It reads the claim from the verified token's payload.
- **Audience:** if the spike shows Supabase stamps `aud` or honours RFC 8707 `resource`, `/mcp` also checks `aud` against the resource URL. If not, `client_id` containment is the binding, and the spec records that.
- **Revocation:** Settings gets a new **Connected assistants** tab. It lists the user's OAuth grants (client name, connected date, last used if Supabase exposes it) and offers Revoke, which uses the Supabase grant APIs the spike confirms.
- **Deletion:** account deletion deletes the auth user, which drops the grants. The closure path needs no change, and the spike verifies this.

## 4. Tools

Tool results are `text` content: a short human summary plus a JSON block. Images come as an `image` content block holding the **thumbnail** (JPEG, from the existing thumbnail pipeline, well under the client limits), plus a `resource_link` to the full image's signed URL (7 days).

| Tool | Input | Does | Annotations |
|---|---|---|---|
| `get_account` | — | Plan, entitled, credits (plan and pack), from `/profile`'s services | readOnly |
| `list_models` | `kind?` | Live families from `buildCatalog()`, each with options, defaults and the price per image, plus styles | readOnly |
| `generate_image` | `prompt`, `model?`, `options?`, `style?`, `count?` (1–4), `idempotency_key?` | Validates the options against the catalog combos, then calls `submitGeneration` with `op:'generate'`. It then waits up to **25 s**, polling the job, and returns the finished images. If the job is still pending, it returns the ids and says to call `get_generation`. The description states the price and that credits are spent. | not readOnly, not idempotent |
| `get_generation` | `id` | Status, progress, the image when done, and the failure reason when failed | readOnly |
| `upscale_image` | `id` | `op:'upscale'` on a finished image, with the same wait-then-return behaviour | not readOnly |
| `vary_image` | `id` | The existing variation route service, with the same wait-then-return behaviour | not readOnly |
| `cancel_generation` | `id` | The cancel service, returning its refund or "cancelling" message | not readOnly |
| `list_recent` | `limit?` (≤ 20) | The newest library items: id, prompt, model, status and thumbnail links | readOnly |

- **Idempotency:** every generate-type tool sends an `Idempotency-Key`: the caller's key if given, otherwise one derived from the JSON-RPC request id and the grant. A client retrying the same call then cannot double-charge.
- **Error mapping:** gateway errors (`content_policy`, `insufficient_credits`, `pro_required`, `subscription_required`, `rate_limited`, `account_suspended`, `model_disabled`, `age_unconfirmed`, `catalog_stale`) become tool results with `isError: true` and one plain sentence, plus what the user can do ("Top up at vansen.vankode.com/app/billing"). They are never JSON-RPC protocol errors.
- **Model names:** `model` takes a family id or label. `options` keys are the catalog axis ids, and invalid combinations get the catalog's valid values back in the error.

## 5. Guardrails and bookkeeping

- **Unchanged:** moderation (prompt strikes and suspension), plan and model gates, the caps, credit charging and refunds, the age gate. Every tool calls the same services the routes do, so there is nothing to duplicate.
- **Client tag:** migration `0035_mcp_client.sql` adds `'mcp'` to the `client` check constraint on `generations` (and on `app_errors`), and `KNOWN_CLIENTS` gains `mcp`. The `/mcp` handler sets the client to `mcp` server-side and ignores any header.
- **Separate request budget:** a new bucket `mcp` (10 generate-type calls per minute per user) in `fn_take_request_slot`'s budgets. A runaway assistant loop then can't starve the user's own app budget, and the app's buckets can't starve the assistant.
- **Logging:** every tool call writes a structured log line (user, client_id, tool, outcome, ms) through the existing logger. Unexpected failures go to `app_errors` with `client='mcp'`.
- **Kill switch:** the release flag `MCP_ENABLED` (an Edge Function secret, read per request like the other release flags). When it's off, `/mcp` returns 503 `mcp_disabled` and the PRM is still served.

## 6. Web

- **`features/auth/consent-page`** (`.ts`, `.html`, `.css`) at route `/oauth/consent`.
  - Loads the details with `auth.oauth.getAuthorizationDetails(authorization_id)`.
  - Shows the client name, the redirect host (flagging any host that isn't https) and the capability list.
  - Allow calls `approveAuthorization` and Deny calls `denyAuthorization`.
  - A signed-out user goes to login with a return URL; the return is restricted to `/oauth/consent`.
  - Error states: expired or unknown authorization, and the network.
- **`features/settings/connected-tab`** (`.ts`, `.html`, `.css`) holds the Connected assistants list with Revoke and an empty state that explains how to connect. It shows the MCP URL with a copy button and one line each for Claude and ChatGPT.
- **Landing and FAQ:** one FAQ entry, "Use Vansen from Claude or ChatGPT", added only once the feature is live.

## 7. Tasks (parallel after Task 0)

- **Task 0 — spike** (blocking; local stack plus a throwaway OAuth client, no production changes). Verify:
  - that Supabase CLI 2.114.0 can enable the OAuth server locally (`[auth.oauth_server]` or equivalent);
  - DCR from a real MCP client (the MCP Inspector);
  - the consent redirect;
  - the token's claims (`client_id`, `aud`), refresh, and the grant list and revoke APIs;
  - that deleting the user kills the grants;
  - that the MCP TypeScript SDK's web-standard Streamable HTTP transport runs in the Deno Edge runtime inside Hono.

  Any failure switches decision 2 to the Cloudflare fallback, and I update this spec before building.
- **Task 1 — gateway core:** the containment middleware, the `/mcp` route with the SDK transport (stateless), the PRM endpoint, the 401 plus `WWW-Authenticate`, the `MCP_ENABLED` flag, the `mcp` client tag and migration `0035`, and the `mcp` request bucket.
- **Task 2 — tools:** the eight tools of §4, their error mapping, the wait-then-return polling, idempotency and thumbnails. Tested with Deno tests against the gateway's existing test harness.
- **Task 3 — web consent page.**
- **Task 4 — Connected assistants tab**, with revoke.

Tasks 1 and 2 share `api/mcp/*`: Task 1 owns the transport and registry, Task 2 adds tool modules. Tasks 3 and 4 are web-only and run in parallel.

Review:
- Tasks 1 and 2 (auth and money) each get their own review.
- Then there is one final review and one fix wave.

## 8. Testing

- **Deno:**
  - an OAuth token is refused on `/profile` and `/billing/*` and accepted on `/mcp`;
  - a session token is refused on `/mcp` with `WWW-Authenticate`;
  - the PRM shape;
  - each tool's happy path and mapped errors;
  - no double charge on a repeated idempotency key;
  - the `mcp` budget is independent of `generation`;
  - `MCP_ENABLED` off returns 503;
  - the client stored on generations is `mcp`.
- **Web:** the consent page's allow, deny, signed-out return and expired states, and the connected tab's list, revoke and empty states.
- **Gates:** `npm run verify`, then the MCP Inspector against the local stack end to end, recorded in the evidence doc.

## 9. Rollout

1. **Owner steps** (Supabase dashboard, security settings):
   - enable the OAuth 2.1 server and Dynamic Client Registration;
   - set the authorization path to `https://vansen.vankode.com/oauth/consent`;
   - switch JWT signing to asymmetric keys if the OAuth server requires it (the spike says).
2. `supabase db push` (0035), then `./deploy.sh --yes` with `MCP_ENABLED` off, then read back the PRM and the 401.
3. Owner smoke: connect Claude (Free allows one connector) and ChatGPT developer mode, generate one image each (about 10 credits), revoke, and confirm the next call fails.
4. Turn on `MCP_ENABLED` and add the FAQ entry.

## 10. Out of scope (v1)

- Reference images from chat.
- Personas, video and the Studio editor.
- Billing tools.
- ChatGPT Deep Research `search`/`fetch`.
- A friendly MCP URL on the web domain.
- The 2026-07-28 stateless protocol and CIMD.
- Per-grant spending limits: revisit if abuse shows up, since the `mcp` budget and the existing caps cover v1.
