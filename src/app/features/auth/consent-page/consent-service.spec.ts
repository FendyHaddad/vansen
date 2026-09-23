import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, ApiService } from '../../../core/api/api-service';
import { ConsentService } from './consent-service';

const DETAILS = {
  clientName: 'Claude',
  redirectUri: 'https://client.example/cb',
  redirectHost: 'client.example',
  scope: 'vansen',
  alreadyGranted: false,
};

function make() {
  TestBed.resetTestingModule();
  const api = { get: vi.fn(), post: vi.fn() };
  TestBed.configureTestingModule({
    providers: [{ provide: ApiService, useValue: api }],
  });
  return { service: TestBed.inject(ConsentService), api };
}

describe('ConsentService', () => {
  it('loads the request details, keyed by the authorization id it was asked for', async () => {
    const { service, api } = make();
    api.get.mockResolvedValue(DETAILS);
    const details = await service.load('auth-1');
    expect(api.get).toHaveBeenCalledWith('/oauth/requests/auth-1');
    expect(details).toEqual({ authorizationId: 'auth-1', ...DETAILS });
  });

  it('reports alreadyGranted for a client the user already approved', async () => {
    const { service, api } = make();
    api.get.mockResolvedValue({ ...DETAILS, alreadyGranted: true });
    const details = await service.load('auth-1');
    expect(details.alreadyGranted).toBe(true);
  });

  it('turns a 404 authorization_not_found into a plain "reconnect" message', async () => {
    const { service, api } = make();
    api.get.mockRejectedValue(new ApiError('authorization_not_found', 'Not found', 404));
    await expect(service.load('auth-1')).rejects.toThrow(/expired or was already used/);
  });

  it('lets any other load failure through with its own message', async () => {
    const { service, api } = make();
    api.get.mockRejectedValue(new ApiError('network', 'Could not reach the server.', 0));
    await expect(service.load('auth-1')).rejects.toThrow('Could not reach the server.');
  });

  it('approve posts to the approve endpoint and resolves to the redirect URL', async () => {
    const { service, api } = make();
    api.post.mockResolvedValue({ redirectUrl: 'https://client.example/cb?code=ok' });
    const url = await service.approve('auth-1');
    expect(api.post).toHaveBeenCalledWith('/oauth/requests/auth-1/approve', {});
    expect(url).toBe('https://client.example/cb?code=ok');
  });

  it('deny posts to the deny endpoint and resolves to the redirect URL', async () => {
    const { service, api } = make();
    api.post.mockResolvedValue({ redirectUrl: 'https://client.example/cb?error=access_denied' });
    const url = await service.deny('auth-1');
    expect(api.post).toHaveBeenCalledWith('/oauth/requests/auth-1/deny', {});
    expect(url).toBe('https://client.example/cb?error=access_denied');
  });

  it('throws when approve fails, e.g. a request that is no longer pending', async () => {
    const { service, api } = make();
    api.post.mockRejectedValue(
      new ApiError('invalid_grant', 'authorization request is no longer pending', 400),
    );
    await expect(service.approve('auth-1')).rejects.toThrow('no longer pending');
  });
});
