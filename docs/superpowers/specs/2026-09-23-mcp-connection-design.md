# MCP connection — design

Date: 2026-09-23. Checklist item "MCP connection" in `plans/post-implementation-review.md`.

**Goal.** A signed-in Vansen user connects the AI assistant of their choice (Claude custom connectors, ChatGPT connectors in developer mode, and other MCP clients) to their account and generates images through it. Pricing, moderation, rate limits, plan gates and the ledger stay in the existing `api` gateway; the assistant is just another client.

Research: `.superpowers/sdd/mcp/research-external.md` (MCP and OAuth landscape, client requirements) and the codebase survey in the session record.

## 0. Spike result (2026-09-23): GO with Supabase's OAuth 2.1 server

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
