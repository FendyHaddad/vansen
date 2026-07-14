/**
 * Domain enums — the single authority for every domain value in the app.
 * DB CHECK constraints (supabase/migrations) and the Edge Function's
 * _shared copy mirror these exactly. No string literals in app code.
 */

export const LedgerType = {
  Generate: 'generate',
  Edit: 'edit',
  Upscale: 'upscale',
  Refund: 'refund',
  PackPurchase: 'pack_purchase',
  CycleReset: 'cycle_reset',
  PackExpiry: 'pack_expiry',
  Promo: 'promo',
} as const;
export type LedgerType = (typeof LedgerType)[keyof typeof LedgerType];

export const GenerationOp = {
  Generate: 'generate',
  Edit: 'edit',
  Upscale: 'upscale',
  Variation: 'variation',
} as const;
export type GenerationOp = (typeof GenerationOp)[keyof typeof GenerationOp];

export const GenerationStatus = {
  Pending: 'pending',
  Done: 'done',
  Failed: 'failed',
} as const;
export type GenerationStatus = (typeof GenerationStatus)[keyof typeof GenerationStatus];

export const MediaKind = {
  Image: 'image',
  Video: 'video',
} as const;
export type MediaKind = (typeof MediaKind)[keyof typeof MediaKind];

export const SubscriptionPlan = {
  Studio: 'studio',
  Pro: 'pro',
  Owner: 'owner',
} as const;
export type SubscriptionPlan = (typeof SubscriptionPlan)[keyof typeof SubscriptionPlan];

export const SubscriptionStatus = {
  Active: 'active',
  Canceled: 'canceled',
  Expired: 'expired',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];
