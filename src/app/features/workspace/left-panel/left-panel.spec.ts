import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LeftPanel, GenerateRequest } from './left-panel';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { PreferencesService } from '../../../core/preferences/preferences-service';
import { ApiService } from '../../../core/api/api-service';
import { ModelAvailability } from '../../../core/models/model-availability';
import { PersonaStore } from '../../../core/personas/persona-store';
import { TREND_PRESETS } from '../../../core/catalog/trend-presets';

const PREFS = {
  defaultMode: 'image' as const,
  defaultImageFamily: 'nano-banana',
  defaultVideoFamily: 'veo',
  defaultAspect: '1:1',
  defaultStyle: '',
  defaultPersona: '',
};

function makeComponent(): LeftPanel {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [LeftPanel],
    providers: [
      { provide: LedgerService, useValue: { totalCredits: () => 1000 } },
      { provide: ProfileStore, useValue: { isOwner: signal(true) } },
      {
        provide: PreferencesService,
        useValue: { prefs: () => PREFS, update: () => Promise.resolve() },
      },
      { provide: ApiService, useValue: {} },
      { provide: ModelAvailability, useValue: { disabled: () => false } },
      {
        provide: PersonaStore,
        useValue: { load: () => Promise.resolve(), readyById: () => false },
      },
    ],
  });
  return TestBed.createComponent(LeftPanel).componentInstance;
}

describe('LeftPanel trend tracking', () => {
  let component: LeftPanel;

  beforeEach(() => {
    component = makeComponent();
  });

  it('emits the trend id after a trend prefill, even when edited', () => {
    let emitted: GenerateRequest | null = null;
    component.generateRequested.subscribe((r) => (emitted = r));

    component.applyTrend(TREND_PRESETS[0]);
    component.updatePrompt(TREND_PRESETS[0].prompt + ' on the moon');
    component.generate();

    expect(emitted!.trendId).toBe(TREND_PRESETS[0].id);
  });

  it('clears the trend when the prompt is emptied', () => {
    component.applyTrend(TREND_PRESETS[0]);
    component.updatePrompt('');

    expect(component.appliedTrend()).toBeNull();
  });
});
