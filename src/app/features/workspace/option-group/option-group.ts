import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FamilyOption } from '../../../core/catalog/model-families';
import { Hint } from '../../../shared/hint/hint';

/**
 * Renders one settings axis (Version, Resolution, Quality, ...) in a fixed slot.
 * The group always renders; when the selected model does not support the axis it
 * greys out with an explanatory tooltip instead of disappearing.
 */
@Component({
  selector: 'app-option-group',
  templateUrl: './option-group.html',
  styleUrl: './option-group.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Hint],
})
export class OptionGroup {
  readonly label = input.required<string>();
  readonly axisTooltip = input('');
  readonly options = input<FamilyOption[] | null>(null);
  readonly selected = input<string | undefined>(undefined);
  readonly disabledReason = input('');
  readonly changed = output<string>();
}
