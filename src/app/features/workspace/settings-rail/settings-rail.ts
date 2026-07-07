import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideImage,
  lucideImagePlus,
  lucideVideo,
  lucideWandSparkles,
  lucideX,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  FamilyOption,
  GenerationSettings,
  MODEL_FAMILIES,
  ModelFamily,
  ModelKind,
  defaultSettings,
  userPriceUsd,
} from '../../../core/catalog/model-families';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { PreferencesService } from '../../../core/preferences/preferences-service';
import { OptionGroup } from '../option-group/option-group';
import { Hint } from '../../../shared/hint/hint';

export interface GenerateRequest {
  family: ModelFamily;
  settings: GenerationSettings;
  prompt: string;
  referenceId: string | null;
  referenceUrl: string | null;
  /** Outputs requested in this run. */
  batch: number;
  /** Total price for the whole batch. */
  priceUsd: number;
}

export interface ReferenceSelection {
  id: string | null; // null = uploaded file
  url: string;
}

const AXIS_TOOLTIPS = {
  version:
    'Model generation. Newer versions produce better results; price and options differ per version.',
  aspect: 'Shape of the output — width : height. Does not change the price.',
  resolution: 'Output pixel size. More pixels, bigger file, higher cost.',
  quality: 'Compute effort the model spends — detail and text fidelity, not pixels.',
  duration: 'Clip length in seconds. Video price scales with duration.',
  batch: 'Outputs per run — get up to 4 takes on the same prompt. You pay per output.',
} as const;

@Component({
  selector: 'app-settings-rail',
  templateUrl: './settings-rail.html',
  styleUrl: './settings-rail.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, NgIcon, HlmButton, OptionGroup, Hint, ...HlmDropdownMenuImports],
  providers: [
    provideIcons({
      lucideImage,
      lucideVideo,
      lucideWandSparkles,
      lucideImagePlus,
      lucideX,
      lucideChevronDown,
    }),
  ],
})
export class SettingsRail {
  private readonly ledger = inject(LedgerService);
  private readonly prefsService = inject(PreferencesService);

  readonly generateRequested = output<GenerateRequest>();
  readonly pickReferenceRequested = output<void>();

  readonly mode = signal<ModelKind>('image');
  readonly familyId = signal(firstFamilyOf('image').id);
  readonly settings = signal<GenerationSettings>(defaultSettings(firstFamilyOf('image')));
  readonly prompt = signal('');
  readonly reference = signal<ReferenceSelection | null>(null);

  readonly axisTooltips = AXIS_TOOLTIPS;

  constructor() {
    // Apply user preferences as starting state
    const prefs = this.prefsService.prefs();
    this.mode.set(prefs.defaultMode);
    const preferredId =
      prefs.defaultMode === 'video' ? prefs.defaultVideoFamily : prefs.defaultImageFamily;
    const preferred = MODEL_FAMILIES.find(
      (f) => f.id === preferredId && f.kind === prefs.defaultMode,
    );
    const family = preferred ?? firstFamilyOf(prefs.defaultMode);
    this.familyId.set(family.id);
    const base = defaultSettings(family);
    if (family.capabilities.aspectRatios.includes(prefs.defaultAspect)) {
      base.aspectRatio = prefs.defaultAspect;
    }
    this.settings.set(base);
  }

  readonly families = computed(() => MODEL_FAMILIES.filter((f) => f.kind === this.mode()));
  readonly family = computed(
    () => MODEL_FAMILIES.find((f) => f.id === this.familyId()) ?? this.families()[0],
  );

  readonly versionOptions = computed<FamilyOption[] | null>(
    () => this.family().capabilities.versions ?? null,
  );

  readonly aspectOptions = computed<FamilyOption[]>(() =>
    this.family().capabilities.aspectRatios.map((ar) => ({
      value: ar,
      label: ar,
      tooltip: `Output shape ${ar} (width : height).`,
    })),
  );

