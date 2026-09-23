// In-memory stand-ins for 0036's OAuth RPCs, so the /oauth routes and /mcp
// auth run against FakeDb. They mirror the SQL rule for rule; the real ones
// are proven by supabase/tests/mcp_oauth.sql. Time is the FakeDb clock.
import type { FakeDb, Row } from "./fakes.ts";

const HOUR = 3600_000;

function rows(db: FakeDb, table: string): Row[] {
  db.tables[table] ??= [];
  return db.tables[table];
}

function iso(db: FakeDb, offsetMs = 0): string {
  return new Date(db.now().getTime() + offsetMs).toISOString();
}

function past(db: FakeDb, at: unknown): boolean {
  return new Date(String(at)).getTime() <= db.now().getTime();
}

function revokeGrant(db: FakeDb, grantId: unknown): boolean {
  const grant = rows(db, "oauth_grants").find((g) => g.id === grantId && g.revoked_at == null);
  if (grant) grant.revoked_at = iso(db);
  for (const t of rows(db, "oauth_tokens")) {
    if (t.grant_id === grantId && t.revoked_at == null) t.revoked_at = iso(db);
  }
  for (const code of rows(db, "oauth_codes")) {
    if (code.grant_id === grantId && code.used_at == null) code.used_at = iso(db);
  }
  return Boolean(grant);
}

function issuePair(db: FakeDb, grant: Row, accessHash: unknown, refreshHash: unknown) {
  rows(db, "oauth_tokens").push(
    { token_hash: accessHash, grant_id: grant.id, kind: "access", expires_at: iso(db, HOUR), revoked_at: null, replaced_by: null },
    { token_hash: refreshHash, grant_id: grant.id, kind: "refresh", expires_at: iso(db, 720 * HOUR), revoked_at: null, replaced_by: null },
  );
  grant.last_used_at = iso(db);
}

const grantOf = (db: FakeDb, id: unknown) => rows(db, "oauth_grants").find((g) => g.id === id)!;

export function installOauthRpcs(db: FakeDb): void {
  const h = db.rpcHandlers;

  h.fn_oauth_register_client = (a, self) => {
    const since = self.now().getTime() - HOUR;
    const recent = rows(self, "oauth_clients").filter((c) =>
      c.registered_ip_hash === a.p_ip_hash && new Date(String(c.created_at)).getTime() > since
    );
    if (recent.length >= 20) throw new Error("rate_limited");
    const lastHour = rows(self, "oauth_clients").filter((c) => new Date(String(c.created_at)).getTime() > since);
    if (lastHour.length >= 500) throw new Error("rate_limited_global");
    rows(self, "oauth_clients").push({
      id: a.p_id, client_name: a.p_name, redirect_uris: a.p_redirect_uris,
      registered_ip_hash: a.p_ip_hash, created_at: iso(self),
    });
    return null;
  };

  h.fn_oauth_revoke_grant = (a, self) => revokeGrant(self, a.p_grant);

  h.fn_oauth_approve = (a, self) => {
    const req = rows(self, "oauth_requests").find((r) => r.id === a.p_request);
    if (!req || past(self, req.expires_at)) throw new Error("authorization_not_found");
    self.tables.oauth_requests = rows(self, "oauth_requests").filter((r) => r !== req);
    let grant = rows(self, "oauth_grants").find((g) =>
      g.user_id === a.p_user && g.client_id === req.client_id && g.revoked_at == null
    );
    if (!grant) {
      grant = {
        id: crypto.randomUUID(), user_id: a.p_user, client_id: req.client_id, approved_redirect_uris: [],
        created_at: iso(self), last_used_at: null, revoked_at: null,
      };
      rows(self, "oauth_grants").push(grant);
    }
    const approved = (grant.approved_redirect_uris ?? []) as unknown[];
    if (!approved.includes(req.redirect_uri)) grant.approved_redirect_uris = [...approved, req.redirect_uri];
    rows(self, "oauth_codes").push({
      code_hash: a.p_code_hash, grant_id: grant.id, request_id: req.id, redirect_uri: req.redirect_uri,
      code_challenge: req.code_challenge, resource: req.resource, expires_at: iso(self, 300_000), used_at: null,
    });
    return { redirectUri: req.redirect_uri, state: req.state, clientId: req.client_id };
  };

  h.fn_oauth_redeem_code = (a, self) => {
    if (!rows(self, "oauth_clients").some((c) => c.id === a.p_client_id)) return { error: "invalid_client" };
    const code = rows(self, "oauth_codes").find((c) => c.code_hash === a.p_code_hash);
    if (!code) return { error: "invalid_grant" };
    if (code.used_at != null) {
      revokeGrant(self, code.grant_id);
      return { error: "invalid_grant", reuse: true, grantId: code.grant_id, clientId: grantOf(self, code.grant_id).client_id };
    }
    const grant = grantOf(self, code.grant_id);
    const refused = grant.revoked_at != null || past(self, code.expires_at) ||
      grant.client_id !== a.p_client_id || code.redirect_uri !== a.p_redirect_uri ||
      code.code_challenge !== a.p_challenge;
    if (refused) return { error: "invalid_grant" };
    code.used_at = iso(self);
    issuePair(self, grant, a.p_access_hash, a.p_refresh_hash);
    return { grantId: grant.id };
  };

  h.fn_oauth_rotate_refresh = (a, self) => {
    const tok = rows(self, "oauth_tokens").find((t) => t.token_hash === a.p_refresh_hash && t.kind === "refresh");
    if (!tok) return { error: "invalid_grant" };
    if (tok.replaced_by != null) {
      revokeGrant(self, tok.grant_id);
      return { error: "invalid_grant", reuse: true, grantId: tok.grant_id, clientId: grantOf(self, tok.grant_id).client_id };
    }
    const grant = grantOf(self, tok.grant_id);
    const refused = tok.revoked_at != null || past(self, tok.expires_at) ||
      grant.revoked_at != null || grant.client_id !== a.p_client_id;
    if (refused) return { error: "invalid_grant" };
    tok.replaced_by = a.p_new_refresh_hash;
    issuePair(self, grant, a.p_access_hash, a.p_new_refresh_hash);
    return { grantId: grant.id };
  };

  h.fn_oauth_revoke_token = (a, self) => {
    const tok = rows(self, "oauth_tokens").find((t) => t.token_hash === a.p_token_hash);
    if (!tok) return null;
    if (a.p_client_id != null && a.p_client_id !== grantOf(self, tok.grant_id).client_id) return null;
    if (tok.kind === "refresh") return void revokeGrant(self, tok.grant_id);
    tok.revoked_at ??= iso(self);
    return null;
  };

  h.fn_oauth_revoke_user_grant = (a, self) => {
    const grant = rows(self, "oauth_grants").find((g) =>
      g.user_id === a.p_user && g.client_id === a.p_client_id && g.revoked_at == null
    );
    return grant ? revokeGrant(self, grant.id) : false;
  };

  h.fn_oauth_resolve_token = (a, self) => {
    const tok = rows(self, "oauth_tokens").find((t) =>
      t.token_hash === a.p_token_hash && t.kind === "access" && t.revoked_at == null && !past(self, t.expires_at)
    );
    const grant = tok ? grantOf(self, tok.grant_id) : null;
    if (!grant || grant.revoked_at != null) return null;
    const stale = grant.last_used_at == null ||
      new Date(String(grant.last_used_at)).getTime() < self.now().getTime() - 300_000;
    if (stale) grant.last_used_at = iso(self);
    return { userId: grant.user_id, clientId: grant.client_id, grantId: grant.id };
  };
}
