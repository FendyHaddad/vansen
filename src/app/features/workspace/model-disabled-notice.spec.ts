import { describe, expect, it } from 'vitest';
import { modelDisabledNotice } from './workspace-page';

/**
 * A persona run is gated by the persona kill switch. "Try another" model is
 * no advice for it: every persona renders on the same model.
 */
describe('model_disabled notice', () => {
  it('says personas are unavailable when the failing run was a persona run', () => {
    expect(modelDisabledNotice(true)).toBe('Personas are temporarily unavailable.');
  });

  it('suggests another model for any other run', () => {
    expect(modelDisabledNotice(false)).toBe('That model is temporarily unavailable. Try another.');
  });
});
