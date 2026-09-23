// Builds the context every route module receives.
// createContext(deps) runs once per createApp(), so the warm-isolate memos
// (signed URLs, the age gate) are one instance per app, exactly as when they
// lived inside createApp. Route modules destructure the names they use.
import type { Hono } from "jsr:@hono/hono";
import type { ApiDeps } from "./deps.ts";
import { createErrorLog } from "./errors.ts";
import { createOrigins } from "./origins.ts";
import { createMediaSigning } from "../services/media-signing.ts";
import { createAccounts } from "../services/accounts.ts";
import { createObjectStorage } from "../services/object-storage.ts";
import { createModerationGate } from "../services/moderation-gate.ts";
import { createGenerationDtos } from "../services/generation-dto.ts";
import { createAccountClosure } from "../services/account-closure.ts";
import { createSubmitGeneration } from "../services/submit-generation.ts";
import { createAgeGate } from "../services/age-gate.ts";
import { createJobs } from "../services/jobs.ts";
import { createLibrary } from "../services/library.ts";
import { createReplay } from "../services/replay.ts";

export type Vars = {
  Variables: {
    userId: string;
    email: string;
    requestId: string;
    /** Server-set client tag ('mcp' on /mcp); wins over the header. */
    client?: string;
    /** The OAuth grant's client_id; set only for assistant tokens. */
    oauthClientId?: string;
  };
};
export type App = Hono<Vars>;

function createServices(deps: ApiDeps) {
  // These names deliberately match the identifiers the route bodies use, so
  // the bodies moved out of createApp without edits.
  const {
    admin,
    stripe,
    moderate,
    adapterFor,
    storageFor,
    appleVerifier,
  } = deps;
  const APP_ORIGINS = deps.env.appOrigins;
  const PLAN_PRICE_IDS = deps.env.planPriceIds;
  const LAUNCH_COUPON_ID = deps.env.launchCouponId;
  const logError = createErrorLog(admin);

  /** Warm-isolate memo of users who already passed the age gate (same pattern as
   * signedUrlMemo). Safe to cache: birth_date only ever transitions unset → set,
   * so a hit can never go stale. deleteAccount evicts on account deletion. */
  const ageOkMemo = new Set<string>();

  const signing = createMediaSigning(deps);
  const storage = createObjectStorage(admin, logError);
  return {
    deps,
    admin,
    stripe,
    moderate,
    adapterFor,
    storageFor,
    appleVerifier,
    APP_ORIGINS,
    PLAN_PRICE_IDS,
    LAUNCH_COUPON_ID,
    logError,
    ageOkMemo,
    ...createOrigins(APP_ORIGINS),
    ...signing,
    ...createAccounts(admin, stripe),
    ...storage,
    ...createModerationGate({
      admin,
      moderate,
      logError,
      removeTracked: storage.removeTracked,
    }),
    ...createGenerationDtos(signing.signStored),
    ...createAccountClosure({ admin, stripe, logError, ageOkMemo }),
    ...createAgeGate(admin, ageOkMemo),
  };
}

/** Everything a service factory may depend on. */
export type Services = ReturnType<typeof createServices>;

export function createContext(deps: ApiDeps) {
  const services = createServices(deps);
  const submit = createSubmitGeneration(services);
  return {
    ...services,
    ...submit,
    ...createReplay({ ...services, ...submit }),
    ...createJobs(services),
    ...createLibrary(services),
  };
}

/** What every route module receives. */
export type ApiContext = ReturnType<typeof createContext>;
