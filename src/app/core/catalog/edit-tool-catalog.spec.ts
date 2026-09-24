import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { EDIT_TOOL_CATALOG_FETCH, EditToolCatalog } from './edit-tool-catalog';

function serving(body: unknown, ok = true): EditToolCatalog {
  TestBed.resetTestingModule();
  const fetchFn = vi.fn(() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response),
  );
  TestBed.configureTestingModule({
    providers: [{ provide: EDIT_TOOL_CATALOG_FETCH, useValue: fetchFn }],
  });
  return TestBed.inject(EditToolCatalog);
}

const CATALOG = {
  flat: {
    editTools: [
      { id: 'edit-remove', label: 'Remove Object', credits: 10, enabled: true, plan: 'pro' },
      { id: 'edit-fill', label: 'Generative Fill', credits: 10, enabled: true, plan: 'pro' },
      { id: 'edit-expand', label: 'Expand', credits: 10, enabled: true, plan: 'studio' },
      { id: 'edit-bg', label: 'Remove Background', credits: 5, enabled: true, plan: 'studio' },
    ],
  },
};

/**
 * `models.min_plan` reaches the right panel through this service. A tool this
 * client cannot name, or a request that fails, must never read as unlocked.
 */
describe('EditToolCatalog', () => {
  it('defaults every tool to the stricter tier before it has an answer', () => {
    const svc = serving(CATALOG);
    expect(svc.loaded()).toBe(false);
    expect(svc.planFor('edit-expand')).toBe('pro');
  });

  it('reports the plan the server actually configured per tool', async () => {
    const svc = serving(CATALOG);
    await svc.load();
    expect(svc.loaded()).toBe(true);
    expect(svc.planFor('edit-remove')).toBe('pro');
    expect(svc.planFor('edit-fill')).toBe('pro');
    expect(svc.planFor('edit-expand')).toBe('studio');
    expect(svc.planFor('edit-bg')).toBe('studio');
  });

  it('drops a tool id this client does not know', async () => {
    const svc = serving({
      flat: { editTools: [{ id: 'edit-remove', plan: 'studio' }, { id: 'edit-future', plan: 'studio' }] },
    });
    await svc.load();
    expect(svc.planFor('edit-remove')).toBe('studio');
    // Unknown to this build — never named, so it falls back to the stricter tier.
    expect(svc.planFor('edit-future')).toBe('pro');
  });

  it('stays unloaded, and every tool stays locked, when the request fails', async () => {
    const svc = serving(CATALOG, false);
    await svc.load();
    expect(svc.loaded()).toBe(false);
    expect(svc.planFor('edit-expand')).toBe('pro');
  });

  it('stays unloaded when the fetch throws', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: EDIT_TOOL_CATALOG_FETCH, useValue: () => Promise.reject(new Error('offline')) },
      ],
    });
    const svc = TestBed.inject(EditToolCatalog);
    await svc.load();
    expect(svc.loaded()).toBe(false);
  });

  it('asks once however many places call load', async () => {
    TestBed.resetTestingModule();
    const fetchFn = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG) } as Response),
    );
    TestBed.configureTestingModule({
      providers: [{ provide: EDIT_TOOL_CATALOG_FETCH, useValue: fetchFn }],
    });
    const shared = TestBed.inject(EditToolCatalog);
    await Promise.all([shared.load(), shared.load(), shared.load()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends no credentials — the route is public', async () => {
    TestBed.resetTestingModule();
    let seen: RequestInit | undefined;
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG) } as Response);
    });
    TestBed.configureTestingModule({
      providers: [{ provide: EDIT_TOOL_CATALOG_FETCH, useValue: fetchFn }],
    });
    await TestBed.inject(EditToolCatalog).load();
    expect(fetchFn).toHaveBeenCalled();
    expect(seen?.headers).toBeUndefined();
  });
});
