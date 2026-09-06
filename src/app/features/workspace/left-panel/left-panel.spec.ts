import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
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
  defaultVideoMode: 'i2v',
  defaultAspect: '1:1',
  defaultStyle: '',
  defaultPersona: '',
};

function makeFixture(): { fixture: ComponentFixture<LeftPanel>; component: LeftPanel } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [LeftPanel],
    providers: [
      { provide: LedgerService, useValue: { totalCredits: () => 1000 } },
      { provide: ProfileStore, useValue: { isOwner: signal(true), proActive: signal(true) } },
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
  const fixture = TestBed.createComponent(LeftPanel);
  return { fixture, component: fixture.componentInstance };
}

function makeComponent(): LeftPanel {
  return makeFixture().component;
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

describe('LeftPanel video mode', () => {
  it('unlocks video for Pro and shows the mode picker', () => {
    const { fixture, component } = makeFixture();
    component.setMode('video');
    fixture.detectChanges();
    expect(component.videoLocked()).toBe(false);
    expect(fixture.nativeElement.querySelector('app-mode-picker')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.batch-group')).toBeNull();
  });

  it('applies the default video mode when switching to video', () => {
    const { fixture, component } = makeFixture();
    component.setMode('video');
    fixture.detectChanges();
    expect(component.videoMode()).toBe('i2v');
  });

  it('hides batch and audio for included-audio families, shows audio chips for kling', () => {
    const { fixture, component } = makeFixture();
    component.setMode('video');
    component.selectFamily('kling');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.audio-group')).not.toBeNull();
    component.selectFamily('veo');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.audio-group')).toBeNull();
    expect(fixture.nativeElement.querySelector('.audio-note')).not.toBeNull();
  });

  it('blocks Generate until references satisfy the mode', () => {
    const { fixture, component } = makeFixture();
    component.setMode('video');
    component.selectFamily('veo');
    component.prompt.set('a fox');
    component.setVideoMode('keyframes');
    fixture.detectChanges();
    expect(component.canGenerate()).toBe(false);
    component.refSlots.set([
      { path: 'u/a.png', url: 'a' },
      { path: 'u/b.png', url: 'b' },
    ]);
    expect(component.canGenerate()).toBe(true);
  });

  it('emits referencePaths and videoParentId on generate', () => {
    const { fixture, component } = makeFixture();
    const reqs: unknown[] = [];
    component.generateRequested.subscribe((r) => reqs.push(r));
    component.setMode('video');
    component.selectFamily('omni');
    component.prompt.set('make it rain');
    component.setVideoMode('edit');
    component.setVideoParent({ id: 'v9' } as never);
    fixture.detectChanges();
    component.generate();
    expect(reqs[0]).toMatchObject({ videoParentId: 'v9', referencePaths: [] });
    expect((reqs[0] as { settings: { mode: string } }).settings.mode).toBe('edit');
  });
});

describe('LeftPanel startVideoFollowUp', () => {
  it('switches to video mode, prefers the item\'s own family when it supports the mode (falling back otherwise), and sets mode + parent', () => {
    const { component } = makeFixture();
    const ownFamilyItem = { id: 'v1', familyId: 'omni' } as never;
    component.startVideoFollowUp(ownFamilyItem, 'extend');
    expect(component.mode()).toBe('video');
    // 'omni' supports extend, so it's kept even though 'veo' comes first in MODEL_FAMILIES.
    expect(component.familyId()).toBe('omni');
    expect(component.videoMode()).toBe('extend');
    expect(component.videoParent()).toEqual(ownFamilyItem);

    const { component: component2 } = makeFixture();
    const foreignFamilyItem = { id: 'v2', familyId: 'kling' } as never;
    component2.startVideoFollowUp(foreignFamilyItem, 'edit');
    // 'kling' can't edit, so a non-extend follow-up falls back to a family that can.
    expect(component2.familyId()).toBe('omni');
    expect(component2.videoMode()).toBe('edit');
    expect(component2.videoParent()).toEqual(foreignFamilyItem);
  });

  it('refuses to extend a clip whose own family cannot extend, leaving state untouched', () => {
    const { component } = makeFixture();
    const foreignFamilyItem = { id: 'v3', familyId: 'kling' } as never;
    component.startVideoFollowUp(foreignFamilyItem, 'extend');
    expect(component.mode()).toBe('image');
    expect(component.videoParent()).toBeNull();
  });
});

describe('LeftPanel hideAspect', () => {
  it('hides the aspect control only for i2v and keyframes', () => {
    const { component } = makeFixture();
    component.setMode('video');
    component.selectFamily('veo');
    component.setVideoMode('t2v');
    expect(component.hideAspect()).toBe(false);
    component.setVideoMode('i2v');
    expect(component.hideAspect()).toBe(true);
    component.setVideoMode('keyframes');
    expect(component.hideAspect()).toBe(true);
    component.setVideoMode('ref2v');
    expect(component.hideAspect()).toBe(false);
    component.setVideoMode('extend');
    expect(component.hideAspect()).toBe(false);
  });
});
