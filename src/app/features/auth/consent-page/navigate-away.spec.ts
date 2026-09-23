import { describe, expect, it } from 'vitest';
import { isAllowedRedirect } from './navigate-away';

/** Minor 5: the consent page only ever leaves for a redirect a real
 * assistant could have registered. GoTrue blocks the dangerous schemes at
 * registration; this is the second lock. */
describe('isAllowedRedirect', () => {
  it('allows https anywhere', () => {
    expect(isAllowedRedirect('https://claude.ai/api/mcp/auth_callback?code=x')).toBe(true);
  });

  it('allows http only on loopback', () => {
    expect(isAllowedRedirect('http://127.0.0.1:6276/oauth/callback')).toBe(true);
    expect(isAllowedRedirect('http://localhost:3000/cb')).toBe(true);
    expect(isAllowedRedirect('http://[::1]:3000/cb')).toBe(true);
    expect(isAllowedRedirect('http://evil.example/cb')).toBe(false);
  });

  it('allows an app custom scheme', () => {
    expect(isAllowedRedirect('cursor://anysphere.cursor-retrieval/oauth/callback?code=x')).toBe(true);
    expect(isAllowedRedirect('vscode://vscode.mcp/cb')).toBe(true);
  });

  it('refuses the dangerous schemes, in any case', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'about:blank',
      'blob:https://vansen.vankode.com/x',
    ]) {
      expect(isAllowedRedirect(url), url).toBe(false);
    }
  });

  it('refuses what does not parse as an absolute URL', () => {
    expect(isAllowedRedirect('/relative')).toBe(false);
    expect(isAllowedRedirect('')).toBe(false);
  });
});
