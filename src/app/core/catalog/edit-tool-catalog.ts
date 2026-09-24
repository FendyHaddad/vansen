import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { EDIT_TOOLS } from './edit-tools';
import type { ToolPlan } from './entitlements';

/** Overridable in tests. Anonymous by construction — GET /catalog needs no token. */
export const EDIT_TOOL_CATALOG_FETCH = new InjectionToken<typeof fetch>(
  'EDIT_TOOL_CATALOG_FETCH',
  {
    providedIn: 'root',
    factory: () => (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  },
);

const KNOWN_TOOL_IDS = new Set(EDIT_TOOLS.map((tool) => tool.id));

function parsePlans(raw: unknown): Record<string, ToolPlan> {
  const tools = (raw as { flat?: { editTools?: unknown } } | null)?.flat?.editTools;
  if (!Array.isArray(tools)) return {};
  const plans: Record<string, ToolPlan> = {};
  for (const entry of tools) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !KNOWN_TOOL_IDS.has(id)) continue;
    const plan = (entry as { plan?: unknown } | null)?.plan;
    plans[id] = plan === 'pro' ? 'pro' : 'studio';
  }
  return plans;
}

/**
 * Each AI edit tool's plan floor, as the server actually has it configured —
 * `models.min_plan`, served as `flat.editTools[].plan` by the public GET
 * /catalog. The right panel used to hard-code every AI edit tool as
 * Pro-only; reading it from here means a `min_plan` change on the server
 * takes effect with no web deploy.
 *
 * A tool id this client does not know (or a response that fails to parse) is
 * dropped rather than echoed back, matching PublicCapabilitiesService.
 */
@Injectable({ providedIn: 'root' })
export class EditToolCatalog {
  private readonly fetchFn = inject(EDIT_TOOL_CATALOG_FETCH);
  private readonly plans = signal<Record<string, ToolPlan> | null>(null);
  private inFlight: Promise<void> | null = null;

  /** Null until a response has been understood. Never a guess. */
  readonly loaded = computed(() => this.plans() !== null);

  /** Safe to call from several places at once; the request happens once. */
  load(): Promise<void> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The plan a tool needs. Defaults to the stricter tier while unknown, so a
   * tool is never shown unlocked before its real floor is known. */
  planFor(toolId: string): ToolPlan {
    return this.plans()?.[toolId] ?? 'pro';
  }

  private async read(): Promise<void> {
    try {
      const res = await this.fetchFn(`${environment.apiBaseUrl}/catalog`);
      if (!res.ok) return;
      this.plans.set(parsePlans(await res.json()));
    } catch {
      // Offline, blocked, or a gateway error. Staying unloaded is the answer.
    }
  }
}
