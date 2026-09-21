import { assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { fakeAdapter, FakeDb, TEST_USER, testDeps } from './testing/fakes.ts';
import { runWorkerTick } from './_shared/testing/worker.ts';
import { CATALOG_VERSION, familyById } from './_shared/model-families.ts';

const AUTH = { authorization: 'Bearer test-token' };

function ready(db: FakeDb, familyId: string) {
  db.tables.subscriptions = [
    {
      user_id: TEST_USER,
      plan: 'pro',
      status: 'active',
      current_period_end: '2099-01-01T00:00:00Z',
    },
  ];
  db.tables.models = [{ id: familyId, enabled: true, min_plan: 'studio' }];
}

/**
 * Submit, then run one worker tick. Since P5 the route reserves and returns;
 * the provider is called by the worker, so the price and the request it paid
 * for can only be compared after the tick.
 */
async function submitOnce(familyId: string, settings: Record<string, unknown>) {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, familyId);
  const app = createApp(deps);
  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'generate', familyId, prompt: 'a cat', batch: 1, settings }),
  });
  // A refused combination never reaches the reservation, so this is read lazily.
  const reserve = db.rpcCalls.find((r) => r.name === 'fn_reserve_generation');
  const charged = reserve
    ? (reserve.args.p_items as Record<string, unknown>[])[0]
    : undefined;
  if (res.status === 202) await runWorkerTick(db, { adapterFor: () => provider.adapter });
  return { res, provider, charged };
}

Deno.test('every selectable image combination charges what it sends', async () => {
  for (const familyId of ['nano-banana', 'gpt-image', 'flux', 'seedream']) {
    const caps = familyById(familyId)!.capabilities;
    const seen = new Map<string, number>();
    for (const version of caps.versions?.map((v) => v.value) ?? [undefined]) {
      for (const resolution of caps.resolutions?.map((r) => r.value) ?? [undefined]) {
        for (const quality of caps.qualities?.map((q) => q.value) ?? [undefined]) {
          const { res, provider, charged } = await submitOnce(familyId, {
            aspectRatio: caps.aspectRatios[0],
            version,
            resolution,
            quality,
          });
          // A combination the catalog offers but the provider cannot render is
          // a catalog defect; it must be refused, never charged.
          if (res.status !== 202) {
            assertEquals(
              res.status,
              400,
              `${familyId} ${version}/${resolution}/${quality} answered ${res.status}`,
            );
            continue;
          }
          const sent = provider.submits[0].normalized!;
          const key = JSON.stringify({ m: sent.providerModel, s: sent.providerSettings });
          const price = Number(charged!.priceCredits);
          const before = seen.get(key);
          if (before !== undefined) {
            assertEquals(before, price, `${familyId}: same request, two prices (${key})`);
          }
          seen.set(key, price);
        }
      }
    }
  }
});

Deno.test('the stored settings record the quote and catalog versions', async () => {
  const { charged } = await submitOnce('flux', { aspectRatio: '1:1', resolution: '1MP' });
  const settings = charged!.settings as Record<string, unknown>;
  assertEquals(settings.quoteVersion, 1);
  assertEquals(settings.catalogVersion, CATALOG_VERSION);
});

Deno.test('the adapter receives the same normalized request the price came from', async () => {
  const { provider, charged } = await submitOnce('nano-banana', {
    aspectRatio: '1:1',
    version: 'pro',
    resolution: '4K',
  });
  const sent = provider.submits[0].normalized!;
  assertEquals(sent.providerModel, 'gemini-3-pro-image');
  assertEquals(sent.providerSettings.image_size, '4K');
  assertEquals(Number(charged!.priceCredits) > 0, true);
});

Deno.test('a gpt-image resolution the chosen version cannot render is refused, not charged', async () => {
  const provider = fakeAdapter();
  const deps = testDeps({ adapterFor: () => provider.adapter });
  const db = deps.admin as unknown as FakeDb;
  ready(db, 'gpt-image');
  const app = createApp(deps);
  const res = await app.request('/api/generations', {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'generate',
      familyId: 'gpt-image',
      prompt: 'a cat',
      batch: 1,
      settings: { aspectRatio: '1:1', version: '1', quality: 'medium', resolution: '4K' },
    }),
  });
  assertEquals(res.status, 400);
  assertEquals(db.rpcCalls.some((r) => r.name === 'fn_reserve_generation'), false);
});
