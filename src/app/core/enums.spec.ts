import { describe, expect, it } from 'vitest';
import {
  GenerationOp,
  GenerationStatus,
  LedgerType,
  MediaKind,
  PersonaStatus,
  SubscriptionPlan,
  SubscriptionStatus,
} from './enums';

describe('domain enums', () => {
  it('mirror DB check constraints exactly', () => {
    expect(Object.values(LedgerType).sort()).toEqual(
      [
        'cycle_reset',
        'edit',
        'generate',
        'pack_expiry',
        'pack_purchase',
        'persona_training',
        'promo',
        'refund',
        'upscale',
      ].sort(),
    );
    expect(Object.values(PersonaStatus).sort()).toEqual(
      ['draft', 'failed', 'ready', 'training'].sort(),
    );
    expect(Object.values(GenerationOp).sort()).toEqual(
      ['edit', 'generate', 'upscale', 'variation'].sort(),
    );
    expect(Object.values(GenerationStatus).sort()).toEqual(['done', 'failed', 'pending'].sort());
    expect(Object.values(MediaKind).sort()).toEqual(['image', 'video'].sort());
    expect(Object.values(SubscriptionPlan).sort()).toEqual(['owner', 'pro', 'studio'].sort());
    expect(Object.values(SubscriptionStatus).sort()).toEqual(
      ['active', 'canceled', 'expired'].sort(),
    );
  });
});
