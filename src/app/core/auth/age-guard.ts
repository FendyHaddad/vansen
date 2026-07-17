import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth-service';
import { ProfileStore } from '../profile/profile-store';

/** Runs after authGuard on /app*. Forces a signed-in but un-gated user to the
 * onboarding age screen. ageConfirmed only ever transitions unset → set, so a
 * loaded-and-true store needs no revalidation — skip the GET on subsequent
 * navigations (e.g. /app ↔ /app/settings). The server middleware is the real
 * enforcement; this guard is routing UX. */
export const ageGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const store = inject(ProfileStore);
  const router = inject(Router);
  await auth.whenReady();
  if (!auth.isAuthed()) return router.createUrlTree(['/login']);
  if (!(store.loaded() && store.ageConfirmed())) await store.load();
  return store.ageConfirmed() ? true : router.createUrlTree(['/onboarding']);
};

/** Guards /onboarding: a confirmed user has no business here. */
export const onboardingGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const store = inject(ProfileStore);
  const router = inject(Router);
  await auth.whenReady();
  if (!auth.isAuthed()) return router.createUrlTree(['/login']);
  if (!(store.loaded() && store.ageConfirmed())) await store.load();
  return store.ageConfirmed() ? router.createUrlTree(['/app']) : true;
};
