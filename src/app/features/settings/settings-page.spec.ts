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

/** The Connected assistants tab exists only while MCP_ENABLED is on (I3). */
describe('SettingsPage: Connected assistants tab', () => {
  let assistantConnection: ReturnType<typeof signal<boolean>>;

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
