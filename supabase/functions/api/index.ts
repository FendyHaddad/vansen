// Vansen API gateway. All data access flows through here (tables are RLS
// deny-all; RPCs are service_role-only). Client's only other Supabase surface
// is Auth. REST contract doubles as the future Java migration contract.
import { Hono, type Context } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import {
  CREDIT_PACKS,
  PERSONA_GEN,
  PERSONA_SLOTS,
  PERSONA_TRAINING,
  STUDIO_MARGIN,
  UPSCALER,
  creditCost,
  editToolById,
  familyById,
  packCredits,
  personaGenCreditCost,
  upscaleCreditCost,
  videoFamilySupports,
  type GenerationSettings,
  type ModelFamily,
  type VideoMode,
} from './_shared/model-families.ts';
import { applyStyle, styleById } from './_shared/style-presets.ts';
import { GenerationOp, LedgerType, MediaKind } from './_shared/enums.ts';
import { adapterFor } from './_shared/providers/index.ts';
import {
  PERSONA_TRIGGER,
  checkPersonaTraining,
  submitPersonaTraining,
} from './_shared/providers/fal.ts';
import { zipSync } from 'npm:fflate@0.8.2';
import type { CheckResult } from './_shared/providers/types.ts';
import { storageFor, videoPath, thumbPath, type StorageBackend } from './_shared/storage/index.ts';
import { dailyCapState, expectedSecondsFor, referenceRule, videoJobCapReached } from './_shared/video-rules.ts';
import { isUrlResult, type SubmitResult } from './_shared/providers/types.ts';
import { moderate } from './_shared/moderation.ts';
import { safetyId } from './_shared/safety.ts';
import { parseServiceAccount, sendGenerationPush, type PushEvent } from './_shared/push.ts';
import { laneFor } from './_shared/billing-lanes.ts';
import { appleVerifier } from './_shared/apple-verifier.ts';
import { applyIapTransaction } from './_shared/iap-grants.ts';

const SUSPEND_STRIKES = 2;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const fcmAccount = parseServiceAccount(Deno.env.get('FCM_SERVICE_ACCOUNT'));
// NOTE: deployed via MCP with _shared/ nested inside the function bundle;
// keep these specifiers matching the deploy layout.

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
  httpClient: Stripe.createFetchHttpClient(),
});
const PLAN_PRICE_IDS: Record<string, string | undefined> = {
  studio: Deno.env.get('STRIPE_STUDIO_PRICE_ID'),
  pro: Deno.env.get('STRIPE_PRO_PRICE_ID'),
};
const LAUNCH_COUPON_ID = Deno.env.get('STRIPE_LAUNCH_COUPON_ID'); // $5 off, 2 months

/** Deployed origins, comma-separated (e.g. "https://vansen.app"). Dev servers are
 * matched by pattern instead — `ng serve` picks whatever port is free. */
const APP_ORIGINS = (Deno.env.get('APP_ORIGIN') ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const DEV_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/;

/** The single source of truth for "is this origin ours?" — used for both CORS and
 * the Stripe return URL. Only ever returns an origin we recognise: echoing the
 * caller's own value back would make checkout an open redirect. */
function allowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (DEV_ORIGIN.test(origin)) return origin;
  return APP_ORIGINS.includes(origin) ? origin : null;
}

/** Where Stripe sends the browser back. Prefer the caller's origin when we trust
 * it, so any `ng serve` port works; fall back to the configured deployment. */
function appOrigin(c: { req: { header: (k: string) => string | undefined } }): string {
  return allowedOrigin(c.req.header('origin')) ?? APP_ORIGINS[0] ?? 'http://localhost:4200';
}

type ReturnUrls = { success: string; cancel: string };

/** Mobile checkouts bounce back into the app via its deep link; web callers
 * keep the site URLs (param absent → unchanged behaviour). */
function checkoutReturnUrls(
  c: { req: { header: (k: string) => string | undefined } },
  body: Record<string, unknown>,
): ReturnUrls {
  if (body.platform === 'mobile') {
    return {
      success: 'vansen://billing-return?status=success',
      cancel: 'vansen://billing-return?status=cancel',
    };
  }
  return {
    success: `${appOrigin(c)}/app?checkout=success`,
    cancel: `${appOrigin(c)}/app?checkout=canceled`,
  };
}

