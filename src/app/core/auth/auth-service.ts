import { Injectable, computed, signal } from '@angular/core';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase/supabase-client';

/**
 * Real Supabase auth. Session/SSO only — profile data (display name, studio,
 * balance) lives in the API-backed stores, not here.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly sessionSig = signal<Session | null>(null);
  private readonly readyPromise: Promise<void>;

  readonly session = this.sessionSig.asReadonly();
  readonly isAuthed = computed(() => this.sessionSig() !== null);
  readonly userEmail = computed(() => this.sessionSig()?.user.email ?? '');
  readonly userSince = computed(() => this.sessionSig()?.user.created_at ?? '');

  constructor() {
    this.readyPromise = supabase.auth.getSession().then(({ data }) => {
      this.sessionSig.set(data.session);
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      this.sessionSig.set(session);
    });
  }

  /** Guards await this so a page refresh restores the session before routing. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  async signInGoogle(): Promise<void> {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/app` },
    });
    if (error) throw new Error(error.message);
  }

  async signInEmail(email: string, password: string): Promise<void> {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }

  async signUpEmail(email: string, password: string): Promise<void> {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw new Error(error.message);
  }

  async signOut(): Promise<void> {
    await supabase.auth.signOut();
  }
}
