import { InjectionToken } from '@angular/core';

/** Schemes the gateway's /oauth/register already refuses; refused here too. */
const DANGEROUS_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CUSTOM_SCHEME = /^[a-z][a-z0-9+.-]*:$/;

/**
 * Where the consent page may send the browser: https anywhere, http only on
 * loopback (local MCP clients), or an app's custom scheme (cursor://,
 * vscode://). Everything else is refused.
 */
export function isAllowedRedirect(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === 'https:') return true;
  if (scheme === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  if (DANGEROUS_SCHEMES.has(scheme)) return false;
  return CUSTOM_SCHEME.test(scheme);
}

/**
 * Leaves the app for good, to a URL the gateway (or our own sanitizer) has
 * already validated, and only when isAllowedRedirect agrees.
 *
 * Behind a token for the same reason `AUTH_CLIENT` is (see auth-service.ts):
 * assigning `location.href` directly is not something a test can observe or
 * safely trigger (jsdom has no real navigation), and Angular's vitest system
 * refuses `vi.mock` on a bare global reference anyway.
 */
export const NAVIGATE_AWAY = new InjectionToken<(url: string) => void>('NAVIGATE_AWAY', {
  providedIn: 'root',
  factory: () => (url: string) => {
    if (!isAllowedRedirect(url)) return;
    location.href = url;
  },
});
