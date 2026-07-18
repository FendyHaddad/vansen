// Vansen API gateway. All data access flows through here (tables are RLS
// deny-all; RPCs are service_role-only). Client's only other Supabase surface
// is Auth. REST contract doubles as the future Java migration contract.
import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import {
  CREDIT_PACKS,
  UPSCALER,
  creditCost,
  editToolById,
  familyById,
  packCredits,
  upscaleCreditCost,
  type GenerationSettings,
} from './_shared/model-families.ts';
import { GenerationOp, LedgerType, MediaKind } from './_shared/enums.ts';
import { adapterFor } from './_shared/providers/index.ts';
import type { CheckResult } from './_shared/providers/types.ts';
import { moderate } from './_shared/moderation.ts';
import { safetyId } from './_shared/safety.ts';
import { parseServiceAccount, sendGenerationPush, type PushEvent } from './_shared/push.ts';
import { laneFor } from './_shared/billing-lanes.ts';

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
  return clean;
}

const PREF_CHECKS: ReadonlyArray<readonly [string, (v: unknown) => boolean]> = [
  ['defaultMode', (v) => v === 'image' || v === 'video'],
  ['defaultImageFamily', (v) => typeof v === 'string' && v.length <= 40],
  ['defaultVideoFamily', (v) => typeof v === 'string' && v.length <= 40],
  ['defaultAspect', (v) => typeof v === 'string' && v.length <= 10],
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
    allowHeaders: ['authorization', 'content-type'],
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

async function toGenerationDto(row: Record<string, unknown>) {
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
    mediaUrl: await signMedia((row.media_path as string) ?? null),
    parentId: row.parent_id,
    createdAt: row.created_at,
  };
}

async function toGenerationDtos(rows: Record<string, unknown>[]) {
  return Promise.all(rows.map(toGenerationDto));
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

/** Upload finished bytes to private storage, flip the generation done. */
async function finishJob(
  job: { id: string; user_id: string; generation_id: string },
  result: CheckResult,
): Promise<void> {
  if (result.state === 'running') return;
  if (result.state === 'failed') {
    await admin.rpc('fn_fail_job', { p_job: job.id, p_error: result.error });
    notifySettled(job.user_id, job.generation_id, 'generation_failed');
    return;
  }
  const path = `${job.user_id}/${job.generation_id}.png`;
  await admin.storage.from('media').upload(path, result.bytes, {
    contentType: result.contentType,
    upsert: true,
  });
  await admin.from('generations').update({ status: 'done', media_path: path }).eq('id', job.generation_id);
  await admin.from('jobs').update({ updated_at: new Date().toISOString() }).eq('id', job.id);
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

app.get('/jobs', async (c) => {
  const userId = c.get('userId');
  const idsParam = c.req.query('ids') ?? '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (ids.length === 0) return c.json({ items: [] });

  const { data: jobs } = await admin
    .from('jobs')
    .select('id,user_id,generation_id,provider_ref,error')
    .eq('user_id', userId)
    .in('generation_id', ids);

  for (const job of jobs ?? []) {
    if (job.error || !job.provider_ref) continue;
    // Skip inline providers already resolved at submit; only poll real refs.
    if (job.provider_ref === 'inline') continue;
    const { data: gen } = await admin
      .from('generations')
      .select('status,family_id')
      .eq('id', job.generation_id)
      .single();
    if (!gen || gen.status !== 'pending') continue;
    try {
      const result = await adapterFor(gen.family_id).check(job.provider_ref);
      await finishJob(job, result);
    } catch (e) {
      logError(c, 'provider_check_failed', e);
      await admin.rpc('fn_fail_job', { p_job: job.id, p_error: String(e).slice(0, 500) });
      notifySettled(job.user_id, job.generation_id, 'generation_failed');
    }
  }

  const { data: gens } = await admin
    .from('generations')
    .select('*')
    .eq('user_id', userId)
    .in('id', ids);
  return c.json({ items: await toGenerationDtos(gens ?? []) });
});

app.post('/generations', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  if (!body) return fail(c, 400, 'invalid_payload', 'JSON body required');

  const op = body.op as string;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const batch = Number.isInteger(body.batch) ? (body.batch as number) : 1;
  const settings = sanitizeSettings(body.settings);
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;

  if (!Object.values(GenerationOp).includes(op as never)) {
    return fail(c, 400, 'invalid_op', `op must be one of ${Object.values(GenerationOp).join(', ')}`);
  }
  if (!prompt) return fail(c, 400, 'invalid_prompt', 'Prompt required');
  if (prompt.length > MAX_PROMPT_LEN) {
    return fail(c, 400, 'invalid_prompt', `Prompt too long (max ${MAX_PROMPT_LEN} characters)`);
  }
  if (batch < 1 || batch > 4) return fail(c, 400, 'invalid_batch', 'batch must be 1–4');
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

  let familyId: string;
  let familyName: string;
  let kind: string;
  let unitCredits: number;

  if (op === GenerationOp.Upscale) {
    familyId = UPSCALER.id;
    familyName = UPSCALER.name;
    kind = MediaKind.Image;
    unitCredits = upscaleCreditCost();
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
  const mod = await moderate({ text: prompt });
  if (mod.flagged) {
    await recordStrike(userId, 'prompt', prompt, mod.categories);
    return fail(c, 422, 'content_policy', 'This prompt violates our content policy.');
  }

  // Resolve reference (parent generation or uploaded image) to a signed URL.
  let referenceUrl: string | undefined;
  const referenceUploadId = typeof body.referenceUploadId === 'string' ? body.referenceUploadId : null;
  if (parentId) {
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
      const submitted = await adapter.submit({
        familyId,
        op,
        prompt,
        settings: { ...settings },
        referenceUrl,
        maskPngBase64: typeof body.maskPngBase64 === 'string' ? body.maskPngBase64 : undefined,
        safetyId: sid,
      });
      await admin.from('jobs').update({ provider_ref: submitted.providerRef }).eq('id', jobRow!.id);
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
  return c.json({ lane: laneFor(platform, storefront) });
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
  const { data, error } = await admin
    .from('generations')
    .delete()
    .eq('id', c.req.param('id'))
    .eq('user_id', c.get('userId'))
    .select('id');
  if (error) return fail(c, 400, 'delete_failed', error.message);
  if (!data?.length) return fail(c, 404, 'not_found', 'Generation not found');
  return c.json({ ok: true });
});

Deno.serve(app.fetch);
