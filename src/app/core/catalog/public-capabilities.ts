import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { MODEL_FAMILIES } from './model-families';

/**
 * What the deployment has actually switched on, read before anyone signs in.
 *
 * The sales pages used to name models from hand-written lists. The lists named
 * a model with no adapter and kept naming families after their kill switch was
 * thrown, so a visitor could buy a plan for something the composer would then
 * refuse. Every public list now intersects the catalog with this.
 *
 * Unknown, unreachable and unparseable all mean the same thing: advertise
 * nothing and promise nothing. A page that says less is recoverable; a page
 * that promises what the deployment cannot do is not.
 */
export interface PublicCapabilities {
  enabledFamilyIds: string[];
  backgroundCompletion: boolean;
  completionNotifications: boolean;
  catalogVersion: string;
  /** MCP_ENABLED: the Connected assistants tab is shown only while on. */
  assistantConnection: boolean;
}

/** Overridable in tests. Anonymous by construction — it sends no token. */
export const CAPABILITIES_FETCH = new InjectionToken<typeof fetch>('CAPABILITIES_FETCH', {
  providedIn: 'root',
  factory: () => (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
});

const KNOWN_FAMILY_IDS = new Set(MODEL_FAMILIES.map((f) => f.id));

function parse(raw: unknown): PublicCapabilities | null {
  const body = raw as Partial<PublicCapabilities> | null;
  if (!body || typeof body !== 'object') return null;
  if (!Array.isArray(body.enabledFamilyIds)) return null;
  return {
    // A family the client has never heard of cannot be rendered, and echoing
    // it back would put an unknown string into the page.
    enabledFamilyIds: body.enabledFamilyIds.filter(
      (id): id is string => typeof id === 'string' && KNOWN_FAMILY_IDS.has(id),
    ),
    backgroundCompletion: body.backgroundCompletion === true,
    completionNotifications:
      body.backgroundCompletion === true && body.completionNotifications === true,
    catalogVersion: typeof body.catalogVersion === 'string' ? body.catalogVersion : '',
    assistantConnection: body.assistantConnection === true,
  };
}

@Injectable({ providedIn: 'root' })
export class PublicCapabilitiesService {
  private readonly fetchFn = inject(CAPABILITIES_FETCH);
  private readonly caps = signal<PublicCapabilities | null>(null);
  private inFlight: Promise<void> | null = null;

  /** Null until a response has been understood. Never a guess. */
  readonly snapshot = this.caps.asReadonly();
  readonly loaded = computed(() => this.caps() !== null);
  readonly enabledFamilyIds = computed(() => this.caps()?.enabledFamilyIds ?? []);
  readonly backgroundCompletion = computed(() => this.caps()?.backgroundCompletion === true);
  readonly completionNotifications = computed(
    () => this.caps()?.completionNotifications === true,
  );
  readonly assistantConnection = computed(() => this.caps()?.assistantConnection === true);

  /** Safe to call from several pages at once; the request happens once. */
  load(): Promise<void> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** A family is advertisable only when the server said so. */
  familyEnabled(id: string): boolean {
    return this.enabledFamilyIds().includes(id);
  }

  private async read(): Promise<void> {
    try {
      const res = await this.fetchFn(`${environment.apiBaseUrl}/capabilities`);
      if (!res.ok) return;
      this.caps.set(parse(await res.json()));
    } catch {
      // Offline, blocked, or a gateway error. Staying null is the answer.
    }
  }
}
