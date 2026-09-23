/**
 * Subscription plans and add-on packs: monthly credit grants, list and launch
 * prices, the Pro bonus figures every page quotes, and pack sizes.
 * Entry points: PLAN_CREDITS, PLAN_PRICE_USD, CREDIT_PACKS, packCredits.
 */

/** Monthly credit grant per subscription plan (owner is unlimited, never granted). */
export const PLAN_CREDITS = { studio: 1500, pro: 3750 } as const;

/** Monthly list price per plan, and the launch price for a first-time customer's
 * first 60 days (Stripe applies it as a $5/mo coupon — see STRIPE_LAUNCH_COUPON_ID). */
export const PLAN_PRICE_USD = { studio: 15, pro: 30 } as const;
export const PLAN_PROMO_USD = { studio: 10, pro: 25 } as const;

/** Add-on packs bought on Pro carry this multiplier. */
export const PRO_PURCHASE_RATE = 1.25;

/**
 * Two true numbers about the same fact, which read as a contradiction when a
 * page picks one and another page picks the other.
 *
 * A job costs the same number of credits on either plan. What changes is what
 * a credit costs: 1c on Studio, 0.8c on Pro. That is 25% more credits per
 * dollar and 20% off the same job — the same 4:5 ratio, counted from opposite
 * ends. Both are derived here so no page can invent a third figure.
 */
const STUDIO_USD_PER_CREDIT = PLAN_PRICE_USD.studio / PLAN_CREDITS.studio;
const PRO_USD_PER_CREDIT = PLAN_PRICE_USD.pro / PLAN_CREDITS.pro;

/** How much less the same job costs on Pro. */
export const PRO_SAVING_PERCENT = Math.round(
  (1 - PRO_USD_PER_CREDIT / STUDIO_USD_PER_CREDIT) * 100,
);

/** How many more credits a dollar buys on Pro. */
export const PRO_EXTRA_CREDIT_PERCENT = Math.round(
  (STUDIO_USD_PER_CREDIT / PRO_USD_PER_CREDIT - 1) * 100,
);

/** The same bonus, applied to one-time add-on packs (PRO_PURCHASE_RATE). */
export const PRO_PACK_BONUS_PERCENT = Math.round((PRO_PURCHASE_RATE - 1) * 100);

/** Add-on packs: one-time purchases, tier rate × size bonus. Subscriber-only. */
export const CREDIT_PACKS: { usd: number; bonusPct: number }[] = [
  { usd: 10, bonusPct: 0 },
  { usd: 25, bonusPct: 5 },
  { usd: 50, bonusPct: 8 },
  { usd: 100, bonusPct: 10 },
];

export function packCredits(usd: number, plan: 'studio' | 'pro'): number {
  const pack = CREDIT_PACKS.find((p) => p.usd === usd);
  if (!pack) return 0;
  const rate = plan === 'pro' ? PRO_PURCHASE_RATE : 1;
  return Math.floor(usd * 100 * rate * (1 + pack.bonusPct / 100));
}
