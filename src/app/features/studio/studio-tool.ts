/** Local (free) tools available in the Studio panel. */
export type StudioTool =
  | 'crop'
  | 'adjust'
  | 'filters'
  | 'sharpen'
  | 'smooth'
  | 'liquify'
  | 'heal'
  | 'mask'
  | 'enhance'
  | 'levels'
  | 'clone'
  | 'retouch'
  | 'perspective'
  | 'bgremove'
  | 'bokeh'
  | 'upscale'
  | 'select'
  | 'dehaze'
  | 'portraitsmooth'
  | 'erase';

/** Tools that own the left-click/drag gesture on the canvas (no click-drag
 * panning) — brushes plus the point-pick tools. */
export const DRAG_TOOLS: ReadonlySet<StudioTool> = new Set([
  'crop',
  'heal',
  'liquify',
  'mask',
  'clone',
  'retouch',
  'bokeh',
  'select',
  'erase',
]);
