import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucidePalette } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  STYLE_CATEGORY_TITLES,
  STYLE_PRESETS,
  StyleCategory,
  StylePreset,
  styleById,
} from '../../../core/catalog/style-presets';
import { Hint } from '../../../shared/hint/hint';

interface StyleGroup {
  category: StyleCategory;
  title: string;
  presets: StylePreset[];
}

@Component({
  selector: 'app-style-picker',
  templateUrl: './style-picker.html',
  styleUrl: './style-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, Hint, ...HlmDropdownMenuImports],
  providers: [provideIcons({ lucideChevronDown, lucidePalette })],
})
export class StylePicker {
  readonly selected = input<string | null>(null);
  readonly changed = output<string | null>();

  readonly groups: StyleGroup[] = (
    Object.keys(STYLE_CATEGORY_TITLES) as StyleCategory[]
  ).map((category) => ({
    category,
    title: STYLE_CATEGORY_TITLES[category],
    presets: STYLE_PRESETS.filter((s) => s.category === category),
  }));

  readonly current = computed(() => {
    const id = this.selected();
    return id ? styleById(id) : null;
  });

  select(id: string | null): void {
    this.changed.emit(id);
  }
}
