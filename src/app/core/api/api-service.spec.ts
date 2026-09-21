import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLifecycle } from '../auth/session-lifecycle';
import {
  API_TOKEN_PROVIDER,
  ApiError,
  ApiService,
  REQUEST_TIMEOUT_MS,
  StaleSessionError,
  UPLOAD_TIMEOUT_MS,
} from './api-service';

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

  it('sends an idempotency key when one is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = makeApi('tok');
    await api.post('/generations', { prompt: 'x' }, { idempotencyKey: 'key-1' });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('key-1');
  });

  it('sends no idempotency header when none is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = makeApi('tok');
    await api.post('/generations', { prompt: 'x' });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
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

  it('accepts a successful empty response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;
    const api = makeApi('tok');
    await expect(api.post('/errors', { message: 'test' })).resolves.toBeUndefined();
  });

  it('still throws on an error response with an empty body', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 502 })) as unknown as typeof fetch;
    const api = makeApi('tok');
    await expect(api.post('/errors', { message: 'test' })).rejects.toBeInstanceOf(ApiError);
  });
});

/**
 * R12: a request made as one account must never resolve into another's state.
 * The epoch is captured when the request leaves and checked when it returns.
 */
describe('ApiService session epoch', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function make(): { api: ApiService; lifecycle: SessionLifecycle } {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: API_TOKEN_PROVIDER, useValue: () => Promise.resolve('tok') }],
    });
    return {
      api: TestBed.inject(ApiService),
      lifecycle: TestBed.inject(SessionLifecycle),
    };
  }

  it('R12: a response that arrives after a user switch is discarded', async () => {
    const { api, lifecycle } = make();
    await lifecycle.onIdentityChange('user-1');
    let release: (r: Response) => void = () => undefined;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as unknown as typeof fetch;

    const inflight = api.get('/generations');
    // The other account signs in while the request is still in the air.
    await lifecycle.onIdentityChange('user-2');
    release(new Response(JSON.stringify({ items: [{ id: 'other-account' }] }), { status: 200 }));

    await expect(inflight).rejects.toBeInstanceOf(StaleSessionError);
  });

  it('a response under the same identity is delivered normally', async () => {
    const { api, lifecycle } = make();
    await lifecycle.onIdentityChange('user-1');
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

    await expect(api.get('/profile')).resolves.toEqual({ ok: true });
  });
});

describe('R27: request deadlines and quotable error ids', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('a 204 resolves rather than failing to parse', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as never;
    await expect(makeApi('tok').post('/errors', { message: 'x' })).resolves.toBeUndefined();
  });

  it('every request carries a deadline', async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = vi.fn((_u: unknown, i: RequestInit) => {
      init = i;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as never;
    await makeApi('tok').get('/generations');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('an upload gets a longer deadline than a read', () => {
    // A 10 MB reference upload on a phone connection is not a hung request.
    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
  });

  it('a timeout surfaces as the 408 copy that already exists', async () => {
    // STATUS_MESSAGES has carried 408 and 504 copy since launch with nothing
    // able to reach it: no request had a deadline, so nothing ever timed out.
    globalThis.fetch = vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted', 'TimeoutError'),
    ) as never;
    await expect(makeApi('tok').get('/generations')).rejects.toThrow(/timed out/i);
  });

  it('a timeout is reported as a timeout, not as a dead connection', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted', 'TimeoutError'),
    ) as never;
    await expect(makeApi('tok').get('/generations')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a genuine network failure still reads as a network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as never;
    await expect(makeApi('tok').get('/generations')).rejects.toMatchObject({ code: 'network' });
  });

  it('a server error id is preserved for support', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'x', message: 'y', errorId: 'err_123' } }),
        { status: 500 },
      ),
    ) as never;
    await expect(makeApi('tok').get('/generations')).rejects.toMatchObject({ errorId: 'err_123' });
  });

  it('falls back to the x-request-id header when the body carries no id', async () => {
    // The gateway sets the header on every response; a 502 from the edge may
    // never reach our handler to put one in the body.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('not json', { status: 502, headers: { 'x-request-id': 'req_abc' } }),
    ) as never;
    await expect(makeApi('tok').get('/generations')).rejects.toMatchObject({ errorId: 'req_abc' });
  });

  it('an error with no id anywhere has an empty one rather than a made-up one', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 400 })) as never;
    await expect(makeApi('tok').get('/generations')).rejects.toMatchObject({ errorId: '' });
  });
});
