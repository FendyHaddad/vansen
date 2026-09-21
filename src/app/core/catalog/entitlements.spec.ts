import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENTS,
  LOCAL_TOOLS,
  PRO_TOOLS,
  requiredPlanFor,
  toolLabels,
  toolsFor,
} from './entitlements';
import type { StudioTool } from '../../features/studio/studio-tool';

/**
 * D1: what a page promises and what the panel unlocks must be the same fact.
 *
 * The pricing page said the on-canvas suite was "free and unlimited on every
 * plan" and named Cut Out, Bokeh and Upscale in the same breath. The panel
 * locked all three behind Pro. A Studio subscriber paid for a list and then hit
 * a padlock on three of the items in it.
 */
describe('entitlements are the single source for gating and for selling', () => {
  it('panel paywalls agree with the same entitlement table as pricing', () => {
    expect(PRO_TOOLS.map((t) => t.id).sort()).toEqual(toolsFor('pro').sort());
    expect([...LOCAL_TOOLS.map((t) => t.id), 'mask'].sort()).toEqual(toolsFor('studio').sort());
    expect(requiredPlanFor('adjust')).toBe('studio');
    expect(requiredPlanFor('bgremove')).toBe('pro');
  });

  it('prices every tool in the union — no tool can be sold unpriced', () => {
    // The `satisfies` clause is a compile-time guard; this is the runtime one,
    // so a tool added through a cast still gets caught.
    const priced = new Set(Object.keys(ENTITLEMENTS));
    const shown = [...LOCAL_TOOLS, ...PRO_TOOLS].map((t) => t.id);
    for (const id of shown) expect(priced.has(id)).toBe(true);
    expect(priced.size).toBe(shown.length + 1); // + mask, which has no button
  });

  it('assigns each tool exactly one plan', () => {
    const studio = new Set(toolsFor('studio'));
    const overlap = toolsFor('pro').filter((id) => studio.has(id));
    expect(overlap).toEqual([]);
  });

  it('the Pro tier is what Pro ADDS, not everything Pro can do', () => {
    // A page that renders Pro's list must concatenate, not substitute — this
    // is the shape mistake that produced "Pro loses crop" copy in review.
    expect(toolsFor('pro')).not.toContain('crop');
    expect(toolsFor('studio')).toContain('crop');
  });

  it('names every tool it lists', () => {
    const labels = toolLabels(toolsFor('pro'));
    expect(labels).toContain('Cut Out');
    expect(labels.some((l) => !l)).toBe(false);
  });

  it('names the contextual mask tool even though it has no button', () => {
    expect(toolLabels(['mask' as StudioTool])).toEqual(['Mask']);
  });

  it('keeps the three tools the pricing page used to give away behind Pro', () => {
    for (const id of ['bgremove', 'bokeh', 'upscale'] as StudioTool[]) {
      expect(requiredPlanFor(id)).toBe('pro');
    }
  });
});
