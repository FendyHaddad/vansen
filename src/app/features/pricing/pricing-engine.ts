export interface PricingConfig {
  creditPriceUsd: number;
  targetNetMargin: number;
  stripePercent: number;
  stripeFixedUsd: number;
  packPriceUsd: number;
}

export interface MarginResult {
  grossUsd: number;
  overheadUsd: number;
  netUsd: number;
  netPct: number;
}

export function packCredits(cfg: PricingConfig): number {
  if (cfg.creditPriceUsd <= 0) return 0;
  return cfg.packPriceUsd / cfg.creditPriceUsd;
}

export function stripeFee(cfg: PricingConfig): number {
  return cfg.packPriceUsd * cfg.stripePercent + cfg.stripeFixedUsd;
}

export function overheadPerCredit(cfg: PricingConfig): number {
  const credits = packCredits(cfg);
  if (credits <= 0) return 0;
  return stripeFee(cfg) / credits;
}

export function requiredCredits(usdCost: number, cfg: PricingConfig): number {
  const netPerCredit = cfg.creditPriceUsd * (1 - cfg.targetNetMargin) - overheadPerCredit(cfg);
  if (netPerCredit <= 0) return Infinity;
  return Math.ceil(usdCost / netPerCredit);
}

export function marginFor(usdCost: number, credits: number, cfg: PricingConfig): MarginResult {
  const grossUsd = credits * cfg.creditPriceUsd;
  const overheadUsd = credits * overheadPerCredit(cfg);
  const netUsd = grossUsd - overheadUsd - usdCost;
  const netPct = grossUsd > 0 ? netUsd / grossUsd : 0;
  return { grossUsd, overheadUsd, netUsd, netPct };
}
