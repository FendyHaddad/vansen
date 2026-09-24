import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileTab } from './profile-tab';
import { AuthService } from '../../../core/auth/auth-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { GenerationStore } from '../../../core/generations/generation-store';
import { ApiError } from '../../../core/api/api-service';
import { ToastService } from '../../../core/feedback/toast-service';

/** Every save in Settings answers with a toast, success or failure. */
describe('ProfileTab toasts', () => {
  const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  const profileStore = {
    profile: signal(null),
    displayName: signal('Ada'),
    loaded: signal(true),
    load: vi.fn(() => Promise.resolve()),
    updateDisplayName: vi.fn(),
  };
  const auth = { userEmail: signal('ada@example.com'), setPassword: vi.fn() };

  function make(): ProfileTab {
    TestBed.configureTestingModule({
      imports: [ProfileTab],
      providers: [
        { provide: ToastService, useValue: toast },
        { provide: ProfileStore, useValue: profileStore },
        { provide: AuthService, useValue: auth },
        { provide: LedgerService, useValue: {} },
        { provide: GenerationStore, useValue: {} },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    });
    return TestBed.createComponent(ProfileTab).componentInstance;
  }

  beforeEach(() => vi.clearAllMocks());

  it('toasts when the display name saves', async () => {
    profileStore.updateDisplayName.mockResolvedValue(undefined);
    const tab = make();

    await tab.save();

    expect(toast.success).toHaveBeenCalledWith('Display name saved');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts and keeps the inline reason when the save fails', async () => {
    profileStore.updateDisplayName.mockRejectedValue(new ApiError('bad_name', 'Name too long', 400));
    const tab = make();

    await tab.save();

    expect(toast.error).toHaveBeenCalledWith("Couldn't save display name");
    expect(tab.error()).toBe('Name too long');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('toasts when the password is updated', async () => {
    auth.setPassword.mockResolvedValue(undefined);
    const tab = make();
    tab.password.set('long-enough');

    await tab.setPassword();

    expect(toast.success).toHaveBeenCalledWith('Password updated');
  });
});
