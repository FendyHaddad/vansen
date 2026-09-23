import { CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, RouterLink } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './settings-page';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';
import { ProfileStore } from '../../core/profile/profile-store';
import { PublicCapabilitiesService } from '../../core/catalog/public-capabilities';
import { ApiService } from '../../core/api/api-service';

/** The Connected assistants tab shows while MCP_ENABLED is on (I3), or while
 * the user still has a grant, so Disconnect always works (final review 2, M4). */
describe('SettingsPage: Connected assistants tab', () => {
  let assistantConnection: ReturnType<typeof signal<boolean>>;
  let grantsGet: ReturnType<typeof vi.fn>;

  function make(query: Record<string, string> = {}) {
    TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
        { provide: AuthService, useValue: { signOut: vi.fn() } },
        { provide: LedgerService, useValue: { totalCredits: signal(0) } },
        { provide: ProfileStore, useValue: { isOwner: signal(false) } },
        {
          provide: PublicCapabilitiesService,
          useValue: { assistantConnection, load: vi.fn(() => Promise.resolve()) },
        },
        { provide: ApiService, useValue: { get: grantsGet } },
      ],
    });
    // The tabs themselves are not under test: render them as inert elements.
    TestBed.overrideComponent(SettingsPage, {
      set: { imports: [DecimalPipe, RouterLink, NgIcon], schemas: [CUSTOM_ELEMENTS_SCHEMA] },
    });
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    return fixture;
  }

  const navText = (el: HTMLElement) => el.querySelector('.tab-nav')?.textContent ?? '';

  beforeEach(() => {
    TestBed.resetTestingModule();
    assistantConnection = signal(false);
    grantsGet = vi.fn(() => Promise.resolve({ grants: [] }));
  });

  it('shows the tab with the connection off while the user still has a grant to disconnect', async () => {
    grantsGet = vi.fn(() => Promise.resolve({ grants: [{ clientId: 'vsn_client_x' }] }));
    const fixture = make();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(grantsGet).toHaveBeenCalledWith('/oauth/grants');
    expect(navText(fixture.nativeElement)).toContain('Connected assistants');
  });

  it('keeps the tab hidden with the connection off when the grant list fails to load', async () => {
    grantsGet = vi.fn(() => Promise.reject(new Error('offline')));
    const fixture = make();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(navText(fixture.nativeElement)).not.toContain('Connected assistants');
  });

  it('hides the tab while the assistant connection is off', () => {
    const fixture = make();
    expect(navText(fixture.nativeElement)).not.toContain('Connected assistants');
    expect(navText(fixture.nativeElement)).toContain('Preferences');
  });

  it('shows the tab once the deployment says the connection is on', () => {
    const fixture = make();
    assistantConnection.set(true);
    fixture.detectChanges();
    expect(navText(fixture.nativeElement)).toContain('Connected assistants');
  });

  it('a ?tab=connected deep link falls back to Profile while the connection is off', () => {
    const fixture = make({ tab: 'connected' });
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('app-connected-tab')).toBeNull();
    expect(el.querySelector('app-profile-tab')).not.toBeNull();
  });

  it('a ?tab=connected deep link opens the tab when the connection is on', () => {
    assistantConnection.set(true);
    const fixture = make({ tab: 'connected' });
    expect(fixture.nativeElement.querySelector('app-connected-tab')).not.toBeNull();
  });

  it('asks the deployment what it has switched on', () => {
    make();
    const caps = TestBed.inject(PublicCapabilitiesService) as unknown as { load: ReturnType<typeof vi.fn> };
    expect(caps.load).toHaveBeenCalled();
  });
});
