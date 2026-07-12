// Vankode backoffice read-only gateway (federation design §5.1).
// Deliberately a SEPARATE edge function: the live `api` function serving
// Vansen users is never redeployed for backoffice needs, and this one holds
// zero write routes. Auth = caller's own Vansen session token + the email
// allowlist below (kept in code rather than a DB table so the prod schema
// stays untouched).
import { Hono } from 'jsr:@hono/hono';
import { cors } from 'jsr:@hono/hono/cors';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUSPEND_STRIKES = 2; // mirror of api/index.ts
const ADMIN_EMAILS = new Set(['fendyhaddad@vankode.com']);

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

type Vars = { Variables: { userId: string; email: string } };
const app = new Hono<Vars>().basePath('/backoffice-api');

app.use(
  '*',
  cors({
    origin: ['http://localhost:4300'], // Vankode backoffice dev server
    allowHeaders: ['authorization', 'content-type', 'apikey'],
    allowMethods: ['GET', 'OPTIONS'],
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
  if (!ADMIN_EMAILS.has(data.user.email ?? '')) {
    return fail(c, 403, 'forbidden', 'Admin access required');
  }
  c.set('userId', data.user.id);
  c.set('email', data.user.email ?? '');
  await next();
});

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

app.get('/admin/kpis', async (c) => {
  const { data, error } = await admin.rpc('backoffice_summary');
  if (error) return fail(c, 400, 'query_failed', error.message);
  return c.json(data);
});

app.get('/admin/users', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) return fail(c, 400, 'query_failed', error.message);
  const matched = (q
    ? data.users.filter((u) => (u.email ?? '').toLowerCase().includes(q) || u.id === q)
    : data.users
  ).slice(0, 50);
  const ids = matched.map((u) => u.id);
  const [{ data: profiles }, { data: subs }] = await Promise.all([
    admin.from('profiles').select('id,display_name,strikes,created_at').in('id', ids),
    admin.from('subscriptions').select('user_id,plan,status').in('user_id', ids),
  ]);
  const profById = new Map((profiles ?? []).map((p) => [p.id as string, p]));
  const subById = new Map((subs ?? []).map((s) => [s.user_id as string, s]));
  return c.json({
    users: matched.map((u) => {
      const p = profById.get(u.id);
      const s = subById.get(u.id);
      return {
        id: u.id,
        email: u.email ?? '',
        displayName: p?.display_name ?? null,
        strikes: p?.strikes ?? 0,
        plan: s?.plan ?? null,
        planStatus: s?.status ?? null,
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at ?? null,
      };
    }),
  });
});

app.get('/admin/users/:id', async (c) => {
  const id = c.req.param('id');
  const { data: authUser, error } = await admin.auth.admin.getUserById(id);
  if (error || !authUser?.user) return fail(c, 404, 'not_found', 'User not found');
  const [profileRes, subRes, balanceUsd, genCountRes, modsRes] = await Promise.all([
    admin
      .from('profiles')
      .select('display_name,strikes,created_at,stripe_customer_id')
      .eq('id', id)
      .maybeSingle(),
    admin
      .from('subscriptions')
      .select('plan,status,current_period_end')
      .eq('user_id', id)
      .maybeSingle(),
    balanceOf(id),
    admin.from('generations').select('id', { count: 'exact', head: true }).eq('user_id', id),
    admin
      .from('moderation_events')
      .select('id,source,categories,resolution,created_at')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);
  const profile = profileRes.data;
  const sub = subRes.data;
  return c.json({
    id,
    email: authUser.user.email ?? '',
    createdAt: authUser.user.created_at,
    lastSignInAt: authUser.user.last_sign_in_at ?? null,
    displayName: profile?.display_name ?? null,
    strikes: profile?.strikes ?? 0,
    suspended: (profile?.strikes ?? 0) >= SUSPEND_STRIKES,
    stripeCustomerId: profile?.stripe_customer_id ?? null,
    balanceUsd,
    subscription: sub
      ? { plan: sub.plan, status: sub.status, currentPeriodEnd: sub.current_period_end }
      : null,
    generationCount: genCountRes.count ?? 0,
    moderation: modsRes.data ?? [],
  });
});

app.get('/admin/users/:id/ledger', async (c) => {
  const { data, error } = await admin
    .from('ledger_entries')
    .select('*')
    .eq('user_id', c.req.param('id'))
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return fail(c, 400, 'query_failed', error.message);
  return c.json({ entries: (data ?? []).map(toLedgerDto) });
});

app.get('/admin/users/:id/generations', async (c) => {
  const { data, error } = await admin
    .from('generations')
    .select('id,kind,family_name,op,prompt,price_usd,status,created_at')
    .eq('user_id', c.req.param('id'))
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return fail(c, 400, 'query_failed', error.message);
  return c.json({
    items: (data ?? []).map((g) => ({
      id: g.id,
      kind: g.kind,
      familyName: g.family_name,
      op: g.op,
      prompt: g.prompt,
      priceUsd: Number(g.price_usd),
      status: g.status,
      createdAt: g.created_at,
    })),
  });
});

app.get('/admin/errors', async (c) => {
  const code = (c.req.query('code') ?? '').trim();
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  let query = admin
    .from('app_errors')
    .select('id,created_at,source,route,method,code,message,stack,user_id,request_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (code) query = query.eq('code', code);
  const { data, error } = await query;
  if (error) return fail(c, 400, 'query_failed', error.message);
  return c.json({ errors: data ?? [] });
});

Deno.serve(app.fetch);
