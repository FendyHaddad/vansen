import { Injectable, InjectionToken, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { SessionLifecycle } from '../auth/session-lifecycle';
import { supabase } from '../supabase/supabase-client';

/**
 * The account changed while this request was in the air.
 *
 * It is not an error the caller can fix, and it must never be written into a
 * store: that is how one person's library ends up on another person's screen.
 * Callers that catch it should do nothing — the new session reloads anyway.
 */
export class StaleSessionError extends Error {
  constructor(readonly path: string) {
    super('The session changed while this request was in flight.');
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
    /**
     * The gateway's id for this exact failure, for a support conversation.
     * Empty when the server did not give one — never invented, because an id
     * that matches no log line is worse than none.
     */
    readonly errorId: string = '',
  ) {
    super(message);
  }
}

/**
 * A read that has not answered in thirty seconds is not going to.
 *
 * Before this, no request carried a deadline at all: a hung connection hung
 * the UI until the user reloaded, and the 408 and 504 copy in STATUS_MESSAGES
 * was unreachable because nothing could ever time out.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * An upload of a large reference over a phone connection legitimately takes
 * longer than a read. Failing it at thirty seconds would break a working flow.
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

export type TokenProvider = () => Promise<string | null>;

export interface RequestOptions {
  /**
   * Makes a retry safe: the server answers a repeat with the first result
   * rather than charging and generating again.
   */
  idempotencyKey?: string;
}

async function supabaseToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Overridable in tests; defaults to the Supabase session token. */
export const API_TOKEN_PROVIDER = new InjectionToken<TokenProvider>('API_TOKEN_PROVIDER', {
  providedIn: 'root',
  factory: () => supabaseToken,
});

/** Plain-language fallback for HTTP statuses the server did not give a message for. */
const STATUS_MESSAGES: Record<number, string> = {
  400: 'That request was not valid. Please check your input and try again.',
  401: 'Your session expired. Please sign in again.',
  403: 'You do not have access to that.',
  404: 'That feature is not available right now. Please try again later.',
  408: 'The request timed out. Please try again.',
  413: 'That file is too large.',
  422: 'That request could not be processed.',
  429: 'Too many requests — please wait a moment and retry.',
  500: 'Something went wrong on our end. Please try again.',
  502: 'The service is briefly unavailable. Please retry in a moment.',
  503: 'The service is briefly unavailable. Please retry in a moment.',
  504: 'The service took too long to respond. Please retry.',
};

function friendlyMessage(status: number): string {
  return STATUS_MESSAGES[status] ?? `Something went wrong (${status}). Please try again.`;
}

/**
 * The only network surface for app data. Attaches the Supabase session JWT,
 * parses the gateway's uniform error body, throws ApiError. Every failure is
 * logged to the browser console (with method, path, status, code) so frontend
 * errors are visible during debugging.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly tokenProvider = inject(API_TOKEN_PROVIDER);
  private readonly lifecycle = inject(SessionLifecycle);

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /** Multipart POST (file uploads) — does not set Content-Type (browser adds boundary). */
  async postForm<T>(path: string, form: FormData): Promise<T> {
    const epoch = this.lifecycle.epoch();
    const token = await this.tokenProvider();
    const headers: Record<string, string> = { 'x-vansen-client': 'web' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await this.fetch('POST', path, { headers, body: form }, UPLOAD_TIMEOUT_MS);
    const parsed = await this.handle<T>('POST', path, response);
    return this.fresh(epoch, path, parsed);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    // Captured before the request leaves: everything that comes back is
    // checked against the identity it was sent under.
    const epoch = this.lifecycle.epoch();
    const token = await this.tokenProvider();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-vansen-client': 'web',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const response = await this.fetch(method, path, {
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await this.handle<T>(method, path, response);
    return this.fresh(epoch, path, parsed);
  }

  /**
   * Started as one account, came back after another signed in. Writing this
   * into the new account's stores is the defect, so it never reaches them.
   */
  private fresh<T>(epoch: number, path: string, value: T): T {
    if (this.lifecycle.isCurrent(epoch)) return value;
    throw new StaleSessionError(path);
  }

  /**
   * Runs fetch under a deadline; turns a dropped connection or an expired
   * deadline into a readable ApiError instead of a raw TypeError.
   *
   * The two are kept apart deliberately. "Check your connection" is wrong and
   * unhelpful advice when the connection is fine and the server is simply
   * taking too long.
   */
  private async fetch(
    method: string,
    path: string,
    init: RequestInit,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    try {
      return await fetch(environment.apiBaseUrl + path, {
        method,
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        console.error(`[api] ${method} ${path} — no answer in ${timeoutMs}ms`);
        throw new ApiError('timeout', friendlyMessage(408), 408);
      }
      console.error(`[api] ${method} ${path} — network error`, err);
      throw new ApiError(
        'network',
        'Could not reach the server. Check your connection and try again.',
        0,
      );
    }
  }

  /** Parses the uniform error body, logs, and throws a friendly ApiError on failure. */
  private async handle<T>(method: string, path: string, response: Response): Promise<T> {
    // 204 (POST /errors) and any other empty success: there is no JSON to parse.
    if (response.ok && (response.status === 204 || response.headers.get('content-length') === '0')) {
      return undefined as T;
    }
    if (response.ok) return (await response.json()) as T;
    const parsed = await response.json().catch(() => null);
    const code = parsed?.error?.code ?? 'unknown';
    const message = parsed?.error?.message ?? friendlyMessage(response.status);
    // The body is the better source, but an edge-level 502 never reaches our
    // handler to put one there -- the gateway's header still carries it.
    const errorId = parsed?.error?.errorId ?? response.headers.get('x-request-id') ?? '';
    console.error(
      `[api] ${method} ${path} — ${response.status} ${code}: ${message}`,
      errorId ? `(id ${errorId})` : '(no id)',
      parsed ?? '(no body)',
    );
    throw new ApiError(code, message, response.status, parsed?.error ?? {}, errorId);
  }
}
