import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedTab } from './connected-tab';
import { AuthService, OAuthGrant } from '../../../core/auth/auth-service';
import { ConfirmService } from '../../../shared/confirm/confirm-service';
import { environment } from '../../../../environments/environment';

function grant(id: string, name: string): OAuthGrant {
  return {
    client: { id, name, uri: '', logo_uri: '' },
    scopes: ['openid', 'email'],
    granted_at: '2026-09-01T00:00:00Z',
  };
}

describe('ConnectedTab', () => {
  let fixture: ComponentFixture<ConnectedTab>;
  let auth: { listGrants: ReturnType<typeof vi.fn>; revokeGrant: ReturnType<typeof vi.fn> };
  let confirm: { ask: ReturnType<typeof vi.fn> };

  function make(): ConnectedTab {
    fixture = TestBed.createComponent(ConnectedTab);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    auth = {
      listGrants: vi.fn(() => Promise.resolve([])),
      revokeGrant: vi.fn(() => Promise.resolve()),
    };
    confirm = { ask: vi.fn(() => Promise.resolve(true)) };
    TestBed.configureTestingModule({
      imports: [ConnectedTab],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: ConfirmService, useValue: confirm },
      ],
    });
  });

  /** A promise-returning constructor effect needs a tick before assertions. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('shows a loading state before the grants arrive', () => {
    auth.listGrants.mockReturnValue(new Promise(() => {}));
    make();
    expect(fixture.nativeElement.textContent).toContain('Loading connected assistants');
  });

  it('lists each grant with its client name and connected date', async () => {
    auth.listGrants.mockResolvedValue([grant('c1', 'Claude'), grant('c2', 'ChatGPT')]);
    make();
    await settle();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Claude');
    expect(text).toContain('ChatGPT');
    expect(text).toContain('Connected');
  });

  it('shows the empty state with the MCP URL and per-client instructions when nothing is connected', async () => {
    auth.listGrants.mockResolvedValue([]);
    make();
    await settle();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('No assistants connected yet');
    expect(text).toContain(`${environment.apiBaseUrl}/mcp`);
    expect(text).toContain('Claude');
    expect(text).toContain('ChatGPT');
  });

  it('shows an error state when the grant list fails to load', async () => {
    auth.listGrants.mockRejectedValue(new Error('network down'));
    make();
    await settle();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Could not load connected assistants');
  });

  it('revokes only after the confirm dialog is accepted', async () => {
    auth.listGrants.mockResolvedValue([grant('c1', 'Claude')]);
    const tab = make();
    await settle();
    fixture.detectChanges();

    confirm.ask.mockResolvedValue(false);
    await tab.revoke(grant('c1', 'Claude'));
    expect(auth.revokeGrant).not.toHaveBeenCalled();

    confirm.ask.mockResolvedValue(true);
    await tab.revoke(grant('c1', 'Claude'));
    expect(auth.revokeGrant).toHaveBeenCalledWith('c1');
  });

  it('drops the revoked grant from the list on success', async () => {
    auth.listGrants.mockResolvedValue([grant('c1', 'Claude'), grant('c2', 'ChatGPT')]);
    const tab = make();
    await settle();
    fixture.detectChanges();

    await tab.revoke(grant('c1', 'Claude'));
    fixture.detectChanges();

    expect(tab.grants().map((g) => g.client.id)).toEqual(['c2']);
  });

  it('shows an error and keeps the grant listed when revoke fails', async () => {
    auth.listGrants.mockResolvedValue([grant('c1', 'Claude')]);
    auth.revokeGrant.mockRejectedValue(new Error('boom'));
    const tab = make();
    await settle();

    await tab.revoke(grant('c1', 'Claude'));
    fixture.detectChanges();

    expect(tab.grants().map((g) => g.client.id)).toEqual(['c1']);
    expect(fixture.nativeElement.textContent).toContain('Could not disconnect');
  });

  it('copies the MCP URL and flashes a confirmation', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    auth.listGrants.mockResolvedValue([]);
    const tab = make();
    await settle();
    fixture.detectChanges();

    await tab.copyUrl();
    expect(writeText).toHaveBeenCalledWith(`${environment.apiBaseUrl}/mcp`);
    expect(tab.copied()).toBe(true);
  });

  it('clears the "Copied" timer when the tab is destroyed', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
    auth.listGrants.mockResolvedValue([]);
    const tab = make();
    await settle();
    vi.useFakeTimers();
    try {
      await tab.copyUrl();
      expect(vi.getTimerCount()).toBe(1);
      fixture.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
