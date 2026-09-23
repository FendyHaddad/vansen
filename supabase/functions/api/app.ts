// Vansen API gateway. All data access flows through here (tables are RLS
// deny-all; RPCs are service_role-only). Client's only other Supabase surface
// is Auth. REST contract doubles as the future Java migration contract.
//
// createApp(deps) exists so routes can be exercised with app.request(...) and
// in-memory fakes. index.ts builds the production deps and serves this app.
//
// This file is only the assembly: middleware and route groups are registered
// here in the order Hono must run them. Route bodies live in routes/*, shared
// helpers in services/* and lib/*, and the per-app context in lib/context.ts.
import { Hono } from "jsr:@hono/hono";
import type { ApiDeps } from "./lib/deps.ts";
import { createContext, type Vars } from "./lib/context.ts";
import {
  registerAuthMiddleware,
  registerRequestMiddleware,
} from "./lib/middleware.ts";
import { registerPublicRoutes } from "./routes/public.ts";
import { registerProfileRoutes } from "./routes/profile.ts";
import { registerLedgerRoutes } from "./routes/ledger.ts";
import { registerLibraryReadRoutes } from "./routes/library.ts";
import { registerStatusRoutes } from "./routes/status.ts";
import { registerJobRoutes } from "./routes/jobs.ts";
import { registerGenerationRoutes } from "./routes/generations.ts";
import { registerBillingCheckoutRoutes } from "./routes/billing-checkout.ts";
import { registerBillingSubscriptionRoutes } from "./routes/billing-subscription.ts";
import { registerBillingReconcileRoutes } from "./routes/billing-reconcile.ts";
import { registerUploadRoutes } from "./routes/uploads.ts";
import { registerPersonaRoutes } from "./routes/personas.ts";
import { registerLibraryWriteRoutes } from "./routes/library-writes.ts";
import { registerMcpPublicRoutes, registerMcpRoutes } from "./routes/mcp.ts";
import { registerOauthPublicRoutes, registerOauthSessionRoutes } from "./routes/oauth.ts";

export type { ApiDeps, ApiEnv, ReleaseIdentity } from "./lib/deps.ts";

export function createApp(deps: ApiDeps): Hono<Vars> {
  const ctx = createContext(deps);
  const app = new Hono<Vars>().basePath("/api");

  // Hono runs middleware and matches routes in registration order. This order
  // is the contract: public routes before auth, auth before everything else.
  registerRequestMiddleware(app, ctx);
  registerPublicRoutes(app, ctx);
  registerMcpPublicRoutes(app, ctx);
  registerOauthPublicRoutes(app, ctx);
  registerAuthMiddleware(app, ctx);
  registerProfileRoutes(app, ctx);
  registerLedgerRoutes(app, ctx);
  registerLibraryReadRoutes(app, ctx);
  registerStatusRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerGenerationRoutes(app, ctx);
  registerBillingCheckoutRoutes(app, ctx);
  registerBillingSubscriptionRoutes(app, ctx);
  registerBillingReconcileRoutes(app, ctx);
  registerUploadRoutes(app, ctx);
  registerPersonaRoutes(app, ctx);
  registerLibraryWriteRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerOauthSessionRoutes(app, ctx);

  return app;
}
