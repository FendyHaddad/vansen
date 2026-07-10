// Vansen API gateway. All data access flows through here (tables are RLS
// deny-all; RPCs are service_role-only). Client's only other Supabase surface
// is Auth. REST contract doubles as the future Java migration contract.
import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@17';
import {
  UPSCALER,
  editToolById,
  familyById,
  upscaleUserPriceUsd,
  userPriceUsd,
  type GenerationSettings,
} from './_shared/model-families.ts';
import { GenerationOp, LedgerType, MediaKind } from './_shared/enums.ts';
import { adapterFor } from './_shared/providers/index.ts';
import type { CheckResult } from './_shared/providers/types.ts';
import { moderate } from './_shared/moderation.ts';
import { safetyId } from './_shared/safety.ts';

const SUSPEND_STRIKES = 2;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
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
const STUDIO_PRICE_ID = Deno.env.get('STRIPE_STUDIO_PRICE_ID')!;
const APP_ORIGIN = 'http://localhost:4200';
const TOPUP_PRESETS = [10, 20, 50, 100];

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
  ['confirmOverUsd', (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000],
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

type Vars = { Variables: { userId: string; email: string } };
const app = new Hono<Vars>().basePath('/api');

app.use(
  '*',
  cors({
    origin: ['http://localhost:4200'],
    allowHeaders: ['authorization', 'content-type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

function fail(c: { json: (b: unknown, s: number) => Response }, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

app.use('*', async (c, next) => {
  const token = c.req.header('authorization')?.replace(/^Bearer /i, '');
  if (!token) return fail(c, 401, 'unauthorized', 'Missing token');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return fail(c, 401, 'unauthorized', 'Invalid token');
  c.set('userId', data.user.id);
  c.set('email', data.user.email ?? '');
  await next();
});

const round2 = (v: number) => Math.round(v * 100) / 100;

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
    priceUsd: Number(row.price_usd),
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

async function modelEnabled(familyId: string): Promise<boolean> {
  const { data } = await admin.from('models').select('enabled').eq('id', familyId).maybeSingle();
  return data?.enabled ?? false;
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

/** Upload finished bytes to private storage, flip the generation done. */
async function finishJob(
  job: { id: string; user_id: string; generation_id: string },
  result: CheckResult,
): Promise<void> {
  if (result.state === 'running') return;
  if (result.state === 'failed') {
    await admin.rpc('fn_fail_job', { p_job: job.id, p_error: result.error });
    return;
  }
  const path = `${job.user_id}/${job.generation_id}.png`;
  await admin.storage.from('media').upload(path, result.bytes, {
    contentType: result.contentType,
    upsert: true,
  });
  await admin.from('generations').update({ status: 'done', media_path: path }).eq('id', job.generation_id);
  await admin.from('jobs').update({ updated_at: new Date().toISOString() }).eq('id', job.id);
}

function toLedgerDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: row.type,
    amountUsd: Number(row.amount_usd),
    familyId: row.family_id,
    note: row.note,
    createdAt: row.created_at,
  };
}

async function balanceOf(userId: string): Promise<number> {
  const { data, error } = await admin.rpc('fn_balance', { p_user: userId });
  if (error) throw error;
  return Number(data ?? 0);
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

async function hasActiveStudio(userId: string): Promise<boolean> {
  const { data } = await admin
    .from('subscriptions')
    .select('status,current_period_end')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data || data.status !== 'active') return false;
  return !data.current_period_end || new Date(data.current_period_end) > new Date();
}

app.get('/profile', async (c) => {
  const userId = c.get('userId');
  const [{ data: profile, error }, balanceUsd, { data: subscription }] = await Promise.all([
    admin.from('profiles').select('*').eq('id', userId).single(),
    balanceOf(userId),
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
    },
    balanceUsd,
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
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

app.delete('/profile', async (c) => {
  const userId = c.get('userId');
  // Cancel any live Stripe subscription first — no charges to dead accounts
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
      console.error('subscription cancel on delete failed:', e);
      return fail(c, 400, 'delete_failed', 'Could not cancel Studio — try again');
    }
  }
  const { error } = await admin.rpc('fn_delete_account', { p_user: userId });
  if (error) return fail(c, 400, 'delete_failed', error.message);
  const { error: authError } = await admin.auth.admin.deleteUser(userId);
  if (authError) return fail(c, 400, 'delete_failed', authError.message);
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
      await admin.rpc('fn_fail_job', { p_job: job.id, p_error: String(e).slice(0, 500) });
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

  let familyId: string;
  let familyName: string;
  let kind: string;
  let unitPrice: number;

  if (op === GenerationOp.Upscale) {
    familyId = UPSCALER.id;
    familyName = UPSCALER.name;
    kind = MediaKind.Image;
    unitPrice = round2(upscaleUserPriceUsd());
  } else {
    const editTool = editToolById(String(body.familyId ?? ''));
    if (editTool) {
      // Studio panel AI tool — fixed retail price, edit op only, Studio members only.
      if (op !== GenerationOp.Edit) return fail(c, 400, 'invalid_op', 'Edit tools use op=edit');
      if (!(await hasActiveStudio(userId))) {
        return fail(c, 403, 'studio_required', 'Studio subscription required for editing tools.');
      }
      if (editTool.needsMask && typeof body.maskPngBase64 !== 'string') {
        return fail(c, 400, 'invalid_payload', `${editTool.name} requires a mask`);
      }
      familyId = editTool.id;
      familyName = editTool.name;
      kind = MediaKind.Image;
      unitPrice = editTool.userPriceUsd; // fixed retail — no rounding drift
    } else {
      const family = familyById(String(body.familyId ?? ''));
      if (!family) return fail(c, 400, 'invalid_family', 'Unknown model family');
      if (family.kind === MediaKind.Video && op !== GenerationOp.Generate && op !== GenerationOp.Variation) {
        return fail(c, 400, 'invalid_op', 'Video supports generate/variation only');
      }
      familyId = family.id;
      familyName = family.name;
      kind = family.kind;
      unitPrice = round2(userPriceUsd(family, settings));
    }
  }

  // Kill switch.
  if (!(await modelEnabled(familyId))) {
    return fail(c, 503, 'model_disabled', 'This model is temporarily unavailable.');
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

  const total = round2(unitPrice * batch);
  const ledgerType = op === GenerationOp.Variation ? LedgerType.Generate : (op as LedgerType);
  const note = batch > 1 ? `${familyName} ×${batch}` : familyName;

  const items = Array.from({ length: batch }, () => ({
    kind,
    familyId,
    familyName,
    op,
    prompt,
    settings,
    priceUsd: unitPrice,
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
      return fail(c, 402, 'insufficient_balance', 'Balance too low for this run');
    }
    console.error('charge_failed:', error.message);
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
      await admin.rpc('fn_fail_job', { p_job: jobRow!.id, p_error: String(e).slice(0, 500) });
    }
  }

  const { data: finalRows } = await admin
    .from('generations')
    .select('*')
    .in('id', created.map((g) => g.id));
  const balanceUsd = await balanceOf(userId);
  return c.json({ items: await toGenerationDtos(finalRows ?? []), balanceUsd });
});

app.post('/billing/checkout', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const studioOnly = body.studioOnly === true;
  const creditsUsd = Number(body.creditsUsd);
  if (!studioOnly && !TOPUP_PRESETS.includes(creditsUsd)) {
    return fail(c, 400, 'invalid_amount', `creditsUsd must be one of ${TOPUP_PRESETS.join(', ')} (min $10)`);
  }
  try {
    const customer = await stripeCustomerFor(userId, c.get('email'));
    const active = await hasActiveStudio(userId);
    const needsStudio = studioOnly || !active;

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    if (needsStudio) lineItems.push({ price: STUDIO_PRICE_ID, quantity: 1 });
    if (!studioOnly) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Vansen generation credits' },
          unit_amount: creditsUsd * 100,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer,
      mode: needsStudio ? 'subscription' : 'payment',
      line_items: lineItems,
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/app?checkout=success`,
      cancel_url: `${APP_ORIGIN}/app?checkout=canceled`,
      metadata: { user_id: userId, credits_usd: studioOnly ? '0' : String(creditsUsd) },
      subscription_data: needsStudio ? { metadata: { user_id: userId } } : undefined,
    });
    return c.json({ url: session.url });
  } catch (e) {
    console.error('checkout_failed:', e);
    return fail(c, 400, 'billing_failed', 'Could not start checkout');
  }
});

app.post('/billing/portal', async (c) => {
  try {
    const customer = await stripeCustomerFor(c.get('userId'), c.get('email'));
    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${APP_ORIGIN}/app/settings`,
    });
    return c.json({ url: portal.url });
  } catch (e) {
    console.error('portal_failed:', e);
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
      return c.json({ credited: 0, balanceUsd: await balanceOf(userId) });
    }
    const sessions = await stripe.checkout.sessions.list({
      customer: profile.stripe_customer_id,
      limit: 100,
    });
    let credited = 0;
    for (const s of sessions.data) {
      if (s.payment_status !== 'paid') continue;
      const credits = Number(s.metadata?.credits_usd ?? 0);
      if (!credits) continue;
      const { error } = await admin.from('ledger_entries').insert({
        user_id: userId,
        type: 'topup',
        amount_usd: credits,
        note: 'Top-up (reconciled)',
        stripe_ref: s.id,
      });
      if (!error) credited += 1; // unique(stripe_ref) bounces already-credited sessions
    }
    return c.json({ credited, balanceUsd: await balanceOf(userId) });
  } catch (e) {
    console.error('reconcile_failed:', e);
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
  if (!(await hasActiveStudio(userId))) {
    return fail(c, 403, 'studio_required', 'Studio subscription required for editing tools.');
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
      price_usd: 0,
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
  if (!(await hasActiveStudio(userId))) {
    return fail(c, 403, 'studio_required', 'Studio subscription required for editing tools.');
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
      price_usd: 0,
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
