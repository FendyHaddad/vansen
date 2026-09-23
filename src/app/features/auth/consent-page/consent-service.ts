import { Injectable, inject } from '@angular/core';
import { AUTH_CLIENT } from '../../../core/auth/auth-service';

/** What the consent page needs to render — nothing the client didn't already
 * hand Supabase, and nothing about the requested scopes (fixed by the spec). */
export interface ConsentDetails {
  authorizationId: string;
  clientName: string;
  redirectUri: string;
}

export type ConsentOutcome =
  | { readonly kind: 'redirect'; readonly url: string }
  | { readonly kind: 'details'; readonly details: ConsentDetails };

const GENERIC_RETRY = 'Something went wrong. Please try again in a moment.';

/**
 * Wraps the three `supabase.auth.oauth` calls the consent page needs.
 *
 * Kept separate from the component so the branch on `getAuthorizationDetails`
 * (full details vs. an already-consented `redirect_url`) and the error
 * unwrapping live in one tested place, not spread across the page.
 */
@Injectable({ providedIn: 'root' })
export class ConsentService {
  private readonly auth = inject(AUTH_CLIENT);

  /**
   * Loads an authorization request.
   *
   * A client the user already consented to comes back as a `redirect_url`
   * instead of details — Supabase has already minted the code — and the
   * caller must follow it immediately rather than show a consent screen.
   */
  async load(authorizationId: string): Promise<ConsentOutcome> {
    const { data, error } = await this.auth.oauth.getAuthorizationDetails(authorizationId);
    if (error) throw new Error(errorMessage(error));
    if ('redirect_url' in data) return { kind: 'redirect', url: data.redirect_url };
    return {
      kind: 'details',
      details: {
        authorizationId: data.authorization_id,
        clientName: data.client.name,
        redirectUri: data.redirect_uri,
      },
    };
  }

  /** Resolves to the URL to send the browser to next. */
  async approve(authorizationId: string): Promise<string> {
    const { data, error } = await this.auth.oauth.approveAuthorization(authorizationId, {
      skipBrowserRedirect: true,
    });
    if (error) throw new Error(errorMessage(error));
    return data.redirect_url;
  }

  /** Resolves to the URL to send the browser to next. */
  async deny(authorizationId: string): Promise<string> {
    const { data, error } = await this.auth.oauth.denyAuthorization(authorizationId, {
      skipBrowserRedirect: true,
    });
    if (error) throw new Error(errorMessage(error));
    return data.redirect_url;
  }
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: string } | null)?.message;
  return message || GENERIC_RETRY;
}
