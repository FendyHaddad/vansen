// iOS IAP price sheet (Lane B). Prices are marked up ~+15% over web so Apple's
// 15% Small Business commission is paid by the convenience premium — per-sale
// net stays >= web everywhere (guarded by iap-products_test.ts). Credit grants
// are identical to web. Intro offers (first 2 cycles) are configured in App
// Store Connect; they grant full credits, so no code branch exists for them.
import { packCredits, PLAN_CREDITS } from './model-families.ts';

export type IapProduct =
  | {
    kind: 'subscription';
    plan: 'studio' | 'pro';
    webUsd: number;
    iosUsd: number;
    introWebUsd?: number;
    introIosUsd?: number;
  }
  | { kind: 'pack'; webUsd: number; iosUsd: number };

export const IAP_PRODUCTS: Record<string, IapProduct> = {
  'vansen.studio.monthly': {
    kind: 'subscription',
    plan: 'studio',
    webUsd: 15,
    iosUsd: 16.99,
    introWebUsd: 10,
    introIosUsd: 11.99,
  },
  'vansen.pro.monthly': {
    kind: 'subscription',
    plan: 'pro',
    webUsd: 30,
    iosUsd: 34.99,
    introWebUsd: 25,
    introIosUsd: 28.99,
  },
  'vansen.pack.s': { kind: 'pack', webUsd: 10, iosUsd: 11.99 },
  'vansen.pack.m': { kind: 'pack', webUsd: 25, iosUsd: 28.99 },
  'vansen.pack.l': { kind: 'pack', webUsd: 50, iosUsd: 56.99 },
  'vansen.pack.xl': { kind: 'pack', webUsd: 100, iosUsd: 113.99 },
};

export function iapGrant(productId: string, plan: 'studio' | 'pro'): number {
  const product = IAP_PRODUCTS[productId];
  if (!product) return 0;
  if (product.kind === 'subscription') return PLAN_CREDITS[product.plan];
  return packCredits(product.webUsd, plan);
}

/** The plan a subscription product sells; null for packs and unknown ids. */
export function iapPlanFor(productId: string): 'studio' | 'pro' | null {
  const product = IAP_PRODUCTS[productId];
  if (!product || product.kind !== 'subscription') return null;
  return product.plan;
}
