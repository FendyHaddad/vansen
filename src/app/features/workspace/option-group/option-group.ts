import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideChevronDown } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { FamilyOption } from '../../../core/catalog/model-families';
import { Hint } from '../../../shared/hint/hint';

const RATIO_PATTERN = /^(\d+):(\d+)$/;
const RATIO_BOX = 16; // px, longest edge of the aspect preview icon

/**
 * One settings axis (Version, Resolution, Quality, ...) as a settings row:
 * label on the left, current value + chevron on the right, dropdown on click.
 * Aspect-ratio options render a small shape preview so non-technical users
 * can see what 1:1 vs 16:9 means. Axes the model doesn't support render nothing.
 */
@Component({
  selector: 'app-option-group',
  templateUrl: './option-group.html',
  styleUrl: './option-group.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, Hint, ...HlmDropdownMenuImports],
  providers: [provideIcons({ lucideChevronDown, lucideCheck })],
})
export class OptionGroup {
  readonly label = input.required<string>();
  readonly axisTooltip = input('');
  readonly options = input<FamilyOption[] | null>(null);
  readonly selected = input<string | undefined>(undefined);
  readonly changed = output<string>();

  readonly selectedOption = computed(
    () => this.options()?.find((o) => o.value === this.selected()) ?? null,
  );

  /** Width/height of the little shape icon for ratio labels like "16:9"; null otherwise. */
  ratioBox(option: FamilyOption): { w: number; h: number } | null {
    const match = RATIO_PATTERN.exec(option.label);
    if (!match) return null;
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (!w || !h) return null;
    return w >= h
      ? { w: RATIO_BOX, h: Math.max(6, Math.round((RATIO_BOX * h) / w)) }
      : { w: Math.max(6, Math.round((RATIO_BOX * w) / h)), h: RATIO_BOX };
  }
}
