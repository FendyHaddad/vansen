import { Injectable, inject } from '@angular/core';
import { ApiError, ApiService } from '../../../core/api/api-service';
import { OAuthDecisionResponse, OAuthRequestDto } from '../../../core/api/dtos';

/** What the consent page needs to render. */
export interface ConsentDetails extends OAuthRequestDto {
  authorizationId: string;
}

const EXPIRED =
  'This connection link has expired or was already used. Ask the assistant to reconnect.';

/**
 * Wraps the session-authenticated `/oauth/requests/*` endpoints (spec §R3)
 * the consent page needs — the app's own gateway, not GoTrue's OAuth server:
 * §R moved authorization off Supabase Auth entirely, so a Supabase access
 * token can no longer double as a Vansen assistant grant.
 *
 * Kept separate from the component so the one code-to-copy translation (a
 * 404 `authorization_not_found` into a sentence a visitor can act on) lives
 * in one tested place, not spread across the page.
 */
@Injectable({ providedIn: 'root' })
export class ConsentService {
  private readonly api = inject(ApiService);

  /**
   * Loads an authorization request.
   *
   * `alreadyGranted` means the user already has an active grant for this
   * client — the caller must approve it right away rather than show a
   * consent screen.
   */
  async load(authorizationId: string): Promise<ConsentDetails> {
    try {
      const dto = await this.api.get<OAuthRequestDto>(`/oauth/requests/${authorizationId}`);
      return { authorizationId, ...dto };
    } catch (e) {
      if (e instanceof ApiError && e.code === 'authorization_not_found') throw new Error(EXPIRED);
      throw e;
    }
  }

  /** Resolves to the URL to send the browser to next. */
  approve(authorizationId: string): Promise<string> {
    return this.decide(authorizationId, 'approve');
  }

  /** Resolves to the URL to send the browser to next. */
  deny(authorizationId: string): Promise<string> {
    return this.decide(authorizationId, 'deny');
  }

  private async decide(authorizationId: string, action: 'approve' | 'deny'): Promise<string> {
    const { redirectUrl } = await this.api.post<OAuthDecisionResponse>(
      `/oauth/requests/${authorizationId}/${action}`,
      {},
    );
    return redirectUrl;
  }
}
