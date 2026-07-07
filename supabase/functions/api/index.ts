// Vansen API gateway. All data access flows through here (tables are RLS
// deny-all; RPCs are service_role-only). Client's only other Supabase surface
// is Auth. REST contract doubles as the future Java migration contract.
import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  UPSCALER,
  familyById,
  upscaleUserPriceUsd,
  userPriceUsd,
  type GenerationSettings,
} from './_shared/model-families.ts';
import { GenerationOp, LedgerType, MediaKind } from './_shared/enums.ts';
// NOTE: deployed via MCP with _shared/ nested inside the function bundle;
// keep these specifiers matching the deploy layout.

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const PLACEHOLDER_MEDIA = [
  'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=640&q=80',
  'https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=640&q=80',
  'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=640&q=80',
  'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=640&q=80',
  'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=640&q=80',
  'https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=640&q=80',
];

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

const PREF_CHECKS: Record<string, (v: unknown) => boolean> = {
  defaultMode: (v) => v === 'image' || v === 'video',
  defaultImageFamily: (v) => typeof v === 'string' && v.length <= 40,
  defaultVideoFamily: (v) => typeof v === 'string' && v.length <= 40,
  defaultAspect: (v) => typeof v === 'string' && v.length <= 10,
  confirmOverUsd: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000,
};

/** Whitelist prefs: unknown keys dropped, invalid values reject the request. */
function sanitizePrefs(raw: Record<string, unknown>): Record<string, unknown> | null {
  const clean: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(PREF_CHECKS)) {
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

function toGenerationDto(row: Record<string, unknown>) {
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
    mediaUrl: row.media_url,
    parentId: row.parent_id,
    createdAt: row.created_at,
  };
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
  return c.json({ items: (data ?? []).map(toGenerationDto) });
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
  if (parentId) {
    const { data: parent } = await admin
      .from('generations')
      .select('id')
      .eq('id', parentId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!parent) return fail(c, 404, 'not_found', 'Parent generation not found');
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

  const total = round2(unitPrice * batch);
  const ledgerType = op === GenerationOp.Variation ? LedgerType.Generate : (op as LedgerType);
  const note = batch > 1 ? `${familyName} ×${batch}` : familyName;
  const seed = Math.floor(Math.random() * PLACEHOLDER_MEDIA.length);

  const items = Array.from({ length: batch }, (_, i) => ({
    kind,
    familyId,
    familyName,
    op,
    prompt,
    settings,
    priceUsd: unitPrice,
    mediaUrl: PLACEHOLDER_MEDIA[(seed + i) % PLACEHOLDER_MEDIA.length],
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

  const balanceUsd = await balanceOf(userId);
  return c.json({ items: (data ?? []).map(toGenerationDto), balanceUsd });
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
