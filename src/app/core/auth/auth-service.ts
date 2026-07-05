import { Injectable, computed, inject, signal } from '@angular/core';
import { LedgerService } from '../ledger/ledger-service';

export interface SessionUser {
  email: string;
  displayName?: string;
  /** Studio membership keeps the library online and the balance alive. */
  studioActive: boolean;
  /** ISO timestamp of account creation (stub). */
  since: string;
}

const STORAGE_KEY = 'vansen.session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly ledger = inject(LedgerService);
  private readonly session = signal<SessionUser | null>(restoreSession());

  readonly user = this.session.asReadonly();
  readonly isAuthed = computed(() => this.session() !== null);
  readonly studioActive = computed(() => this.session()?.studioActive ?? false);

  signIn(email: string): void {
    const user: SessionUser = { email, studioActive: true, since: new Date().toISOString() };
    this.session.set(user);
    persistSession(user);
    // Stub: demo account starts with the $20 first top-up ($15 usable, Studio month included)
    this.ledger.seedIfEmpty();
  }

  updateProfile(patch: Partial<Pick<SessionUser, 'displayName' | 'studioActive'>>): void {
    const current = this.session();
    if (!current) return;
    const user = { ...current, ...patch };
    this.session.set(user);
    persistSession(user);
  }

  signOut(): void {
    this.session.set(null);
    persistSession(null);
  }
}

function restoreSession(): SessionUser | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionUser>;
    // Older stub sessions (tier/credits/balance shapes) are invalid now
    if (typeof parsed.email !== 'string' || typeof parsed.studioActive !== 'boolean') return null;
    return { since: new Date().toISOString(), ...parsed } as SessionUser;
  } catch {
    return null;
  }
}

function persistSession(user: SessionUser | null): void {
  if (typeof localStorage === 'undefined') return;
  if (!user) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}
