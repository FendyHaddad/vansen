import { Injectable, InjectionToken, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { supabase } from '../supabase/supabase-client';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type TokenProvider = () => Promise<string | null>;

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

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
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
    const token = await this.tokenProvider();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await this.fetch('POST', path, { headers, body: form });
    return this.handle<T>('POST', path, response);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokenProvider();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await this.fetch(method, path, {
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.handle<T>(method, path, response);
  }

  /** Runs fetch; turns a dropped connection into a readable ApiError instead of a raw TypeError. */
  private async fetch(method: string, path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(environment.apiBaseUrl + path, { method, ...init });
    } catch (err) {
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
    if (response.ok) return (await response.json()) as T;
    const parsed = await response.json().catch(() => null);
    const code = parsed?.error?.code ?? 'unknown';
    const message = parsed?.error?.message ?? friendlyMessage(response.status);
    console.error(
      `[api] ${method} ${path} — ${response.status} ${code}: ${message}`,
      parsed ?? '(no body)',
    );
    throw new ApiError(code, message, response.status);
  }
}
