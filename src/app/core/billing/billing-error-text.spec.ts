import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/api-service';
import { APP_STORE_SUBSCRIPTIONS_URL, billingErrorText } from './billing-error-text';

describe('billingErrorText', () => {
  it('links App Store subscriptions to Apple', () => {
    expect(APP_STORE_SUBSCRIPTIONS_URL).toBe('https://apps.apple.com/account/subscriptions');
  });

  it('explains managed_in_app_store', () => {
    const text = billingErrorText(new ApiError('managed_in_app_store', 'server words', 409), 'x');
    expect(text).toContain('App Store');
    expect(text).not.toBe('server words');
  });

  it('explains subscribed_in_app_store', () => {
    const text = billingErrorText(new ApiError('subscribed_in_app_store', 'server words', 409), 'x');
    expect(text).toContain('App Store');
    expect(text).not.toBe('server words');
  });

  it('falls back to the server message for other codes', () => {
    expect(billingErrorText(new ApiError('no_subscription', 'No active subscription', 400), 'x')).toBe(
      'No active subscription',
    );
  });

  it('falls back to the caller text for a non-API failure', () => {
    expect(billingErrorText(new Error('boom'), 'Billing action failed')).toBe('Billing action failed');
  });
});
