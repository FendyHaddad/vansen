import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedTab } from './connected-tab';
import { ApiError, ApiService } from '../../../core/api/api-service';
import { OAuthGrantDto } from '../../../core/api/dtos';
import { ConfirmService } from '../../../shared/confirm/confirm-service';
import { environment } from '../../../../environments/environment';

function grant(clientId: string, clientName: string): OAuthGrantDto {
  return {
    clientId,
    clientName,
    redirectHost: 'claude.ai',
    createdAt: '2026-09-01T00:00:00Z',
    lastUsedAt: null,
  };
}

describe('ConnectedTab', () => {
  let fixture: ComponentFixture<ConnectedTab>;
  let api: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let confirm: { ask: ReturnType<typeof vi.fn> };

  function make(): ConnectedTab {
    fixture = TestBed.createComponent(ConnectedTab);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = { get: vi.fn(), delete: vi.fn() };
    api.get.mockResolvedValue({ grants: [] });
    api.delete.mockResolvedValue(undefined);
    confirm = { ask: vi.fn(() => Promise.resolve(true)) };
    TestBed.configureTestingModule({
      imports: [ConnectedTab],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: ConfirmService, useValue: confirm },
      ],
    });
  });

  /** A promise-returning constructor effect needs a tick before assertions. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('shows a loading state before the grants arrive', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    make();
    expect(fixture.nativeElement.textContent).toContain('Loading connected assistants');
  });

  it('loads the list through GET /oauth/grants', async () => {
    make();
    await settle();
    expect(api.get).toHaveBeenCalledWith('/oauth/grants');
  });

  it('lists each grant with its client name and connected date', async () => {
    api.get.mockResolvedValue({ grants: [grant('c1', 'Claude'), grant('c2', 'ChatGPT')] });
    make();
    await settle();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Claude');
    expect(text).toContain('ChatGPT');
    expect(text).toContain('Connected');
  });

  it('shows the empty state with the MCP URL and per-client instructions when nothing is connected', async () => {
    api.get.mockResolvedValue({ grants: [] });
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
    api.get.mockRejectedValue(new Error('network down'));
    make();
    await settle();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Could not load connected assistants');
  });

  it('revokes only after the confirm dialog is accepted', async () => {
    api.get.mockResolvedValue({ grants: [grant('c1', 'Claude')] });
    const tab = make();
    await settle();
    fixture.detectChanges();

    confirm.ask.mockResolvedValue(false);
    await tab.revoke(grant('c1', 'Claude'));
    expect(api.delete).not.toHaveBeenCalled();

    confirm.ask.mockResolvedValue(true);
    await tab.revoke(grant('c1', 'Claude'));
    expect(api.delete).toHaveBeenCalledWith('/oauth/grants/c1');
  });

  it('drops the revoked grant from the list on success', async () => {
    api.get.mockResolvedValue({ grants: [grant('c1', 'Claude'), grant('c2', 'ChatGPT')] });
    const tab = make();
    await settle();
    fixture.detectChanges();

    await tab.revoke(grant('c1', 'Claude'));
    fixture.detectChanges();

    expect(tab.grants().map((g) => g.clientId)).toEqual(['c2']);
  });

  it('shows an error and keeps the grant listed when revoke fails', async () => {
    api.get.mockResolvedValue({ grants: [grant('c1', 'Claude')] });
    api.delete.mockRejectedValue(new Error('boom'));
    const tab = make();
    await settle();

    await tab.revoke(grant('c1', 'Claude'));
    fixture.detectChanges();

    expect(tab.grants().map((g) => g.clientId)).toEqual(['c1']);
    expect(fixture.nativeElement.textContent).toContain('Could not disconnect');
  });

  it('a 404 on revoke (already gone) still drops it from the list, with no error', async () => {
    api.get.mockResolvedValue({ grants: [grant('c1', 'Claude')] });
    api.delete.mockRejectedValue(new ApiError('not_found', 'Not found', 404));
    const tab = make();
    await settle();

    await tab.revoke(grant('c1', 'Claude'));
    fixture.detectChanges();

    expect(tab.grants()).toEqual([]);
    expect(tab.error()).toBe('');
  });

  it('copies the MCP URL and flashes a confirmation', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    api.get.mockResolvedValue({ grants: [] });
    const tab = make();
    await settle();
    fixture.detectChanges();

    await tab.copyUrl();
    expect(writeText).toHaveBeenCalledWith(`${environment.apiBaseUrl}/mcp`);
    expect(tab.copied()).toBe(true);
  });

  it('clears the "Copied" timer when the tab is destroyed', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
    api.get.mockResolvedValue({ grants: [] });
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
