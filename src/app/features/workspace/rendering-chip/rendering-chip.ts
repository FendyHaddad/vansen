import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-rendering-chip',
  templateUrl: './rendering-chip.html',
  styleUrl: './rendering-chip.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RenderingChip {
  readonly count = input.required<number>();
  readonly label = computed(() => `Rendering ${this.count()} ${this.count() === 1 ? 'video' : 'videos'}`);
}
