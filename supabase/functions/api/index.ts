// Production composition for the Vansen API gateway. All behaviour lives in
// app.ts; this file only wires real clients, secrets and the listener so the
// routes stay testable with in-memory fakes.
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { createApp } from "./app.ts";
import { releaseFlagsFromEnv } from "./services/public-capabilities.ts";
import { mcpEnvFrom } from "./mcp/metadata.ts";
import { adapterFor } from "./_shared/providers/index.ts";
import { storageFor } from "./_shared/storage/index.ts";
import { moderate } from "./_shared/moderation.ts";
import { parseServiceAccount } from "./_shared/push.ts";
import { appleVerifier } from "./_shared/apple-verifier.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20" as Stripe.LatestApiVersion,
  httpClient: Stripe.createFetchHttpClient(),
});

/** Deployed origins, comma-separated (e.g. "https://vansen.app"). Dev servers
 * are matched by pattern inside app.ts — `ng serve` picks whatever port is free. */
const appOrigins = (Deno.env.get("APP_ORIGIN") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * What this deployment says it is, for `GET /manifest`.
 *
 * Only this file reads the environment; `app.ts` takes these as dependencies,
 * so a test can state a revision without touching global Deno.env. Absent
 * values stay empty and the route reports "unknown" -- never a remembered
 * previous revision, which would make a failed deploy look successful.
 */
const release = {
  gitRevision: Deno.env.get("GIT_REVISION") ?? "",
  workerVersion: Deno.env.get("WORKER_VERSION") ?? "",
  deployedAt: Deno.env.get("DEPLOYED_AT") ?? null,
};

/** Where assistants reach /mcp and sign in (see mcpEnvFrom). */
const mcp = mcpEnvFrom((k) => Deno.env.get(k));

const app = createApp({
  admin,
  stripe,
  moderate,
  adapterFor,
  storageFor,
  appleVerifier,
  fcmAccount: parseServiceAccount(Deno.env.get("FCM_SERVICE_ACCOUNT")),
  env: {
    appOrigins,
    planPriceIds: {
      studio: Deno.env.get("STRIPE_STUDIO_PRICE_ID"),
      pro: Deno.env.get("STRIPE_PRO_PRICE_ID"),
    },
    launchCouponId: Deno.env.get("STRIPE_LAUNCH_COUPON_ID"), // $5 off, 2 months
    releaseFlags: releaseFlagsFromEnv((k) => Deno.env.get(k)),
    release,
    mediaPublicOrigin: Deno.env.get("MEDIA_PUBLIC_ORIGIN") || undefined,
    mcp,
  },
  now: () => new Date(),
});

Deno.serve(app.fetch);
