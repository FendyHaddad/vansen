// Which plan each Studio tool belongs to — one table, read by the panel that
// locks the tool and by every page that sells it.
//
// The pricing page used to describe the on-canvas suite as "free and unlimited
// on every plan" while the panel locked Cut Out, Bokeh and Upscale behind Pro.
// Both statements were hand-written, so neither knew about the other. They now
// come from here, and the spec fails if they diverge.
import type { StudioTool } from '../../features/studio/studio-tool';

export type ToolPlan = 'studio' | 'pro';

export interface ToolDef {
  id: StudioTool;
  label: string;
  icon: string;
}

/** Studio-tier tools — included with any subscription. */
export const LOCAL_TOOLS: ToolDef[] = [
  { id: 'crop', label: 'Crop', icon: 'lucideCrop' },
  { id: 'adjust', label: 'Adjust', icon: 'lucideSlidersHorizontal' },
  { id: 'filters', label: 'Filters', icon: 'lucidePalette' },
  { id: 'sharpen', label: 'Sharpen', icon: 'lucideWand' },
  { id: 'smooth', label: 'Smooth', icon: 'lucideWand' },
  { id: 'heal', label: 'Spot Heal', icon: 'lucideBrush' },
  { id: 'dehaze', label: 'Dehaze', icon: 'lucideCloudFog' },
  { id: 'portraitsmooth', label: 'Portrait Smooth', icon: 'lucideSmile' },
];

/** Pro-tier locals — pro/owner subscribers only (see `proLocked`). */
export const PRO_TOOLS: ToolDef[] = [
  { id: 'select', label: 'Ai Select', icon: 'lucideMousePointerClick' },
  { id: 'upscale', label: 'Ai Upscale', icon: 'lucideMaximize2' },
  { id: 'aisharpen', label: 'Ai Sharpen', icon: 'lucideFocus' },
  { id: 'bgremove', label: 'Cut Out', icon: 'lucideImageOff' },
  { id: 'bokeh', label: 'Bokeh', icon: 'lucideAperture' },
  { id: 'enhance', label: 'Enhance', icon: 'lucideSun' },
  { id: 'levels', label: 'Levels', icon: 'lucideChartNoAxesColumn' },
  { id: 'clone', label: 'Clone', icon: 'lucideStamp' },
  { id: 'retouch', label: 'Retouch', icon: 'lucideEclipse' },
  { id: 'perspective', label: 'Perspective', icon: 'lucideMove3d' },
  { id: 'liquify', label: 'Liquify', icon: 'lucideScan' },
  { id: 'erase', label: 'Magic Erase', icon: 'lucideEraser' },
];

/**
 * Every tool, and the plan that grants it.
 *
 * `satisfies Record<StudioTool, ToolPlan>` is the point: add a tool to the
 * union without pricing it and the build fails, rather than the tool quietly
 * appearing on a sales page for a plan that does not include it.
 *
 * `mask` has no panel button of its own — it is reached from inside the AI edit
 * tools — but it is still a capability the copy can mention, so it is priced.
 */
export const ENTITLEMENTS = {
  crop: 'studio',
  adjust: 'studio',
  filters: 'studio',
  sharpen: 'studio',
  smooth: 'studio',
  heal: 'studio',
  dehaze: 'studio',
  portraitsmooth: 'studio',
  mask: 'studio',
  select: 'pro',
  upscale: 'pro',
  aisharpen: 'pro',
  bgremove: 'pro',
  bokeh: 'pro',
  enhance: 'pro',
  levels: 'pro',
  clone: 'pro',
  retouch: 'pro',
  perspective: 'pro',
  liquify: 'pro',
  erase: 'pro',
} as const satisfies Record<StudioTool, ToolPlan>;

export const requiredPlanFor = (id: StudioTool): ToolPlan => ENTITLEMENTS[id];

/** The tools this tier ADDS. Pro's sales copy is Studio's list plus this one. */
export const toolsFor = (plan: ToolPlan): StudioTool[] =>
  (Object.keys(ENTITLEMENTS) as StudioTool[]).filter((id) => ENTITLEMENTS[id] === plan);

/** Display labels, in panel order. `mask` has no button, so it names itself. */
export const toolLabels = (ids: StudioTool[]): string[] =>
  ids.map((id) => [...LOCAL_TOOLS, ...PRO_TOOLS].find((t) => t.id === id)?.label ?? 'Mask');
