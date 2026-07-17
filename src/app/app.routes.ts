import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth-guard';
import { ageGuard, onboardingGuard } from './core/auth/age-guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/landing/landing-page').then((m) => m.LandingPage),
  },
  {
    path: 'pricing',
    loadComponent: () => import('./features/plans/plans-page').then((m) => m.PlansPage),
  },
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'onboarding',
    canActivate: [authGuard, onboardingGuard],
    loadComponent: () =>
      import('./features/onboarding/onboarding-page').then((m) => m.OnboardingPage),
  },
  {
    path: 'app',
    canActivate: [authGuard, ageGuard],
    loadComponent: () => import('./features/workspace/workspace-page').then((m) => m.WorkspacePage),
  },
  {
    // Absorbed into the workspace edit mode — the id opens the canvas directly.
    path: 'app/edit/:id',
    canActivate: [authGuard, ageGuard],
    loadComponent: () => import('./features/workspace/workspace-page').then((m) => m.WorkspacePage),
  },
  {
    path: 'app/settings',
    canActivate: [authGuard, ageGuard],
    loadComponent: () => import('./features/settings/settings-page').then((m) => m.SettingsPage),
  },
  {
    path: 'legal/terms',
    title: 'Terms of Service — Vansen',
    loadComponent: () => import('./features/legal/terms-page').then((m) => m.TermsPage),
  },
  {
    path: 'legal/privacy',
    title: 'Privacy Policy — Vansen',
    loadComponent: () => import('./features/legal/privacy-page').then((m) => m.PrivacyPage),
  },
  {
    path: 'legal/acceptable-use',
    title: 'Acceptable Use Policy — Vansen',
    loadComponent: () =>
      import('./features/legal/acceptable-use-page').then((m) => m.AcceptableUsePage),
  },
  { path: '**', redirectTo: '' },
];
