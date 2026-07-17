import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { ApiService, ApiError } from '../../core/api/api-service';
import { ProfileStore } from '../../core/profile/profile-store';
import { AuthService } from '../../core/auth/auth-service';
import { OnboardingPage } from './onboarding-page';

function make(overrides: Partial<{ post: any }> = {}) {
  const api = { post: overrides.post ?? vi.fn().mockResolvedValue({ ok: true }) };
  const store = { load: vi.fn().mockResolvedValue(undefined), reset: vi.fn() };
  const auth = { signOut: vi.fn().mockResolvedValue(undefined) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]), // RouterLink in the template needs real router DI
      { provide: ApiService, useValue: api },
      { provide: ProfileStore, useValue: store },
      { provide: AuthService, useValue: auth },
    ],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const cmp = TestBed.createComponent(OnboardingPage).componentInstance;
  return { cmp, api, store, auth, navigate };
}

describe('OnboardingPage', () => {
  it('an adult DOB posts and navigates to /app', async () => {
    const { cmp, api, navigate } = make();
    cmp.year.set('1990'); cmp.month.set('1'); cmp.day.set('1');
    await cmp.submit();
    expect(api.post).toHaveBeenCalledWith('/profile/age', { birthDate: '1990-01-01' });
    expect(navigate).toHaveBeenCalledWith(['/app']);
  });

  it('an under-18 DOB shows the confirm step without posting', async () => {
    const thisYear = new Date().getFullYear();
    const { cmp, api } = make();
    cmp.year.set(String(thisYear - 10)); cmp.month.set('6'); cmp.day.set('15');
    await cmp.submit();
    expect(cmp.step()).toBe('confirm');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('confirming an under-18 delete posts, then signs out and shows rejected', async () => {
    const post = vi.fn().mockRejectedValue(new ApiError('underage', 'nope', 403));
    const { cmp, auth, store } = make({ post });
    const thisYear = new Date().getFullYear();
    cmp.year.set(String(thisYear - 10)); cmp.month.set('6'); cmp.day.set('15');
    await cmp.submit();          // → confirm
    await cmp.confirmDelete();    // → posts, 403
    expect(post).toHaveBeenCalled();
    expect(store.reset).toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalled();
    expect(cmp.step()).toBe('rejected');
  });

  it('an incomplete date sets an error and does not post', async () => {
    const { cmp, api } = make();
    cmp.year.set('1990'); cmp.month.set(''); cmp.day.set('1');
    await cmp.submit();
    expect(cmp.error()).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('an impossible date (Feb 30) gets the invalid-date error, not the blank one', async () => {
    const { cmp, api } = make();
    cmp.year.set('1990'); cmp.month.set('2'); cmp.day.set('30');
    await cmp.submit();
    expect(cmp.error()).toContain('doesn’t exist');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sign out instead resets the store, signs out, and goes home', async () => {
    const { cmp, store, auth, navigate } = make();
    await cmp.signOutInstead();
    expect(store.reset).toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/']);
  });
});
