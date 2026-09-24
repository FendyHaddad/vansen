import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideUserRound } from '@ng-icons/lucide';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { PersonaStore } from '../../../core/personas/persona-store';
import { ProfileStore } from '../../../core/profile/profile-store';
import { PersonaStatus } from '../../../core/enums';

@Component({
  selector: 'app-persona-picker',
  templateUrl: './persona-picker.html',
  styleUrl: './persona-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, ...HlmDropdownMenuImports],
  providers: [provideIcons({ lucideChevronDown, lucideUserRound })],
})
export class PersonaPicker {
  private readonly store = inject(PersonaStore);
  private readonly profile = inject(ProfileStore);

  readonly selected = input<string | null>(null);
  readonly changed = output<string | null>();
  readonly manageRequested = output<void>();

  readonly locked = computed(() => !this.profile.studioActive());
  readonly personas = this.store.items;
  readonly statuses = PersonaStatus;

  readonly current = computed(() => {
    const id = this.selected();
    return id ? (this.store.readyById(id) ?? null) : null;
  });

  select(id: string | null): void {
    this.changed.emit(id);
  }

  manage(): void {
    this.manageRequested.emit();
  }
}
