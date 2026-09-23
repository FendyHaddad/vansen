// Vansen API gateway. All data access flows through here (tables are RLS
// deny-all; RPCs are service_role-only). Client's only other Supabase surface
// is Auth. REST contract doubles as the future Java migration contract.
//
// createApp(deps) exists so routes can be exercised with app.request(...) and
// in-memory fakes. index.ts builds the production deps and serves this app.
import { type Context, Hono } from "jsr:@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { JWSTransactionDecodedPayload } from "npm:@apple/app-store-server-library@1.6.0";
import type Stripe from "npm:stripe@17";
import {
  CATALOG_VERSION,
  CREDIT_PACKS,
  creditCost,
  PROMPT_MAX_CHARS,
  editToolById,
  familyById,
  type GenerationInput,
  type GenerationSettings,
  type ModelFamily,
  packCredits,
  PERSONA_GEN,
  PERSONA_SLOTS,
  personaGenCreditCost,
  personaProviderCost,
  personaSettings,
  STUDIO_MARGIN,
  upscaleCreditCost,
  UPSCALER,
  videoFamilySupports,
  type VideoMode,
} from "./_shared/model-families.ts";
import { applyStyle, styleById } from "./_shared/style-presets.ts";
import { GenerationOp, LedgerType, MediaKind } from "./_shared/enums.ts";
import {
  isPersonaSlot,
  PERSONA_MIN_EDGE,
  personaPhotoFailure,
  personaPrompt,
  readyPersona,
  toPersonaDto,
} from "./personas.ts";
import type {
  CheckResult,
  ProviderAdapter,
} from "./_shared/providers/types.ts";
import {
  type StorageAdapter,
  type StorageBackend,
  thumbPath,
} from "./_shared/storage/index.ts";
import {
  enqueueDeletions,
  holdObject,
  markObjectLive,
  type ObjectPurpose,
  registerObject,
} from "./_shared/storage/registry.ts";
import { finishJob as storeFinishedJob } from "./_shared/jobs/store.ts";
import type { StoredPayload } from "./_shared/jobs/payload.ts";
import { bodyHash, readIdempotencyKey } from "./services/idempotency.ts";
import { captureSnapshot } from "./_shared/request-snapshot.ts";
import type { GenerationRequestSnapshotV1 } from "./_shared/request-snapshot.ts";
import {
  planRetry,
  planVariation,
  REFUSAL_MESSAGE,
  REFUSAL_STATUS,
  type RetryContext,
  type RetryDecision,
} from "./services/retry.ts";
import { imageSize } from "./_shared/image-size.ts";
import { validateSettings } from "./services/request-validation.ts";
import {
  publicCapabilities,
  type ReleaseFlags,
} from "./services/public-capabilities.ts";
import {
  normalizeGenerationRequest,
  type NormalizedRequest,
  quote,
  QUOTE_VERSION,
} from "./_shared/generation-request.ts";
import {
  type ReferenceError,
  resolveOwnedUpload,
} from "./_shared/reference-resolver.ts";
import {
  dailyCapState,
  expectedSecondsFor,
  referenceRule,
  videoJobCapReached,
} from "./_shared/video-rules.ts";
import { isUrlResult, type SubmitResult } from "./_shared/providers/types.ts";
import type {
  ModerationDecision,
  ModerationResult,
} from "./_shared/moderation.ts";
import { safetyId } from "./_shared/safety.ts";
import type { ServiceAccount } from "./_shared/push.ts";
import { laneFor } from "./_shared/billing-lanes.ts";
import { applyIapTransaction } from "./_shared/iap-grants.ts";
import { applyFulfillment } from "./_shared/billing-fulfillment.ts";
import { settleDone, settleFailed } from "./_shared/jobs/settlement.ts";
import { classifyProviderError } from "./_shared/providers/provider-errors.ts";
import { CATALOG_STALE, catalogHandler, isStaleCatalog } from "./catalog.ts";
import { isEntitled } from "./services/entitlement.ts";

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
}

const SUSPEND_STRIKES = 2;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const PERSONA_MAX_BYTES = 2.5 * 1024 * 1024;

/** D2: quarantined evidence is kept for 12 months after the enforcement
 * action, for appeals and legal defence. See the retention policy spec. */
const EVIDENCE_HOLD_MS = 365 * 24 * 60 * 60 * 1000;

/** Which Supabase bucket a purpose lives in. There is no default: a delete
 * aimed at the wrong bucket silently misses, which is how R11 happened. */
const SUPABASE_BUCKETS: Record<ObjectPurpose, string> = {
  media: "media",
  thumb: "media",
  upload: "uploads",
  "persona-photo": "uploads",
  "persona-zip": "uploads",
  scratch: "uploads",
  quarantine: "uploads",
};

/** Pre-allocation guard: nothing downstream needs more than 50 MP, and a larger
 * header is a decompression bomb, not a photo. */
const UPLOAD_MAX_PIXELS = 50 * 1_000_000;
const DEV_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/;

type ReturnUrls = { success: string; cancel: string };

/**
 * What a paid checkout session is worth, per the catalog. `pack_credits` on the
 * session metadata is deliberately ignored: the grant is recomputed from the
 * rate inputs, so a stale or tampered number can never be paid out. Returns 0
 * for anything that is not a pack we recognise.
 */
function catalogPackCredits(metadata: Stripe.Metadata | null): number {
  const usd = Number(metadata?.pack_usd);
  if (!CREDIT_PACKS.some((p) => p.usd === usd)) return 0;
  const plan = metadata?.pack_plan;
  if (plan !== "studio" && plan !== "pro") return 0;
  return packCredits(usd, plan);
}

