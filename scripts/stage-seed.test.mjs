import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grantCredits, grantSql, modelsSql, packGrantSql, profileSql, seed, serviceRoleGrantsSql,
  sqlLiteral, STAGING_USERS,
} from './stage-seed.mjs';

test('the three accounts cover free, studio and pro', () => {
  assert.deepEqual(STAGING_USERS.map((u) => u.plan), [null, 'studio', 'pro']);
  assert.deepEqual(STAGING_USERS.map((u) => u.credits), [0, 1500, 3750]);
  assert.ok(STAGING_USERS.every((u) => u.email.endsWith('@staging.vansen')));
});

test('sqlLiteral doubles single quotes', () => {
  assert.equal(sqlLiteral("o'brien"), "'o''brien'");
});

test('a free account is granted nothing', () => {
  assert.equal(grantSql(STAGING_USERS[0], '11111111-1111-1111-1111-111111111111'), null);
});

test('a plan account is granted through fn_apply_fulfillment, not a ledger insert', () => {
  const sql = grantSql(STAGING_USERS[1], '22222222-2222-2222-2222-222222222222');
  assert.match(sql, /select public\.fn_apply_fulfillment\(/);
  assert.match(sql, /'seed:studio@staging\.vansen'/);
  assert.match(sql, /'subscription_grant'/);
  assert.match(sql, /'studio', 1500/);
  assert.doesNotMatch(sql, /insert into public\.ledger_entries/);
});

test('the grant carries an entitlement whose period is in the future', () => {
  const sql = grantSql(STAGING_USERS[2], '33333333-3333-3333-3333-333333333333');
  assert.match(sql, /now\(\) \+ interval '30 days'/);
  assert.match(sql, /'status', 'active'/);
  assert.match(sql, /'plan', 'pro'/);
});

test('modelsSql enables and disables only the families it was given', () => {
  const sql = modelsSql({ enabled: ['flux', 'persona'], disabled: ['gpt-image'] });
  assert.match(sql, /set enabled = true.*where id in \('flux', 'persona'\)/s);
  assert.match(sql, /set enabled = false.*where id in \('gpt-image'\)/s);
});

test('modelsSql never names a video family', () => {
  const sql = modelsSql({ enabled: ['flux'], disabled: ['gpt-image'] });
  for (const video of ['veo', 'omni', 'kling', 'runway', 'seedance']) {
    assert.doesNotMatch(sql, new RegExp(`'${video}'`));
  }
});

test('modelsSql omits an empty side rather than writing where id in ()', () => {
  assert.doesNotMatch(modelsSql({ enabled: [], disabled: ['flux'] }), /true/);
  assert.doesNotMatch(modelsSql({ enabled: ['flux'], disabled: [] }), /false/);
});

test('profileSql confirms the age gate so a seeded account can reach the app', () => {
  const sql = profileSql('44444444-4444-4444-4444-444444444444');
  assert.match(sql, /update public\.profiles/);
  assert.match(sql, /birth_date/);
  assert.match(sql, /age_confirmed_at = now\(\)/);
});

test('serviceRoleGrantsSql grants data access to service_role and nobody else', () => {
  const sql = serviceRoleGrantsSql();
  assert.match(sql, /grant select, insert, update, delete on all tables in schema public to service_role/);
  assert.match(sql, /alter default privileges in schema public grant select, insert, update, delete on tables to service_role/);
  assert.doesNotMatch(sql, /anon|authenticated/);
});

test('packGrantSql writes a pack grant with the id it was given', () => {
  const sql = packGrantSql('55555555-5555-5555-5555-555555555555', 250, 'manual:123');
  assert.match(sql, /'pack_grant'/);
  assert.match(sql, /'manual:123'/);
  assert.match(sql, /null::text, 250/);
});

test('packGrantSql refuses a non-positive amount', () => {
  assert.throws(() => packGrantSql('5555', 0, 'manual:1'), /positive/);
  assert.throws(() => packGrantSql('5555', -5, 'manual:1'), /positive/);
});

test('seed creates a missing user and reuses an existing one', async () => {
  const existing = [{ id: 'aaaa', email: 'free@staging.vansen' }];
  const requests = [];
  const statements = [];
  const request = async (url, init) => {
    requests.push({ url, method: init?.method ?? 'GET' });
    if (init?.method !== 'POST') return { ok: true, json: async () => ({ users: existing }) };
    const email = JSON.parse(init.body).email;
    const created = { id: `id-${email}`, email };
    existing.push(created);
    return { ok: true, json: async () => created };
  };
  const run = (_cmd, args) => {
    statements.push(args[args.indexOf('-c') + 1]);
    return { status: 0 };
  };

  await seed({ env: { FAL_API_KEY: 'k' }, run, request, log: () => {} });

  const posts = requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2, 'only the two missing accounts are created');
  assert.ok(statements.some((s) => s.includes("'seed:studio@staging.vansen'")));
  assert.ok(statements.some((s) => s.includes('set enabled = false')));
  assert.ok(statements.some((s) => s.includes('age_confirmed_at')));
  assert.ok(statements[0].includes('on all tables in schema public to service_role'), 'grants run first');
});

test('seed refuses a non-local database', async () => {
  await assert.rejects(
    () => seed({ env: {}, databaseUrl: 'postgresql://postgres@db.bnorhcxhvxydkgvcxjad.supabase.co:5432/postgres' }),
    /disposable local database/,
  );
});

test('seed reports a missing psql rather than a bare non-zero status', async () => {
  await assert.rejects(
    () => seed({
      env: {},
      request: async () => ({ ok: true, json: async () => ({ users: [] }) }),
      run: () => ({ error: new Error('ENOENT') }),
      log: () => {},
    }),
    /could not start psql/,
  );
});

test('grantCredits fails with a clear message for an unknown account', async () => {
  const request = async () => ({ ok: true, json: async () => ({ users: [] }) });
  await assert.rejects(
    () => grantCredits({ email: 'nobody@staging.vansen', credits: 10, request, run: () => ({ status: 0 }) }),
    /nobody@staging\.vansen/,
  );
});
