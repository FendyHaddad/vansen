// Dependency and environment types for the API gateway.
// createApp(deps) takes an ApiDeps: index.ts builds the production one and
// tests build fakes (testing/fakes.ts). app.ts re-exports these types, so
// importers keep using "./app.ts".
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { JWSTransactionDecodedPayload } from "npm:@apple/app-store-server-library@1.6.0";
import type Stripe from "npm:stripe@17";
import type { ProviderAdapter } from "../_shared/providers/types.ts";
import type {
  StorageAdapter,
  StorageBackend,
} from "../_shared/storage/index.ts";
import type { ModerationResult } from "../_shared/moderation.ts";
import type { ServiceAccount } from "../_shared/push.ts";
import type { ReleaseFlags } from "../services/public-capabilities.ts";

/**
 * What `GET /manifest` reports about this deployment.
 *
 * Set from Edge Function secrets at deploy time. Empty means "we do not know",
 * never a remembered previous value: reporting a stale revision would make a
 * failed deploy look like a successful one, which is the exact question the
 * manifest exists to answer.
 */
export interface ReleaseIdentity {
  gitRevision: string;
  workerVersion: string;
  deployedAt: string | null;
}

/** Where assistants find us: the MCP resource URL and its OAuth server. */
export interface McpEnv {
  /** The exact public URL of POST /mcp; clients compare it to the PRM. */
  resourceUrl: string;
  /** Supabase Auth's issuer, e.g. https://<ref>.supabase.co/auth/v1. */
  authServerUrl: string;
}

export interface ApiEnv {
  appOrigins: string[];
  planPriceIds: Record<string, string | undefined>;
  launchCouponId: string | undefined;
  /** Promises the deployment has been verified to keep. Default: none. */
  releaseFlags: ReleaseFlags;
  release: ReleaseIdentity;
  /** Staging only. Inside the local Edge runtime SUPABASE_URL is
   * http://kong:8000, which a browser cannot resolve; signed storage URLs for
   * the browser are rewritten to this origin. Unset in production. */
  mediaPublicOrigin?: string;
  /** Unset: /mcp and its PRM answer 503 (nothing to point a client at). */
  mcp?: McpEnv;
}

export interface ApiDeps {
  admin: SupabaseClient;
  stripe: Stripe;
  moderate: (
    input: { text?: string; imageUrl?: string },
  ) => Promise<ModerationResult>;
  adapterFor: (familyId: string) => ProviderAdapter;
  storageFor: (backend: StorageBackend) => StorageAdapter;
  appleVerifier: () => {
    verifyAndDecodeTransaction(
      jws: string,
    ): Promise<JWSTransactionDecodedPayload>;
  };
  /**
   * Kept on the deps, unused by the routes: settlement queues notifications in
   * the outbox and P5's scheduled drainer is what sends them.
   */
  fcmAccount: ServiceAccount | null;
  env: ApiEnv;
  now: () => Date;
  /** The MCP tools' wait between job polls. Tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
}
