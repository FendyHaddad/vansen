import { describe, expect, it } from 'vitest';
import { safeConsentReturnUrl } from './consent-return-url';

describe('safeConsentReturnUrl', () => {
  it('keeps a return to the consent page, authorization id and all', () => {
    expect(safeConsentReturnUrl('/oauth/consent?authorization_id=abc-123')).toBe(
      '/oauth/consent?authorization_id=abc-123',
    );
  });

  it('keeps the bare consent path with no query', () => {
    expect(safeConsentReturnUrl('/oauth/consent')).toBe('/oauth/consent');
  });

  it('refuses a foreign origin smuggled in as a path', () => {
    expect(safeConsentReturnUrl('https://evil.example/oauth/consent')).toBeNull();
  });

  it('refuses a protocol-relative URL', () => {
    expect(safeConsentReturnUrl('//evil.example/oauth/consent')).toBeNull();
  });

  it('refuses a backslash smuggling a host past the leading-slash check', () => {
    expect(safeConsentReturnUrl('/\\evil.example/oauth/consent')).toBeNull();
  });

  it('refuses any path other than the consent page', () => {
    expect(safeConsentReturnUrl('/app')).toBeNull();
    expect(safeConsentReturnUrl('/app/settings')).toBeNull();
  });

  it('refuses a javascript: pseudo-URL', () => {
    expect(safeConsentReturnUrl('javascript:alert(1)')).toBeNull();
  });

  it('refuses null, undefined and empty input', () => {
    expect(safeConsentReturnUrl(null)).toBeNull();
    expect(safeConsentReturnUrl(undefined)).toBeNull();
    expect(safeConsentReturnUrl('')).toBeNull();
  });
});
