// Storefront → billing lane (spec: three-lane money model). Lane B ships in P5;
// until then every non-A iOS storefront reads as C.

export type BillingLane = 'A' | 'B' | 'C';

const EU_STOREFRONTS = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export function laneFor(platform: 'ios' | 'android', storefront: string): BillingLane {
  if (platform === 'android') return 'A';
  if (storefront === 'US') return 'A';
  if (EU_STOREFRONTS.has(storefront)) return 'A';
  return 'C';
}
