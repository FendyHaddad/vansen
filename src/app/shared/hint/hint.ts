import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';

@Component({
  selector: 'app-hint',
  templateUrl: './hint.html',
  styleUrl: './hint.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [...HlmTooltipImports],
})
export class Hint {
  readonly text = input.required<string>();
}
