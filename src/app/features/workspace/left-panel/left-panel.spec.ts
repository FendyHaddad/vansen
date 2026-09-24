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
import { PERSONA_SLOT_ORDER, personaGenCreditCost } from '../../../core/catalog/model-families';
import { PersonaDto } from '../../../core/api/dtos';

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

const READY_PERSONA: PersonaDto = {
  id: 'p1',
  name: 'Me',
  status: 'ready',
  photos: PERSONA_SLOT_ORDER.map((slot) => ({ slot, url: 'https://x/p1.jpg' })),
  thumbUrl: 'https://x/p1.jpg',
  createdAt: '2026-07-24T00:00:00Z',
};

function makePersonaFixture(): { fixture: ComponentFixture<LeftPanel>; component: LeftPanel } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [LeftPanel],
    providers: [
      {
        provide: LedgerService,
        useValue: { totalCredits: () => 1000 },
      },
      {
        provide: ProfileStore,
        useValue: { isOwner: signal(true), proActive: signal(true), studioActive: signal(true) },
      },
      {
        provide: PreferencesService,
        useValue: { prefs: () => PREFS, update: () => Promise.resolve() },
      },
      { provide: ApiService, useValue: {} },
      { provide: ModelAvailability, useValue: { disabled: () => false } },
      {
        provide: PersonaStore,
        useValue: {
          items: signal([READY_PERSONA]),
          load: () => Promise.resolve(),
          readyById: (id: string) => (id === READY_PERSONA.id ? READY_PERSONA : undefined),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(LeftPanel);
  return { fixture, component: fixture.componentInstance };
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

/**
 * FLUX.2 clamps every edge to 2048, so 4MP is real at 1:1 and impossible at
 * 16:9. The chip has to disappear with the ratio, and a 4MP selection left
 * behind by the switch would be refused by the server after the customer had
 * already pressed Generate.
 */
describe('LeftPanel resolution tiers follow the aspect ratio', () => {
  it('drops the 4MP chip when the ratio cannot reach 4MP', () => {
    const component = makeComponent();
    component.selectFamily('flux');

    component.setAxis('aspectRatio', '1:1');
    expect(component.resolutionOptions()?.map((o) => o.value)).toEqual(['1MP', '2MP', '4MP']);

    component.setAxis('aspectRatio', '16:9');
    expect(component.resolutionOptions()?.map((o) => o.value)).toEqual(['1MP', '2MP']);
  });

  it('moves a now-impossible 4MP selection to the largest size still offered', () => {
    const component = makeComponent();
    component.selectFamily('flux');
    component.setAxis('aspectRatio', '1:1');
    component.setAxis('resolution', '4MP');

    component.setAxis('aspectRatio', '16:9');

    // Not 1MP: someone who asked for the biggest wants the biggest available.
    expect(component.settings().resolution).toBe('2MP');
  });

  it('leaves a legal selection alone when the ratio changes', () => {
    const component = makeComponent();
    component.selectFamily('flux');
    component.setAxis('resolution', '1MP');
    component.setAxis('aspectRatio', '9:16');
    expect(component.settings().resolution).toBe('1MP');
  });
});

/**
 * The panel used to name a GPT Image version in a literal, so the two 2.5
 * models shipped on 2026-09-22 offering 1K only — a capability we sell, hidden
 * by the control that was supposed to expose it. The ceiling is catalog data
 * now; these lock the offer to it.
 */
describe('LeftPanel resolution tiers follow the model version', () => {
  it('offers 1K to 4K and all five qualities on both GPT Image 2.5 models', () => {
    const component = makeComponent();
    component.selectFamily('gpt-image');

    for (const version of ['2.5-flare', '2.5-sunburst']) {
      component.setAxis('version', version);
      expect(component.resolutionOptions()?.map((o) => o.value)).toEqual(['1K', '2K', '4K']);
      expect(component.qualityOptions()?.map((o) => o.value)).toEqual([
        'low', 'medium', 'high', 'xhigh', 'max',
      ]);
    }
  });

  it('withholds the Seedream tiers an endpoint cannot render and moves the selection', () => {
    const component = makeComponent();
    component.selectFamily('seedream');
    component.setAxis('version', '4');
    component.setAxis('resolution', '4K');

    // 5 Pro tops out at 2K: the largest still on offer, not the smallest.
    component.setAxis('version', '5-pro');
    expect(component.resolutionOptions()?.map((o) => o.value)).toEqual(['1K', '2K']);
    expect(component.settings().resolution).toBe('2K');

    // 4.5 has no 1K: a 1K selection is pulled UP to the smallest it can do.
    component.setAxis('resolution', '1K');
    component.setAxis('version', '4.5');
    expect(component.resolutionOptions()?.map((o) => o.value)).toEqual(['2K', '4K']);
    expect(component.settings().resolution).toBe('4K');
  });

  it('prices a reference image into the credit total where the provider bills it', () => {
    const component = makeComponent();
    component.selectFamily('gpt-image');
    const without = component.unitCredits();
    component.reference.set({ id: null, uploadId: 'u1', url: 'https://x/u1.png' });
    expect(component.unitCredits()).toBeGreaterThan(without);

    // Seedream bills flat per image, so a reference changes nothing there.
    component.reference.set(null);
    component.selectFamily('seedream');
    const flat = component.unitCredits();
    component.reference.set({ id: null, uploadId: 'u1', url: 'https://x/u1.png' });
    expect(component.unitCredits()).toBe(flat);
  });

  it('still caps Nano Banana Fast at 1K', () => {
    const component = makeComponent();
    component.selectFamily('nano-banana');
    component.setAxis('version', 'fast');
    expect(component.resolutionOptions()?.map((o) => o.value)).toEqual(['1K']);

    component.setAxis('version', 'standard');
    expect(component.resolutionOptions()?.map((o) => o.value)).toEqual(['1K', '2K', '4K']);
  });
});

/**
 * R25: the composer must not offer Generate for a request it would have to
 * compact. ref2v accepts 1–3 references, so [empty, filled] passes a naive
 * count and would ship the second reference as the first.
 */
describe('LeftPanel video reference slots', () => {
  /** veo is the family that offers all three of these modes. */
  function videoPanel(mode: 'i2v' | 'ref2v' | 'keyframes'): LeftPanel {
    const component = makeComponent();
    component.setMode('video');
    component.selectFamily('veo');
    component.setVideoMode(mode);
    // A family that does not offer the mode silently keeps t2v, whose rule is
    // 0-0 references — every assertion below would then pass for the wrong
    // reason.
    expect(component.videoMode()).toBe(mode);
    component.prompt.set('a cat walks');
    return component;
  }

  const ref = (path: string) => ({ path, url: 'blob:test' });

  it('refuses Generate while a keyframes pair is half filled', () => {
    const component = videoPanel('keyframes');
    component.refSlots.set([null, ref('last.png')]);
    expect(component.canGenerate()).toBe(false);
  });

  it('allows Generate once both keyframes are in place', () => {
    const component = videoPanel('keyframes');
    component.refSlots.set([ref('first.png'), ref('last.png')]);
    expect(component.canGenerate()).toBe(true);
  });

  it('refuses Generate when a ref2v slot is a hole rather than the end', () => {
    const component = videoPanel('ref2v');
    component.refSlots.set([null, ref('second.png')]);
    // One reference IS within ref2v's 1–3, so only the hole check catches it.
    expect(component.canGenerate()).toBe(false);
  });

  it('allows Generate for one ref2v reference in the first position', () => {
    const component = videoPanel('ref2v');
    component.refSlots.set([ref('first.png')]);
    expect(component.canGenerate()).toBe(true);
  });

  it('refuses Generate when i2v has no reference at all', () => {
    const component = videoPanel('i2v');
    component.refSlots.set([]);
    expect(component.canGenerate()).toBe(false);
  });
});

/**
 * A persona supplies its own fixed pipeline: Nano Banana Pro at 4K. The
 * Resolution control (and Quality, gated the same way) has nothing to offer
 * there, and the price is the flat persona rate times the batch size.
 */
describe('LeftPanel persona pipeline', () => {
  it('shows the persona chip, hides Resolution, and prices per-batch at the persona rate', () => {
    const { fixture, component } = makePersonaFixture();
    component.setPersona(READY_PERSONA.id);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Persona · Nano Banana Pro · 4K');
    const labels = Array.from(fixture.nativeElement.querySelectorAll('.ss-label')) as HTMLElement[];
    expect(labels.some((el) => el.textContent?.trim().startsWith('Resolution'))).toBe(false);

    component.setBatch('4');
    expect(component.unitCredits()).toBe(personaGenCreditCost());
    expect(component.priceCredits()).toBe(4 * personaGenCreditCost());
  });

  it('shows the per-image × batch price form on the Generate button', () => {
    const { fixture, component } = makePersonaFixture();
    component.setPersona(READY_PERSONA.id);
    component.prompt.set('a portrait');
    component.setBatch('4');
    fixture.detectChanges();

    const unit = personaGenCreditCost();
    expect(fixture.nativeElement.querySelector('.gen-btn').textContent).toContain(
      `${unit} cr × 4 = ${unit * 4} cr`,
    );
  });
});
