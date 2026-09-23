import { TestBed } from '@angular/core/testing';
import { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_CLIENT } from '../../../core/auth/auth-service';
import { ConsentService } from './consent-service';

function make(oauth: Record<string, ReturnType<typeof vi.fn>>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: AUTH_CLIENT, useValue: { oauth } as unknown as SupabaseClient['auth'] }],
  });
  return TestBed.inject(ConsentService);
}

describe('ConsentService', () => {
  it('reports an already-consented client as an immediate redirect', async () => {
    const service = make({
      getAuthorizationDetails: vi.fn(() =>
        Promise.resolve({ data: { redirect_url: 'https://client.example/cb?code=x' }, error: null }),
      ),
    });
    const outcome = await service.load('auth-1');
    expect(outcome).toEqual({ kind: 'redirect', url: 'https://client.example/cb?code=x' });
  });

  it('surfaces full details when consent is still needed', async () => {
    const service = make({
      getAuthorizationDetails: vi.fn(() =>
        Promise.resolve({
          data: {
            authorization_id: 'auth-1',
            redirect_uri: 'https://client.example/cb',
            client: { id: 'c1', name: 'Claude', uri: '', logo_uri: '' },
            user: { id: 'u1', email: 'a@b.com' },
            scope: 'openid email',
          },
          error: null,
        }),
      ),
    });
    const outcome = await service.load('auth-1');
    expect(outcome).toEqual({
      kind: 'details',
      details: {
        authorizationId: 'auth-1',
        clientName: 'Claude',
        redirectUri: 'https://client.example/cb',
      },
    });
  });

  it('throws the vendor message when loading fails', async () => {
    const service = make({
      getAuthorizationDetails: vi.fn(() =>
        Promise.resolve({ data: null, error: { message: 'authorization expired' } }),
      ),
    });
    await expect(service.load('auth-1')).rejects.toThrow('authorization expired');
  });

  it('falls back to a generic message when the vendor gives none', async () => {
    const service = make({
      getAuthorizationDetails: vi.fn(() => Promise.resolve({ data: null, error: {} })),
    });
    await expect(service.load('auth-1')).rejects.toThrow('Something went wrong');
  });

  it('approve resolves to the redirect URL without letting the SDK navigate', async () => {
    const approveAuthorization = vi.fn(() =>
      Promise.resolve({ data: { redirect_url: 'https://client.example/cb?code=ok' }, error: null }),
    );
    const service = make({ approveAuthorization });
    const url = await service.approve('auth-1');
    expect(url).toBe('https://client.example/cb?code=ok');
    expect(approveAuthorization).toHaveBeenCalledWith('auth-1', { skipBrowserRedirect: true });
  });

  it('deny resolves to the redirect URL without letting the SDK navigate', async () => {
    const denyAuthorization = vi.fn(() =>
      Promise.resolve({ data: { redirect_url: 'https://client.example/cb?error=access_denied' }, error: null }),
    );
    const service = make({ denyAuthorization });
    const url = await service.deny('auth-1');
    expect(url).toBe('https://client.example/cb?error=access_denied');
    expect(denyAuthorization).toHaveBeenCalledWith('auth-1', { skipBrowserRedirect: true });
  });

  it('throws when approve fails, e.g. a request that is no longer pending', async () => {
    const service = make({
      approveAuthorization: vi.fn(() =>
        Promise.resolve({ data: null, error: { message: 'authorization request is no longer pending' } }),
      ),
    });
    await expect(service.approve('auth-1')).rejects.toThrow('no longer pending');
  });
});