  readonly resolutionOptions = computed<FamilyOption[] | null>(() => {
    const f = this.family();
    const list = f.capabilities.resolutions;
    if (!list) return null;
    // GPT Image: 2K/4K exist on version 2 only
    if (f.id === 'gpt-image' && this.settings().version !== '2') {
      return list.filter((o) => o.value === '1K');
    }
    // Nano Banana Fast outputs ~1K only
    if (f.id === 'nano-banana' && this.settings().version === 'fast') {
      return list.filter((o) => o.value === '1K');
    }
    // Veo Fast has no 4K
    if (f.id === 'veo' && this.settings().version === 'fast') {
      return list.filter((o) => o.value !== '4K');
    }
    return list;
  });

  readonly qualityOptions = computed<FamilyOption[] | null>(
    () => this.family().capabilities.qualities ?? null,
  );

  readonly durationOptions = computed<FamilyOption[] | null>(() => {
    const durations = this.family().capabilities.durations;
    if (!durations) return null;
    return durations.map((d) => ({
      value: String(d),
      label: `${d}s`,
      tooltip: `${d}-second clip. Video price scales with duration.`,
    }));
  });

  readonly batchOptions: FamilyOption[] = [1, 2, 3, 4].map((n) => ({
    value: String(n),
    label: String(n),
    tooltip:
      n === 1
        ? 'Single output.'
        : `${n} different takes on the same prompt in one run — ${n}× the price.`,
  }));

  readonly batch = computed(() => this.settings().batch ?? 1);
  readonly unitPriceUsd = computed(() => userPriceUsd(this.family(), this.settings()));
  readonly priceUsd = computed(() => this.unitPriceUsd() * this.batch());
  readonly insufficient = computed(() => this.priceUsd() > this.ledger.balanceUsd());
  readonly canGenerate = computed(
    () => this.prompt().trim().length > 0 && !this.insufficient(),
  );

  notSupported(axis: string): string {
    return `${axis} is not supported by ${this.family().name}.`;
  }

  setMode(kind: ModelKind): void {
    this.mode.set(kind);
    this.selectFamily(firstFamilyOf(kind).id);
  }

  selectFamily(id: string): void {
    this.familyId.set(id);
    this.settings.set(defaultSettings(this.family()));
    if (!this.family().capabilities.imageInput) this.reference.set(null);
  }

  setAxis(axis: 'version' | 'aspectRatio' | 'resolution' | 'quality', value: string): void {
    this.settings.update((s) => ({ ...s, [axis]: value }));
    if (axis === 'version') this.clampSettings();
  }

  setDuration(value: string): void {
    this.settings.update((s) => ({ ...s, durationS: Number(value) }));
  }

  setBatch(value: string): void {
    this.settings.update((s) => ({ ...s, batch: Number(value) }));
  }

  updatePrompt(value: string): void {
    this.prompt.set(value);
  }

  setReference(ref: ReferenceSelection | null): void {
    this.reference.set(ref);
  }

  onFilePicked(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.reference.set({ id: null, url: String(reader.result) });
    reader.readAsDataURL(file);
    (event.target as HTMLInputElement).value = '';
  }

  generate(): void {
    if (!this.canGenerate()) return;
    this.generateRequested.emit({
      family: this.family(),
      settings: { ...this.settings() },
      prompt: this.prompt().trim(),
      referenceId: this.reference()?.id ?? null,
      referenceUrl: this.reference()?.url ?? null,
      batch: this.batch(),
      priceUsd: this.priceUsd(),
    });
    this.prompt.set('');
  }

  /** Reset options that fell out of range after a version switch. */
  private clampSettings(): void {
    const allowed = this.resolutionOptions();
    if (allowed && !allowed.some((o) => o.value === this.settings().resolution)) {
      this.settings.update((s) => ({ ...s, resolution: allowed[0]?.value }));
    }
  }
}

function firstFamilyOf(kind: ModelKind): ModelFamily {
  return MODEL_FAMILIES.find((f) => f.kind === kind)!;
}