/** Detect image type from magic bytes; returns extension or null. */
function sniffImage(bytes: Uint8Array): "png" | "jpg" | "webp" | null {
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

// The catalog owns the cap because it also prices it: every token-billed
// generation carries PROMPT_TOKEN_ALLOWANCE, sized for a prompt this long.
const MAX_PROMPT_LEN = PROMPT_MAX_CHARS;
const AR_PATTERN = /^\d{1,2}:\d{1,2}$/;
const VIDEO_MODES: ReadonlySet<string> = new Set([
  "t2v",
  "i2v",
  "ref2v",
  "keyframes",
  "extend",
  "edit",
]);
const REF_SIGN_TTL_S = 3600;
const UPLOAD_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/i;

/** Only known settings keys, type- and size-checked, are ever stored or priced. */
function sanitizeSettings(raw: unknown): GenerationSettings {
  const src = (raw ?? {}) as Record<string, unknown>;
  const clean: GenerationSettings = { aspectRatio: "1:1" };
  if (typeof src.aspectRatio === "string" && AR_PATTERN.test(src.aspectRatio)) {
    clean.aspectRatio = src.aspectRatio;
  }
  if (typeof src.version === "string" && src.version.length <= 20) {
    clean.version = src.version;
  }
  if (typeof src.resolution === "string" && src.resolution.length <= 10) {
    clean.resolution = src.resolution;
  }
  if (typeof src.quality === "string" && src.quality.length <= 10) {
    clean.quality = src.quality;
  }
  if (
    typeof src.durationS === "number" &&
    Number.isFinite(src.durationS) &&
    src.durationS > 0 &&
    src.durationS <= 60
  ) {
    clean.durationS = src.durationS;
  }
  if (src.audio === "off" || src.audio === "on" || src.audio === "voice") {
    clean.audio = src.audio;
  }
  if (typeof src.mode === "string" && VIDEO_MODES.has(src.mode)) {
    clean.mode = src.mode as VideoMode;
  }
  return clean;
}

const PREF_CHECKS: ReadonlyArray<readonly [string, (v: unknown) => boolean]> = [
  ["defaultMode", (v) => v === "image" || v === "video"],
  ["defaultImageFamily", (v) => typeof v === "string" && v.length <= 40],
  ["defaultVideoFamily", (v) => typeof v === "string" && v.length <= 40],
  ["defaultVideoMode", (v) => typeof v === "string" && VIDEO_MODES.has(v)],
  ["defaultAspect", (v) => typeof v === "string" && v.length <= 10],
  ["defaultStyle", (v) => typeof v === "string" && v.length <= 40],
  ["defaultPersona", (v) => typeof v === "string" && v.length <= 40],
  ["tourSeen", (v) => typeof v === "boolean"],
];

/** Whitelist prefs: unknown keys dropped, invalid values reject the request. */
function sanitizePrefs(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const clean: Record<string, unknown> = {};
  for (const [key, check] of PREF_CHECKS) {
    if (key in raw) {
      if (!check(raw[key])) return null;
      clean[key] = raw[key];
    }
  }
  return clean;
}

type Vars = { Variables: { userId: string; email: string; requestId: string } };

export function createApp(deps: ApiDeps): Hono<Vars> {
  // These names deliberately match the identifiers the moved route bodies
  // already use, so the bodies needed no edits when they moved here.
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

  /** A signed storage URL the browser can open. Only applied to URLs meant
   * for the browser: a provider needs the URL as storage signed it, and no
   * origin makes a laptop reachable from a provider anyway. */
  function browserUrl(signed: string): string {
    const origin = deps.env.mediaPublicOrigin?.replace(/\/$/, '');
    if (!origin) return signed;
    if (!signed) return signed;
    const parsed = new URL(signed);
    return `${origin}${parsed.pathname}${parsed.search}`;
  }
  const LAUNCH_COUPON_ID = deps.env.launchCouponId;

  /** The single source of truth for "is this origin ours?" — used for both CORS
   * and the Stripe return URL. Only ever returns an origin we recognise. */
  function allowedOrigin(origin: string | undefined): string | null {
    if (!origin) return null;
    if (DEV_ORIGIN.test(origin)) return origin;
    return APP_ORIGINS.includes(origin) ? origin : null;
  }

  /** Where Stripe sends the browser back. Prefer the caller's origin when we trust
   * it, so any `ng serve` port works; fall back to the configured deployment. */
  function appOrigin(
    c: { req: { header: (k: string) => string | undefined } },
  ): string {
    return allowedOrigin(c.req.header("origin")) ?? APP_ORIGINS[0] ??
      "http://localhost:4200";
  }

  /** Mobile checkouts bounce back into the app via its deep link; web callers
   * keep the site URLs (param absent → unchanged behaviour). */
  function checkoutReturnUrls(
    c: { req: { header: (k: string) => string | undefined } },
    body: Record<string, unknown>,
  ): ReturnUrls {
    if (body.platform === "mobile") {
      return {
        success: "vansen://billing-return?status=success",
        cancel: "vansen://billing-return?status=cancel",
      };
    }
    return {
      success: `${appOrigin(c)}/app?checkout=success`,
      cancel: `${appOrigin(c)}/app?checkout=canceled`,
    };
  }

  const app = new Hono<Vars>().basePath("/api");

  app.use(
    "*",
    cors({
      origin: (origin) => allowedOrigin(origin) ?? undefined,
      allowHeaders: ["authorization", "content-type", "x-vansen-client"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  function fail(
    c: {
      json: (b: unknown, s: number) => Response;
      get?: (k: "requestId") => string | undefined;
    },
    status: number,
    code: string,
    message: string,
  ) {
    // A 4xx is the caller's to fix and reads as plain advice. Attaching an
    // incident id to "that file is too large" would suggest we think something
    // broke, and train people to quote ids that lead nowhere useful.
    if (status < 500) return c.json({ error: { code, message } }, status);
    // A 5xx is ours. The id is the whole support conversation: it matches the
    // x-request-id header and the app_errors row for this exact request.
    const errorId = c.get?.("requestId") ?? "";
    return c.json({ error: { code, message, errorId } }, status);
  }

  type ErrCtx = {
    req: { url: string; method: string };
    get: (k: "userId" | "requestId") => string | undefined;
  };

  /** Fire-and-forget write to app_errors — monitoring must never break a request.
   * Never log request bodies or headers here: prompts are user content, headers
   * carry tokens. Message + stack only. */
  function logError(c: ErrCtx, code: string, err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    admin
      .from("app_errors")
      .insert({
        source: "api",
        route: new URL(c.req.url).pathname,
        method: c.req.method,
        code,
        message: (e.message || "unknown").slice(0, 1000),
        stack: (e.stack ?? "").slice(0, 4000),
        user_id: c.get("userId") ?? null,
        request_id: c.get("requestId") ?? null,
      })
      .then(({ error }) => {
        if (error) console.error("app_errors insert failed:", error.message);
      });
  }

  /** Stripe checkout is only allowed where the storefront's rules permit it.
   * An unknown platform or a missing storefront is NOT Android/US — a wrong
   * guess here sells a subscription Apple requires to be an in-app purchase. */
  function requireWebLane(c: Context): Response | null {
    const client = clientOf(c);
    if (client !== "ios") return null;
    const storefront = (c.req.header("x-vansen-storefront") ?? "").toUpperCase();
    const lane = laneFor("ios", storefront, Deno.env.get("LANE_B") === "on");
    if (lane === "A") return null;
    return fail(
      c,
      403,
      "lane_not_allowed",
      "Purchases on this device go through the App Store.",
    );
  }

  const KNOWN_CLIENTS = new Set(["web", "ios", "android"]);

  /** Platform marker from the x-vansen-client header; anything unexpected → null. */
  function clientOf(
    c: { req: { header: (name: string) => string | undefined } },
  ): string | null {
    const v = c.req.header("x-vansen-client");
    return v && KNOWN_CLIENTS.has(v) ? v : null;
  }

  /** Short free-text field: control chars stripped, trimmed, capped, null if empty. */
  function sanitizeLabel(v: unknown, max = 80): string | null {
    if (typeof v !== "string") return null;
    const s = v.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max);
    return s || null;
  }

  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    c.set("requestId", requestId);
    await next();
    // On every answer, not only the failures. The request people report is
    // often the one that succeeded slowly, or returned the wrong thing --
    // neither has an error body to carry the id in.
    c.header("x-request-id", requestId);
  });

  // Any exception nothing else caught: log it, answer with a request id the
  // user can quote back so the row is findable.
  app.onError((err, c) => {
    logError(c, "unhandled", err);
    return c.json(
      {
        error: {
          code: "internal",
          message: "Something went wrong",
          // Both names, on purpose: `errorId` is what every failure now calls
          // it, and `requestId` is what older clients already read. Dropping
          // it would silently blind an app we cannot force to update.
          errorId: c.get("requestId"),
          requestId: c.get("requestId"),
        },
      },
      500,
    );
  });

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

  app.use("*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /i, "");
    if (!token) return fail(c, 401, "unauthorized", "Missing token");
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) {
      return fail(c, 401, "unauthorized", "Invalid token");
    }
    c.set("userId", data.user.id);
    c.set("email", data.user.email ?? "");
    await next();
  });

  /** Warm-isolate memo of users who already passed the age gate (same pattern as
   * signedUrlMemo). Safe to cache: birth_date only ever transitions unset → set,
   * so a hit can never go stale. deleteAccount evicts on account deletion. */
  const ageOkMemo = new Set<string>();

  /** Routes reachable before the gate: read your profile, pass the gate, or
   * delete the account. Everything else requires a confirmed 18+ DOB. */
  const AGE_EXEMPT = new Set([
    "GET /api/profile",
    "POST /api/profile/age",
    "DELETE /api/profile",
  ]);

  app.use("*", async (c, next) => {
    const key = `${c.req.method} ${new URL(c.req.url).pathname}`;
    if (!AGE_EXEMPT.has(key)) {
      const userId = c.get("userId");
      if (!ageOkMemo.has(userId)) {
        const { data } = await admin
          .from("profiles")
          .select("birth_date")
          .eq("id", userId)
          .single();
        if (!data?.birth_date) {
          return fail(
            c,
            403,
            "age_unconfirmed",
            "Confirm your date of birth to continue",
          );
        }
        if (ageOkMemo.size > 10_000) ageOkMemo.clear();
        ageOkMemo.add(userId);
      }
    }
    await next();
  });

  // Shared database budgets survive cold starts and concurrent API instances.
  // Run before parsing uploads, moderation, or reserving provider spend.
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const bucket = c.req.method !== "POST" ? null
      : path === "/api/generations" || /^\/api\/generations\/[^/]+\/retry$/.test(path)
      ? "generation"
      : path === "/api/uploads" || path === "/api/edits/save" ? "upload" : null;
    if (bucket) {
      const { data, error } = await admin.rpc("fn_take_request_slot", {
        p_user: c.get("userId"), p_bucket: bucket,
      });
      if (error || !data) {
        return fail(c, 503, "request_limit_unavailable", "Requests are temporarily unavailable. Please try again shortly.");
      }
      if (!data.allowed) {
        const res = fail(c, 429, "rate_limited", "Too many requests. Please wait a moment and try again.");
        res.headers.set("retry-after", String(data.retryAfterSeconds));
        return res;
      }
    }
    await next();
  });

  /** Warm-isolate memo so list reloads don't re-sign every media path, and the
   * URL stays stable across requests (lets browser HTTP caching work too). */
  const signedUrlMemo = new Map<string, { url: string; expiresAt: number }>();
  const SIGN_TTL_S = 604800; // 7 days
  const RESIGN_FLOOR_MS = 86_400_000; // re-sign when under 1 day of validity left

  async function signMedia(path: string | null): Promise<string> {
    if (!path) return "";
    const hit = signedUrlMemo.get(path);
    if (hit && hit.expiresAt - Date.now() > RESIGN_FLOOR_MS) return hit.url;
    const { data } = await admin.storage.from("media").createSignedUrl(
      path,
      SIGN_TTL_S,
    );
    if (!data?.signedUrl) return "";
    const url = browserUrl(data.signedUrl);
    if (signedUrlMemo.size > 5000) signedUrlMemo.clear();
    signedUrlMemo.set(path, {
      url,
      expiresAt: Date.now() + SIGN_TTL_S * 1000,
    });
    return url;
  }

  const r2SignMemo = new Map<string, { url: string; exp: number }>();

  /** Video media lives in R2, not the Supabase `media` bucket — sign through the
   * right backend. R2 URLs are memoized separately since signMedia's memo is
   * keyed to Supabase's own createSignedUrl call. */
  async function signStored(
    backend: StorageBackend,
    path: string | null,
    ttlS = SIGN_TTL_S,
  ): Promise<string> {
    if (!path) return "";
    if (backend !== "r2") return signMedia(path);
    const memoKey = `${path}|${ttlS}`;
    const hit = r2SignMemo.get(memoKey);
    if (hit && hit.exp > Date.now()) return hit.url;
    const url = await storageFor("r2").signedUrl(path, ttlS);
    if (r2SignMemo.size > 5000) r2SignMemo.clear();
    r2SignMemo.set(memoKey, { url, exp: Date.now() + (ttlS - 60) * 1000 });
    return url;
  }

  type JobRow = {
    id: string;
    generation_id: string;
    progress: number | null;
    phase: string | null;
    claimed_at: string | null;
    created_at: string;
    queue_position: number | null;
  };

  const NOT_CANCELLABLE = new Set(["veo", "omni"]);

  function jobDto(row: Record<string, unknown>, job: JobRow | undefined) {
    if (!job || row.status !== "pending") return undefined;
    const family = familyById(String(row.family_id));
    const settings = (row.settings ?? {}) as GenerationSettings;
    return {
      progress: job.progress ?? undefined,
      phase: (job.claimed_at ? "saving" : job.phase ?? "queued") as
        | "queued"
        | "rendering"
        | "saving",
      cancellable: !NOT_CANCELLABLE.has(String(row.family_id)),
      expectedS: family ? expectedSecondsFor(family, settings.durationS) : 30,
      startedAt: job.created_at,
      queuePosition: job.queue_position ?? undefined,
    };
  }

  const FAILURE_CODES = new Set([
    "cancelled",
    "moderation",
    "provider_error",
    "timeout",
    "store_failed",
    "generation_failed",
  ]);

  /**
   * The safe, stable reason a generation ended badly.
   *
   * P4 persists it, so a reload sees the same thing the live client saw — a
   * cancelled video used to come back as "Generation failed · Retry" because
   * cancellation lived only in a client-side patch. The raw provider text
   * stays in `jobs.error` and never reaches a customer.
   */
  function failureDto(row: Record<string, unknown>) {
    if (row.status !== "failed") return undefined;
    const raw = String(row.failure_code ?? "");
    const code = FAILURE_CODES.has(raw) ? raw : "generation_failed";
    const message = typeof row.failure_message === "string" && row.failure_message
      ? row.failure_message
      : "Generation failed. Your credits were refunded.";
    return {
      code: code as
        | "cancelled"
        | "moderation"
        | "provider_error"
        | "timeout"
        | "store_failed"
        | "generation_failed",
      message,
      cancelled: code === "cancelled",
    };
  }

  /** Options for the list shape; a grid needs a tile, not the original. */
  interface DtoOpts {
    /** Sign the thumbnail only. Full media is signed when an item is opened. */
    thumbsOnly?: boolean;
  }

  async function toGenerationDto(
    row: Record<string, unknown>,
    job?: JobRow,
    opts: DtoOpts = {},
  ) {
    const backend = (row.storage_backend ?? "supabase") as StorageBackend;
    const mediaPath = (row.media_path as string | null) ?? null;
    const thumbPath = (row.thumb_path as string | null) ?? null;
    // One signature per row in list shape. A row with no thumbnail yet
    // (everything made before 0022, and a video whose poster has not been
    // captured) signs its original instead, so the tile still renders and the
    // poster capture still has something to read.
    const listsMedia = opts.thumbsOnly && !thumbPath;
    return {
      id: row.id,
      kind: row.kind,
      familyId: row.family_id,
      familyName: row.family_name,
      op: row.op,
      prompt: row.prompt,
      settings: row.settings,
      priceCredits: Number(row.price_credits),
      status: row.status,
      mediaUrl: opts.thumbsOnly && !listsMedia
        ? ""
        : await signStored(backend, mediaPath),
      thumbUrl: thumbPath ? await signStored(backend, thumbPath) : undefined,
      storageBackend: row.kind === MediaKind.Video ? backend : undefined,
      durationS: row.duration_s == null ? undefined : Number(row.duration_s),
      parentId: row.parent_id,
      createdAt: row.created_at,
      job: jobDto(row, job),
      failure: failureDto(row),
    };
  }

  async function toGenerationDtos(
    rows: Record<string, unknown>[],
    jobs: Map<string, JobRow> = new Map(),
    opts: DtoOpts = {},
  ) {
    // Signing is independent per row; awaiting them in sequence made a
    // 200-row page 400 round trips deep.
    return Promise.all(
      rows.map((r) => toGenerationDto(r, jobs.get(String(r.id)), opts)),
    );
  }

  const MAX_PAGE = 100;
  const DEFAULT_PAGE = 50;

  /**
   * Keyset cursor: created_at plus id, so rows sharing a timestamp still order
   * deterministically. Offset paging skips and repeats rows whenever a
   * generation lands between two page fetches.
   */
  function encodeCursor(row: Record<string, unknown>): string {
    return btoa(`${row.created_at}|${row.id}`);
  }

  /**
   * The decoded halves are pasted into a PostgREST filter string, so anything
   * that is not plainly a timestamp and an id is refused here rather than
   * sent to the database.
   */
  function decodeCursor(raw: string): { createdAt: string; id: string } | null {
    let decoded: string;
    try {
      decoded = atob(raw);
    } catch {
      return null;
    }
    const parts = decoded.split("|");
    if (parts.length !== 2) return null;
    const [createdAt, id] = parts;
    if (!createdAt || !id) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    if (!/^[0-9T:.+\-]+Z?$/.test(createdAt)) return null;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
    return { createdAt, id };
  }

  function pageSize(raw: string | undefined): number {
    const asked = Number(raw ?? DEFAULT_PAGE);
    if (!Number.isFinite(asked) || asked < 1) return DEFAULT_PAGE;
    return Math.min(Math.floor(asked), MAX_PAGE);
  }

  /**
   * Ancestors (via parent_id) + the row itself + every descendant, oldest
   * first — the same chain the client used to assemble from loaded rows only.
   */
  function versionChain(
    all: Record<string, unknown>[],
    root: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const byId = new Map(all.map((r) => [String(r.id), r]));
    const chain: Record<string, unknown>[] = [];
    let current: Record<string, unknown> | undefined = byId.get(
      String(root.id),
    ) ?? root;
    while (current) {
      chain.unshift(current);
      const parent: unknown = current.parent_id;
      current = parent ? byId.get(String(parent)) : undefined;
    }
    let frontier = [String(root.id)];
    const seen = new Set(chain.map((r) => String(r.id)));
    while (frontier.length) {
      const children = all.filter(
        (r) => r.parent_id && frontier.includes(String(r.parent_id)),
      );
      for (const child of children) {
        if (seen.has(String(child.id))) continue;
        seen.add(String(child.id));
        chain.push(child);
      }
      frontier = children.map((r) => String(r.id));
    }
    return chain.sort((a, b) =>
      String(a.created_at).localeCompare(String(b.created_at))
    );
  }

  /** Newest-first keyset page over `generations`, one extra row for "is there more?". */
  function pageQuery(
    userId: string,
    limit: number,
    cursor: { createdAt: string; id: string } | null,
  ) {
    let query = admin
      .from("generations")
      .select("*")
      .eq("user_id", userId)
      // A tombstoned row is gone as far as its owner is concerned; it exists
      // only until its job settles and the cleanup worker has its bytes.
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (!cursor) return query;
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
    return query;
  }

  async function isSuspended(userId: string): Promise<boolean> {
    const { data } = await admin.from("profiles").select("strikes").eq(
      "id",
      userId,
    ).single();
    return (data?.strikes ?? 0) >= SUSPEND_STRIKES;
  }

  async function modelGate(
    familyId: string,
  ): Promise<{ enabled: boolean; minPlan: string }> {
    const { data } = await admin
      .from("models")
      .select("enabled,min_plan")
      .eq("id", familyId)
      .maybeSingle();
    return {
      enabled: data?.enabled ?? false,
      minPlan: data?.min_plan ?? "studio",
    };
  }

  async function recordStrike(
    userId: string,
    source: "prompt" | "upload",
    prompt: string | null,
    categories: Record<string, number>,
    quarantinePath?: string,
  ): Promise<void> {
    const { error } = await admin.from("moderation_events").insert({
      user_id: userId,
      source,
      prompt,
      categories,
      quarantine_path: quarantinePath ?? null,
    });
    if (error) throw new Error("moderation_event_insert_failed");
    const { error: strikeError } = await admin.rpc("fn_increment_strike", {
      p_user: userId,
    });
    if (strikeError) throw new Error("moderation_strike_failed");
  }

  /** One response for a moderation outage: readable, retryable, never charged. */
  async function moderationFailure(
    c: Context,
    decision: Extract<ModerationDecision, { state: "unavailable" }>,
  ): Promise<Response> {
    const res = fail(
      c,
      503,
      "moderation_unavailable",
      "Safety check is unavailable right now. Nothing was charged — please try again shortly.",
    );
    res.headers.set("retry-after", String(decision.retryAfterSeconds));
    console.error("moderation_unavailable", decision.reason);
    const { error } = await admin.rpc("fn_raise_alert", {
      p_kind: "moderation_unavailable", p_severity: "critical",
      p_detail: { reason: decision.reason },
    });
    if (error) console.error("moderation_alert_failed", error.message);
    return res;
  }

  const REFERENCE_MESSAGES: Record<ReferenceError, string> = {
    not_found: "That reference image is no longer available — upload it again.",
    not_owned: "That reference image does not belong to you.",
    not_moderated: "That reference image has not finished its safety check.",
    wrong_purpose: "That image was not uploaded as a reference.",
  };

  function referenceFailure(c: Context, err: ReferenceError): Response {
    const status = err === "not_found" ? 404 : 403;
    return fail(c, status, "invalid_reference", REFERENCE_MESSAGES[err]);
  }

  /** Copy the bytes into quarantine for an appeal, then delete the original.
   * A failed copy must not leave `moderation_events` pointing at nothing.
   *
   * The copy is registered and immediately HELD: evidence is kept on purpose
   * for the D2 appeal window (12 months), so no purge, account closure or
   * inventory sweep may treat it as an orphan. */
  async function quarantine(
    userId: string,
    bucketPath: string,
    ext: string,
  ): Promise<string | null> {
    const target = `quarantine/${userId}/${crypto.randomUUID()}.${ext}`;
    let objectId: string;
    try {
      objectId = await registerObject(admin, {
        userId,
        backend: "supabase",
        bucket: "uploads",
        path: target,
        purpose: "quarantine",
      });
    } catch (e) {
      console.error("quarantine_register_failed", String(e));
      return null;
    }
    const { error } = await admin.storage.from("uploads").copy(
      bucketPath,
      target,
    );
    if (error) {
      console.error("quarantine_copy_failed", error.message);
      return null;
    }
    await holdObject(admin, objectId, new Date(Date.now() + EVIDENCE_HOLD_MS));
    return target;
  }

  /**
   * The R2 bucket the deployment actually uses, as recorded in the database.
   * There is no default: naming the wrong bucket is a delete that misses.
   */
  async function r2Bucket(): Promise<string> {
    const { data, error } = await admin.rpc("fn_storage_config", {
      p_key: "r2_bucket",
    });
    if (error || !data) throw new Error("r2_bucket is not configured");
    return String(data);
  }

  /**
   * Remove one object now, and fall back to the deletion outbox when storage
   * refuses. The customer's request never fails on a bad minute at the storage
   * provider, and the bytes are never forgotten either.
   */
  async function removeTracked(
    c: Context,
    userId: string,
    purpose: ObjectPurpose,
    path: string,
    reason: string,
  ): Promise<void> {
    const bucket = SUPABASE_BUCKETS[purpose];
    const { error } = await admin.storage.from(bucket).remove([path]);
    if (!error) return;
    console.error("object_delete_deferred", { bucket, path, reason });
    try {
      const id = await registerObject(admin, {
        userId,
        backend: "supabase",
        bucket,
        path,
        purpose,
      });
      await enqueueDeletions(admin, [id], reason);
    } catch (e) {
      logError(c, "deletion_enqueue_failed", e);
    }
  }

  /**
   * Stage bytes where moderation can read them. Returns an error Response, or
   * null when the write landed. The locator is registered first so a scratch
   * object survives a crash between the write and its cleanup.
   */
  async function writeScratch(
    c: Context,
    userId: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<Response | null> {
    const registered = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.scratch,
      path,
      purpose: "scratch",
    }).catch((e) => {
      logError(c, "scratch_register_failed", e);
      return null;
    });
    if (!registered) {
      return moderationFailure(c, {
        state: "unavailable",
        reason: "scratch_register_failed",
        retryAfterSeconds: 10,
      });
    }
    const { error } = await admin.storage
      .from(SUPABASE_BUCKETS.scratch)
      .upload(path, bytes, { contentType });
    if (!error) return null;
    return moderationFailure(c, {
      state: "unavailable",
      reason: "scratch_write_failed",
      retryAfterSeconds: 10,
    });
  }

  type ImageCheck =
    | { ok: true }
    | { ok: false; response: Response };

  async function refuseBlockedImage(
    c: Context,
    userId: string,
    path: string,
    ext: string,
    categories: Record<string, number>,
  ): Promise<ImageCheck> {
    const kept = await quarantine(userId, path, ext);
    if (!kept) {
      return {
        ok: false,
        response: await moderationFailure(c, {
          state: "unavailable",
          reason: "quarantine_copy_failed",
          retryAfterSeconds: 10,
        }),
      };
    }
    await recordStrike(userId, "upload", null, categories, kept);
    // The evidence copy is kept; the original goes. A failed removal here used
    // to be a log line and nothing else — it is now a durable cleanup job.
    await removeTracked(c, userId, "upload", path, "moderation_blocked");
    return {
      ok: false,
      response: fail(
        c,
        422,
        "content_policy",
        "This image violates our content policy.",
      ),
    };
  }

  /** Sign a just-written object and moderate it. Any failure to produce a real
   * signed URL is an outage, not a pass — we never call moderate() with an
   * undefined image. Blocked images are quarantined and striked here. */
  async function moderateStoredImage(
    c: Context,
    userId: string,
    path: string,
    ext: string,
  ): Promise<ImageCheck> {
    const { data: signed, error: signError } = await admin.storage
      .from("uploads")
      .createSignedUrl(path, 600);
    if (signError || !signed?.signedUrl) {
      await admin.storage.from("uploads").remove([path]);
      console.error(
        "moderation_sign_failed",
        signError?.message ?? "no signed url",
      );
      return {
        ok: false,
        response: await moderationFailure(c, {
          state: "unavailable",
          reason: "moderation_sign_failed",
          retryAfterSeconds: 10,
        }),
      };
    }
    const decision = await moderate({ imageUrl: signed.signedUrl });
    if (decision.state === "unavailable") {
      await admin.storage.from("uploads").remove([path]);
      return { ok: false, response: await moderationFailure(c, decision) };
    }
    if (decision.state === "blocked") {
      return refuseBlockedImage(c, userId, path, ext, decision.categories);
    }
    return { ok: true };
  }

  // Nothing pushes from inside a request any more. `fn_settle_job` writes a
  // notification_outbox row in the same transaction as the settlement, and
  // `_shared/jobs/notifications.ts` delivers it on its own schedule (wired up
  // in P5). A push that fails can no longer fail a paid request, and "was the
  // customer told" is answerable from the database.

  // A staged library row is only a promise of media. When the promise cannot be
  // kept, both halves are rolled back; a cleanup that itself fails leaves an
  // orphan, which P6's durable object registry is what finally collects.
  async function dropStagedObject(
    generationId: string,
    path: string,
  ): Promise<void> {
    const { error } = await admin.storage.from("media").remove([path]);
    if (!error) return;
    console.error("staged_object_cleanup_failed", {
      generationId,
      path,
      message: error.message,
    });
  }

  async function dropStagedRow(generationId: string): Promise<void> {
    const { error } = await admin.from("generations").delete().eq(
      "id",
      generationId,
    );
    if (!error) return;
    console.error("staged_row_cleanup_failed", {
      generationId,
      message: error.message,
    });
  }

  /**
   * Store the finished bytes and settle, via the one shared finalizer that
   * P5's dispatcher will also call. Nothing about "store then settle" is
   * implemented twice.
   */
  function finishJob(
    job: {
      id: string;
      user_id: string;
      generation_id: string;
      attempts?: number;
      lease_token?: string;
    },
    result: CheckResult,
  ): Promise<void> {
    return storeFinishedJob({ admin, storageFor }, job, result);
  }

  function toLedgerDto(row: Record<string, unknown>) {
    return {
      id: row.id,
      type: row.type,
      amountCredits: Number(row.amount_credits),
      bucket: row.bucket,
      familyId: row.family_id,
      note: row.note,
      createdAt: row.created_at,
    };
  }

  async function creditsOf(
    userId: string,
  ): Promise<{ plan: number; pack: number }> {
    const { data, error } = await admin.rpc("fn_balances", { p_user: userId });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    return { plan: row?.plan_credits ?? 0, pack: row?.pack_credits ?? 0 };
  }

  async function stripeCustomerFor(
    userId: string,
    email: string,
  ): Promise<string> {
    const { data: profile } = await admin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();
    if (profile?.stripe_customer_id) return profile.stripe_customer_id;
    const customer = await stripe.customers.create({
      email,
      metadata: { user_id: userId },
    });
    await admin.from("profiles").update({ stripe_customer_id: customer.id }).eq(
      "id",
      userId,
    );
    return customer.id;
  }

  /** Highest active plan, or null. canceled = works until period end. */
  async function activePlan(
    userId: string,
  ): Promise<"studio" | "pro" | "owner" | null> {
    const { data } = await admin
      .from("subscriptions")
      .select("plan, status, current_period_end")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return null;
    if (!isEntitled(data, Date.now())) return null;
    return data.plan as "studio" | "pro" | "owner";
  }

  app.get("/profile", async (c) => {
    const userId = c.get("userId");
    const [{ data: profile, error }, credits, { data: subscription }] =
      await Promise.all([
        admin.from("profiles").select("*").eq("id", userId).single(),
        creditsOf(userId),
        admin.from("subscriptions").select("*").eq("user_id", userId)
          .maybeSingle(),
      ]);
    if (error || !profile) return fail(c, 404, "not_found", "Profile missing");
    return c.json({
      profile: {
        id: profile.id,
        email: c.get("email"),
        displayName: profile.display_name,
        prefs: profile.prefs,
        createdAt: profile.created_at,
        ageConfirmed: !!profile.birth_date,
      },
      credits,
      subscription: subscription
        ? {
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
          pendingPlan: subscription.pending_plan ?? null,
          pendingAt: subscription.pending_at ?? null,
          entitled: isEntitled(subscription, Date.now()),
        }
        : null,
    });
  });

  app.patch("/profile", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body || typeof body.displayName !== "string" ||
      body.displayName.length > 80
    ) {
      return fail(
        c,
        400,
        "invalid_payload",
        "displayName required (max 80 chars)",
      );
    }
    const cleanName = body.displayName.replace(/[\u0000-\u001f\u007f]/gu, "")
      .trim();
    const { error } = await admin
      .from("profiles")
      .update({ display_name: cleanName || null })
      .eq("id", c.get("userId"));
    if (error) {
      return fail(c, 400, "update_failed", "Profile could not be updated");
    }
    return c.json({ ok: true });
  });

  /** What a delete request tells the customer: hidden now, bytes queued. */
  function deletionStatus(data: unknown): Record<string, unknown> {
    const result = (data ?? {}) as { status?: string; objects?: number };
    return {
      // `pending_job` means a render is still running and may yet hand us
      // bytes; the content is already hidden either way.
      status: result.status === "pending_job" ? "processing" : "accepted",
      objectsQueued: result.objects ?? 0,
    };
  }

  /** One subscription, as it actually stood when the closure was recorded. */
  interface ClosureSubscription {
    source: "stripe" | "apple";
    id: string;
    status: string;
    action: "cancelled" | "already_final" | "manage_in_app_store";
    checkedAt: string;
  }

  /**
   * Stripe statuses that bill nothing and never will again. Everything else —
   * active, trialing, past_due, unpaid, incomplete, paused — can still take
   * money, so it is cancelled rather than assumed harmless. The old code
   * looked only at `status: "active"` and left the rest collecting.
   */
  const FINAL_STRIPE_STATUSES = new Set(["canceled", "incomplete_expired"]);

  /**
   * Establish, from the provider, what every subscription is doing — and stop
   * the ones we are able to stop.
   *
   * Throws on an operational failure: a closure recorded against a Stripe we
   * could not reach would claim a reconciliation that never happened.
   */
  async function reconcileStripeSubscriptions(
    customerId: string,
  ): Promise<ClosureSubscription[]> {
    const listed = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
    });
    const out: ClosureSubscription[] = [];
    for (const sub of listed.data) {
      const checkedAt = new Date().toISOString();
      if (FINAL_STRIPE_STATUSES.has(sub.status)) {
        out.push({
          source: "stripe",
          id: sub.id,
          status: sub.status,
          action: "already_final",
          checkedAt,
        });
        continue;
      }
      const cancelled = await stripe.subscriptions.cancel(sub.id);
      out.push({
        source: "stripe",
        id: sub.id,
        status: cancelled.status,
        action: "cancelled",
        checkedAt,
      });
    }
    return out;
  }

  /**
   * Apple subscriptions cannot be cancelled by us. Verifying a transaction
   * proves what the customer is entitled to; it grants no power to end the
   * purchase, which lives in their App Store account. We record the
   * entitlement against the closure and tell them the one action that works.
   */
  async function appleSubscriptionOf(
    userId: string,
  ): Promise<ClosureSubscription | null> {
    const { data } = await admin
      .from("subscriptions")
      .select("iap_original_transaction_id,status")
      .eq("user_id", userId)
      .maybeSingle();
    const id = data?.iap_original_transaction_id as string | undefined;
    if (!id) return null;
    return {
      source: "apple",
      id,
      status: String(data?.status ?? "unknown"),
      action: "manage_in_app_store",
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Request closure. Returns an error Response on failure, or the closure
   * result. Shared by DELETE /profile and the underage branch of
   * POST /profile/age.
   *
   * Nothing here deletes anything directly any more. The RPC hides the
   * content, cancels what can be cancelled, queues every locator and
   * anonymises what D2 keeps; the cleanup worker finishes the parts that need
   * an HTTP call. A closure is reported "completed" only when it is.
   */
  async function deleteAccount(
    c: ErrCtx & { json: (b: unknown, s: number) => Response },
    userId: string,
  ): Promise<{ error: Response } | { result: Record<string, unknown> }> {
    const { data: prof } = await admin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    const subscriptions: ClosureSubscription[] = [];
    if (prof?.stripe_customer_id) {
      try {
        subscriptions.push(
          ...await reconcileStripeSubscriptions(prof.stripe_customer_id),
        );
      } catch (e) {
        // An unreconciled subscription is the one thing worth stopping for:
        // closing the account around a live one would keep charging a
        // customer who no longer has an account to show for it.
        logError(c, "delete_failed", e);
        return {
          error: fail(
            c,
            503,
            "delete_failed",
            "Could not confirm your subscription is cancelled — try again",
          ),
        };
      }
    }
    const apple = await appleSubscriptionOf(userId);
    if (apple) subscriptions.push(apple);

    const { data, error } = await admin.rpc("fn_delete_account", {
      p_user: userId,
      p_subscriptions: subscriptions,
    });
    if (error) {
      logError(c, "delete_failed", error);
      return {
        error: fail(c, 503, "delete_failed", "Could not delete — try again"),
      };
    }
    const closure = (data ?? {}) as Record<string, unknown>;
    await finishClosure(c, closure);
    ageOkMemo.delete(userId);
    return {
      result: {
        ...closure,
        subscriptions,
        // The only honest thing to say about an Apple subscription.
        appleAction: apple ? "manage_in_app_store" : null,
      },
    };
  }

  /**
   * Remove the auth user as soon as the data side is finalised, so a closed
   * account cannot sign in while the worker's next tick is pending. A failure
   * is not fatal: the same work is queued, and the cleanup worker retries it.
   */
  async function finishClosure(
    c: ErrCtx,
    closure: Record<string, unknown>,
  ): Promise<void> {
    const authUserId = closure.authUserId as string | undefined;
    if (!authUserId) return;
    const { error } = await admin.auth.admin.deleteUser(authUserId);
    if (error && !/not.?found/i.test(error.message)) {
      logError(c, "auth_delete_deferred", error);
      return;
    }
    const { error: completeError } = await admin.rpc(
      "fn_complete_account_deletion",
      { p_request: closure.requestId },
    );
    if (completeError) logError(c, "closure_complete_deferred", completeError);
  }

  app.delete("/profile", async (c) => {
    const outcome = await deleteAccount(c, c.get("userId"));
    if ("error" in outcome) return outcome.error;
    return c.json(outcome.result, 202);
  });

  /** Accept a strict, real, non-future, ≤120y-old YYYY-MM-DD string; else null. */
  function parseBirthDate(s: unknown): string | null {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (
      dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 ||
      dt.getUTCDate() !== d
    ) {
      return null; // e.g. 2001-02-30 rolled over
    }
    const now = Date.now();
    if (dt.getTime() > now) return null; // future
    if (now - dt.getTime() > 120 * 365.25 * 864e5) return null; // >120 years
    return s;
  }

  /** Whole years old today, UTC, with correct month/day rollover. */
  function ageFromBirthDate(s: string): number {
    const [y, m, d] = s.split("-").map(Number);
    const now = new Date();
    let age = now.getUTCFullYear() - y;
    const mo = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    if (mo < m || (mo === m && day < d)) age--;
    return age;
  }

  app.post("/profile/age", async (c) => {
    const body = await c.req.json().catch(() => null);
    const birthDate = parseBirthDate(body?.birthDate);
    if (!birthDate) {
      return fail(
        c,
        400,
        "invalid_payload",
        "A valid date of birth is required",
      );
    }

    if (ageFromBirthDate(birthDate) < 18) {
      const outcome = await deleteAccount(c, c.get("userId"));
      if ("error" in outcome) return outcome.error;
      return fail(c, 403, "underage", "You must be 18 or older to use Vansen");
    }

    const { error } = await admin
      .from("profiles")
      .update({
        birth_date: birthDate,
        age_confirmed_at: new Date().toISOString(),
      })
      .eq("id", c.get("userId"));
    if (error) {
      return fail(c, 400, "update_failed", "Could not save your date of birth");
    }
    return c.json({ ok: true });
  });

  app.put("/prefs", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail(c, 400, "invalid_payload", "Prefs object required");
    }
    const clean = sanitizePrefs(body as Record<string, unknown>);
    if (!clean) {
      return fail(c, 400, "invalid_payload", "Invalid preference values");
    }
    const { error } = await admin.from("profiles").update({ prefs: clean }).eq(
      "id",
      c.get("userId"),
    );
    if (error) {
      return fail(c, 400, "update_failed", "Preferences could not be saved");
    }
    return c.json({ ok: true });
  });

  app.post("/devices", async (c) => {
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const platform = body?.platform;
    if (!token || token.length > 512) {
      return fail(c, 400, "invalid_token", "token required");
    }
    if (platform !== "ios" && platform !== "android") {
      return fail(
        c,
        400,
        "invalid_platform",
        "platform must be 'ios' or 'android'",
      );
    }
    const { error } = await admin.from("devices").upsert(
      {
        user_id: c.get("userId"),
        token,
        platform,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,token" },
    );
    if (error) {
      logError(c, "device_register_failed", new Error(error.message));
      return fail(c, 500, "internal", "Could not register device");
    }
    return c.json({ ok: true });
  });

  app.delete("/devices", async (c) => {
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) return fail(c, 400, "invalid_token", "token required");
    await admin.from("devices").delete().eq("user_id", c.get("userId")).eq(
      "token",
      token,
    );
    return c.json({ ok: true });
  });

  app.get("/ledger", async (c) => {
    const limit = pageSize(c.req.query("limit"));
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return fail(c, 400, "invalid_cursor", "That page marker is not valid.");
    }

    let query = admin
      .from("ledger_entries")
      .select("*")
      .eq("user_id", c.get("userId"))
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit + 1);
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error) return fail(c, 400, "query_failed", error.message);

    // The old `.limit(100)` was not a page, it was a truncation: an account
    // with more history than that could never see its oldest charges.
    const rows = (data ?? []) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return c.json({
      entries: page.map(toLedgerDto),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  app.get("/generations", async (c) => {
    const userId = c.get("userId") as string;
    const limit = pageSize(c.req.query("limit"));
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return fail(c, 400, "invalid_cursor", "That page marker is not valid.");
    }

    const { data, error } = await pageQuery(userId, limit, cursor);
    if (error) return fail(c, 400, "query_failed", error.message);

    const rows = (data ?? []) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return c.json({
      items: await toGenerationDtos(page, new Map(), { thumbsOnly: true }),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  /**
   * One item, fully signed. The library is paged now, so an item the client
   * wants — a deep link, an edit parent — may never have been in a loaded page.
   */
  app.get("/generations/:id", async (c) => {
    const { data } = await admin
      .from("generations")
      .select("*")
      .eq("id", c.req.param("id"))
      .eq("user_id", c.get("userId") as string)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return fail(c, 404, "not_found", "That item does not exist.");
    return c.json({ item: await toGenerationDto(data) });
  });

  /**
   * The version chain rooted at one item, oldest first. The client used to
   * assemble this from whatever happened to be loaded, which silently lost
   * ancestors once the library paged.
   */
  app.get("/generations/:id/versions", async (c) => {
    const userId = c.get("userId") as string;
    const limit = pageSize(c.req.query("limit"));
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      return fail(c, 400, "invalid_cursor", "That page marker is not valid.");
    }

    const { data: root } = await admin
      .from("generations")
      .select("*")
      .eq("id", c.req.param("id"))
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!root) return fail(c, 404, "not_found", "That item does not exist.");

    const { data, error } = await admin
      .from("generations")
      .select("*")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_PAGE * 4);
    if (error) return fail(c, 400, "query_failed", error.message);

    const chain = versionChain((data ?? []) as Record<string, unknown>[], root);
    const start = cursor
      ? chain.findIndex((r) => String(r.id) === cursor.id) + 1
      : 0;
    const page = chain.slice(start, start + limit);
    const hasMore = start + limit < chain.length;
    return c.json({
      items: await toGenerationDtos(page),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  app.get("/models", async (c) => {
    const { data } = await admin.from("models").select("id,enabled");
    return c.json({ models: data ?? [] });
  });

  // Client-side error reports (web ErrorHandler, mobile crash hooks). Same
  // privacy rule as logError: message + stack only, never bodies or headers.
  app.post("/errors", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => null);
    const message = typeof body?.message === "string"
      ? body.message.trim().slice(0, 1000)
      : "";
    if (!message) return fail(c, 400, "invalid_payload", "message required");

    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await admin
      .from("app_errors")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("source", "client")
      .gte("created_at", hourAgo);
    if ((count ?? 0) >= 20) {
      return fail(c, 429, "rate_limited", "Too many error reports");
    }

    const { error } = await admin.from("app_errors").insert({
      source: "client",
      client: clientOf(c),
      route: sanitizeLabel(body.route),
      code: sanitizeLabel(body.code),
      message,
      stack: typeof body.stack === "string" && body.stack
        ? body.stack.slice(0, 4000)
        : null,
      app_version: sanitizeLabel(body.appVersion),
      user_id: userId,
      request_id: c.get("requestId") ?? null,
    });
    if (error) {
      return fail(c, 500, "report_failed", "Could not record the report");
    }
    return c.body(null, 204);
  });

  app.get("/jobs", async (c) => {
    const userId = c.get("userId");
    const idsParam = c.req.query("ids") ?? "";
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(
      0,
      20,
    );
    if (ids.length === 0) return c.json({ items: [] });

    // Read-only. Progress used to be produced by polling providers from inside
    // this request, which meant a closed tab stranded the job until a timeout
    // refunded it. The worker drives every job now; this only reports.
    const { data: freshJobs } = await admin
      .from("jobs")
      .select(
        "id,generation_id,progress,phase,claimed_at,created_at,queue_position",
      )
      .eq("user_id", userId)
      .in("generation_id", ids);
    const jobsByGen = new Map<string, JobRow>(
      (freshJobs ?? []).map((j) => [j.generation_id, j as JobRow]),
    );
    const { data: gens } = await admin.from("generations").select("*").eq(
      "user_id",
      userId,
    ).in("id", ids).is("deleted_at", null);
    return c.json({ items: await toGenerationDtos(gens ?? [], jobsByGen) });
  });

  app.post("/jobs/:id/cancel", async (c) => {
    const userId = c.get("userId") as string;
    const generationId = c.req.param("id");
    const { data: gen } = await admin
      .from("generations")
      .select("id,status,family_id,price_credits,kind")
      .eq("id", generationId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!gen) return fail(c, 404, "not_found", "Generation not found.");
    if (gen.status !== "pending") {
      return fail(c, 409, "not_pending", "Already finished.");
    }
    if (NOT_CANCELLABLE.has(gen.family_id)) {
      return fail(
        c,
        409,
        "not_cancellable",
        "This model can't be cancelled once started.",
      );
    }
    const { data: job } = await admin
      .from("jobs")
      .select("id,state,provider_ref,lease_token")
      .eq("generation_id", generationId)
      .is("error", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!job) return fail(c, 404, "not_found", "Job not found.");

    // Cancellation is a durable request, not an action. The worker owns the
    // provider conversation, and only a provider that confirms it stopped
    // earns a refund — the route cannot know that from here.
    const { error: markError } = await admin
      .from("jobs")
      .update({ cancel_requested_at: new Date().toISOString(), next_run_at: new Date().toISOString() })
      .eq("id", job.id);
    if (markError) {
      return fail(
        c,
        503,
        "cancel_failed",
        "Could not record your cancellation. Try again.",
      );
    }

    // Work that never left the building is different: nothing is running and
    // nothing is billing us, so it can be refunded here and now.
    const untouched = job.state === "ready" && !job.lease_token &&
      !job.provider_ref;
    if (!untouched) {
      return c.json({
        cancelling: true,
        refundedCredits: 0,
        credits: await creditsOf(userId),
      }, 202);
    }

    const settled = await settleFailed(admin, job.id, "cancelled");
    if (!settled.settled) {
      return c.json({
        cancelling: true,
        refundedCredits: 0,
        credits: await creditsOf(userId),
      }, 202);
    }
    return c.json({
      refundedCredits: settled.refunded,
      credits: await creditsOf(userId),
    });
  });

  interface VideoPrep {
    mode: VideoMode;
    referencePaths: string[];
    referenceUrls: string[];
    parentVideoUrl?: string;
    interactionId?: string;
  }

  /** Resolves the parent video for extend/edit modes (a no-op for modes that don't
   * need one). Guard clauses only — flattened out of `prepareVideo` so the
   * `rule.needsParent` check never wraps another `if`. */
  async function resolveParentVideo(
    userId: string,
    family: ModelFamily,
    parentId: string | null,
    needsParent: boolean,
  ): Promise<
    { parentVideoUrl?: string; interactionId?: string } | "bad_parent" | null
  > {
    if (!needsParent) return null;
    if (!parentId) return "bad_parent";
    const { data: parent } = await admin
      .from("generations")
      .select("id,kind,status,media_path,storage_backend,settings,family_id")
      .eq("id", parentId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    const usable = parent && parent.kind === MediaKind.Video &&
      parent.status === "done" && parent.media_path;
    if (!usable) return "bad_parent";
    // Veo can only continue its own clips — it takes the parent as inline media it
    // generated, not an arbitrary MP4.
    if (family.id === "veo" && parent.family_id !== "veo") return "bad_parent";
    const parentVideoUrl = await signStored(
      parent.storage_backend as StorageBackend,
      parent.media_path,
      REF_SIGN_TTL_S,
    );
    const parentInteraction = (parent.settings as GenerationSettings | null)
      ?.interactionId;
    const omniContinuation = family.id === "omni" &&
      parent.family_id === "omni" && !!parentInteraction;
    return {
      parentVideoUrl,
      interactionId: omniContinuation ? parentInteraction : undefined,
    };
  }

  /** Validates + prepares a video request. Returns a Response on rejection. */
  async function prepareVideo(
    c: Context,
    userId: string,
    family: ModelFamily,
    settings: GenerationSettings,
    body: Record<string, unknown>,
    parentId: string | null,
  ): Promise<VideoPrep | Response> {
    const mode = settings.mode ?? "t2v";
    if (!videoFamilySupports(family, mode)) {
      return fail(c, 400, "unsupported_mode", "This model can't do that mode.");
    }
    const rule = referenceRule(mode);
    const rawRefs = Array.isArray(body.referencePaths)
      ? body.referencePaths
      : [];
    const referencePaths = rawRefs.filter((p): p is string =>
      typeof p === "string" && UPLOAD_PATH.test(p)
    );
    if (
      referencePaths.length !== rawRefs.length ||
      referencePaths.length < rule.min || referencePaths.length > rule.max
    ) {
      return fail(
        c,
        400,
        "bad_reference_count",
        `${mode} needs ${rule.min}–${rule.max} reference image(s).`,
      );
    }
    for (const path of referencePaths) {
      const owned = await resolveOwnedUpload(admin, userId, path, "reference");
      if (typeof owned === "string") return referenceFailure(c, owned);
    }

    const prep: VideoPrep = { mode, referencePaths, referenceUrls: [] };

    const parentResult = await resolveParentVideo(
      userId,
      family,
      parentId,
      rule.needsParent,
    );
    if (parentResult === "bad_parent") {
      return fail(
        c,
        400,
        "bad_parent",
        "Pick a finished video to extend or edit.",
      );
    }
    if (parentResult) Object.assign(prep, parentResult);

    // Caps are NOT checked here any more. A select before the charge is a
    // suggestion, not a limit — four simultaneous submissions all passed it.
    // `fn_reserve_generation` enforces pending count and daily spend inside the
    // charging transaction.

    for (const path of referencePaths) {
      const { data: signed, error } = await admin.storage.from("uploads")
        .createSignedUrl(path, REF_SIGN_TTL_S);
      if (error || !signed) {
        return fail(
          c,
          400,
          "bad_reference_count",
          "Reference upload not found.",
        );
      }
      const decision = await moderate({ imageUrl: signed.signedUrl });
      if (decision.state === "unavailable") {
        return moderationFailure(c, decision);
      }
      if (decision.state === "blocked") {
        await recordStrike(userId, "upload", null, decision.categories, path);
        return fail(
          c,
          422,
          "content_policy",
          "A reference image was blocked by moderation.",
        );
      }
      prep.referenceUrls.push(signed.signedUrl);
    }
    return prep;
  }

  /** Guard-clause wrapper so the `kind === Video` branch never wraps another
   * `if` in the handler: non-video requests short-circuit to `null` here. */
  async function resolveVideoPrep(
    c: Context,
    userId: string,
    kind: string,
    familyId: string,
    settings: GenerationSettings,
    body: Record<string, unknown>,
    parentId: string | null,
  ): Promise<VideoPrep | Response | null> {
    if (kind !== MediaKind.Video) return null;
    const family = familyById(familyId)!;
    return prepareVideo(c, userId, family, settings, body, parentId);
  }

  /**
   * An option the catalog does not offer. From a client on an older catalog it
   * is not the client's bug — its picker is out of date — so it gets 409
   * catalog_stale and refreshes; everyone else gets the plain 400.
   */
  function optionRefusal(
    c: Context,
    sentCatalog: unknown,
    code: string,
    message: string,
  ): Response {
    if (isStaleCatalog(sentCatalog)) {
      return fail(c, 409, CATALOG_STALE.code, CATALOG_STALE.message);
    }
    return fail(c, 400, code, message);
  }

  /**
   * The price and the provider request as ONE object. They used to be derived
   * separately — the catalog priced by version and resolution while the adapter
   * hard-coded a model and a size — so a customer could pay the 4K price for a
   * 1K render. A combination the provider cannot render is a 400 here, never a
   * charge.
   */
  function priceRequest(
    c: Context,
    family: ModelFamily,
    op: string,
    settings: GenerationSettings,
    ctx: GenerationInput & { hasMask: boolean },
    sentCatalog: unknown,
  ): { normalized: NormalizedRequest; credits: number } | Response {
    try {
      const normalized = normalizeGenerationRequest(family, op, settings, ctx);
      return { normalized, credits: quote(normalized, family).credits };
    } catch {
      return optionRefusal(
        c,
        sentCatalog,
        "invalid_settings",
        `${family.name} cannot render that combination of options.`,
      );
    }
  }

  app.post("/generations", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return fail(c, 400, "invalid_payload", "JSON body required");
    return await submitGeneration(c, body);
  });

  /**
   * Rebuild the decision context for one generation.
   *
   * Everything `planRetry` needs, read once. `expressible` is the interesting
   * one: a price move is NOT a refusal (the retry is re-quoted and the
   * customer pays today's price), but a request that today's catalog can no
   * longer express — a withdrawn family, an option that no longer exists —
   * has no honest replay.
   */
  async function retryContextOf(
    userId: string,
    snapshotId: string | null,
  ): Promise<RetryContext> {
    const empty: RetryContext = {
      snapshot: null,
      liveUploadPaths: new Set<string>(),
      familyEnabled: false,
      entitled: false,
      expressible: false,
      personaUnavailable: false,
    };
    if (!snapshotId) return empty;

    const { data: row } = await admin.from("request_snapshots")
      .select("body").eq("id", snapshotId).eq("user_id", userId).maybeSingle();
    const snapshot = (row?.body ?? null) as GenerationRequestSnapshotV1 | null;
    if (!snapshot) return empty;

    const wanted = [...(snapshot.referenceUploadIds ?? [])];
    if (snapshot.maskUploadId) wanted.push(snapshot.maskUploadId);
    const live = new Set<string>();
    if (wanted.length) {
      const { data: uploads } = await admin.from("uploads")
        .select("path").eq("user_id", userId).in("path", wanted);
      for (const upload of uploads ?? []) live.add(upload.path as string);
    }

    // A persona run is gated by the persona kill switch, not its render family's.
    const gate = await modelGate(snapshot.personaId ? PERSONA_GEN.id : snapshot.familyId);
    const plan = await activePlan(userId);
    const persona = snapshot.personaId
      ? await readyPersona(admin, userId, snapshot.personaId)
      : null;
    const family = familyById(snapshot.familyId);
    // A fixed-price edit tool or the upscaler has no catalog family to
    // validate against; its options are the tool itself.
    const expressible = family
      ? validateSettings(family, snapshot.settings) === null
      : !!(editToolById(snapshot.familyId) || snapshot.familyId === UPSCALER.id ||
        snapshot.familyId === PERSONA_GEN.id);

    return {
      snapshot,
      liveUploadPaths: live,
      familyEnabled: gate.enabled,
      entitled: !(gate.minPlan === "pro" && plan === "studio"),
      expressible,
      personaUnavailable: persona === "unavailable",
    };
  }

  /** The generation, or a 404 — a stranger learns nothing either way. */
  async function ownedGeneration(
    c: Context,
    userId: string,
  ): Promise<{ id: string; snapshot_id: string | null } | Response> {
    const { data } = await admin.from("generations")
      .select("id,snapshot_id")
      .eq("id", c.req.param("id")).eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return fail(c, 404, "not_found", "Generation not found");
    return data as { id: string; snapshot_id: string | null };
  }

  function refuse(c: Context, decision: Extract<RetryDecision, { ok: false }>): Response {
    const status = REFUSAL_STATUS[decision.refusal] ?? 409;
    return fail(c, status, decision.refusal, REFUSAL_MESSAGE[decision.refusal]);
  }

  // Re-run what the customer actually asked for. The body is rebuilt here and
  // goes back through the normal submission path, so it is re-validated,
  // re-moderated, re-quoted at today's price and re-snapshotted.
  app.post("/generations/:id/retry", async (c) => {
    const userId = c.get("userId");
    const generation = await ownedGeneration(c, userId);
    if (generation instanceof Response) return generation;

    const decision = planRetry(await retryContextOf(userId, generation.snapshot_id));
    if (!decision.ok) return refuse(c, decision);
    return await submitGeneration(c, decision.body);
  });

  // Another take on the same prompt, hung off the original as its parent.
  app.post("/generations/:id/variation", async (c) => {
    const userId = c.get("userId");
    const generation = await ownedGeneration(c, userId);
    if (generation instanceof Response) return generation;

    const context = await retryContextOf(userId, generation.snapshot_id);
    const decision = planVariation(context, generation.id);
    if (!decision.ok) return refuse(c, decision);
    return await submitGeneration(c, decision.body);
  });

  // What the UI should enable. A disabled button with a reason is honest; a
  // button that always fails is not.
  app.get("/generations/:id/retryable", async (c) => {
    const userId = c.get("userId");
    const generation = await ownedGeneration(c, userId);
    if (generation instanceof Response) return generation;

    const context = await retryContextOf(userId, generation.snapshot_id);
    const retry = planRetry(context);
    const variation = planVariation(context, generation.id);
    const blocked = retry.ok ? null : retry.refusal;
    return c.json({
      retry: retry.ok,
      variation: variation.ok,
      reason: blocked ? REFUSAL_MESSAGE[blocked] : undefined,
    });
  });

  /**
   * One submission path, whether the request came from the composer or was
   * rebuilt by the server from a snapshot. Retry re-enters here so it gets the
   * same validation, entitlement checks, moderation, quote and snapshot — the
   * old client-side retry skipped all of it and guessed at the fields.
   */
  // deno-lint-ignore no-explicit-any
  async function submitGeneration(c: Context, body: any): Promise<Response> {
    const userId = c.get("userId");

    const op = body.op as string;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    let batch = Number.isInteger(body.batch) ? (body.batch as number) : 1;
    let settings = sanitizeSettings(body.settings);
    const parentId = typeof body.parentId === "string" && body.parentId
      ? body.parentId
      : null;
    const styleId = typeof body.style === "string" && body.style
      ? body.style
      : null;
    const personaId = typeof body.personaId === "string" && body.personaId
      ? body.personaId
      : null;
    const trendId = sanitizeLabel(body.trendId, 40);

    if (!Object.values(GenerationOp).includes(op as never)) {
      return fail(
        c,
        400,
        "invalid_op",
        `op must be one of ${Object.values(GenerationOp).join(", ")}`,
      );
    }
    if (!prompt) return fail(c, 400, "invalid_prompt", "Prompt required");
    if (prompt.length > MAX_PROMPT_LEN) {
      return fail(
        c,
        400,
        "invalid_prompt",
        `Prompt too long (max ${MAX_PROMPT_LEN} characters)`,
      );
    }
    if (batch < 1 || batch > 4) {
      return fail(c, 400, "invalid_batch", "batch must be 1–4");
    }
    if (styleId && !styleById(styleId)) {
      return fail(c, 400, "invalid_style", "Unknown style preset");
    }
    const styled = applyStyle(prompt, styleId);
    if (
      (op === GenerationOp.Edit || op === GenerationOp.Upscale) && !parentId
    ) {
      return fail(c, 400, "invalid_parent", `${op} requires parentId`);
    }

    // Suspension shield (2 strikes = out).
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }

    // Subscription gate: no active plan, no generation of any kind.
    const plan = await activePlan(userId);
    if (!plan) {
      return fail(
        c,
        403,
        "subscription_required",
        "An active subscription is required to generate.",
      );
    }

    // Persona: owned + ready, generate-op only. Rendered as Nano Banana Pro 4K
    // with the persona's five photos; the server resolves them, never the client.
    if (personaId && op !== GenerationOp.Generate) {
      return fail(c, 400, "invalid_op", "Personas support generate only");
    }
    // A persona run's references are its five photos; any other image would
    // be a sixth likeness nobody labelled.
    if (personaId && (parentId || body.referenceUploadId)) {
      return fail(
        c,
        400,
        "invalid_reference",
        "A persona uses its own photos. Remove the other reference image.",
      );
    }
    const found = personaId ? await readyPersona(admin, userId, personaId) : null;
    if (found instanceof Error) {
      logError(c, "persona_lookup_failed", found);
      return fail(c, 503, "persona_lookup_failed", "Could not read your persona. Try again.");
    }
    if (found === "unavailable") {
      return fail(c, 400, "persona_unavailable", "That persona is missing or unfinished.");
    }
    const persona = found;
    // The persona fixes version and size; only the ratio is the customer's,
    // and it must be one Nano Banana renders.
    if (persona) settings = personaSettings(String(settings.aspectRatio ?? "1:1"));
    const personaFamily = persona ? familyById("nano-banana") : undefined;
    const personaInvalid = personaFamily ? validateSettings(personaFamily, settings) : null;
    if (personaInvalid) {
      return optionRefusal(
        c,
        body.catalogVersion,
        "invalid_settings",
        `Personas do not offer ${personaInvalid.field} ${personaInvalid.value}.`,
      );
    }

    // The provider sees the persona instruction wrapped around the styled
    // prompt; moderation sees the customer's styled prompt (the wrapper is
    // ours) and the stored prompt stays the customer's own text.
    const effectivePrompt = persona ? personaPrompt(styled) : styled;

    let familyId: string;
    let familyName: string;
    let kind: string;
    let unitCredits: number;
    /** Set for catalog families; edit tools and the upscaler price separately. */
    let quoteFamily: ModelFamily | undefined;

    if (op === GenerationOp.Upscale) {
      familyId = UPSCALER.id;
      familyName = UPSCALER.name;
      kind = MediaKind.Image;
      unitCredits = upscaleCreditCost();
    } else if (persona) {
      familyId = PERSONA_GEN.id;
      familyName = PERSONA_GEN.name;
      kind = MediaKind.Image;
      // Priced as a persona, rendered as Nano Banana Pro: the quote family
      // builds the provider request, the persona price is the charge.
      quoteFamily = personaFamily;
      unitCredits = personaGenCreditCost();
    } else {
      const editTool = editToolById(String(body.familyId ?? ""));
      if (editTool) {
        // Studio panel AI tool — fixed credit price, edit op only.
        if (op !== GenerationOp.Edit) {
          return fail(c, 400, "invalid_op", "Edit tools use op=edit");
        }
        // A retry names a mask that is already stored; the composer sends
        // bytes. Either satisfies the requirement.
        const hasMask = typeof body.maskPngBase64 === "string" ||
          (typeof body.maskUploadId === "string" && !!body.maskUploadId);
        if (editTool.needsMask && !hasMask) {
          return fail(
            c,
            400,
            "invalid_payload",
            `${editTool.name} requires a mask`,
          );
        }
        familyId = editTool.id;
        familyName = editTool.name;
        kind = MediaKind.Image;
        unitCredits = editTool.creditCost; // fixed — no margin formula
      } else {
        const family = familyById(String(body.familyId ?? ""));
        if (!family) {
          return optionRefusal(c, body.catalogVersion, "invalid_family", "Unknown model family");
        }
        if (
          family.kind === MediaKind.Video && op !== GenerationOp.Generate &&
          op !== GenerationOp.Variation
        ) {
          return fail(
            c,
            400,
            "invalid_op",
            "Video supports generate/variation only",
          );
        }
        if (family.kind === MediaKind.Video && plan === "studio") {
          return fail(
            c,
            403,
            "pro_required",
            "Video models require the Pro plan.",
          );
        }
        // The catalog is the contract: an axis this family does not offer must
        // never reach creditCost(), which would fall through to a default price
        // and charge for a request the provider will clamp or reject.
        const invalid = validateSettings(family, settings);
        if (invalid) {
          return optionRefusal(
            c,
            body.catalogVersion,
            "invalid_settings",
            `${family.name} does not offer ${invalid.field} ${invalid.value}.`,
          );
        }
        familyId = family.id;
        familyName = family.name;
        kind = family.kind;
        quoteFamily = family;
        // Provisional: re-quoted from the normalized request below, once the
        // reference is resolved and `hasReference` is actually known.
        unitCredits = creditCost(family, settings);
      }
    }

    // Kill switch + per-model plan floor.
    const gate = await modelGate(familyId);
    if (!gate.enabled) {
      return fail(
        c,
        503,
        "model_disabled",
        "This model is temporarily unavailable.",
      );
    }
    if (gate.minPlan === "pro" && plan === "studio") {
      return fail(c, 403, "pro_required", "This model requires the Pro plan.");
    }

    // Moderation gate — BEFORE charge and BEFORE any provider call. An outage
    // refuses the request; it never silently lets an unchecked prompt through.
    const promptDecision = await moderate({ text: styled });
    if (promptDecision.state === "unavailable") {
      return moderationFailure(c, promptDecision);
    }
    if (promptDecision.state === "blocked") {
      await recordStrike(userId, "prompt", prompt, promptDecision.categories);
      return fail(
        c,
        422,
        "content_policy",
        "This prompt violates our content policy.",
      );
    }

    const videoResult = await resolveVideoPrep(
      c,
      userId,
      kind,
      familyId,
      settings,
      body as Record<string, unknown>,
      parentId,
    );
    if (videoResult instanceof Response) return videoResult;
    const video = videoResult;
    if (video) batch = 1;

    // Resolve reference (parent generation or uploaded image) to a signed URL.
    // An UPLOADED reference travels with op=generate + referenceUploadId; a
    // LIBRARY parent travels with op=edit + parentId. Both end up as
    // SubmitCtx.referenceUrl.
    const referenceUploadId = typeof body.referenceUploadId === "string"
      ? body.referenceUploadId
      : null;
    if (video && referenceUploadId) {
      return optionRefusal(
        c,
        body.catalogVersion,
        "reference_unsupported",
        "Use the video reference slots for this model.",
      );
    }
    if (parentId && referenceUploadId) {
      return fail(c, 400, "invalid_reference", "Choose one reference source.");
    }
    const referenceFamily = familyById(familyId);
    if (referenceUploadId && !referenceFamily?.capabilities.imageInput) {
      return optionRefusal(
        c,
        body.catalogVersion,
        "reference_unsupported",
        "This model does not take a reference image.",
      );
    }

    async function uploadReferenceUrl(
      uploadId: string,
    ): Promise<string | Response> {
      const owned = await resolveOwnedUpload(
        admin,
        userId,
        uploadId,
        "reference",
      );
      if (typeof owned === "string") return referenceFailure(c, owned);
      const { data: signed, error } = await admin.storage.from("uploads")
        .createSignedUrl(owned.path, REF_SIGN_TTL_S);
      if (error || !signed?.signedUrl) {
        return fail(
          c,
          503,
          "reference_unavailable",
          "Could not read your reference image — try again.",
        );
      }
      return signed.signedUrl;
    }

    async function imageParentUrl(
      parentId: string,
      userId: string,
    ): Promise<string | Response> {
      const { data: parent, error } = await admin.from("generations")
        .select("id,kind,status,media_path,storage_backend")
        .eq("id", parentId).eq("user_id", userId).is("deleted_at", null)
        .maybeSingle();
      if (error) {
        return fail(
          c,
          503,
          "reference_unavailable",
          "Could not read your image. Try again.",
        );
      }
      if (!parent) {
        return fail(c, 404, "not_found", "Parent generation not found");
      }
      if (parent.kind !== MediaKind.Image) {
        return fail(c, 400, "invalid_parent", "Pick an image to edit.");
      }
      if (parent.status !== "done" || !parent.media_path) {
        return fail(c, 400, "parent_not_ready", "That image is not ready.");
      }
      // Goes through signMedia, so in staging this is a browser URL. It is only
      // tested for presence below; a provider gets its own signed URL in payload.ts.
      return signStored(parent.storage_backend, parent.media_path);
    }

    const parentReference = parentId && !video
      ? await imageParentUrl(parentId, userId)
      : undefined;
    if (parentReference instanceof Response) return parentReference;
    const uploadReference = referenceUploadId
      ? await uploadReferenceUrl(referenceUploadId)
      : undefined;
    if (uploadReference instanceof Response) return uploadReference;
    const referenceUrl = parentReference ?? uploadReference;

    const priced = quoteFamily
      ? priceRequest(c, quoteFamily, op, settings, {
        hasReference: !!referenceUrl || !!persona,
        referenceCount: persona ? persona.paths.length : (referenceUrl ? 1 : 0),
        hasMask: typeof body.maskPngBase64 === "string" ||
          (typeof body.maskUploadId === "string" && !!body.maskUploadId),
      }, body.catalogVersion)
      : null;
    if (priced instanceof Response) return priced;
    const normalized = priced?.normalized;
    if (priced && !persona) unitCredits = priced.credits;

    const ledgerType = op === GenerationOp.Variation
      ? LedgerType.Generate
      : (op as LedgerType);

    if (styleId) settings.style = styleId;
    if (personaId && persona) settings.persona = personaId;
    if (trendId) settings.trend = trendId;

    // The versions travel with the row so a later reader can tell which catalog
    // and which pricing rule produced this charge.
    const storedSettings = normalized
      ? {
        ...settings,
        quoteVersion: normalized.quoteVersion,
        catalogVersion: normalized.catalogVersion,
      }
      : settings;

    // A mask is stored like any other input, with an owner and a moderation
    // record. Carrying base64 in the job payload would be an unbounded row
    // nothing owns.
    // A retry names a mask that is already stored and owned; the composer
    // sends fresh bytes. Both end up as an upload path.
    const maskUploadId = typeof body.maskUploadId === "string" && body.maskUploadId
      ? await existingMask(c, userId, body.maskUploadId)
      : await storeMask(c, userId, body.maskPngBase64);
    if (maskUploadId instanceof Response) return maskUploadId;

    const sid = await safetyId(userId);
    const payload: StoredPayload = {
      familyId,
      op,
      prompt: effectivePrompt,
      settings: { ...settings },
      providerModel: normalized?.providerModel ?? familyId,
      providerSettings: normalized?.providerSettings ?? {},
      quoteVersion: normalized?.quoteVersion ?? 0,
      catalogVersion: normalized?.catalogVersion ?? "",
      safetyId: sid,
      referenceUploadId: referenceUploadId ?? undefined,
      parentId: parentId ?? undefined,
      maskUploadId: maskUploadId ?? undefined,
      referenceSlots: video ? slotsOf(video) : undefined,
      personaId: personaId ?? undefined,
      styleId: styleId ?? undefined,
      trendId: trendId ?? undefined,
      mode: video?.mode,
    };

    // The request, recorded once, by owned identity. This is the only thing a
    // retry weeks from now has to work from, so it is built from the resolved
    // identities rather than from the client's body.
    // A persona run is stored and priced under the pseudo-family 'persona',
    // which is not a model. The snapshot records the family it renders on —
    // the one whose settings it stores, so /retryable validates against the
    // right catalog entry — and the persona id, which is what sends a retry
    // back through the persona branch.
    const snapshotFamilyId = persona && quoteFamily ? quoteFamily.id : familyId;

    const snapshot = captureSnapshot({
      // Checked against GenerationOp at the top of this route.
      op: op as GenerationOp,
      familyId: snapshotFamilyId,
      prompt,
      settings,
      referenceUploadIds: video
        ? [...video.referencePaths]
        : (referenceUploadId ? [referenceUploadId] : []),
      referenceSlots: {
        first: video?.mode === "keyframes" ? (video.referencePaths[0] ?? null) : null,
        last: video?.mode === "keyframes" ? (video.referencePaths[1] ?? null) : null,
        references: video && video.mode !== "keyframes" ? [...video.referencePaths] : [],
      },
      maskUploadId: maskUploadId ?? null,
      personaId: personaId ?? null,
      styleId: styleId ?? null,
      trendId: trendId ?? null,
      mode: video?.mode ?? null,
      parentId: parentId ?? null,
      catalogVersion: normalized?.catalogVersion ?? CATALOG_VERSION,
      quoteVersion: normalized?.quoteVersion ?? 0,
    });

    const items = Array.from({ length: batch }, () => ({
      kind,
      familyId,
      familyName,
      op,
      prompt,
      settings: storedSettings,
      priceCredits: unitCredits,
      mediaUrl: "", // filled when the provider job completes
      parentId,
      client: clientOf(c) ?? "",
    }));

    // One transaction decides everything: the caps, the charge, the generation
    // rows, their jobs and the provider expense. A crash anywhere takes the
    // charge with it — the old two-step left charged generations with no job,
    // which the stale sweep could never find.
    const reservation = await admin.rpc("fn_reserve_generation", {
      p_user: userId,
      p_key: readIdempotencyKey(c) ?? crypto.randomUUID(),
      p_hash: await bodyHash(body),
      p_items: items,
      p_quote: {
        provider: adapterFor(familyId).provider,
        chargeType: ledgerType,
        unitCredits,
        unitProviderCostUsd: providerCostUsd(familyId, quoteFamily, settings),
        catalogVersion: normalized?.catalogVersion ?? "",
        quoteVersion: normalized?.quoteVersion ?? 0,
      },
      // The snapshot rides beside the payload and is written by the RPC, in
      // the same transaction as the charge. The client never names its id.
      p_payload: { ...payload, snapshot },
    });
    if (reservation.error) {
      return await reservationFailure(c, userId, reservation.error.message);
    }

    const generationIds = ((reservation.data ?? {}) as {
      generationIds?: string[];
    }).generationIds ?? [];
    const { data: createdRows } = await admin
      .from("generations")
      .select("*")
      .in("id", generationIds);
    // 202: accepted, not finished. The worker executes it whether or not this
    // client is still here to watch.
    return c.json({
      items: await toGenerationDtos(createdRows ?? []),
      credits: await creditsOf(userId),
    }, 202);
  }

  /**
   * Persist an edit mask as an owned upload and return its path.
   *
   * It arrives as base64 in the request because that is what the editor has,
   * but it must not travel in the job payload: the worker dispatches hours
   * later, and an unbounded blob with no owner and no moderation record is not
   * something to keep in a row.
   */
  async function storeMask(
    c: Context,
    userId: string,
    raw: unknown,
  ): Promise<string | null | Response> {
    if (typeof raw !== "string" || raw.length === 0) return null;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
    } catch {
      return fail(c, 400, "invalid_payload", "Mask must be base64 PNG");
    }
    if (sniffImage(bytes) !== "png") {
      return fail(c, 400, "invalid_payload", "Mask must be a PNG");
    }
    const path = `${userId}/${crypto.randomUUID()}.png`;
    const objectId = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.upload,
      path,
      purpose: "upload",
    }).catch((e) => {
      logError(c, "mask_register_failed", e);
      return null;
    });
    if (!objectId) {
      return fail(c, 503, "mask_unavailable", "Could not store your mask.");
    }
    const { error: upErr } = await admin.storage.from("uploads").upload(
      path,
      bytes,
      { contentType: "image/png" },
    );
    if (upErr) {
      return fail(c, 503, "mask_unavailable", "Could not store your mask.");
    }
    await markObjectLive(admin, objectId);
    // A mask is a shape, not a picture of anything — it is moderated by the
    // image it is applied to, so it is registered as allowed on arrival.
    const { error: regErr } = await admin.from("uploads").insert({
      user_id: userId,
      path,
      purpose: "mask",
      mime: "image/png",
      bytes: bytes.byteLength,
      width: 0,
      height: 0,
      moderation: "allowed",
    });
    if (regErr) {
      await removeTracked(c, userId, "upload", path, "mask_register_failed");
      return fail(c, 503, "mask_unavailable", "Could not store your mask.");
    }
    return path;
  }

  /**
   * A mask this user already owns, for a retry. Re-verified rather than
   * trusted: the path arrives from a snapshot, but a snapshot is data and the
   * upload behind it may have been deleted or may never have been theirs.
   */
  async function existingMask(
    c: Context,
    userId: string,
    path: string,
  ): Promise<string | Response> {
    const { data } = await admin.from("uploads")
      .select("path")
      .eq("user_id", userId).eq("path", path).eq("purpose", "mask")
      .maybeSingle();
    if (!data) {
      return fail(
        c,
        409,
        "reference_unavailable",
        REFUSAL_MESSAGE.reference_unavailable,
      );
    }
    return data.path as string;
  }

  /** Video reference slots, keeping first/last positional order. */
  function slotsOf(video: VideoPrep): StoredPayload["referenceSlots"] {
    if (video.mode === "keyframes") {
      return { first: video.referencePaths[0], last: video.referencePaths[1] };
    }
    return { references: [...video.referencePaths] };
  }

  /**
   * What this run is expected to cost US, for the budget. The catalog knows it
   * for its own families; the fixed-price tools are priced backwards from their
   * retail credits, which is an estimate and is labelled as one.
   */
  function providerCostUsd(
    familyId: string,
    family: ModelFamily | undefined,
    settings: GenerationSettings,
  ): number {
    // Before the catalog family: a persona run carries Nano Banana as its
    // quote family, but its cost includes the five photos and the premium settings.
    if (familyId === PERSONA_GEN.id) return personaProviderCost();
    if (family) return family.providerCost(settings);
    if (familyId === UPSCALER.id) return UPSCALER.providerCost;
    const tool = editToolById(familyId);
    if (tool) return (tool.creditCost / 100) * (1 - STUDIO_MARGIN);
    return 0;
  }

  /** The reservation raises plain codes; each one has a customer-facing answer. */
  async function reservationFailure(
    c: Context,
    userId: string,
    message: string,
  ): Promise<Response> {
    if (message.includes("idempotency_conflict")) {
      return fail(
        c,
        409,
        "idempotency_conflict",
        "That request id was already used for a different request.",
      );
    }
    if (message.includes("insufficient_balance")) {
      return fail(
        c,
        402,
        "insufficient_credits",
        "Not enough credits for this run",
      );
    }
    if (message.includes("too_many_jobs")) {
      return fail(
        c,
        429,
        "too_many_jobs",
        "3 videos are still rendering — wait for one to finish",
      );
    }
    if (message.includes("daily_cap")) {
      const { data: resetsAt } = await admin.rpc("fn_spend_resets_at", {
        p_user: userId,
      });
      return c.json({
        error: {
          code: "daily_cap",
          message: "Daily video limit reached.",
          resetsAt: resetsAt ?? null,
        },
      }, 429);
    }
    logError(c, "reservation_failed", new Error(message));
    return fail(c, 400, "charge_failed", "Charge could not be completed");
  }

  app.post("/billing/subscribe", async (c) => {
    const laneBlocked = requireWebLane(c);
    if (laneBlocked) return laneBlocked;
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const plan = body.plan === "pro"
      ? "pro"
      : body.plan === "studio"
      ? "studio"
      : null;
    if (!plan) {
      return fail(c, 400, "invalid_plan", "plan must be studio or pro");
    }
    const { data: ownSub } = await admin
      .from("subscriptions")
      .select("plan, status, stripe_subscription_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (ownSub?.plan === "owner" && ownSub.status === "active") {
      return fail(
        c,
        400,
        "owner_plan",
        "Owner accounts have unlimited credits",
      );
    }
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      // Ask Stripe, not our mirror. The `subscriptions` table is written only by the
      // webhook, so it lags (or, if the webhook failed, never arrives) and it holds one
      // row per user — a second subscription would overwrite the first and bill twice
      // with nothing to show for it. Stripe Checkout does not dedupe subscriptions
      // itself, so this is the only thing standing between a double click and a
      // double charge.
      const history = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      // "Billing" is wider than our 'active': past_due/unpaid are still in dunning, and
      // a cancel_at_period_end sub is plain `active` here — it charges until it lapses.
      const billing = history.data.filter((s) =>
        s.status === "active" || s.status === "trialing" ||
        s.status === "past_due" || s.status === "unpaid"
      );
      if (billing.length > 0) {
        return fail(
          c,
          400,
          "already_subscribed",
          "Use the billing portal to change plans",
        );
      }
      // Launch promo: first-time subscribers only. Keyed off Stripe's full history
      // rather than the mirror, so a missing row cannot hand out the coupon twice.
      const firstTime = history.data.length === 0;
      const returns = checkoutReturnUrls(c, body);
      const session = await stripe.checkout.sessions.create({
        customer,
        mode: "subscription",
        line_items: [{ price: PLAN_PRICE_IDS[plan]!, quantity: 1 }],
        discounts: firstTime && LAUNCH_COUPON_ID
          ? [{ coupon: LAUNCH_COUPON_ID }]
          : undefined,
        success_url: returns.success,
        cancel_url: returns.cancel,
        metadata: { user_id: userId, plan },
        subscription_data: { metadata: { user_id: userId, plan } },
      });
      return c.json({ url: session.url });
    } catch (e) {
      logError(c, "subscribe_failed", e);
      return fail(c, 400, "billing_failed", "Could not start checkout");
    }
  });

  app.post("/billing/pack", async (c) => {
    const laneBlocked = requireWebLane(c);
    if (laneBlocked) return laneBlocked;
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const usd = Number(body.usd);
    const plan = await activePlan(userId);
    if (!plan) {
      return fail(
        c,
        403,
        "subscription_required",
        "Packs are for active subscribers.",
      );
    }
    if (plan === "owner") {
      return fail(
        c,
        400,
        "owner_plan",
        "Owner accounts have unlimited credits",
      );
    }
    if (!CREDIT_PACKS.some((p) => p.usd === usd)) {
      return fail(
        c,
        400,
        "invalid_amount",
        `usd must be one of ${CREDIT_PACKS.map((p) => p.usd).join(", ")}`,
      );
    }
    const credits = packCredits(usd, plan);
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const returns = checkoutReturnUrls(c, body);
      const session = await stripe.checkout.sessions.create({
        customer,
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: `Vansen credit pack — ${credits.toLocaleString()} credits`,
            },
            unit_amount: usd * 100,
          },
          quantity: 1,
        }],
        success_url: returns.success,
        cancel_url: returns.cancel,
        metadata: {
          user_id: userId,
          pack_usd: String(usd),
          // The rate in force at purchase time. The webhook recomputes the
          // grant from (pack_usd, pack_plan) through the catalog; pack_credits
          // is display/audit only and is never consumed as a grant.
          pack_plan: plan,
          pack_credits: String(credits),
        },
      });
      return c.json({ url: session.url });
    } catch (e) {
      logError(c, "pack_failed", e);
      return fail(c, 400, "billing_failed", "Could not start checkout");
    }
  });

  /**
   * Studio <-> Pro. Swaps the price on the EXISTING subscription rather than
   * cancelling and re-creating: one subscription per customer is what keeps the
   * double-billing guard in /billing/subscribe meaningful.
   *
   * when='now' restarts the billing cycle today (unused time on the old plan is
   * prorated back), so invoice.paid fires and fn_apply_fulfillment lands the new
   * grant (p_never_lower, so an upgrade tops the bucket up rather than cutting it).
   * when='period_end' books a Stripe Subscription Schedule; the swap happens at
   * renewal and that cycle's invoice.paid carries the new grant.
   *
   * Downgrades are period_end only, and that is enforced HERE rather than in the
   * dialog: an immediate downgrade makes fn_apply_fulfillment compute a negative
   * delta (1500 - 3000 = -1500) and silently delete credits the user paid Pro
   * prices for. p_never_lower guards the upgrade direction, not this one.
   */
  app.post("/billing/change-plan", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const plan = body.plan === "pro"
      ? "pro"
      : body.plan === "studio"
      ? "studio"
      : null;
    const when = body.when === "now"
      ? "now"
      : body.when === "period_end"
      ? "period_end"
      : null;
    if (!plan) {
      return fail(c, 400, "invalid_plan", "plan must be studio or pro");
    }
    if (!when) {
      return fail(c, 400, "invalid_when", "when must be now or period_end");
    }

    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const list = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      const sub = list.data.find(
        (s) =>
          s.status === "active" || s.status === "trialing" ||
          s.status === "past_due",
      );
      if (!sub) {
        return fail(
          c,
          400,
          "no_subscription",
          "Start a subscription before changing plans",
        );
      }

      const currentPlan = sub.items.data[0]?.price?.id === PLAN_PRICE_IDS.pro
        ? "pro"
        : "studio";
      if (currentPlan === plan) {
        return fail(c, 400, "same_plan", `You are already on ${plan}`);
      }
      const downgrade = currentPlan === "pro" && plan === "studio";
      if (downgrade && when === "now") {
        return fail(
          c,
          400,
          "downgrade_at_period_end",
          "Downgrades take effect at your renewal date",
        );
      }
      // A schedule cannot ride on a subscription that is already set to stop.
      if (sub.cancel_at_period_end && when === "period_end") {
        return fail(
          c,
          400,
          "subscription_ending",
          "Resume your subscription in Billing before scheduling a change",
        );
      }

      const scheduleId = typeof sub.schedule === "string"
        ? sub.schedule
        : (sub.schedule?.id ?? null);
      if (scheduleId && when === "period_end") {
        return fail(
          c,
          400,
          "already_scheduled",
          "A plan change is already scheduled for your renewal",
        );
      }

      const itemId = sub.items.data[0]!.id;
      if (when === "now") {
        // "Start now" overrides a change booked earlier: a schedule-managed
        // subscription rejects direct updates, so hand it back to normal billing
        // before swapping the price.
        if (scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
        const updated = await stripe.subscriptions.update(sub.id, {
          items: [{ id: itemId, price: PLAN_PRICE_IDS[plan]! }],
          proration_behavior: "create_prorations",
          billing_cycle_anchor: "now",
          cancel_at_period_end: false,
          metadata: { user_id: userId, plan },
        });
        // Mirror the swap synchronously: the workspace reloads /profile the moment
        // this returns, and waiting for the webhook leaves it showing the old plan
        // (and its subscribe CTA) until a manual refresh. Credits still land via
        // invoice.paid — only the plan/status mirror is written here.
        const periodEndEpoch =
          (updated as { current_period_end?: number }).current_period_end ??
            (updated.items?.data?.[0] as
              | { current_period_end?: number }
              | undefined)
              ?.current_period_end;
        await admin
          .from("subscriptions")
          .update({
            plan,
            status: "active",
            stripe_subscription_id: updated.id,
            ...(periodEndEpoch
              ? {
                current_period_end: new Date(periodEndEpoch * 1000)
                  .toISOString(),
              }
              : {}),
            pending_plan: null,
            pending_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
        return c.json({ plan, effectiveAt: null });
      }

      const schedule = await stripe.subscriptionSchedules.create({
        from_subscription: sub.id,
      });
      const current = schedule.phases[0]!;
      await stripe.subscriptionSchedules.update(schedule.id, {
        // release hands the subscription back to normal billing once the new phase
        // starts; without it the schedule would cancel the sub when it runs out.
        end_behavior: "release",
        phases: [
          {
            items: [{ price: PLAN_PRICE_IDS[currentPlan]!, quantity: 1 }],
            start_date: current.start_date,
            end_date: current.end_date,
          },
          {
            items: [{ price: PLAN_PRICE_IDS[plan]!, quantity: 1 }],
            metadata: { user_id: userId, plan },
          },
        ],
        metadata: { user_id: userId, plan },
      });
      const effectiveAt = new Date(current.end_date * 1000).toISOString();
      await admin
        .from("subscriptions")
        .update({ pending_plan: plan, pending_at: effectiveAt })
        .eq("user_id", userId);
      return c.json({ plan, effectiveAt });
    } catch (e) {
      logError(c, "change_plan_failed", e);
      return fail(c, 400, "billing_failed", "Could not change your plan");
    }
  });

  app.get("/billing/lane", (c) => {
    // An unrecognised platform must not read as Android (lane A) — that would
    // open Stripe checkout to any caller that omits or misspells the value.
    const raw = c.req.query("platform");
    const platform = raw === "android" ? "android" : "ios";
    const storefront = (c.req.query("storefront") ?? "").toUpperCase();
    const laneBEnabled = Deno.env.get("LANE_B") === "on";
    return c.json({ lane: laneFor(platform, storefront, laneBEnabled) });
  });

  /**
   * One call for everything the Subscription tab shows beyond our own mirror:
   * next invoice, card on file, and whether the sub is set to stop. All read
   * straight from Stripe — the mirror only knows plan/status/period-end.
   */
  app.get("/billing/overview", async (c) => {
    const userId = c.get("userId");
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const list = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
        expand: ["data.default_payment_method"],
      });
      const sub = list.data.find(
        (s) =>
          s.status === "active" || s.status === "trialing" ||
          s.status === "past_due",
      );
      if (!sub) {
        return c.json({
          cancelAtPeriodEnd: false,
          upcoming: null,
          paymentMethod: null,
        });
      }

      let upcoming: { amountUsd: number; date: string | null } | null = null;
      if (!sub.cancel_at_period_end) {
        try {
          const invoice = await stripe.invoices.retrieveUpcoming({ customer });
          const epoch = invoice.next_payment_attempt ?? invoice.period_end ??
            null;
          upcoming = {
            amountUsd: Math.round(invoice.amount_due) / 100,
            date: epoch ? new Date(epoch * 1000).toISOString() : null,
          };
        } catch {
          // No upcoming invoice is a normal state, not an error.
        }
      }

      const pm = sub.default_payment_method;
      const card = pm && typeof pm !== "string" ? pm.card : null;
      return c.json({
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        upcoming,
        paymentMethod: card ? { brand: card.brand, last4: card.last4 } : null,
      });
    } catch (e) {
      logError(c, "overview_failed", e);
      return fail(c, 400, "billing_failed", "Could not load billing details");
    }
  });

  /**
   * In-app cancellation (at period end, never immediate — the user keeps what
   * they paid for). The reason is required by the UI and stored on the Stripe
   * subscription's metadata, where the dashboard shows it next to the churn.
   */
  app.post("/billing/cancel", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const reason = typeof body.reason === "string"
      ? body.reason.slice(0, 120)
      : "";
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const list = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      const sub = list.data.find(
        (s) =>
          s.status === "active" || s.status === "trialing" ||
          s.status === "past_due",
      );
      if (!sub) {
        return fail(
          c,
          400,
          "no_subscription",
          "No active subscription to cancel",
        );
      }
      if (sub.cancel_at_period_end) return c.json({ cancelAtPeriodEnd: true });

      // A schedule-managed sub rejects direct updates; a booked plan change dies
      // with the cancellation anyway, so release it (and its reminder) first.
      const scheduleId = typeof sub.schedule === "string"
        ? sub.schedule
        : (sub.schedule?.id ?? null);
      if (scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
      await stripe.subscriptions.update(sub.id, {
        cancel_at_period_end: true,
        metadata: { ...sub.metadata, cancel_reason: reason },
      });
      await admin
        .from("subscriptions")
        .update({
          status: "canceled",
          cancel_reason: reason || null,
          pending_plan: null,
          pending_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      return c.json({ cancelAtPeriodEnd: true });
    } catch (e) {
      logError(c, "cancel_failed", e);
      return fail(
        c,
        400,
        "billing_failed",
        "Could not cancel your subscription",
      );
    }
  });

  /** Undo a pending cancellation — billing continues as if nothing happened. */
  app.post("/billing/resume", async (c) => {
    const userId = c.get("userId");
    try {
      const customer = await stripeCustomerFor(userId, c.get("email"));
      const list = await stripe.subscriptions.list({
        customer,
        status: "all",
        limit: 100,
      });
      const sub = list.data.find(
        (s) =>
          s.status === "active" || s.status === "trialing" ||
          s.status === "past_due",
      );
      if (!sub) {
        return fail(c, 400, "no_subscription", "No subscription to resume");
      }
      if (sub.cancel_at_period_end) {
        await stripe.subscriptions.update(sub.id, {
          cancel_at_period_end: false,
        });
      }
      await admin
        .from("subscriptions")
        .update({
          status: "active",
          cancel_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      return c.json({ cancelAtPeriodEnd: false });
    } catch (e) {
      logError(c, "resume_failed", e);
      return fail(
        c,
        400,
        "billing_failed",
        "Could not resume your subscription",
      );
    }
  });

  app.post("/billing/portal", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const customer = await stripeCustomerFor(c.get("userId"), c.get("email"));
      const returnUrl = body.platform === "mobile"
        ? "vansen://billing-return?status=portal"
        : `${appOrigin(c)}/app/settings`;
      const portal = await stripe.billingPortal.sessions.create({
        customer,
        return_url: returnUrl,
      });
      return c.json({ url: portal.url });
    } catch (e) {
      logError(c, "portal_failed", e);
      return fail(c, 400, "billing_failed", "Could not open billing portal");
    }
  });

  /**
   * Reconcile fallback for a dropped `checkout.session.completed`: re-read the
   * caller's own paid sessions and settle any pack the webhook never landed.
   *
   * Two rules make this safe to call at any time. The grant is recomputed from
   * the catalog — the dollar size and the plan in force at purchase — so a
   * number written on the session is never paid out. And it settles through the
   * same `fn_apply_fulfillment` transaction as the webhook, keyed on the same
   * session id, so whichever path arrives second sees a replay instead of
   * granting the money twice.
   */
  app.post("/billing/reconcile", async (c) => {
    const userId = c.get("userId");
    try {
      const { data: profile } = await admin
        .from("profiles")
        .select("stripe_customer_id")
        .eq("id", userId)
        .single();
      if (!profile?.stripe_customer_id) {
        return c.json({ credited: 0, credits: await creditsOf(userId) });
      }
      const sessions = await stripe.checkout.sessions.list({
        customer: profile.stripe_customer_id,
        limit: 100,
      });
      let credited = 0;
      for (const s of sessions.data) {
        if (s.payment_status !== "paid") continue;
        const credits = catalogPackCredits(s.metadata);
        if (!credits) continue;
        const result = await applyFulfillment(admin, {
          source: "stripe",
          businessTxnId: String(s.id),
          userId,
          kind: "pack_grant",
          credits,
          eventAt: new Date((s.created ?? 0) * 1000).toISOString(),
        });
        if (result.applied) credited += 1;
      }
      return c.json({ credited, credits: await creditsOf(userId) });
    } catch (e) {
      logError(c, "reconcile_failed", e);
      return fail(c, 400, "billing_failed", "Reconcile failed");
    }
  });

  // Reconcile fallback for a dropped App Store notification: the client submits
  // its own purchase JWS for server-side re-validation. The appAccountToken baked
  // into the transaction must be the caller — nobody redeems another user's
  // receipt. Grants are idempotent (iaptx marker + stripe_ref UNIQUE), so calling
  // this after every purchase is safe and doubles as the instant-grant path.
  app.post("/iap/verify", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => ({}));
    const jws = typeof body.jws === "string" ? body.jws : "";
    if (!jws) return fail(c, 400, "invalid_input", "Missing jws");
    try {
      const tx = await appleVerifier().verifyAndDecodeTransaction(jws);
      if (tx.appAccountToken !== userId) {
        return fail(c, 403, "forbidden", "Receipt belongs to another account");
      }
      const result = await applyIapTransaction(admin, userId, {
        productId: tx.productId ?? "",
        transactionId: tx.transactionId ?? "",
        originalTransactionId: tx.originalTransactionId ?? "",
        expiresDate: tx.expiresDate,
        revocationDate: tx.revocationDate,
      });
      // The client must be able to tell "your credits are here" from "try again
      // in a moment" — a retryable failure that reads as success strands paid
      // money, and one that reads as a hard error sends the user to support.
      if (result.outcome === "rejected") {
        return fail(
          c,
          422,
          "purchase_rejected",
          "This purchase cannot be applied to this account.",
        );
      }
      return c.json({
        // `granted` is kept for one release so an un-updated mobile build is
        // not broken; MT-01 moves the client to `outcome`.
        granted: true,
        outcome: result.outcome,
        credits: result.credits ?? await creditsOf(userId),
      });
    } catch (e) {
      logError(c, "iap_verify_failed", e);
      const res = fail(
        c,
        503,
        "retry_later",
        "We could not confirm your purchase yet. It is safe to try again.",
      );
      res.headers.set("retry-after", "10");
      return res;
    }
  });

  app.post("/uploads", async (c) => {
    const userId = c.get("userId");
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return fail(c, 400, "upload_failed", "No file provided");
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      return fail(c, 400, "upload_failed", "File exceeds 10MB");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = sniffImage(bytes);
    if (!ext) {
      return fail(
        c,
        400,
        "upload_failed",
        "Only PNG, JPEG, or WEBP images are allowed",
      );
    }

    const dims = imageSize(bytes);
    if (!dims) {
      return fail(c, 400, "upload_failed", "Could not read the image dimensions");
    }
    if (dims.width * dims.height > UPLOAD_MAX_PIXELS) {
      return fail(
        c,
        400,
        "upload_too_large",
        "Image is too large — keep it under 50 megapixels",
      );
    }
    // The web client sends a 2048px JPEG at 0.92, typically 0.5–2 MB.
    if (form?.get("purpose") === "persona-photo" && file.size > PERSONA_MAX_BYTES) {
      return fail(c, 400, "photo_too_large", "Use a smaller photo — at most 2.5 MB.");
    }
    const tooSmallForPersona = form?.get("purpose") === "persona-photo" &&
      Math.min(dims.width, dims.height) < PERSONA_MIN_EDGE;
    if (tooSmallForPersona) {
      return fail(c, 400, "photo_too_small",
        `Use a sharper photo — at least ${PERSONA_MIN_EDGE}px on its short edge.`);
    }

    const purpose = form?.get("purpose") === "persona-photo"
      ? "persona-photo"
      : "reference";
    const mime = `image/${ext === "jpg" ? "jpeg" : ext}`;
    const path = `${userId}/${crypto.randomUUID()}.${ext}`;
    // The locator is recorded BEFORE the bytes exist. An upload whose response
    // we never see still leaves something deletion can find.
    const objectId = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.upload,
      path,
      purpose: purpose === "persona-photo" ? "persona-photo" : "upload",
    }).catch((e) => {
      logError(c, "upload_register_failed", e);
      return null;
    });
    if (!objectId) {
      return fail(c, 500, "upload_failed", "Could not record the upload");
    }
    const { error: upErr } = await admin.storage.from("uploads").upload(
      path,
      bytes,
      { contentType: mime },
    );
    if (upErr) {
      return fail(c, 400, "upload_failed", "Storage rejected the file");
    }
    await markObjectLive(admin, objectId);

    // Registry row first, as `pending`: an upload that never reaches `allowed`
    // can never be referenced, and deletion (P6/T08) still has its path.
    const { data: registered, error: regErr } = await admin
      .from("uploads")
      .insert({
        user_id: userId,
        path,
        purpose,
        mime,
        bytes: file.size,
        width: dims.width,
        height: dims.height,
        moderation: "pending",
      })
      .select("id")
      .single();
    if (regErr || !registered) {
      await admin.storage.from("uploads").remove([path]);
      logError(c, "upload_register_failed", new Error(regErr?.message ?? "no row"));
      return fail(c, 500, "upload_failed", "Could not record the upload");
    }

    // Moderate the image before it can be used as a reference.
    const check = await moderateStoredImage(c, userId, path, ext);
    if (!check.ok) {
      await admin.from("uploads").update({ moderation: "blocked" }).eq(
        "id",
        registered.id,
      );
      return check.response;
    }
    await admin.from("uploads").update({ moderation: "allowed" }).eq(
      "id",
      registered.id,
    );

    const { data: signed } = await admin.storage.from("uploads")
      .createSignedUrl(path, 600);
    return c.json({ uploadId: path, url: browserUrl(signed?.signedUrl ?? "") });
  });

  const THUMB_MAX_BYTES = 512 * 1024;

  app.post("/generations/:id/thumb", async (c) => {
    const userId = c.get("userId") as string;
    const generationId = c.req.param("id");
    const { data: gen } = await admin
      .from("generations")
      .select("id,kind,status,storage_backend,thumb_path")
      .eq("id", generationId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!gen || gen.kind !== MediaKind.Video) {
      return fail(c, 404, "not_found", "Video not found.");
    }
    if (gen.status !== "done") {
      return fail(c, 409, "not_ready", "Video is not finished.");
    }

    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return fail(c, 400, "invalid_file", "Missing file.");
    }
    if (file.size > THUMB_MAX_BYTES) {
      return fail(c, 413, "too_large", "Thumbnail must be ≤ 512 KB.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniffImage(bytes) !== "jpg") {
      return fail(c, 415, "bad_type", "Thumbnail must be JPEG.");
    }

    // Posters are client-captured bytes, not a vetted server render: they cross
    // the same gate as any other user image before they are stored or served.
    const posterScratch = `scratch/${userId}/${crypto.randomUUID()}.jpg`;
    const posterErr = await writeScratch(c, userId, posterScratch, bytes, "image/jpeg");
    if (posterErr) return posterErr;
    let posterCheck: ImageCheck;
    try {
      posterCheck = await moderateStoredImage(c, userId, posterScratch, "jpg");
    } finally {
      await removeTracked(c, userId, "scratch", posterScratch, "scratch_cleanup");
    }
    if (!posterCheck.ok) return posterCheck.response;

    // The backend is the one RECORDED on the generation. The old `?? "r2"`
    // guess could write a poster into a store the row does not name, which
    // makes it undeletable and unsignable.
    const backend = gen.storage_backend as StorageBackend;
    if (backend !== "supabase" && backend !== "r2") {
      return fail(c, 409, "thumb_failed", "This video has no recorded storage.");
    }
    const path = thumbPath(userId, generationId);
    const posterId = await registerObject(admin, {
      userId,
      backend,
      bucket: backend === "r2" ? await r2Bucket() : SUPABASE_BUCKETS.thumb,
      path,
      purpose: "thumb",
    }).catch((e) => {
      logError(c, "thumb_register_failed", e);
      return null;
    });
    if (!posterId) {
      return fail(c, 503, "thumb_failed", "Could not record the thumbnail.");
    }
    await storageFor(backend).put(path, bytes, "image/jpeg");
    await markObjectLive(admin, posterId);
    const { error } = await admin.from("generations").update({
      thumb_path: path,
    }).eq("id", generationId);
    if (error) return fail(c, 500, "thumb_failed", error.message);
    return c.json({ thumbUrl: await signStored(backend, path) });
  });

  /**
   * List personas. Read-only: a persona is only ever changed by its own
   * routes, so there is nothing here for a background worker to advance.
   */
  app.get("/personas", async (c) => {
    const userId = c.get("userId");
    const { data: fresh } = await admin
      .from("personas")
      .select("*")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    const plan = await activePlan(userId);
    const max = plan ? PERSONA_SLOTS[plan] : 0;
    const items = await Promise.all(
      (fresh ?? []).map((row) => toPersonaDto(admin, browserUrl, row)),
    );
    // Every row this query returns is already draft or ready: deleted_at is
    // filtered above, and those are the only two statuses a persona has (0032).
    return c.json({ items, slots: { used: items.length, max } });
  });

  /** Create a draft persona. The slot check is the locked reservation, not a
   * count query here: two concurrent creates must not both slip under the cap. */
  app.post("/personas", async (c) => {
    const userId = c.get("userId");
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }
    const plan = await activePlan(userId);
    if (!plan) {
      return fail(
        c,
        403,
        "studio_required",
        "Personas require an active subscription.",
      );
    }
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === "string"
      ? body.name.replace(/[\u0000-\u001f\u007f]/gu, "").trim()
      : "";
    if (!name || name.length > 40) {
      return fail(c, 400, "invalid_payload", "name required (max 40 chars)");
    }
    if (body?.attested !== true) {
      return fail(c, 400, "invalid_payload", "Consent attestation is required");
    }
    const { data: reserved, error: reserveErr } = await admin.rpc("fn_reserve_persona", {
      p_user: userId,
      p_key: readIdempotencyKey(c) ?? crypto.randomUUID(),
      p_hash: await bodyHash({ name }),
      p_name: name,
    });
    if (reserveErr?.message?.includes("slot_limit")) {
      return fail(c, 403, "slot_limit", `Your plan allows ${PERSONA_SLOTS[plan]} personas`);
    }
    if (reserveErr?.message?.includes("idempotency_conflict")) {
      return fail(c, 409, "idempotency_conflict",
        "That request id was already used for a different request.");
    }
    if (reserveErr?.message?.includes("subscription_required")) {
      return fail(c, 403, "studio_required", "Personas require an active subscription.");
    }
    if (reserveErr || !reserved?.personaId) {
      logError(c, "persona_create_failed", reserveErr ?? new Error("no persona"));
      return fail(c, 503, "create_failed", "Could not create the persona");
    }
    const { data: row } = await admin.from("personas").select("*")
      .eq("id", reserved.personaId).single();
    // A replayed idempotency key can outlive the persona it made: the row may
    // since have been deleted. That is a 404, not a crash on a null row.
    if (!row) return fail(c, 404, "not_found", "Persona not found");
    const { error: clientErr } = await admin.from("personas")
      .update({ client: clientOf(c) }).eq("id", reserved.personaId);
    if (clientErr) logError(c, "persona_client_update_failed", clientErr);
    return c.json({ item: await toPersonaDto(admin, browserUrl, row) });
  });

  /**
   * Delete a persona. Its photos are queued for deletion from the registry;
   * nothing is trained and no provider holds a file for us any more (0032).
   */
  app.delete("/personas/:id", async (c) => {
    const { data, error } = await admin.rpc("fn_delete_persona", {
      p_user: c.get("userId"),
      p_id: c.req.param("id"),
    });
    if (error?.message?.includes("not_found")) {
      return fail(c, 404, "not_found", "Persona not found");
    }
    if (error) {
      logError(c, "delete_failed", error);
      return fail(c, 503, "delete_failed", "Could not delete — try again.");
    }
    return c.json(deletionStatus(data), 202);
  });

  /** Put one moderated photo in one slot; the replaced photo is queued for deletion. */
  app.put("/personas/:id/photos/:slot", async (c) => {
    const userId = c.get("userId");
    const personaId = c.req.param("id");
    const slot = c.req.param("slot");
    if (!isPersonaSlot(slot)) {
      return fail(c, 400, "invalid_slot", "Unknown photo slot");
    }
    if (await isSuspended(userId)) {
      return fail(c, 429, "account_suspended", "Account suspended — contact support to appeal.");
    }
    const body = await c.req.json().catch(() => null);
    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : "";
    const owned = await resolveOwnedUpload(admin, userId, uploadId, "persona-photo");
    if (typeof owned === "string") {
      const refused = personaPhotoFailure(owned);
      return fail(c, refused.status, "invalid_reference", refused.message);
    }
    if (Math.min(owned.width, owned.height) < PERSONA_MIN_EDGE) {
      return fail(c, 400, "photo_too_small",
        `Use a sharper photo — at least ${PERSONA_MIN_EDGE}px on its short edge.`);
    }
    const { error } = await admin.rpc("fn_set_persona_photo", {
      p_user: userId, p_persona: personaId, p_slot: slot, p_path: owned.path,
    });
    if (error?.message?.includes("not_found")) {
      return fail(c, 404, "not_found", "Persona not found");
    }
    if (error?.message?.includes("invalid_slot")) {
      return fail(c, 400, "invalid_slot", "Unknown photo slot");
    }
    if (error?.message?.includes("invalid_photo")) {
      return fail(c, 409, "photo_unavailable",
        "That photo can't be used here — it's in use by another persona or being removed. " +
          "Upload it again.");
    }
    if (error) {
      logError(c, "persona_photo_failed", error);
      return fail(c, 503, "persona_photo_failed", "Could not save the photo — try again.");
    }
    const { data: row } = await admin.from("personas").select("*").eq("id", personaId)
      .maybeSingle();
    // Deleted between the write and this read: the persona is gone, say so.
    if (!row) return fail(c, 404, "not_found", "Persona not found");
    return c.json({ item: await toPersonaDto(admin, browserUrl, row) });
  });

  /** Persist a locally-edited canvas as a new $0 generation version. */
  app.post("/edits/save", async (c) => {
    const userId = c.get("userId");
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }
    if (!(await activePlan(userId))) {
      return fail(
        c,
        403,
        "subscription_required",
        "An active subscription is required for editing tools.",
      );
    }
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    const parentId = String(form?.get("parentId") ?? "");
    if (!(file instanceof File)) {
      return fail(c, 400, "upload_failed", "No file provided");
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      return fail(c, 400, "upload_failed", "File exceeds 10MB");
    }
    if (!parentId) return fail(c, 400, "invalid_parent", "parentId required");

    const { data: parent } = await admin
      .from("generations")
      .select("id,prompt,settings")
      .eq("id", parentId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!parent) {
      return fail(c, 404, "not_found", "Parent generation not found");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniffImage(bytes) !== "png") {
      return fail(c, 400, "upload_failed", "PNG required");
    }

    // Moderation BEFORE anything persists outside quarantine reach. A failed
    // scratch write is an outage: we must not write to `media` unchecked.
    const scratch = `scratch/${userId}/${crypto.randomUUID()}.png`;
    const scratchErr = await writeScratch(c, userId, scratch, bytes, "image/png");
    if (scratchErr) return scratchErr;
    let saveCheck: ImageCheck;
    try {
      saveCheck = await moderateStoredImage(c, userId, scratch, "png");
    } finally {
      await removeTracked(c, userId, "scratch", scratch, "scratch_cleanup");
    }
    if (!saveCheck.ok) return saveCheck.response;

    const { data: gen, error } = await admin
      .from("generations")
      .insert({
        user_id: userId,
        kind: MediaKind.Image,
        family_id: "studio",
        family_name: "Studio Edit",
        op: GenerationOp.Edit,
        prompt: parent.prompt,
        settings: parent.settings,
        price_credits: 0,
        // Staged, not done: a row only becomes `done` once the bytes are
        // stored AND that fact is persisted. Inserting `done` up front is how
        // library rows that point at nothing were created.
        status: "pending",
        media_url: "",
        parent_id: parentId,
      })
      .select("*")
      .single();
    if (error || !gen) {
      return fail(c, 400, "save_failed", "Could not save the edit");
    }

    const path = `${userId}/${gen.id}.png`;
    const objectId = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.media,
      path,
      purpose: "media",
    }).catch((e) => {
      logError(c, "media_register_failed", e);
      return null;
    });
    if (!objectId) {
      await dropStagedRow(gen.id);
      return fail(c, 503, "save_failed", "Could not record the file");
    }
    const { error: upErr } = await admin.storage.from("media").upload(
      path,
      bytes,
      {
        contentType: "image/png",
        upsert: true,
      },
    );
    if (upErr) {
      await dropStagedRow(gen.id);
      return fail(c, 400, "save_failed", "Storage rejected the file");
    }
    await markObjectLive(admin, objectId);
    const { data: saved, error: saveError } = await admin.from("generations")
      .update({ media_path: path, status: "done" })
      .eq("id", gen.id)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
    if (saveError || !saved) {
      await dropStagedObject(gen.id, path);
      await dropStagedRow(gen.id);
      return fail(
        c,
        503,
        "save_failed",
        "Your image could not be saved. Please retry.",
      );
    }
    return c.json({
      item: await toGenerationDto({ ...gen, media_path: path, status: "done" }),
    });
  });

  /** Import a user's own image as a root $0 library item they can edit. Studio-gated. */
  app.post("/library/import", async (c) => {
    const userId = c.get("userId");
    if (await isSuspended(userId)) {
      return fail(
        c,
        429,
        "account_suspended",
        "Account suspended — contact support to appeal.",
      );
    }
    if (!(await activePlan(userId))) {
      return fail(
        c,
        403,
        "subscription_required",
        "An active subscription is required for editing tools.",
      );
    }
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return fail(c, 400, "upload_failed", "No file provided");
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      return fail(c, 400, "upload_failed", "File exceeds 10MB");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = sniffImage(bytes);
    if (!ext) {
      return fail(
        c,
        400,
        "upload_failed",
        "Only PNG, JPEG, or WEBP images are allowed",
      );
    }
    const contentType = `image/${ext === "jpg" ? "jpeg" : ext}`;

    // Moderate BEFORE the image enters the library.
    const scratch = `scratch/${userId}/${crypto.randomUUID()}.${ext}`;
    const scratchErr = await writeScratch(c, userId, scratch, bytes, contentType);
    if (scratchErr) return scratchErr;
    let importCheck: ImageCheck;
    try {
      importCheck = await moderateStoredImage(c, userId, scratch, ext);
    } finally {
      await removeTracked(c, userId, "scratch", scratch, "scratch_cleanup");
    }
    if (!importCheck.ok) return importCheck.response;

    const { data: gen, error } = await admin
      .from("generations")
      .insert({
        user_id: userId,
        kind: MediaKind.Image,
        family_id: "studio",
        family_name: "Imported",
        op: GenerationOp.Generate,
        prompt: "Imported image",
        settings: {},
        price_credits: 0,
        // See /edits/save: staged until the stored object is recorded.
        status: "pending",
        media_url: "",
      })
      .select("*")
      .single();
    if (error || !gen) {
      return fail(c, 400, "save_failed", "Could not import the image");
    }

    const path = `${userId}/${gen.id}.${ext}`;
    const objectId = await registerObject(admin, {
      userId,
      backend: "supabase",
      bucket: SUPABASE_BUCKETS.media,
      path,
      purpose: "media",
    }).catch((e) => {
      logError(c, "media_register_failed", e);
      return null;
    });
    if (!objectId) {
      await dropStagedRow(gen.id);
      return fail(c, 503, "save_failed", "Could not record the file");
    }
    const { error: upErr } = await admin.storage.from("media").upload(
      path,
      bytes,
      {
        contentType,
        upsert: true,
      },
    );
    if (upErr) {
      await dropStagedRow(gen.id);
      return fail(c, 400, "save_failed", "Storage rejected the file");
    }
    await markObjectLive(admin, objectId);
    const { data: saved, error: saveError } = await admin.from("generations")
      .update({ media_path: path, status: "done" })
      .eq("id", gen.id)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
    if (saveError || !saved) {
      await dropStagedObject(gen.id, path);
      await dropStagedRow(gen.id);
      return fail(
        c,
        503,
        "save_failed",
        "Your image could not be saved. Please retry.",
      );
    }
    return c.json({
      item: await toGenerationDto({ ...gen, media_path: path, status: "done" }),
    });
  });

  /**
   * Hide it now, remove the bytes durably.
   *
   * The route no longer deletes objects itself: it could only ever be
   * best-effort, and a failed `storage.delete` left bytes nobody could name
   * again. `fn_delete_generation` tombstones the row, asks any running job to
   * stop (it never settles one — only the lease holder may), and queues every
   * registered locator for the cleanup worker. A generation whose job is
   * still running keeps its row until the job settles, so a late provider
   * output lands somewhere we can still delete it from.
   */
  app.delete("/generations/:id", async (c) => {
    const userId = c.get("userId") as string;
    const { data, error } = await admin.rpc("fn_delete_generation", {
      p_user: userId,
      p_id: c.req.param("id"),
    });
    if (error?.message?.includes("not_found")) {
      return fail(c, 404, "not_found", "Generation not found.");
    }
    if (error) {
      logError(c, "delete_failed", error);
      return fail(c, 503, "delete_failed", "Could not delete — try again.");
    }
    return c.json(deletionStatus(data), 202);
  });

  return app;
}
