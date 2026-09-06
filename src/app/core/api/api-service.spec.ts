import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_PROVIDER, ApiError, ApiService } from './api-service';

const originalFetch = globalThis.fetch;

function makeApi(token: string | null): ApiService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: API_TOKEN_PROVIDER, useValue: () => Promise.resolve(token) }],
  });
  return TestBed.inject(ApiService);
}

describe('ApiService', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps error body to ApiError with status and attaches bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'insufficient_credits', message: 'Top up' } }), {
        status: 402,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const api = makeApi('tok');
    await expect(api.post('/generations', {})).rejects.toMatchObject({
      code: 'insufficient_credits',
      status: 402,
      message: 'Top up',
    });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
  });

  it('carries error details such as resetsAt through to ApiError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'daily_cap', message: 'Daily video limit reached', resetsAt: '2026-09-07T00:00:00Z' },
        }),
        { status: 429 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const api = makeApi('tok');
    await expect(api.post('/generations', {})).rejects.toMatchObject({
      code: 'daily_cap',
      status: 429,
      details: { resetsAt: '2026-09-07T00:00:00Z' },
    });
  });

  it('returns parsed JSON on success', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })) as never;
    const api = makeApi(null);
    await expect(api.get<{ ok: boolean }>('/profile')).resolves.toEqual({ ok: true });
  });

  it('throws ApiError with unknown code on non-JSON failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 })) as never;
    const api = makeApi('tok');
    await expect(api.get('/ledger')).rejects.toBeInstanceOf(ApiError);
  });

  it('sends the platform header on JSON requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = makeApi('tok');
    await api.get('/profile');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-vansen-client']).toBe('web');
  });

  it('sends the platform header on multipart requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = makeApi('tok');
    await api.postForm('/uploads', new FormData());
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['x-vansen-client']).toBe('web');
  });
});
