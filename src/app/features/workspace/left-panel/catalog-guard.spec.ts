import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { LeftPanel } from './left-panel';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { PreferencesService } from '../../../core/preferences/preferences-service';
import { ApiService } from '../../../core/api/api-service';
import { ModelAvailability } from '../../../core/models/model-availability';
import { PersonaStore } from '../../../core/personas/persona-store';
import { MODEL_FAMILIES } from '../../../core/catalog/model-families';
import {
  buildCatalog,
  type CatalogAxisId,
  type CatalogFamily,
  type CatalogSettings,
} from '../../../core/catalog/build-catalog';

/**
 * The web composer reads model-families.ts directly while every other client
 * reads GET /catalog. Both derive from one file, and this spec proves the two
 * views agree: the same families, axes, values, valid combinations and prices.
 */
const CATALOG = buildCatalog(MODEL_FAMILIES.map((f) => ({ id: f.id, enabled: true, min_plan: 'studio' })));

const PREFS = {
  defaultMode: 'image' as const,
  defaultImageFamily: 'nano-banana',
  defaultVideoFamily: 'veo',
  defaultVideoMode: 'i2v',
  defaultAspect: '1:1',
  defaultPersona: '',
};

function makePanel(): LeftPanel {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [LeftPanel],
    providers: [
      { provide: LedgerService, useValue: { totalCredits: () => 1000 } },
      { provide: ProfileStore, useValue: { isOwner: signal(true), proActive: signal(true) } },
      { provide: PreferencesService, useValue: { prefs: () => PREFS, update: () => Promise.resolve() } },
      { provide: ApiService, useValue: {} },
      { provide: ModelAvailability, useValue: { disabled: () => false } },
      { provide: PersonaStore, useValue: { load: () => Promise.resolve(), readyById: () => false } },
    ],
  });
  return TestBed.createComponent(LeftPanel).componentInstance;
}

interface Step {
  id: CatalogAxisId;
  options: () => (string | number)[];
  apply: (value: string | number) => void;
}

function steps(panel: LeftPanel): Step[] {
  return [
    {
      id: 'version',
      options: () => panel.versionOptions()?.map((o) => o.value) ?? [],
      apply: (v) => panel.setAxis('version', String(v)),
    },
    {
      id: 'aspectRatio',
      options: () => panel.aspectOptions().map((o) => o.value),
      apply: (v) => panel.setAxis('aspectRatio', String(v)),
    },
    {
      id: 'resolution',
      options: () => panel.resolutionOptions()?.map((o) => o.value) ?? [],
      apply: (v) => panel.setAxis('resolution', String(v)),
    },
    {
      id: 'quality',
      options: () => panel.qualityOptions()?.map((o) => o.value) ?? [],
      apply: (v) => panel.setAxis('quality', String(v)),
    },
    {
      id: 'durationS',
      options: () => panel.durationOptions()?.map((o) => Number(o.value)) ?? [],
      apply: (v) => panel.setDuration(String(v)),
    },
    {
      id: 'audio',
      options: () => (panel.audioSelectable() ? panel.audioOptions.map((o) => o.value) : []),
      apply: (v) => panel.setAudio(String(v)),
    },
  ];
}

function key(settings: CatalogSettings): string {
  return JSON.stringify(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)));
}

/** Every combination the composer lets someone click through, with its price. */
function walk(panel: LeftPanel, all: Step[], index: number, chosen: CatalogSettings, found: Map<string, number>): void {
  if (index === all.length) {
    found.set(key(chosen), panel.unitCredits());
    return;
  }
  const step = all[index];
  const options = step.options();
  if (options.length === 0) {
    walk(panel, all, index + 1, chosen, found);
    return;
  }
  for (const value of options) {
    step.apply(value);
    walk(panel, all, index + 1, { ...chosen, [step.id]: value }, found);
  }
}

function axisValues(family: CatalogFamily, id: CatalogAxisId): (string | number)[] {
  return family.axes.find((a) => a.id === id)?.values.map((v) => v.value) ?? [];
}

describe('composer and /catalog agree', () => {
  it('lists the same families', () => {
    expect(CATALOG.families.map((f) => f.id)).toEqual(MODEL_FAMILIES.map((f) => f.id));
  });

  for (const family of CATALOG.families) {
    it(`${family.id}: same axes, values, combinations and prices`, () => {
      const panel = makePanel();
      panel.setMode(family.kind);
      panel.selectFamily(family.id);
      expect(panel.versionOptions()?.map((o) => o.value) ?? []).toEqual(axisValues(family, 'version'));
      expect(panel.aspectOptions().map((o) => o.value)).toEqual(axisValues(family, 'aspectRatio'));
      expect(panel.durationOptions()?.map((o) => Number(o.value)) ?? []).toEqual(axisValues(family, 'durationS'));
      expect(panel.audioSelectable() ? panel.audioOptions.map((o) => o.value) : []).toEqual(
        axisValues(family, 'audio'),
      );

      const found = new Map<string, number>();
      walk(panel, steps(panel), 0, {}, found);
      const listed = new Map(family.combos.map((c) => [key(c.settings), c.credits[0]]));
      expect([...found.entries()].sort()).toEqual([...listed.entries()].sort());
    });
  }

  it('the image batch stepper stops where the catalog does', () => {
    const panel = makePanel();
    const nano = CATALOG.families.find((f) => f.id === 'nano-banana');
    expect(panel.batchOptions.length).toBe(nano?.batch.max);
  });
});
