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

/**
 * The only network surface for app data. Attaches the Supabase session JWT,
 * parses the gateway's uniform error body, throws ApiError.
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
    const response = await fetch(environment.apiBaseUrl + path, {
      method: 'POST',
      headers,
      body: form,
    });
    if (!response.ok) {
      const parsed = await response.json().catch(() => null);
      throw new ApiError(
        parsed?.error?.code ?? 'unknown',
        parsed?.error?.message ?? `Request failed (${response.status})`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokenProvider();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(environment.apiBaseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const parsed = await response.json().catch(() => null);
      const code = parsed?.error?.code ?? 'unknown';
      const message = parsed?.error?.message ?? `Request failed (${response.status})`;
      throw new ApiError(code, message, response.status);
    }
    return (await response.json()) as T;
  }
}
