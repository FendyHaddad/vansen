import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { RightPanel } from './right-panel';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { EditToolCatalog } from '../../../core/catalog/edit-tool-catalog';
import { EDIT_TOOLS, type EditTool } from '../../../core/catalog/model-families';

const STUDIO_TOOL = EDIT_TOOLS.find((t) => t.id === 'edit-bg') as EditTool;
const PRO_TOOL = EDIT_TOOLS.find((t) => t.id === 'edit-remove') as EditTool;

interface Setup {
  studioActive: boolean;
  proActive: boolean;
  planFor: Record<string, 'studio' | 'pro'>;
}

function make(setup: Setup): ComponentFixture<RightPanel> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [RightPanel],
    providers: [
      { provide: LedgerService, useValue: { totalCredits: () => 1000 } },
      {
        provide: ProfileStore,
        useValue: {
          loaded: signal(true),
          studioActive: signal(setup.studioActive),
          proActive: signal(setup.proActive),
          subscription: signal(null),
        },
      },
      {
        provide: EditToolCatalog,
        useValue: {
          loaded: signal(true),
          planFor: (id: string) => setup.planFor[id] ?? 'pro',
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(RightPanel);
  fixture.componentRef.setInput('editing', true);
  fixture.detectChanges();
  return fixture;
}

/**
 * `flat.editTools[].plan` (from `models.min_plan`) is the source of truth for
 * each AI edit tool's lock — not a blanket "AI tools are Pro" rule. These
 * specs exercise the three shapes a server-side `min_plan` change can take on
 * the client without a web deploy.
 */
describe('RightPanel AI edit tool locking', () => {
  let panel: RightPanel;

  beforeEach(() => {
    panel = make({
      studioActive: true,
      proActive: false,
      planFor: { [STUDIO_TOOL.id]: 'studio', [PRO_TOOL.id]: 'pro' },
    }).componentInstance;
  });

  it('leaves a studio-plan tool unlocked for a Studio subscriber', () => {
    expect(panel.aiToolPlan(STUDIO_TOOL)).toBe('studio');
    expect(panel.aiToolLocked(STUDIO_TOOL)).toBe(false);
  });

  it('locks a pro-plan tool for a Studio subscriber', () => {
    expect(panel.aiToolPlan(PRO_TOOL)).toBe('pro');
    expect(panel.aiToolLocked(PRO_TOOL)).toBe(true);
  });

  it('unlocks the same pro-plan tool once the subscriber is on Pro', () => {
    const proPanel = make({
      studioActive: true,
      proActive: true,
      planFor: { [STUDIO_TOOL.id]: 'studio', [PRO_TOOL.id]: 'pro' },
    }).componentInstance;
    expect(proPanel.aiToolLocked(PRO_TOOL)).toBe(false);
  });

  it('names the plan a locked tool actually needs, not a hard-coded "Pro"', () => {
    expect(panel.aiToolLockTitle(PRO_TOOL)).toBe('Pro tool — upgrade to unlock');
  });

  it('reports the section as mixed when only some AI tools are locked', () => {
    expect(panel.anyAiToolLocked()).toBe(true);
    expect(panel.anyAiToolUnlocked()).toBe(true);
  });

  it('refuses to run a locked tool even if credits would cover it', () => {
    let emitted: unknown = null;
    panel.aiToolRequested.subscribe((e) => (emitted = e));
    panel.runAiTool(PRO_TOOL.id);
    expect(emitted).toBeNull();
  });

  it('runs an unlocked tool', () => {
    let emitted: { toolId: string } | null = null;
    panel.aiToolRequested.subscribe((e) => (emitted = e));
    panel.runAiTool(STUDIO_TOOL.id);
    expect(emitted).toEqual({ toolId: STUDIO_TOOL.id, prompt: '' });
  });
});

describe('RightPanel readiness', () => {
  it('is not ready until the AI edit tool catalog has answered', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [RightPanel],
      providers: [
        { provide: LedgerService, useValue: { totalCredits: () => 0 } },
        {
          provide: ProfileStore,
          useValue: {
            loaded: signal(true),
            studioActive: signal(true),
            proActive: signal(false),
            subscription: signal(null),
          },
        },
        {
          provide: EditToolCatalog,
          useValue: { loaded: signal(false), planFor: () => 'pro' },
        },
      ],
    });
    const fixture = TestBed.createComponent(RightPanel);
    fixture.detectChanges();
    expect(fixture.componentInstance.ready()).toBe(false);
  });
});

describe('RightPanel locked Pro tools', () => {
  it('opens the upgrade dialog instead of selecting the tool below Pro', () => {
    const panel = make({ studioActive: true, proActive: false, planFor: {} }).componentInstance;
    let upgrades = 0;
    panel.upgradeRequested.subscribe(() => upgrades++);
    panel.pickProTool(panel.proTools[0].id);
    expect(upgrades).toBe(1);
    expect(panel.activeTool()).toBeNull();
  });

  it('selects the tool for a Pro subscriber', () => {
    const panel = make({ studioActive: true, proActive: true, planFor: {} }).componentInstance;
    panel.pickProTool(panel.proTools[0].id);
    expect(panel.activeTool()).toBe(panel.proTools[0].id);
  });
});
