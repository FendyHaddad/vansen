import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HlmButton } from '@spartan-ng/helm/button';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBot, lucideCheck, lucideCopy, lucideTrash2 } from '@ng-icons/lucide';
import { ApiError, ApiService } from '../../../core/api/api-service';
import { OAuthGrantDto, OAuthGrantsResponse } from '../../../core/api/dtos';
import { ConfirmService } from '../../../shared/confirm/confirm-service';
import { environment } from '../../../../environments/environment';

/** How long the "Copied" acknowledgement stays up. */
const COPIED_FLASH_MS = 2000;

/**
 * Settings → Connected assistants: the OAuth grants an MCP client (Claude,
 * ChatGPT, …) holds on this account, with revoke, plus how to connect a new
 * one. Talks to the gateway's own `/oauth/grants*` endpoints through the
 * app's api client — GoTrue never sees an assistant grant (spec §R, §R3, §R4).
 */
@Component({
  selector: 'app-connected-tab',
  templateUrl: './connected-tab.html',
  styleUrl: './connected-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, HlmButton, NgIcon],
  providers: [provideIcons({ lucideBot, lucideCheck, lucideCopy, lucideTrash2 })],
})
export class ConnectedTab {
  private readonly api = inject(ApiService);
  private readonly confirm = inject(ConfirmService);

  /** Derived from the app's own Supabase config, never hard-coded, so staging
   * and production each show their own URL. */
  readonly mcpUrl = `${environment.apiBaseUrl}/mcp`;

  readonly grants = signal<OAuthGrantDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly revokingId = signal<string | null>(null);
  readonly copied = signal(false);
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.copiedTimer));
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const res = await this.api.get<OAuthGrantsResponse>('/oauth/grants');
      this.grants.set(res.grants);
    } catch {
      this.error.set('Could not load connected assistants. Check your connection and try again.');
    } finally {
      this.loading.set(false);
    }
  }

  async revoke(grant: OAuthGrantDto): Promise<void> {
    if (this.revokingId()) return;
    const ok = await this.confirm.ask({
      title: `Disconnect ${grant.clientName || 'this assistant'}?`,
      body: 'It loses access to your account immediately. Your credits, library and plan are unaffected, and you can reconnect any time.',
      confirmLabel: 'Disconnect',
      cancelLabel: 'Keep connected',
      destructive: true,
    });
    if (!ok) return;

    this.revokingId.set(grant.clientId);
    this.error.set('');
    const outcome = await this.deleteGrant(grant.clientId);
    if (outcome === 'failed') {
      this.error.set('Could not disconnect — check your connection and try again.');
      this.revokingId.set(null);
      return;
    }
    this.grants.update((list) => list.filter((g) => g.clientId !== grant.clientId));
    this.revokingId.set(null);
  }

  /**
   * A 404 means the grant is already gone — the outcome the user wanted —
   * so it is treated the same as success, not surfaced as a failure.
   */
  private async deleteGrant(clientId: string): Promise<'ok' | 'failed'> {
    try {
      await this.api.delete(`/oauth/grants/${clientId}`);
      return 'ok';
    } catch (e) {
      return e instanceof ApiError && e.status === 404 ? 'ok' : 'failed';
    }
  }

  async copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.mcpUrl);
      this.copied.set(true);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(false), COPIED_FLASH_MS);
    } catch {
      // Clipboard permission denied or unavailable in this browser — the URL
      // is still plain, selectable text right above the button.
    }
  }
}
