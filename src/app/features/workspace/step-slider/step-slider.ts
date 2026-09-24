import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FamilyOption } from '../../../core/catalog/model-families';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';
import { Hint } from '../../../shared/hint/hint';

const RATIO_PATTERN = /^(\d+):(\d+)$/;
const RATIO_BOX = 14; // px, longest edge of the aspect preview icon

/** One thumb move, from stop to stop. `key` alternates the animation classes so each move replays. */
export interface SliderMove {
  from: number;
  to: number;
  key: number;
}

/**
 * One settings axis as a notched slider, like the iOS text-size control: one
 * stop per option, the same track length whatever the stop count. Options the
 * current combination cannot run stay on the track, dimmed, and the thumb
 * skips over them. An axis with nothing to offer renders nothing.
 */
@Component({
  selector: 'app-step-slider',
  templateUrl: './step-slider.html',
  styleUrl: './step-slider.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Hint, ...HlmTooltipImports],
})
export class StepSlider {
  readonly label = input.required<string>();
  readonly axisTooltip = input('');
  readonly options = input<FamilyOption[] | null>(null);
  /** Values shown on the track but not selectable right now. */
  readonly disabled = input<string[]>([]);
  readonly selected = input<string | undefined>(undefined);
  readonly changed = output<string>();

  readonly index = computed(() =>
    Math.max(0, this.options()?.findIndex((o) => o.value === this.selected()) ?? 0),
  );
  readonly selectedOption = computed(() => this.options()?.[this.index()] ?? null);
  readonly max = computed(() => (this.options()?.length ?? 1) - 1);

  /** The latest move, for the thumb's shrink and the trail it leaves; null until one happens. */
  readonly move = signal<SliderMove | null>(null);
  /** Which of the two identical animation classes plays this move. */
  readonly phase = computed(() => {
    const m = this.move();
    if (!m) return null;
    return m.key % 2 === 1 ? 'a' : 'b';
  });
  readonly trailStart = computed(() => {
    const m = this.move();
    return m ? this.position(Math.min(m.from, m.to)) : 0;
  });
  readonly trailWidth = computed(() => {
    const m = this.move();
    return m ? Math.abs(this.position(m.to) - this.position(m.from)) : 0;
  });

  private lastIndex = -1;
  private lastOptions: FamilyOption[] | null = null;

  constructor() {
    effect(() => {
      const options = this.options();
      const index = this.index();
      untracked(() => this.track(options, index));
    });
  }

  /** Percent along the track for a stop. */
  position(stop: number): number {
    const max = this.max();
    return max > 0 ? (stop / max) * 100 : 0;
  }

  isDisabled(option: FamilyOption): boolean {
    return this.disabled().includes(option.value);
  }

  pick(position: number): void {
    const option = this.options()?.[position];
    if (!option || this.isDisabled(option)) return;
    if (option.value === this.selected()) return;
    this.changed.emit(option.value);
  }

  onInput(event: Event): void {
    const el = event.target as HTMLInputElement;
    const wanted = Number(el.value);
    const target = this.nearestEnabled(wanted, Math.sign(wanted - this.index()));
    el.value = String(target);
    this.pick(target);
  }

  /** Width/height of the shape icon for a ratio label like "16:9"; null otherwise. */
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

  /** A new option list (another model) is a fresh slider, not a move. */
  private track(options: FamilyOption[] | null, index: number): void {
    const fresh = options !== this.lastOptions;
    const from = this.lastIndex;
    this.lastOptions = options;
    this.lastIndex = index;
    if (fresh) {
      this.move.set(null);
      return;
    }
    if (from < 0 || from === index) return;
    this.move.set({ from, to: index, key: (this.move()?.key ?? 0) + 1 });
  }

  /** The stop the thumb lands on: the wanted one, else the next enabled stop onward, else back. */
  private nearestEnabled(wanted: number, direction: number): number {
    const options = this.options() ?? [];
    const step = direction || 1;
    for (let i = wanted; i >= 0 && i < options.length; i += step) {
      if (!this.isDisabled(options[i])) return i;
    }
    for (let i = wanted - step; i >= 0 && i < options.length; i -= step) {
      if (!this.isDisabled(options[i])) return i;
    }
    return this.index();
  }
}
