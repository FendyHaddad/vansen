// Every database read and write of the authorization server. State changes go
// through 0036's RPCs (atomic); plain reads use the tables. Callers pass hashes,
// never raw tokens. A database failure comes back as UNAVAILABLE, never as
// "not found", so a transient error cannot look like a revoked token.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const UNAVAILABLE = "unavailable" as const;
type Unavailable = typeof UNAVAILABLE;

export interface OauthClient {
  id: string;
  client_name: string;
  redirect_uris: string[];
}

export interface OauthRequest {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  scope: string;
  expires_at: string;
}

export interface ResolvedGrant {
  userId: string;
  clientId: string;
  grantId: string;
}

/** What a code redemption or refresh rotation returns. A reuse names the
 * grant it revoked, for the log line. */
export type GrantOutcome =
  | { grantId: string }
  | { error: string; reuse?: boolean; grantId?: string; clientId?: string }
  | Unavailable;

export interface NewRequest {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: string;
  resource: string | null;
  expires_at: string;
}

export function createOauthStore(admin: SupabaseClient) {
  async function registerClient(
    id: string,
    name: string,
    redirectUris: string[],
    ipHash: string,
  ): Promise<"ok" | "rate_limited" | "rate_limited_global" | Unavailable> {
    const { error } = await admin.rpc("fn_oauth_register_client", {
      p_id: id,
      p_name: name,
      p_redirect_uris: redirectUris,
      p_ip_hash: ipHash,
    });
    if (error && /rate_limited_global/.test(error.message)) return "rate_limited_global";
    if (error && /rate_limited/.test(error.message)) return "rate_limited";
    return error ? UNAVAILABLE : "ok";
  }

  async function clientById(id: string): Promise<OauthClient | null | Unavailable> {
    const { data, error } = await admin.from("oauth_clients")
      .select("id,client_name,redirect_uris").eq("id", id).maybeSingle();
    if (error) return UNAVAILABLE;
    return (data as OauthClient | null) ?? null;
  }

  async function clientsByIds(ids: string[]): Promise<OauthClient[] | Unavailable> {
    if (ids.length === 0) return [];
    const { data, error } = await admin.from("oauth_clients")
      .select("id,client_name,redirect_uris").in("id", ids);
    return error ? UNAVAILABLE : (data ?? []) as OauthClient[];
  }

  async function createRequest(row: NewRequest): Promise<boolean> {
    const { error } = await admin.from("oauth_requests").insert(row);
    return !error;
  }

  /** The pending request, or null when unknown or expired. */
  async function liveRequest(id: string, now: Date): Promise<OauthRequest | null | Unavailable> {
    const { data, error } = await admin.from("oauth_requests")
      .select("id,client_id,redirect_uri,state,scope,expires_at").eq("id", id).maybeSingle();
    if (error) return UNAVAILABLE;
    const row = data as OauthRequest | null;
    if (!row || new Date(row.expires_at).getTime() <= now.getTime()) return null;
    return row;
  }

  async function approve(
    requestId: string,
    userId: string,
    codeHash: string,
  ): Promise<{ redirectUri: string; state: string | null } | null | Unavailable> {
    const { data, error } = await admin.rpc("fn_oauth_approve", {
      p_request: requestId,
      p_user: userId,
      p_code_hash: codeHash,
    });
    if (error && /authorization_not_found/.test(error.message)) return null;
    if (error || !data) return UNAVAILABLE;
    return data as { redirectUri: string; state: string | null };
  }

  /** Deletes the pending request; null when unknown or expired. */
  async function deny(requestId: string, now: Date): Promise<OauthRequest | null | Unavailable> {
    const { data, error } = await admin.from("oauth_requests").delete().eq("id", requestId)
      .select("id,client_id,redirect_uri,state,scope,expires_at");
    if (error) return UNAVAILABLE;
    const row = ((data ?? []) as OauthRequest[])[0];
    if (!row || new Date(row.expires_at).getTime() <= now.getTime()) return null;
    return row;
  }

  async function grantRpc(name: string, args: Record<string, unknown>): Promise<GrantOutcome> {
    const { data, error } = await admin.rpc(name, args);
    if (error || !data) return UNAVAILABLE;
    return data as GrantOutcome;
  }

  const redeemCode = (args: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    challenge: string;
    accessHash: string;
    refreshHash: string;
  }) =>
    grantRpc("fn_oauth_redeem_code", {
      p_code_hash: args.codeHash,
      p_client_id: args.clientId,
      p_redirect_uri: args.redirectUri,
      p_challenge: args.challenge,
      p_access_hash: args.accessHash,
      p_refresh_hash: args.refreshHash,
    });

  const rotateRefresh = (args: {
    refreshHash: string;
    clientId: string;
    accessHash: string;
    newRefreshHash: string;
  }) =>
    grantRpc("fn_oauth_rotate_refresh", {
      p_refresh_hash: args.refreshHash,
      p_client_id: args.clientId,
      p_access_hash: args.accessHash,
      p_new_refresh_hash: args.newRefreshHash,
    });

  async function revokeToken(tokenHash: string, clientId: string | null): Promise<boolean> {
    const { error } = await admin.rpc("fn_oauth_revoke_token", {
      p_token_hash: tokenHash,
      p_client_id: clientId,
    });
    return !error;
  }

  async function resolveAccess(tokenHash: string): Promise<ResolvedGrant | null | Unavailable> {
    const { data, error } = await admin.rpc("fn_oauth_resolve_token", { p_token_hash: tokenHash });
    if (error) return UNAVAILABLE;
    return (data as ResolvedGrant | null) ?? null;
  }

  /** The user already approved this exact redirect URI for this client, on an
   * active grant. Approving one registered URI never approves another. */
  async function isApproved(userId: string, clientId: string, redirectUri: string): Promise<boolean | Unavailable> {
    const { data, error } = await admin.from("oauth_grants").select("approved_redirect_uris")
      .eq("user_id", userId).eq("client_id", clientId).is("revoked_at", null);
    if (error) return UNAVAILABLE;
    const grants = (data ?? []) as { approved_redirect_uris: string[] | null }[];
    return grants.some((g) => (g.approved_redirect_uris ?? []).includes(redirectUri));
  }

  async function activeGrants(userId: string) {
    const { data, error } = await admin.from("oauth_grants")
      .select("id,client_id,approved_redirect_uris,created_at,last_used_at")
      .eq("user_id", userId).is("revoked_at", null).order("created_at", { ascending: false });
    if (error) return UNAVAILABLE;
    return (data ?? []) as {
      client_id: string;
      approved_redirect_uris: string[] | null;
      created_at: string;
      last_used_at: string | null;
    }[];
  }

  async function revokeUserGrant(userId: string, clientId: string): Promise<boolean | Unavailable> {
    const { data, error } = await admin.rpc("fn_oauth_revoke_user_grant", {
      p_user: userId,
      p_client_id: clientId,
    });
    return error ? UNAVAILABLE : data === true;
  }

  return {
    registerClient,
    clientById,
    clientsByIds,
    createRequest,
    liveRequest,
    approve,
    deny,
    redeemCode,
    rotateRefresh,
    revokeToken,
    resolveAccess,
    isApproved,
    activeGrants,
    revokeUserGrant,
  };
}

export type OauthStore = ReturnType<typeof createOauthStore>;
