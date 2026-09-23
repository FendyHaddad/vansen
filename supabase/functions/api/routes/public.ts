// Public, unauthenticated routes, registered before the auth middleware:
// GET /health, /capabilities, /catalog and /manifest. Returning a response
// stops the chain, so none of these reach auth.
import { CATALOG_VERSION } from "../_shared/model-families.ts";
import { QUOTE_VERSION } from "../_shared/generation-request.ts";
import { publicCapabilities } from "../services/public-capabilities.ts";
import { catalogHandler } from "../catalog.ts";
import type { ApiContext, App } from "../lib/context.ts";

export function registerPublicRoutes(app: App, ctx: ApiContext): void {
  const { admin, deps, logError } = ctx;

  // Unauthenticated liveness probe for uptime monitors (registered before the
  // auth middleware; returning a response stops the chain).
  app.get("/health", async (c) => {
    const { error } = await admin.from("models").select("id").limit(1);
    return c.json(
      { ok: !error, db: !error, requestId: c.get("requestId") },
      error ? 503 : 200,
    );
  });

  // Public, unauthenticated: what this deployment can actually do. The
  // pricing, landing, footer and login pages read it before anyone signs in,
  // so they stop advertising models that are switched off. Whitelist only —
  // see services/public-capabilities.ts.
  app.get("/capabilities", async (c) => {
    const { data } = await admin.from("models").select("id,enabled");
    return c.json(publicCapabilities(data ?? [], deps.env.releaseFlags));
  });

  // Public, unauthenticated: the one catalog every app renders. See catalog.ts.
  app.get("/catalog", catalogHandler(admin, logError));

  // Public, unauthenticated: exactly what is running here. After a deploy the
  // only way to tell whether a fix was live was to try it and infer; the
  // rollout gates in the runbook read this before and after every step.
  //
  // Public on purpose. It carries versions and on/off switches -- the same
  // facts /capabilities already gives anyone -- and no names, counts, costs or
  // credentials. A deploy check that needs a token is a deploy check nobody
  // runs.
  app.get("/manifest", async (c) => {
    const { data: models } = await admin.from("models").select("id,enabled");
    const capabilities = Object.fromEntries(
      (models ?? []).map((m: { id: string; enabled: unknown }) => [m.id, m.enabled === true]),
    );

    // A missing or failed fn_schema_version is itself worth reporting, and is
    // not a reason to fail the request: this endpoint is most needed exactly
    // when something is wrong.
    let schemaVersion = "unknown";
    try {
      const { data, error } = await admin.rpc("fn_schema_version");
      if (!error && typeof data === "string" && data) schemaVersion = data;
    } catch {
      schemaVersion = "unknown";
    }

    const { gitRevision, workerVersion, deployedAt } = deps.env.release;
    return c.json({
      gitRevision: gitRevision || "unknown",
      workerVersion: workerVersion || "unknown",
      deployedAt: deployedAt ?? null,
      schemaVersion,
      catalogVersion: CATALOG_VERSION,
      quoteVersion: QUOTE_VERSION,
      capabilities,
    });
  });
}
