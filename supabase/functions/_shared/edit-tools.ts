/**
 * The Studio panel's AI edit tools (remove, fill, expand, background). Each
 * runs one curated backend model at a FIXED credit price, not the margin
 * formula in credit-cost.ts. Entry points: EDIT_TOOLS, editToolById.
 */

/**
 * Studio panel AI edit tools — fixed-function (one curated backend model each,
 * user never picks) with fixed retail prices (NOT the PAYG margin formula).
 */
export interface EditTool {
  id: string;
  name: string;
  /** Fixed credit price per use — NOT the margin formula. */
  creditCost: number;
  /** Our provider cost, for margin bookkeeping only. */
  providerCost: number;
  /** Tool needs a painted mask before it can run. */
  needsMask: boolean;
  /** Tool needs a user prompt (generative fill). */
  needsPrompt: boolean;
  blurb: string;
}

export const EDIT_TOOLS: EditTool[] = [
  {
    id: 'edit-remove',
    name: 'Remove Object',
    creditCost: 10,
    providerCost: 0.05,
    needsMask: true,
    needsPrompt: false,
    blurb: 'Mask anything and AI repaints the scene behind it.',
  },
  {
    id: 'edit-fill',
    name: 'Generative Fill',
    creditCost: 10,
    providerCost: 0.05,
    needsMask: true,
    needsPrompt: true,
    blurb: 'Mask an area and describe what should appear there.',
  },
  {
    id: 'edit-expand',
    name: 'Expand',
    creditCost: 10,
    providerCost: 0.05,
    needsMask: false,
    needsPrompt: false,
    blurb: 'Grow the canvas — AI paints beyond the original edges.',
  },
  {
    id: 'edit-bg',
    name: 'Remove Background',
    creditCost: 5,
    providerCost: 0.002,
    needsMask: false,
    needsPrompt: false,
    blurb: 'Cut the subject out onto a transparent background.',
  },
];

export function editToolById(id: string): EditTool | undefined {
  return EDIT_TOOLS.find((t) => t.id === id);
}
