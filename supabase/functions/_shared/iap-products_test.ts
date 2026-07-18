import { assert, assertEquals } from 'jsr:@std/assert';
import { IAP_PRODUCTS, iapGrant, iapPlanFor } from './iap-products.ts';

Deno.test('subscription grants are the plan cycle grants', () => {
  assertEquals(iapGrant('vansen.studio.monthly', 'studio'), 1500);
  assertEquals(iapGrant('vansen.pro.monthly', 'pro'), 3750);
});

Deno.test('pack grants follow the web pack table per plan tier', () => {
  assertEquals(iapGrant('vansen.pack.s', 'studio'), 1000);
  assertEquals(iapGrant('vansen.pack.s', 'pro'), 1250);
  assertEquals(iapGrant('vansen.pack.xl', 'studio'), 11000);
  assertEquals(iapGrant('vansen.pack.xl', 'pro'), 13750);
});

Deno.test('unknown product grants nothing', () => {
  assertEquals(iapGrant('vansen.pack.xxl', 'studio'), 0);
  assertEquals(iapPlanFor('vansen.pack.s'), null);
  assertEquals(iapPlanFor('vansen.studio.monthly'), 'studio');
});

// Lane-B economics guard (spec): iOS net = 0.85 × price − provider cost must be
// positive and ≥ the web net for the same product. Provider cost = 60% of credit
// value ($ value = credits / 100). Web net = price − (2.9% + $0.30) − provider cost.
function providerCost(credits: number): number {
  return 0.6 * credits / 100;
}
function webNet(webUsd: number, credits: number): number {
  return webUsd - (webUsd * 0.029 + 0.30) - providerCost(credits);
}
function iosNet(iosUsd: number, credits: number): number {
  return 0.85 * iosUsd - providerCost(credits);
}

Deno.test('every iOS price nets positive and >= web net', () => {
  for (const [id, product] of Object.entries(IAP_PRODUCTS)) {
    const plans = product.kind === 'pack' ? (['studio', 'pro'] as const) : [product.plan];
    for (const plan of plans) {
      const credits = iapGrant(id, plan);
      const ios = iosNet(product.iosUsd, credits);
      assert(ios > 0, `${id}/${plan} iOS net ${ios} not positive`);
      assert(ios >= webNet(product.webUsd, credits), `${id}/${plan} iOS net below web net`);
    }
  }
});

function subscriptionProduct(id: string) {
  const product = IAP_PRODUCTS[id];
  if (product.kind !== 'subscription') throw new Error(`${id} is not a subscription`);
  return product;
}

Deno.test('intro offers net positive and >= web promo net', () => {
  const studio = subscriptionProduct('vansen.studio.monthly');
  const pro = subscriptionProduct('vansen.pro.monthly');
  assert(iosNet(studio.introIosUsd!, 1500) > 0);
  assert(iosNet(studio.introIosUsd!, 1500) >= webNet(studio.introWebUsd!, 1500));
  assert(iosNet(pro.introIosUsd!, 3750) > 0);
  assert(iosNet(pro.introIosUsd!, 3750) >= webNet(pro.introWebUsd!, 3750));
});