/** Detect image type from magic bytes; returns extension or null. */
function sniffImage(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

const MAX_PROMPT_LEN = 2000;
const AR_PATTERN = /^\d{1,2}:\d{1,2}$/;
const VIDEO_MODES: ReadonlySet<string> = new Set(['t2v', 'i2v', 'ref2v', 'keyframes', 'extend', 'edit']);
const REF_SIGN_TTL_S = 3600;
const UPLOAD_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/i;

/** Only known settings keys, type- and size-checked, are ever stored or priced. */
function sanitizeSettings(raw: unknown): GenerationSettings {
  const src = (raw ?? {}) as Record<string, unknown>;
  const clean: GenerationSettings = { aspectRatio: '1:1' };
  if (typeof src.aspectRatio === 'string' && AR_PATTERN.test(src.aspectRatio)) {
    clean.aspectRatio = src.aspectRatio;
  }
  if (typeof src.version === 'string' && src.version.length <= 20) clean.version = src.version;
  if (typeof src.resolution === 'string' && src.resolution.length <= 10) {
    clean.resolution = src.resolution;
  }
  if (typeof src.quality === 'string' && src.quality.length <= 10) clean.quality = src.quality;
  if (
    typeof src.durationS === 'number' &&
    Number.isFinite(src.durationS) &&
    src.durationS > 0 &&
    src.durationS <= 60
  ) {
    clean.durationS = src.durationS;
  }
  if (src.audio === 'off' || src.audio === 'on' || src.audio === 'voice') clean.audio = src.audio;
  if (typeof src.mode === 'string' && VIDEO_MODES.has(src.mode)) clean.mode = src.mode as VideoMode;
  return clean;
}

const PREF_CHECKS: ReadonlyArray<readonly [string, (v: unknown) => boolean]> = [
  ['defaultMode', (v) => v === 'image' || v === 'video'],
  ['defaultImageFamily', (v) => typeof v === 'string' && v.length <= 40],
  ['defaultVideoFamily', (v) => typeof v === 'string' && v.length <= 40],
  ['defaultVideoMode', (v) => typeof v === 'string' && VIDEO_MODES.has(v)],
  ['defaultAspect', (v) => typeof v === 'string' && v.length <= 10],
  ['defaultStyle', (v) => typeof v === 'string' && v.length <= 40],
  ['defaultPersona', (v) => typeof v === 'string' && v.length <= 40],
  ['tourSeen', (v) => typeof v === 'boolean'],
];

/** Whitelist prefs: unknown keys dropped, invalid values reject the request. */
function sanitizePrefs(raw: Record<string, unknown>): Record<string, unknown> | null {
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
const app = new Hono<Vars>().basePath('/api');

app.use(
  '*',
  cors({
    origin: (origin) => allowedOrigin(origin) ?? undefined,
    allowHeaders: ['authorization', 'content-type', 'x-vansen-client'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

function fail(c: { json: (b: unknown, s: number) => Response }, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

type ErrCtx = { req: { url: string; method: string }; get: (k: 'userId' | 'requestId') => string | undefined };

/** Fire-and-forget write to app_errors — monitoring must never break a request.
 * Never log request bodies or headers here: prompts are user content, headers
 * carry tokens. Message + stack only. */
function logError(c: ErrCtx, code: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  admin
    .from('app_errors')
    .insert({
      source: 'api',
      route: new URL(c.req.url).pathname,
      method: c.req.method,
      code,
      message: (e.message || 'unknown').slice(0, 1000),
      stack: (e.stack ?? '').slice(0, 4000),
      user_id: c.get('userId') ?? null,
      request_id: c.get('requestId') ?? null,
    })
    .then(({ error }) => {
      if (error) console.error('app_errors insert failed:', error.message);
    });
}

const KNOWN_CLIENTS = new Set(['web', 'ios', 'android']);

/** Platform marker from the x-vansen-client header; anything unexpected → null. */
function clientOf(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const v = c.req.header('x-vansen-client');
  return v && KNOWN_CLIENTS.has(v) ? v : null;
}

/** Short free-text field: control chars stripped, trimmed, capped, null if empty. */
function sanitizeLabel(v: unknown, max = 80): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, max);
  return s || null;
}

app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID().slice(0, 8));
  await next();
});

// Any exception nothing else caught: log it, answer with a request id the
// user can quote back so the row is findable.
app.onError((err, c) => {
  logError(c, 'unhandled', err);
  return c.json(
    { error: { code: 'internal', message: 'Something went wrong', requestId: c.get('requestId') } },
    500,
  );
});

// Unauthenticated liveness probe for uptime monitors (registered before the
// auth middleware; returning a response stops the chain).
app.get('/health', async (c) => {
  const { error } = await admin.from('models').select('id').limit(1);
  return c.json({ ok: !error, db: !error, requestId: c.get('requestId') }, error ? 503 : 200);
});

app.use('*', async (c, next) => {
  const token = c.req.header('authorization')?.replace(/^Bearer /i, '');
  if (!token) return fail(c, 401, 'unauthorized', 'Missing token');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return fail(c, 401, 'unauthorized', 'Invalid token');
  c.set('userId', data.user.id);
  c.set('email', data.user.email ?? '');
  await next();
});

/** Warm-isolate memo of users who already passed the age gate (same pattern as
 * signedUrlMemo). Safe to cache: birth_date only ever transitions unset → set,
 * so a hit can never go stale. deleteAccount evicts on account deletion. */
const ageOkMemo = new Set<string>();

/** Routes reachable before the gate: read your profile, pass the gate, or
 * delete the account. Everything else requires a confirmed 18+ DOB. */
const AGE_EXEMPT = new Set([
  'GET /api/profile',
  'POST /api/profile/age',
  'DELETE /api/profile',
]);

app.use('*', async (c, next) => {
  const key = `${c.req.method} ${new URL(c.req.url).pathname}`;
  if (!AGE_EXEMPT.has(key)) {
    const userId = c.get('userId');
    if (!ageOkMemo.has(userId)) {
      const { data } = await admin
        .from('profiles')
        .select('birth_date')
        .eq('id', userId)
        .single();
      if (!data?.birth_date) {
        return fail(c, 403, 'age_unconfirmed', 'Confirm your date of birth to continue');
      }
      if (ageOkMemo.size > 10_000) ageOkMemo.clear();
      ageOkMemo.add(userId);
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
  if (!path) return '';
  const hit = signedUrlMemo.get(path);
  if (hit && hit.expiresAt - Date.now() > RESIGN_FLOOR_MS) return hit.url;
  const { data } = await admin.storage.from('media').createSignedUrl(path, SIGN_TTL_S);
  if (!data?.signedUrl) return '';
  if (signedUrlMemo.size > 5000) signedUrlMemo.clear();
  signedUrlMemo.set(path, { url: data.signedUrl, expiresAt: Date.now() + SIGN_TTL_S * 1000 });
  return data.signedUrl;
}

const r2SignMemo = new Map<string, { url: string; exp: number }>();

/** Video media lives in R2, not the Supabase `media` bucket — sign through the
 * right backend. R2 URLs are memoized separately since signMedia's memo is
 * keyed to Supabase's own createSignedUrl call. */
async function signStored(backend: StorageBackend, path: string | null, ttlS = SIGN_TTL_S): Promise<string> {
  if (!path) return '';
  if (backend !== 'r2') return signMedia(path);
  const memoKey = `${path}|${ttlS}`;
  const hit = r2SignMemo.get(memoKey);
  if (hit && hit.exp > Date.now()) return hit.url;
  const url = await storageFor('r2').signedUrl(path, ttlS);
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

const NOT_CANCELLABLE = new Set(['veo', 'omni']);

function jobDto(row: Record<string, unknown>, job: JobRow | undefined) {
  if (!job || row.status !== 'pending') return undefined;
  const family = familyById(String(row.family_id));
  const settings = (row.settings ?? {}) as GenerationSettings;
  return {
    progress: job.progress ?? undefined,
    phase: (job.claimed_at ? 'saving' : job.phase ?? 'queued') as 'queued' | 'rendering' | 'saving',
    cancellable: !NOT_CANCELLABLE.has(String(row.family_id)),
    expectedS: family ? expectedSecondsFor(family, settings.durationS) : 30,
    startedAt: job.created_at,
    queuePosition: job.queue_position ?? undefined,
  };
}

async function toGenerationDto(row: Record<string, unknown>, job?: JobRow) {
  const backend = (row.storage_backend ?? 'supabase') as StorageBackend;
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
    mediaUrl: await signStored(backend, (row.media_path as string | null) ?? null),
    thumbUrl: row.thumb_path ? await signStored(backend, row.thumb_path as string) : undefined,
    storageBackend: row.kind === MediaKind.Video ? backend : undefined,
    durationS: row.duration_s == null ? undefined : Number(row.duration_s),
    parentId: row.parent_id,
    createdAt: row.created_at,
    job: jobDto(row, job),
  };
}

async function toGenerationDtos(rows: Record<string, unknown>[], jobs: Map<string, JobRow> = new Map()) {
  return Promise.all(rows.map((r) => toGenerationDto(r, jobs.get(String(r.id)))));
}

async function isSuspended(userId: string): Promise<boolean> {
  const { data } = await admin.from('profiles').select('strikes').eq('id', userId).single();
  return (data?.strikes ?? 0) >= SUSPEND_STRIKES;
}

async function modelGate(familyId: string): Promise<{ enabled: boolean; minPlan: string }> {
  const { data } = await admin
    .from('models')
    .select('enabled,min_plan')
    .eq('id', familyId)
    .maybeSingle();
  return { enabled: data?.enabled ?? false, minPlan: data?.min_plan ?? 'studio' };
}

async function recordStrike(
  userId: string,
  source: 'prompt' | 'upload',
  prompt: string | null,
  categories: Record<string, number>,
  quarantinePath?: string,
): Promise<void> {
  await admin.from('moderation_events').insert({
    user_id: userId,
    source,
    prompt,
    categories,
    quarantine_path: quarantinePath ?? null,
  });
  await admin.rpc('fn_increment_strike', { p_user: userId });
}

/** Fire-and-forget push on job settle; never fails the request. */
function notifySettled(userId: string, generationId: string, type: PushEvent['type']): void {
  if (!fcmAccount) return;
  pushToDevices(userId, generationId, type).catch((e) => console.error('push_notify_failed', e));
}

async function pushToDevices(userId: string, generationId: string, type: PushEvent['type']): Promise<void> {
  const { data: devices } = await admin.from('devices').select('token').eq('user_id', userId);
  if (!devices || devices.length === 0) return;
  const stale = await sendGenerationPush(fcmAccount!, devices.map((d) => d.token), { type, generationId });
  if (stale.length === 0) return;
  await admin.from('devices').delete().eq('user_id', userId).in('token', stale);
}

const MAX_STORE_ATTEMPTS = 3;

/** Upload finished bytes to private storage, flip the generation done. */
async function finishJob(
  job: { id: string; user_id: string; generation_id: string; attempts?: number },
  result: CheckResult,
): Promise<void> {
  if (result.state === 'running') {
    await admin
      .from('jobs')
      .update({
        ...(result.progress != null ? { progress: result.progress } : {}),
        ...(result.queuePosition != null ? { queue_position: result.queuePosition } : {}),
        phase: result.phase ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    return;
  }
  if (result.state === 'failed') {
    await admin.rpc('fn_fail_job', { p_job: job.id, p_error: result.error });
    notifySettled(job.user_id, job.generation_id, 'generation_failed');
    return;
  }
  if (isUrlResult(result)) {
    await storeVideoResult(job, result);
    return;
  }
  const path = `${job.user_id}/${job.generation_id}.png`;
  await admin.storage.from('media').upload(path, result.bytes, { contentType: result.contentType, upsert: true });
  await admin.from('generations').update({ status: 'done', media_path: path }).eq('id', job.generation_id);
  await admin.from('jobs').update({ updated_at: new Date().toISOString() }).eq('id', job.id);
  notifySettled(job.user_id, job.generation_id, 'generation_done');
}

// Zero rows can also mean a previous attempt already committed `done` and only
// its response was lost; never delete media a done row still points at.
async function dropLostObject(generationId: string, path: string): Promise<void> {
  const { data: row } = await admin.from('generations').select('status').eq('id', generationId).maybeSingle();
  if (row?.status === 'done') return;
  console.warn('[finishJob] generation already settled, dropping object', generationId);
  await storageFor('r2').delete(path).catch(() => undefined);
}

async function storeVideoResult(
  job: { id: string; user_id: string; generation_id: string; attempts?: number },
  result: Extract<CheckResult, { url: string }>,
): Promise<void> {
  // Claim: only one poller streams the file. No row back (and no error) → someone else has it.
  const { data: claimed, error: claimError } = await admin
    .from('jobs')
    .update({ claimed_at: new Date().toISOString(), phase: 'saving' })
    .eq('id', job.id)
    .is('claimed_at', null)
    .select('id');
  if (claimError) {
    console.error('[finishJob] claim failed', job.id, claimError.message);
    return;
  }
  if (!claimed || claimed.length === 0) return;

  const path = videoPath(job.user_id, job.generation_id);
  try {
    const res = await fetch(result.url, { headers: result.headers });
    if (!res.ok || !res.body) throw new Error(`video fetch ${res.status}`);
    // Buffer before the PUT: a streaming body makes fetch send chunked transfer
    // encoding, which R2's S3 PutObject rejects.
    const bytes = new Uint8Array(await new Response(res.body).arrayBuffer());
    await storageFor('r2').put(path, bytes, result.contentType || 'video/mp4');
  } catch (e) {
    const attempts = (job.attempts ?? 0) + 1;
    console.error('store_failed', job.id, attempts, e);
    if (attempts >= MAX_STORE_ATTEMPTS) {
      await admin.rpc('fn_fail_job', { p_job: job.id, p_error: 'store_failed' });
      notifySettled(job.user_id, job.generation_id, 'generation_failed');
      return;
    }
    await admin.from('jobs').update({ claimed_at: null, phase: 'rendering', attempts }).eq('id', job.id);
    return;
  }

  // Conditional on still-pending: a cancel or the stale sweep can have failed +
  // refunded the row while the bytes were in flight. Losing that race must not
  // hand the user the video on top of the refund.
  const { data: finished, error: genError } = await admin
    .from('generations')
    .update({
      status: 'done',
      media_path: path,
      storage_backend: 'r2',
      duration_s: result.durationS ?? null,
      width: result.width ?? null,
      height: result.height ?? null,
    })
    .eq('id', job.generation_id)
    .eq('status', 'pending')
    .select('id');
  if (genError) {
    console.error('[finishJob] generation update failed', job.generation_id, genError.message);
    await admin.from('jobs').update({ claimed_at: null, phase: 'rendering' }).eq('id', job.id);
    return;
  }
  if (!finished || finished.length === 0) {
    await dropLostObject(job.generation_id, path);
    return;
  }
  await admin.from('jobs').update({ progress: 1, updated_at: new Date().toISOString() }).eq('id', job.id);
  notifySettled(job.user_id, job.generation_id, 'generation_done');
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

async function creditsOf(userId: string): Promise<{ plan: number; pack: number }> {
  const { data, error } = await admin.rpc('fn_balances', { p_user: userId });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return { plan: row?.plan_credits ?? 0, pack: row?.pack_credits ?? 0 };
}

async function stripeCustomerFor(userId: string, email: string): Promise<string> {
  const { data: profile } = await admin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .single();
  if (profile?.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await stripe.customers.create({ email, metadata: { user_id: userId } });
  await admin.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', userId);
  return customer.id;
}

/** Highest active plan, or null. canceled = works until period end. */
async function activePlan(userId: string): Promise<'studio' | 'pro' | 'owner' | null> {
  const { data } = await admin
    .from('subscriptions')
    .select('plan, status, current_period_end')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return null;
  if (data.status === 'expired') return null;
  if (
    data.status === 'canceled' &&
    data.current_period_end && new Date(data.current_period_end).getTime() < Date.now()
  ) {
    return null;
  }
  return data.plan as 'studio' | 'pro' | 'owner';
}

app.get('/profile', async (c) => {
  const userId = c.get('userId');
  const [{ data: profile, error }, credits, { data: subscription }] = await Promise.all([
    admin.from('profiles').select('*').eq('id', userId).single(),
    creditsOf(userId),
    admin.from('subscriptions').select('*').eq('user_id', userId).maybeSingle(),
  ]);
  if (error || !profile) return fail(c, 404, 'not_found', 'Profile missing');
  return c.json({
    profile: {
      id: profile.id,
      email: c.get('email'),
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
        }
      : null,
  });
});

app.patch('/profile', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.displayName !== 'string' || body.displayName.length > 80) {
    return fail(c, 400, 'invalid_payload', 'displayName required (max 80 chars)');
  }
  const cleanName = body.displayName.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  const { error } = await admin
    .from('profiles')
    .update({ display_name: cleanName || null })
    .eq('id', c.get('userId'));
  if (error) return fail(c, 400, 'update_failed', 'Profile could not be updated');
  return c.json({ ok: true });
});

/** Cancel any live Stripe sub, then hard-delete the account (data + auth row).
 * Returns an error Response on failure, or null on success. Shared by
 * DELETE /profile and the underage branch of POST /profile/age. */
async function deleteAccount(
  c: ErrCtx & { json: (b: unknown, s: number) => Response },
  userId: string,
): Promise<Response | null> {
  const { data: prof } = await admin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .single();
  if (prof?.stripe_customer_id) {
    try {
      const subs = await stripe.subscriptions.list({
        customer: prof.stripe_customer_id,
        status: 'active',
      });
      for (const sub of subs.data) await stripe.subscriptions.cancel(sub.id);
    } catch (e) {
      logError(c, 'delete_failed', e);
      return fail(c, 400, 'delete_failed', 'Could not cancel Studio — try again');
    }
  }
  const { error } = await admin.rpc('fn_delete_account', { p_user: userId });
  if (error) return fail(c, 400, 'delete_failed', error.message);
  const { error: authError } = await admin.auth.admin.deleteUser(userId);
  if (authError) return fail(c, 400, 'delete_failed', authError.message);
  ageOkMemo.delete(userId); // hygiene — the auth row is gone anyway
  return null;
}

app.delete('/profile', async (c) => {
  const err = await deleteAccount(c, c.get('userId'));
  return err ?? c.json({ ok: true });
});

/** Accept a strict, real, non-future, ≤120y-old YYYY-MM-DD string; else null. */
function parseBirthDate(s: unknown): string | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null; // e.g. 2001-02-30 rolled over
  }
  const now = Date.now();
  if (dt.getTime() > now) return null; // future
  if (now - dt.getTime() > 120 * 365.25 * 864e5) return null; // >120 years
  return s;
}

/** Whole years old today, UTC, with correct month/day rollover. */
function ageFromBirthDate(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  const mo = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  if (mo < m || (mo === m && day < d)) age--;
  return age;
}

app.post('/profile/age', async (c) => {
  const body = await c.req.json().catch(() => null);
  const birthDate = parseBirthDate(body?.birthDate);
  if (!birthDate) return fail(c, 400, 'invalid_payload', 'A valid date of birth is required');

  if (ageFromBirthDate(birthDate) < 18) {
    const err = await deleteAccount(c, c.get('userId'));
    if (err) return err;
    return fail(c, 403, 'underage', 'You must be 18 or older to use Vansen');
  }

  const { error } = await admin
    .from('profiles')
    .update({ birth_date: birthDate, age_confirmed_at: new Date().toISOString() })
    .eq('id', c.get('userId'));
  if (error) return fail(c, 400, 'update_failed', 'Could not save your date of birth');
  return c.json({ ok: true });
});

app.put('/prefs', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(c, 400, 'invalid_payload', 'Prefs object required');
  }
  const clean = sanitizePrefs(body as Record<string, unknown>);
  if (!clean) return fail(c, 400, 'invalid_payload', 'Invalid preference values');
  const { error } = await admin.from('profiles').update({ prefs: clean }).eq('id', c.get('userId'));
  if (error) return fail(c, 400, 'update_failed', 'Preferences could not be saved');
  return c.json({ ok: true });
});

app.post('/devices', async (c) => {
  const body = await c.req.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  const platform = body?.platform;
  if (!token || token.length > 512) return fail(c, 400, 'invalid_token', 'token required');
  if (platform !== 'ios' && platform !== 'android') {
    return fail(c, 400, 'invalid_platform', "platform must be 'ios' or 'android'");
  }
  const { error } = await admin.from('devices').upsert(
    { user_id: c.get('userId'), token, platform, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,token' },
  );
  if (error) {
    logError(c, 'device_register_failed', new Error(error.message));
    return fail(c, 500, 'internal', 'Could not register device');
  }
  return c.json({ ok: true });
});

app.delete('/devices', async (c) => {
  const body = await c.req.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) return fail(c, 400, 'invalid_token', 'token required');
  await admin.from('devices').delete().eq('user_id', c.get('userId')).eq('token', token);
  return c.json({ ok: true });
});

app.get('/ledger', async (c) => {
  const { data, error } = await admin
    .from('ledger_entries')
    .select('*')
    .eq('user_id', c.get('userId'))
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return fail(c, 400, 'query_failed', error.message);
  return c.json({ entries: (data ?? []).map(toLedgerDto) });
});

app.get('/generations', async (c) => {
  const { data, error } = await admin
    .from('generations')
    .select('*')
    .eq('user_id', c.get('userId'))
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return fail(c, 400, 'query_failed', error.message);
  return c.json({ items: await toGenerationDtos(data ?? []) });
});

app.get('/models', async (c) => {
  const { data } = await admin.from('models').select('id,enabled');
  return c.json({ models: data ?? [] });
});

// Client-side error reports (web ErrorHandler, mobile crash hooks). Same
// privacy rule as logError: message + stack only, never bodies or headers.
app.post('/errors', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const message = typeof body?.message === 'string' ? body.message.trim().slice(0, 1000) : '';
  if (!message) return fail(c, 400, 'invalid_payload', 'message required');

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await admin
    .from('app_errors')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('source', 'client')
    .gte('created_at', hourAgo);
  if ((count ?? 0) >= 20) return fail(c, 429, 'rate_limited', 'Too many error reports');

  const { error } = await admin.from('app_errors').insert({
    source: 'client',
    client: clientOf(c),
    route: sanitizeLabel(body.route),
    code: sanitizeLabel(body.code),
    message,
    stack: typeof body.stack === 'string' && body.stack ? body.stack.slice(0, 4000) : null,
    app_version: sanitizeLabel(body.appVersion),
    user_id: userId,
    request_id: c.get('requestId') ?? null,
  });
  if (error) return fail(c, 500, 'report_failed', 'Could not record the report');
  return c.body(null, 204);
});

app.get('/jobs', async (c) => {
  const userId = c.get('userId');
  const idsParam = c.req.query('ids') ?? '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (ids.length === 0) return c.json({ items: [] });

  const { data: jobs } = await admin
    .from('jobs')
    .select('id,user_id,generation_id,provider_ref,error,progress,phase,claimed_at,created_at,attempts,queue_position')
    .eq('user_id', userId)
    .in('generation_id', ids);

  for (const job of jobs ?? []) {
    // Skip already-errored/resolved jobs, inline providers resolved at submit,
    // and jobs another concurrent tick is currently saving (claimed_at set).
    if (job.error || !job.provider_ref || job.provider_ref === 'inline' || job.claimed_at) continue;
    const { data: gen } = await admin
      .from('generations')
      .select('status,family_id')
      .eq('id', job.generation_id)
      .single();
    if (!gen || gen.status !== 'pending') continue;
    try {
      const result = await adapterFor(gen.family_id).check(job.provider_ref);
      await finishJob({ id: job.id, user_id: job.user_id, generation_id: job.generation_id, attempts: job.attempts }, result);
    } catch (e) {
      logError(c, 'provider_check_failed', e);
      await admin.rpc('fn_fail_job', { p_job: job.id, p_error: String(e).slice(0, 500) });
      notifySettled(job.user_id, job.generation_id, 'generation_failed');
    }
  }

  const { data: freshJobs } = await admin
    .from('jobs')
    .select('id,generation_id,progress,phase,claimed_at,created_at,queue_position')
    .eq('user_id', userId)
    .in('generation_id', ids);
  const jobsByGen = new Map<string, JobRow>((freshJobs ?? []).map((j) => [j.generation_id, j as JobRow]));
  const { data: gens } = await admin.from('generations').select('*').eq('user_id', userId).in('id', ids);
  return c.json({ items: await toGenerationDtos(gens ?? [], jobsByGen) });
});

app.post('/jobs/:id/cancel', async (c) => {
  const userId = c.get('userId') as string;
  const generationId = c.req.param('id');
  const { data: gen } = await admin
    .from('generations')
    .select('id,status,family_id,price_credits,kind')
    .eq('id', generationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!gen) return fail(c, 404, 'not_found', 'Generation not found.');
  if (gen.status !== 'pending') return fail(c, 409, 'not_pending', 'Already finished.');
  if (NOT_CANCELLABLE.has(gen.family_id)) {
    return fail(c, 409, 'not_cancellable', "This model can't be cancelled once started.");
  }
  const { data: job } = await admin
    .from('jobs')
    .select('id,provider_ref,claimed_at')
    .eq('generation_id', generationId)
    .is('error', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!job) return fail(c, 404, 'not_found', 'Job not found.');
  if (job.claimed_at) return fail(c, 409, 'not_pending', 'Already saving.');

  const adapter = adapterFor(gen.family_id);
  if (adapter.cancel && job.provider_ref && job.provider_ref !== 'inline') {
    try {
      await adapter.cancel(job.provider_ref);
    } catch (e) {
      logError(c, 'provider_cancel_failed', e);
    }
  }
  const { error } = await admin.rpc('fn_fail_job', { p_job: job.id, p_error: 'cancelled' });
  if (error) return fail(c, 500, 'cancel_failed', error.message);

  const { data: settled } = await admin
    .from('generations')
    .select('status')
    .eq('id', generationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (settled?.status !== 'failed') return fail(c, 409, 'not_pending', 'This video already finished.');

  return c.json({ refundedCredits: Number(gen.price_credits), credits: await creditsOf(userId) });
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
): Promise<{ parentVideoUrl?: string; interactionId?: string } | 'bad_parent' | null> {
  if (!needsParent) return null;
  if (!parentId) return 'bad_parent';
  const { data: parent } = await admin
    .from('generations')
    .select('id,kind,status,media_path,storage_backend,settings,family_id')
    .eq('id', parentId)
    .eq('user_id', userId)
    .maybeSingle();
  const usable = parent && parent.kind === MediaKind.Video && parent.status === 'done' && parent.media_path;
  if (!usable) return 'bad_parent';
  // Veo can only continue its own clips — it takes the parent as inline media it
  // generated, not an arbitrary MP4.
  if (family.id === 'veo' && parent.family_id !== 'veo') return 'bad_parent';
  const parentVideoUrl = await signStored(parent.storage_backend as StorageBackend, parent.media_path, REF_SIGN_TTL_S);
  const parentInteraction = (parent.settings as GenerationSettings | null)?.interactionId;
  const omniContinuation = family.id === 'omni' && parent.family_id === 'omni' && !!parentInteraction;
  return { parentVideoUrl, interactionId: omniContinuation ? parentInteraction : undefined };
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
  const mode = settings.mode ?? 't2v';
  if (!videoFamilySupports(family, mode)) {
    return fail(c, 400, 'unsupported_mode', "This model can't do that mode.");
  }
  const rule = referenceRule(mode);
  const rawRefs = Array.isArray(body.referencePaths) ? body.referencePaths : [];
  const referencePaths = rawRefs.filter((p): p is string => typeof p === 'string' && UPLOAD_PATH.test(p));
  if (referencePaths.length !== rawRefs.length || referencePaths.length < rule.min || referencePaths.length > rule.max) {
    return fail(c, 400, 'bad_reference_count', `${mode} needs ${rule.min}–${rule.max} reference image(s).`);
  }
  if (referencePaths.some((p) => !p.startsWith(`${userId}/`))) {
    return fail(c, 400, 'bad_reference_count', 'Reference does not belong to you.');
  }

  const prep: VideoPrep = { mode, referencePaths, referenceUrls: [] };

  const parentResult = await resolveParentVideo(userId, family, parentId, rule.needsParent);
  if (parentResult === 'bad_parent') return fail(c, 400, 'bad_parent', 'Pick a finished video to extend or edit.');
  if (parentResult) Object.assign(prep, parentResult);

  const { count: pendingCount, error: pendingErr } = await admin
    .from('generations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', MediaKind.Video)
    .eq('status', 'pending');
  if (pendingErr) return fail(c, 503, 'cap_check_failed', 'Could not verify your video limits. Try again.');
  if (videoJobCapReached(pendingCount ?? 0)) {
    return fail(c, 429, 'too_many_jobs', '3 videos are still rendering — wait for one to finish');
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: recentErr } = await admin
    .from('generations')
    .select('price_credits,created_at')
    .eq('user_id', userId)
    .eq('kind', MediaKind.Video)
    .neq('status', 'failed')
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (recentErr) return fail(c, 503, 'cap_check_failed', 'Could not verify your video limits. Try again.');
  const spentUsd = (recent ?? []).reduce((sum, r) => sum + Number(r.price_credits), 0) * (1 - STUDIO_MARGIN) / 100;
  const oldest = recent?.[0]?.created_at ? new Date(recent[0].created_at) : null;
  const cap = dailyCapState(spentUsd, oldest, new Date());
  if (cap.blocked) {
    return c.json({ error: { code: 'daily_cap', message: 'Daily video limit reached.', resetsAt: cap.resetsAt } }, 429);
  }

  for (const path of referencePaths) {
    const { data: signed, error } = await admin.storage.from('uploads').createSignedUrl(path, REF_SIGN_TTL_S);
    if (error || !signed) return fail(c, 400, 'bad_reference_count', 'Reference upload not found.');
    const mod = await moderate({ imageUrl: signed.signedUrl });
    if (mod.flagged) {
      await recordStrike(userId, 'upload', null, mod.categories, path);
      return fail(c, 422, 'content_policy', 'A reference image was blocked by moderation.');
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

app.post('/generations', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  if (!body) return fail(c, 400, 'invalid_payload', 'JSON body required');

  const op = body.op as string;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  let batch = Number.isInteger(body.batch) ? (body.batch as number) : 1;
  const settings = sanitizeSettings(body.settings);
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;
  const styleId = typeof body.style === 'string' && body.style ? body.style : null;
  const personaId = typeof body.personaId === 'string' && body.personaId ? body.personaId : null;
  const trendId = sanitizeLabel(body.trendId, 40);

  if (!Object.values(GenerationOp).includes(op as never)) {
    return fail(c, 400, 'invalid_op', `op must be one of ${Object.values(GenerationOp).join(', ')}`);
  }
  if (!prompt) return fail(c, 400, 'invalid_prompt', 'Prompt required');
  if (prompt.length > MAX_PROMPT_LEN) {
    return fail(c, 400, 'invalid_prompt', `Prompt too long (max ${MAX_PROMPT_LEN} characters)`);
  }
  if (batch < 1 || batch > 4) return fail(c, 400, 'invalid_batch', 'batch must be 1–4');
  if (styleId && !styleById(styleId)) {
    return fail(c, 400, 'invalid_style', 'Unknown style preset');
  }
  const styled = applyStyle(prompt, styleId);
  if ((op === GenerationOp.Edit || op === GenerationOp.Upscale) && !parentId) {
    return fail(c, 400, 'invalid_parent', `${op} requires parentId`);
  }

  // Suspension shield (2 strikes = out).
  if (await isSuspended(userId)) {
    return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
  }

  // Subscription gate: no active plan, no generation of any kind.
  const plan = await activePlan(userId);
  if (!plan) {
    return fail(c, 403, 'subscription_required', 'An active subscription is required to generate.');
  }

  // Persona: owned + ready, generate-op only. Routes to the hidden flux-lora family.
  let persona: { lora_url: string; trigger_word: string } | null = null;
  if (personaId) {
    if (op !== GenerationOp.Generate) {
      return fail(c, 400, 'invalid_op', 'Personas support generate only');
    }
    const { data } = await admin
      .from('personas')
      .select('status, lora_url, trigger_word')
      .eq('id', personaId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!data || data.status !== 'ready' || !data.lora_url) {
      return fail(c, 400, 'persona_not_ready', 'Persona not found or not ready');
    }
    persona = { lora_url: data.lora_url, trigger_word: data.trigger_word ?? '' };
  }

  // Boosted prompt is what moderation and the provider see; the stored prompt
  // stays the user's text. Persona trigger word leads so the LoRA locks on.
  const effectivePrompt = persona ? `${persona.trigger_word}, ${styled}` : styled;

  let familyId: string;
  let familyName: string;
  let kind: string;
  let unitCredits: number;

  if (op === GenerationOp.Upscale) {
    familyId = UPSCALER.id;
    familyName = UPSCALER.name;
    kind = MediaKind.Image;
    unitCredits = upscaleCreditCost();
  } else if (persona) {
    familyId = PERSONA_GEN.id;
    familyName = PERSONA_GEN.name;
    kind = MediaKind.Image;
    unitCredits = personaGenCreditCost();
  } else {
    const editTool = editToolById(String(body.familyId ?? ''));
    if (editTool) {
      // Studio panel AI tool — fixed credit price, edit op only.
      if (op !== GenerationOp.Edit) return fail(c, 400, 'invalid_op', 'Edit tools use op=edit');
      if (editTool.needsMask && typeof body.maskPngBase64 !== 'string') {
        return fail(c, 400, 'invalid_payload', `${editTool.name} requires a mask`);
      }
      familyId = editTool.id;
      familyName = editTool.name;
      kind = MediaKind.Image;
      unitCredits = editTool.creditCost; // fixed — no margin formula
    } else {
      const family = familyById(String(body.familyId ?? ''));
      if (!family) return fail(c, 400, 'invalid_family', 'Unknown model family');
      if (family.kind === MediaKind.Video && op !== GenerationOp.Generate && op !== GenerationOp.Variation) {
        return fail(c, 400, 'invalid_op', 'Video supports generate/variation only');
      }
      if (family.kind === MediaKind.Video && plan === 'studio') {
        return fail(c, 403, 'pro_required', 'Video models require the Pro plan.');
      }
      familyId = family.id;
      familyName = family.name;
      kind = family.kind;
      unitCredits = creditCost(family, settings);
    }
  }

  // Kill switch + per-model plan floor.
  const gate = await modelGate(familyId);
  if (!gate.enabled) {
    return fail(c, 503, 'model_disabled', 'This model is temporarily unavailable.');
  }
  if (gate.minPlan === 'pro' && plan === 'studio') {
    return fail(c, 403, 'pro_required', 'This model requires the Pro plan.');
  }

  // Moderation gate — BEFORE charge and BEFORE any provider call.
  const mod = await moderate({ text: effectivePrompt });
  if (mod.flagged) {
    await recordStrike(userId, 'prompt', prompt, mod.categories);
    return fail(c, 422, 'content_policy', 'This prompt violates our content policy.');
  }

  const videoResult = await resolveVideoPrep(c, userId, kind, familyId, settings, body as Record<string, unknown>, parentId);
  if (videoResult instanceof Response) return videoResult;
  const video = videoResult;
  if (video) batch = 1;

  // Resolve reference (parent generation or uploaded image) to a signed URL.
  let referenceUrl: string | undefined;
  const referenceUploadId = typeof body.referenceUploadId === 'string' ? body.referenceUploadId : null;
  if (parentId && !video) {
    const { data: parent } = await admin
      .from('generations')
      .select('media_path')
      .eq('id', parentId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!parent) return fail(c, 404, 'not_found', 'Parent generation not found');
    referenceUrl = await signMedia(parent.media_path);
  } else if (referenceUploadId) {
    const { data } = await admin.storage.from('uploads').createSignedUrl(referenceUploadId, 3600);
    referenceUrl = data?.signedUrl ?? undefined;
  }

  const total = unitCredits * batch;
  const ledgerType = op === GenerationOp.Variation ? LedgerType.Generate : (op as LedgerType);
  const note = batch > 1 ? `${familyName} ×${batch}` : familyName;

  if (styleId) settings.style = styleId;
  if (personaId && persona) settings.persona = personaId;
  if (trendId) settings.trend = trendId;

  const items = Array.from({ length: batch }, () => ({
    kind,
    familyId,
    familyName,
    op,
    prompt,
    settings,
    priceCredits: unitCredits,
    mediaUrl: '', // filled when the provider job completes
    parentId,
    client: clientOf(c) ?? '',
  }));

  const { data, error } = await admin.rpc('fn_charge_and_generate', {
    p_user: userId,
    p_amount: total,
    p_type: ledgerType,
    p_family_id: familyId,
    p_note: note,
    p_items: items,
  });
  if (error) {
    if (error.message.includes('insufficient_balance')) {
      return fail(c, 402, 'insufficient_credits', 'Not enough credits for this run');
    }
    logError(c, 'charge_failed', new Error(error.message));
    return fail(c, 400, 'charge_failed', 'Charge could not be completed');
  }

  // Dispatch each generation to its provider.
  const adapter = adapterFor(familyId);
  const sid = await safetyId(userId);
  const created = (data ?? []) as Record<string, unknown>[];
  for (const gen of created) {
    const genId = gen.id as string;
    const { data: jobRow } = await admin
      .from('jobs')
      .insert({ generation_id: genId, user_id: userId, provider: adapter.provider })
      .select('id')
      .single();
    try {
      const submitted: SubmitResult = await adapter.submit({
        familyId,
        op,
        prompt: effectivePrompt,
        settings: { ...settings },
        referenceUrl,
        maskPngBase64: typeof body.maskPngBase64 === 'string' ? body.maskPngBase64 : undefined,
        loraUrl: persona?.lora_url,
        safetyId: sid,
        mode: video?.mode,
        referenceUrls: video?.referenceUrls,
        parentVideoUrl: video?.parentVideoUrl,
        interactionId: video?.interactionId,
      });
      await admin.from('jobs').update({ provider_ref: submitted.providerRef }).eq('id', jobRow!.id);
      if (submitted.interactionId) {
        await admin
          .from('generations')
          .update({ settings: { ...settings, interactionId: submitted.interactionId } })
          .eq('id', genId);
      }
      if (submitted.inline) {
        await finishJob({ id: jobRow!.id, user_id: userId, generation_id: genId }, submitted.inline);
      }
    } catch (e) {
      logError(c, 'provider_submit_failed', e);
      await admin.rpc('fn_fail_job', { p_job: jobRow!.id, p_error: String(e).slice(0, 500) });
      notifySettled(userId, genId, 'generation_failed');
    }
  }

  const { data: finalRows } = await admin
    .from('generations')
    .select('*')
    .in('id', created.map((g) => g.id));
  return c.json({ items: await toGenerationDtos(finalRows ?? []), credits: await creditsOf(userId) });
});

app.post('/billing/subscribe', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const plan = body.plan === 'pro' ? 'pro' : body.plan === 'studio' ? 'studio' : null;
  if (!plan) return fail(c, 400, 'invalid_plan', 'plan must be studio or pro');
  const { data: ownSub } = await admin
    .from('subscriptions')
    .select('plan, status, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (ownSub?.plan === 'owner' && ownSub.status === 'active') {
    return fail(c, 400, 'owner_plan', 'Owner accounts have unlimited credits');
  }
  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    // Ask Stripe, not our mirror. The `subscriptions` table is written only by the
    // webhook, so it lags (or, if the webhook failed, never arrives) and it holds one
    // row per user — a second subscription would overwrite the first and bill twice
    // with nothing to show for it. Stripe Checkout does not dedupe subscriptions
    // itself, so this is the only thing standing between a double click and a
    // double charge.
    const history = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    // "Billing" is wider than our 'active': past_due/unpaid are still in dunning, and
    // a cancel_at_period_end sub is plain `active` here — it charges until it lapses.
    const billing = history.data.filter((s) =>
      s.status === 'active' || s.status === 'trialing' || s.status === 'past_due' || s.status === 'unpaid',
    );
    if (billing.length > 0) {
      return fail(c, 400, 'already_subscribed', 'Use the billing portal to change plans');
    }
    // Launch promo: first-time subscribers only. Keyed off Stripe's full history
    // rather than the mirror, so a missing row cannot hand out the coupon twice.
    const firstTime = history.data.length === 0;
    const returns = checkoutReturnUrls(c, body);
    const session = await stripe.checkout.sessions.create({
      customer,
      mode: 'subscription',
      line_items: [{ price: PLAN_PRICE_IDS[plan]!, quantity: 1 }],
      discounts: firstTime && LAUNCH_COUPON_ID ? [{ coupon: LAUNCH_COUPON_ID }] : undefined,
      success_url: returns.success,
      cancel_url: returns.cancel,
      metadata: { user_id: userId, plan },
      subscription_data: { metadata: { user_id: userId, plan } },
    });
    return c.json({ url: session.url });
  } catch (e) {
    logError(c, 'subscribe_failed', e);
    return fail(c, 400, 'billing_failed', 'Could not start checkout');
  }
});

app.post('/billing/pack', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const usd = Number(body.usd);
  const plan = await activePlan(userId);
  if (!plan) return fail(c, 403, 'subscription_required', 'Packs are for active subscribers.');
  if (plan === 'owner') return fail(c, 400, 'owner_plan', 'Owner accounts have unlimited credits');
  if (!CREDIT_PACKS.some((p) => p.usd === usd)) {
    return fail(c, 400, 'invalid_amount', `usd must be one of ${CREDIT_PACKS.map((p) => p.usd).join(', ')}`);
  }
  const credits = packCredits(usd, plan);
  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    const returns = checkoutReturnUrls(c, body);
    const session = await stripe.checkout.sessions.create({
      customer,
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Vansen credit pack — ${credits.toLocaleString()} credits` },
          unit_amount: usd * 100,
        },
        quantity: 1,
      }],
      success_url: returns.success,
      cancel_url: returns.cancel,
      metadata: { user_id: userId, pack_usd: String(usd), pack_credits: String(credits) },
    });
    return c.json({ url: session.url });
  } catch (e) {
    logError(c, 'pack_failed', e);
    return fail(c, 400, 'billing_failed', 'Could not start checkout');
  }
});

/**
 * Studio <-> Pro. Swaps the price on the EXISTING subscription rather than
 * cancelling and re-creating: one subscription per customer is what keeps the
 * double-billing guard in /billing/subscribe meaningful.
 *
 * when='now' restarts the billing cycle today (unused time on the old plan is
 * prorated back), so invoice.paid fires and fn_cycle_reset lands the new grant.
 * when='period_end' books a Stripe Subscription Schedule; the swap happens at
 * renewal and that cycle's invoice.paid carries the new grant.
 *
 * Downgrades are period_end only, and that is enforced HERE rather than in the
 * dialog: an immediate downgrade makes fn_cycle_reset compute a negative delta
 * (1500 - 3000 = -1500) and silently delete credits the user paid Pro prices for.
 */
app.post('/billing/change-plan', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const plan = body.plan === 'pro' ? 'pro' : body.plan === 'studio' ? 'studio' : null;
  const when = body.when === 'now' ? 'now' : body.when === 'period_end' ? 'period_end' : null;
  if (!plan) return fail(c, 400, 'invalid_plan', 'plan must be studio or pro');
  if (!when) return fail(c, 400, 'invalid_when', 'when must be now or period_end');

  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    const list = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    const sub = list.data.find(
      (s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due',
    );
    if (!sub) return fail(c, 400, 'no_subscription', 'Start a subscription before changing plans');

    const currentPlan = sub.items.data[0]?.price?.id === PLAN_PRICE_IDS.pro ? 'pro' : 'studio';
    if (currentPlan === plan) return fail(c, 400, 'same_plan', `You are already on ${plan}`);
    const downgrade = currentPlan === 'pro' && plan === 'studio';
    if (downgrade && when === 'now') {
      return fail(c, 400, 'downgrade_at_period_end', 'Downgrades take effect at your renewal date');
    }
    // A schedule cannot ride on a subscription that is already set to stop.
    if (sub.cancel_at_period_end && when === 'period_end') {
      return fail(c, 400, 'subscription_ending', 'Resume your subscription in Billing before scheduling a change');
    }

    const scheduleId = typeof sub.schedule === 'string' ? sub.schedule : (sub.schedule?.id ?? null);
    if (scheduleId && when === 'period_end') {
      return fail(c, 400, 'already_scheduled', 'A plan change is already scheduled for your renewal');
    }

    const itemId = sub.items.data[0]!.id;
    if (when === 'now') {
      // "Start now" overrides a change booked earlier: a schedule-managed
      // subscription rejects direct updates, so hand it back to normal billing
      // before swapping the price.
      if (scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: itemId, price: PLAN_PRICE_IDS[plan]! }],
        proration_behavior: 'create_prorations',
        billing_cycle_anchor: 'now',
        cancel_at_period_end: false,
        metadata: { user_id: userId, plan },
      });
      // Mirror the swap synchronously: the workspace reloads /profile the moment
      // this returns, and waiting for the webhook leaves it showing the old plan
      // (and its subscribe CTA) until a manual refresh. Credits still land via
      // invoice.paid — only the plan/status mirror is written here.
      const periodEndEpoch =
        (updated as { current_period_end?: number }).current_period_end ??
        (updated.items?.data?.[0] as { current_period_end?: number } | undefined)
          ?.current_period_end;
      await admin
        .from('subscriptions')
        .update({
          plan,
          status: 'active',
          stripe_subscription_id: updated.id,
          ...(periodEndEpoch
            ? { current_period_end: new Date(periodEndEpoch * 1000).toISOString() }
            : {}),
          pending_plan: null,
          pending_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
      return c.json({ plan, effectiveAt: null });
    }

    const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
    const current = schedule.phases[0]!;
    await stripe.subscriptionSchedules.update(schedule.id, {
      // release hands the subscription back to normal billing once the new phase
      // starts; without it the schedule would cancel the sub when it runs out.
      end_behavior: 'release',
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
      .from('subscriptions')
      .update({ pending_plan: plan, pending_at: effectiveAt })
      .eq('user_id', userId);
    return c.json({ plan, effectiveAt });
  } catch (e) {
    logError(c, 'change_plan_failed', e);
    return fail(c, 400, 'billing_failed', 'Could not change your plan');
  }
});

app.get('/billing/lane', (c) => {
  const platform = c.req.query('platform') === 'ios' ? 'ios' : 'android';
  const storefront = (c.req.query('storefront') ?? '').toUpperCase();
  const laneBEnabled = Deno.env.get('LANE_B') === 'on';
  return c.json({ lane: laneFor(platform, storefront, laneBEnabled) });
});

/**
 * One call for everything the Subscription tab shows beyond our own mirror:
 * next invoice, card on file, and whether the sub is set to stop. All read
 * straight from Stripe — the mirror only knows plan/status/period-end.
 */
app.get('/billing/overview', async (c) => {
  const userId = c.get('userId');
  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    const list = await stripe.subscriptions.list({
      customer,
      status: 'all',
      limit: 100,
      expand: ['data.default_payment_method'],
    });
    const sub = list.data.find(
      (s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due',
    );
    if (!sub) return c.json({ cancelAtPeriodEnd: false, upcoming: null, paymentMethod: null });

    let upcoming: { amountUsd: number; date: string | null } | null = null;
    if (!sub.cancel_at_period_end) {
      try {
        const invoice = await stripe.invoices.retrieveUpcoming({ customer });
        const epoch = invoice.next_payment_attempt ?? invoice.period_end ?? null;
        upcoming = {
          amountUsd: Math.round(invoice.amount_due) / 100,
          date: epoch ? new Date(epoch * 1000).toISOString() : null,
        };
      } catch {
        // No upcoming invoice is a normal state, not an error.
      }
    }

    const pm = sub.default_payment_method;
    const card = pm && typeof pm !== 'string' ? pm.card : null;
    return c.json({
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      upcoming,
      paymentMethod: card ? { brand: card.brand, last4: card.last4 } : null,
    });
  } catch (e) {
    logError(c, 'overview_failed', e);
    return fail(c, 400, 'billing_failed', 'Could not load billing details');
  }
});

/**
 * In-app cancellation (at period end, never immediate — the user keeps what
 * they paid for). The reason is required by the UI and stored on the Stripe
 * subscription's metadata, where the dashboard shows it next to the churn.
 */
app.post('/billing/cancel', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 120) : '';
  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    const list = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    const sub = list.data.find(
      (s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due',
    );
    if (!sub) return fail(c, 400, 'no_subscription', 'No active subscription to cancel');
    if (sub.cancel_at_period_end) return c.json({ cancelAtPeriodEnd: true });

    // A schedule-managed sub rejects direct updates; a booked plan change dies
    // with the cancellation anyway, so release it (and its reminder) first.
    const scheduleId = typeof sub.schedule === 'string' ? sub.schedule : (sub.schedule?.id ?? null);
    if (scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
    await stripe.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
      metadata: { ...sub.metadata, cancel_reason: reason },
    });
    await admin
      .from('subscriptions')
      .update({
        status: 'canceled',
        cancel_reason: reason || null,
        pending_plan: null,
        pending_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
    return c.json({ cancelAtPeriodEnd: true });
  } catch (e) {
    logError(c, 'cancel_failed', e);
    return fail(c, 400, 'billing_failed', 'Could not cancel your subscription');
  }
});

/** Undo a pending cancellation — billing continues as if nothing happened. */
app.post('/billing/resume', async (c) => {
  const userId = c.get('userId');
  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    const list = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    const sub = list.data.find(
      (s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due',
    );
    if (!sub) return fail(c, 400, 'no_subscription', 'No subscription to resume');
    if (sub.cancel_at_period_end) {
      await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    }
    await admin
      .from('subscriptions')
      .update({ status: 'active', cancel_reason: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    return c.json({ cancelAtPeriodEnd: false });
  } catch (e) {
    logError(c, 'resume_failed', e);
    return fail(c, 400, 'billing_failed', 'Could not resume your subscription');
  }
});

app.post('/billing/portal', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const customer = await stripeCustomerFor(c.get('userId'), c.get('email'));
    const returnUrl = body.platform === 'mobile'
      ? 'vansen://billing-return?status=portal'
      : `${appOrigin(c)}/app/settings`;
    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: returnUrl,
    });
    return c.json({ url: portal.url });
  } catch (e) {
    logError(c, 'portal_failed', e);
    return fail(c, 400, 'billing_failed', 'Could not open billing portal');
  }
});

app.post('/billing/reconcile', async (c) => {
  const userId = c.get('userId');
  try {
    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
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
      if (s.payment_status !== 'paid') continue;
      const credits = Number(s.metadata?.pack_credits ?? 0);
      if (!credits) continue;
      const { error } = await admin.rpc('fn_grant_pack', {
        p_user: userId, p_credits: credits, p_stripe_ref: s.id,
      });
      if (!error) credited += 1; // unique(stripe_ref) bounces already-credited sessions
    }
    return c.json({ credited, credits: await creditsOf(userId) });
  } catch (e) {
    logError(c, 'reconcile_failed', e);
    return fail(c, 400, 'billing_failed', 'Reconcile failed');
  }
});

// Reconcile fallback for a dropped App Store notification: the client submits
// its own purchase JWS for server-side re-validation. The appAccountToken baked
// into the transaction must be the caller — nobody redeems another user's
// receipt. Grants are idempotent (iaptx marker + stripe_ref UNIQUE), so calling
// this after every purchase is safe and doubles as the instant-grant path.
app.post('/iap/verify', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const jws = typeof body.jws === 'string' ? body.jws : '';
  if (!jws) return fail(c, 400, 'invalid_input', 'Missing jws');
  try {
    const tx = await appleVerifier().verifyAndDecodeTransaction(jws);
    if (tx.appAccountToken !== userId) {
      return fail(c, 403, 'forbidden', 'Receipt belongs to another account');
    }
    const granted = await applyIapTransaction(admin, userId, {
      productId: tx.productId ?? '',
      transactionId: tx.transactionId ?? '',
      originalTransactionId: tx.originalTransactionId ?? '',
      expiresDate: tx.expiresDate,
    });
    return c.json({ granted, credits: await creditsOf(userId) });
  } catch (e) {
    logError(c, 'iap_verify_failed', e);
    return fail(c, 400, 'billing_failed', 'Receipt verification failed');
  }
});

app.post('/uploads', async (c) => {
  const userId = c.get('userId');
  if (await isSuspended(userId)) {
    return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
  }
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return fail(c, 400, 'upload_failed', 'No file provided');
  if (file.size > UPLOAD_MAX_BYTES) return fail(c, 400, 'upload_failed', 'File exceeds 10MB');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = sniffImage(bytes);
  if (!ext) return fail(c, 400, 'upload_failed', 'Only PNG, JPEG, or WEBP images are allowed');

  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await admin.storage.from('uploads').upload(path, bytes, {
    contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
  });
  if (upErr) return fail(c, 400, 'upload_failed', 'Storage rejected the file');

  // Moderate the image before it can be used as a reference.
  const { data: signed } = await admin.storage.from('uploads').createSignedUrl(path, 600);
  const mod = await moderate({ imageUrl: signed?.signedUrl });
  if (mod.flagged) {
    const quarantine = `quarantine/${userId}/${crypto.randomUUID()}.${ext}`;
    await admin.storage.from('uploads').copy(path, quarantine);
    await admin.storage.from('uploads').remove([path]);
    await recordStrike(userId, 'upload', null, mod.categories, quarantine);
    return fail(c, 422, 'content_policy', 'This image violates our content policy.');
  }

  return c.json({ uploadId: path, url: signed?.signedUrl ?? '' });
});

const THUMB_MAX_BYTES = 512 * 1024;

app.post('/generations/:id/thumb', async (c) => {
  const userId = c.get('userId') as string;
  const generationId = c.req.param('id');
  const { data: gen } = await admin
    .from('generations')
    .select('id,kind,status,storage_backend,thumb_path')
    .eq('id', generationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!gen || gen.kind !== MediaKind.Video) return fail(c, 404, 'not_found', 'Video not found.');
  if (gen.status !== 'done') return fail(c, 409, 'not_ready', 'Video is not finished.');

  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return fail(c, 400, 'invalid_file', 'Missing file.');
  if (file.size > THUMB_MAX_BYTES) return fail(c, 413, 'too_large', 'Thumbnail must be ≤ 512 KB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniffImage(bytes) !== 'jpg') return fail(c, 415, 'bad_type', 'Thumbnail must be JPEG.');

  const backend = (gen.storage_backend ?? 'r2') as StorageBackend;
  const path = thumbPath(userId, generationId);
  await storageFor(backend).put(path, bytes, 'image/jpeg');
  const { error } = await admin.from('generations').update({ thumb_path: path }).eq('id', generationId);
  if (error) return fail(c, 500, 'thumb_failed', error.message);
  return c.json({ thumbUrl: await signStored(backend, path) });
});

async function toPersonaDto(row: Record<string, unknown>) {
  const photos = (row.photo_paths as string[]) ?? [];
  let thumbUrl = '';
  if (photos[0]) {
    const { data } = await admin.storage.from('uploads').createSignedUrl(photos[0], 3600);
    thumbUrl = data?.signedUrl ?? '';
  }
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    photoCount: photos.length,
    thumbUrl,
    error: row.error,
    createdAt: row.created_at,
    trainedAt: row.trained_at,
  };
}

/** List personas; lazily settle any in-flight trainings (same pattern as GET /jobs). */
app.get('/personas', async (c) => {
  const userId = c.get('userId');
  const { data: rows } = await admin
    .from('personas')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  let changed = false;
  for (const row of rows ?? []) {
    if (row.status !== 'training' || !row.provider_ref) continue;
    try {
      const check = await checkPersonaTraining(row.provider_ref);
      if (check.state === 'done') {
        await admin
          .from('personas')
          .update({ status: 'ready', lora_url: check.loraUrl, trained_at: new Date().toISOString() })
          .eq('id', row.id);
        changed = true;
      } else if (check.state === 'failed') {
        await admin.rpc('fn_fail_persona', { p_persona: row.id, p_error: check.error });
        changed = true;
      }
    } catch (e) {
      logError(c, 'persona_check_failed', e);
    }
  }
  const { data: fresh } = changed
    ? await admin.from('personas').select('*').eq('user_id', userId).order('created_at', { ascending: false })
    : { data: rows };

  const plan = await activePlan(userId);
  const max = plan ? PERSONA_SLOTS[plan] : 0;
  const items = await Promise.all((fresh ?? []).map(toPersonaDto));
  return c.json({ items, slots: { used: items.length, max } });
});

app.post('/personas', async (c) => {
  const userId = c.get('userId');
  if (await isSuspended(userId)) {
    return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
  }
  const plan = await activePlan(userId);
  if (!plan) return fail(c, 403, 'studio_required', 'Personas require an active subscription.');
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === 'string'
    ? body.name.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
    : '';
  if (!name || name.length > 40) {
    return fail(c, 400, 'invalid_payload', 'name required (max 40 chars)');
  }
  if (body?.attested !== true) {
    return fail(c, 400, 'invalid_payload', 'Consent attestation is required');
  }
  const { count } = await admin
    .from('personas')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if ((count ?? 0) >= PERSONA_SLOTS[plan]) {
    return fail(c, 403, 'slot_limit', `Your plan allows ${PERSONA_SLOTS[plan]} personas`);
  }
  const { data: row, error } = await admin
    .from('personas')
    .insert({ user_id: userId, name, client: clientOf(c) })
    .select('*')
    .single();
  if (error || !row) return fail(c, 400, 'create_failed', 'Could not create the persona');
  return c.json({ item: await toPersonaDto(row) });
});

app.delete('/personas/:id', async (c) => {
  const userId = c.get('userId');
  const { data: rows, error } = await admin
    .from('personas')
    .delete()
    .eq('id', c.req.param('id'))
    .eq('user_id', userId)
    .select('id, photo_paths');
  if (error) return fail(c, 400, 'delete_failed', error.message);
  const row = rows?.[0];
  if (!row) return fail(c, 404, 'not_found', 'Persona not found');
  const paths = [...((row.photo_paths as string[]) ?? []), `persona-zips/${userId}/${row.id}.zip`];
  await admin.storage.from('uploads').remove(paths); // best-effort cleanup
  return c.json({ ok: true });
});

/** Charge 350 credits, zip the moderated photos, submit fal LoRA training. */
app.post('/personas/:id/train', async (c) => {
  const userId = c.get('userId');
  const personaId = c.req.param('id');
  if (await isSuspended(userId)) {
    return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
  }
  if (!(await activePlan(userId))) {
    return fail(c, 403, 'studio_required', 'Personas require an active subscription.');
  }
  const body = await c.req.json().catch(() => null);
  const photoIds = Array.isArray(body?.photoUploadIds)
    ? (body.photoUploadIds as unknown[]).filter(
        (p): p is string => typeof p === 'string' && p.startsWith(`${userId}/`),
      )
    : [];
  if (
    photoIds.length < PERSONA_TRAINING.minPhotos ||
    photoIds.length > PERSONA_TRAINING.maxPhotos ||
    new Set(photoIds).size !== photoIds.length
  ) {
    return fail(
      c, 400, 'invalid_payload',
      `Between ${PERSONA_TRAINING.minPhotos} and ${PERSONA_TRAINING.maxPhotos} unique photos required`,
    );
  }

  // Fetch every photo BEFORE charging — a bad reference must not cost credits.
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < photoIds.length; i++) {
    const { data: blob, error } = await admin.storage.from('uploads').download(photoIds[i]);
    if (error || !blob) return fail(c, 400, 'invalid_payload', 'A photo could not be read');
    files[`photo_${String(i + 1).padStart(2, '0')}.jpg`] = new Uint8Array(await blob.arrayBuffer());
  }

  const { error: chargeErr } = await admin.rpc('fn_charge_persona', {
    p_user: userId,
    p_persona: personaId,
    p_amount: PERSONA_TRAINING.creditCost,
  });
  if (chargeErr) {
    if (chargeErr.message.includes('insufficient_balance')) {
      return fail(c, 402, 'insufficient_credits', 'Not enough credits for training');
    }
    if (chargeErr.message.includes('invalid_persona_status')) {
      return fail(c, 400, 'train_failed', 'Persona not found or already training');
    }
    logError(c, 'persona_charge_failed', new Error(chargeErr.message));
    return fail(c, 400, 'charge_failed', 'Charge could not be completed');
  }

  try {
    const zip = zipSync(files, { level: 0 }); // JPEGs don't compress
    const zipPath = `persona-zips/${userId}/${personaId}.zip`;
    const { error: upErr } = await admin.storage.from('uploads').upload(zipPath, zip, {
      contentType: 'application/zip',
      upsert: true,
    });
    if (upErr) throw new Error(`zip upload: ${upErr.message}`);
    const { data: signed } = await admin.storage.from('uploads').createSignedUrl(zipPath, 3600);
    if (!signed?.signedUrl) throw new Error('zip sign failed');
    const providerRef = await submitPersonaTraining(signed.signedUrl);
    await admin
      .from('personas')
      .update({ provider_ref: providerRef, photo_paths: photoIds, trigger_word: PERSONA_TRIGGER })
      .eq('id', personaId);
  } catch (e) {
    logError(c, 'persona_train_submit_failed', e);
    await admin.rpc('fn_fail_persona', { p_persona: personaId, p_error: String(e).slice(0, 500) });
    return fail(c, 502, 'train_failed', 'Training could not be started — credits refunded');
  }

  const { data: row } = await admin.from('personas').select('*').eq('id', personaId).single();
  return c.json({ item: await toPersonaDto(row!), credits: await creditsOf(userId) });
});

/** Persist a locally-edited canvas as a new $0 generation version. */
app.post('/edits/save', async (c) => {
  const userId = c.get('userId');
  if (await isSuspended(userId)) {
    return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
  }
  if (!(await activePlan(userId))) {
    return fail(c, 403, 'subscription_required', 'An active subscription is required for editing tools.');
  }
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  const parentId = String(form?.get('parentId') ?? '');
  if (!(file instanceof File)) return fail(c, 400, 'upload_failed', 'No file provided');
  if (file.size > UPLOAD_MAX_BYTES) return fail(c, 400, 'upload_failed', 'File exceeds 10MB');
  if (!parentId) return fail(c, 400, 'invalid_parent', 'parentId required');

  const { data: parent } = await admin
    .from('generations')
    .select('id,prompt,settings')
    .eq('id', parentId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!parent) return fail(c, 404, 'not_found', 'Parent generation not found');

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniffImage(bytes) !== 'png') return fail(c, 400, 'upload_failed', 'PNG required');

  // Moderation BEFORE anything persists outside quarantine reach.
  const scratch = `scratch/${userId}/${crypto.randomUUID()}.png`;
  await admin.storage.from('uploads').upload(scratch, bytes, { contentType: 'image/png' });
  const { data: signed } = await admin.storage.from('uploads').createSignedUrl(scratch, 600);
  const mod = await moderate({ imageUrl: signed?.signedUrl });
  if (mod.flagged) {
    const quarantine = `quarantine/${userId}/${crypto.randomUUID()}.png`;
    await admin.storage.from('uploads').copy(scratch, quarantine);
    await admin.storage.from('uploads').remove([scratch]);
    await recordStrike(userId, 'upload', null, mod.categories, quarantine);
    return fail(c, 422, 'content_policy', 'This image violates our content policy.');
  }
  await admin.storage.from('uploads').remove([scratch]);

  const { data: gen, error } = await admin
    .from('generations')
    .insert({
      user_id: userId,
      kind: MediaKind.Image,
      family_id: 'studio',
      family_name: 'Studio Edit',
      op: GenerationOp.Edit,
      prompt: parent.prompt,
      settings: parent.settings,
      price_credits: 0,
      status: 'done',
      media_url: '',
      parent_id: parentId,
    })
    .select('*')
    .single();
  if (error || !gen) return fail(c, 400, 'save_failed', 'Could not save the edit');

  const path = `${userId}/${gen.id}.png`;
  const { error: upErr } = await admin.storage.from('media').upload(path, bytes, {
    contentType: 'image/png',
    upsert: true,
  });
  if (upErr) {
    await admin.from('generations').delete().eq('id', gen.id);
    return fail(c, 400, 'save_failed', 'Storage rejected the file');
  }
  await admin.from('generations').update({ media_path: path }).eq('id', gen.id);
  return c.json({ item: await toGenerationDto({ ...gen, media_path: path }) });
});

/** Import a user's own image as a root $0 library item they can edit. Studio-gated. */
app.post('/library/import', async (c) => {
  const userId = c.get('userId');
  if (await isSuspended(userId)) {
    return fail(c, 429, 'account_suspended', 'Account suspended — contact support to appeal.');
  }
  if (!(await activePlan(userId))) {
    return fail(c, 403, 'subscription_required', 'An active subscription is required for editing tools.');
  }
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return fail(c, 400, 'upload_failed', 'No file provided');
  if (file.size > UPLOAD_MAX_BYTES) return fail(c, 400, 'upload_failed', 'File exceeds 10MB');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = sniffImage(bytes);
  if (!ext) return fail(c, 400, 'upload_failed', 'Only PNG, JPEG, or WEBP images are allowed');
  const contentType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

  // Moderate BEFORE the image enters the library.
  const scratch = `scratch/${userId}/${crypto.randomUUID()}.${ext}`;
  await admin.storage.from('uploads').upload(scratch, bytes, { contentType });
  const { data: signed } = await admin.storage.from('uploads').createSignedUrl(scratch, 600);
  const mod = await moderate({ imageUrl: signed?.signedUrl });
  if (mod.flagged) {
    const quarantine = `quarantine/${userId}/${crypto.randomUUID()}.${ext}`;
    await admin.storage.from('uploads').copy(scratch, quarantine);
    await admin.storage.from('uploads').remove([scratch]);
    await recordStrike(userId, 'upload', null, mod.categories, quarantine);
    return fail(c, 422, 'content_policy', 'This image violates our content policy.');
  }
  await admin.storage.from('uploads').remove([scratch]);

  const { data: gen, error } = await admin
    .from('generations')
    .insert({
      user_id: userId,
      kind: MediaKind.Image,
      family_id: 'studio',
      family_name: 'Imported',
      op: GenerationOp.Generate,
      prompt: 'Imported image',
      settings: {},
      price_credits: 0,
      status: 'done',
      media_url: '',
    })
    .select('*')
    .single();
  if (error || !gen) return fail(c, 400, 'save_failed', 'Could not import the image');

  const path = `${userId}/${gen.id}.${ext}`;
  const { error: upErr } = await admin.storage.from('media').upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (upErr) {
    await admin.from('generations').delete().eq('id', gen.id);
    return fail(c, 400, 'save_failed', 'Storage rejected the file');
  }
  await admin.from('generations').update({ media_path: path }).eq('id', gen.id);
  return c.json({ item: await toGenerationDto({ ...gen, media_path: path }) });
});

app.delete('/generations/:id', async (c) => {
  const userId = c.get('userId') as string;
  const id = c.req.param('id');
  const { data: row, error } = await admin
    .from('generations')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select('id,media_path,thumb_path,storage_backend')
    .maybeSingle();
  if (error) return fail(c, 400, 'delete_failed', error.message);
  if (!row) return fail(c, 404, 'not_found', 'Generation not found.');
  const backend = (row.storage_backend ?? 'supabase') as StorageBackend;
  const paths = [row.media_path, row.thumb_path].filter((p): p is string => !!p);
  for (const p of paths) {
    try {
      await storageFor(backend).delete(p);
    } catch (e) {
      logError(c, 'storage_delete_failed', e);
    }
  }
  return c.json({ ok: true });
});

Deno.serve(app.fetch);
