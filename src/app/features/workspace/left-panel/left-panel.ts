import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideImage,
  lucideImagePlus,
  lucideLock,
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
  creditCost,
  defaultSettings,
  personaGenCreditCost,
} from '../../../core/catalog/model-families';
import { LedgerService } from '../../../core/ledger/ledger-service';
import { ProfileStore } from '../../../core/profile/profile-store';
import { PreferencesService } from '../../../core/preferences/preferences-service';
import { ApiService } from '../../../core/api/api-service';
import { UploadResponse } from '../../../core/api/dtos';
import { ModelAvailability } from '../../../core/models/model-availability';
import { OptionGroup } from '../option-group/option-group';
import { Hint } from '../../../shared/hint/hint';
import { CachedSrc } from '../../../core/media/cached-src';
import { styleById } from '../../../core/catalog/style-presets';
import { StylePicker } from '../style-picker/style-picker';
import { PersonaStore } from '../../../core/personas/persona-store';
import { PersonaPicker } from '../persona-picker/persona-picker';
import { TrendPreset } from '../../../core/catalog/trend-presets';
import { TrendGallery } from '../trend-gallery/trend-gallery';

export interface GenerateRequest {
  family: ModelFamily;
  settings: GenerationSettings;
  prompt: string;
  /** Style preset id, null = none. Server appends the modifier. */
  style: string | null;
  /** Persona id, null = none. Server injects the trigger + locks to flux-lora. */
  personaId: string | null;
  /** Trend the prompt was prefilled from, null = hand-written. */
  trendId: string | null;
  /** Library generation used as edit source. */
  referenceId: string | null;
  /** Uploaded image (storage path) used as edit source. */
  referenceUploadId: string | null;
  referenceUrl: string | null;
  /** Outputs requested in this run. */
  batch: number;
  /** Total credit price for the whole batch (display/confirm only — server prices). */
  priceCredits: number;
}

export interface ReferenceSelection {
  id: string | null; // library generation id
  uploadId: string | null; // storage upload path
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
  selector: 'app-left-panel',
  templateUrl: './left-panel.html',
  styleUrl: './left-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgIcon,
    HlmButton,
    OptionGroup,
    Hint,
    CachedSrc,
    StylePicker,
    PersonaPicker,
    TrendGallery,
    ...HlmDropdownMenuImports,
  ],
  providers: [
    provideIcons({
      lucideImage,
      lucideLock,
      lucideVideo,
      lucideWandSparkles,
      lucideImagePlus,
      lucideX,
      lucideChevronDown,
    }),
  ],
})
export class LeftPanel {
  private readonly ledger = inject(LedgerService);
  private readonly profileStore = inject(ProfileStore);
  private readonly prefsService = inject(PreferencesService);
  private readonly api = inject(ApiService);
  private readonly availability = inject(ModelAvailability);
  private readonly personaStore = inject(PersonaStore);

  readonly generateRequested = output<GenerateRequest>();
  readonly pickReferenceRequested = output<void>();
  readonly managePersonasRequested = output<void>();

  readonly uploading = signal(false);
  readonly uploadError = signal('');

  /** Video generation ships with the Pro tier (Phase 4b) — locked teaser until then. */
  readonly videoLocked = true;

  readonly mode = signal<ModelKind>('image');
  readonly familyId = signal(firstFamilyOf('image').id);
  readonly settings = signal<GenerationSettings>(defaultSettings(firstFamilyOf('image')));
  readonly prompt = signal('');
  readonly style = signal<string | null>(null);
  readonly persona = signal<string | null>(null);
  /** Set when the prompt came from a trend prefill; survives edits, dies with the prompt. */
  readonly appliedTrend = signal<string | null>(null);
  readonly reference = signal<ReferenceSelection | null>(null);

  readonly axisTooltips = AXIS_TOOLTIPS;

  constructor() {
    // Apply user preferences as starting state
    const prefs = this.prefsService.prefs();
    this.mode.set(this.videoLocked ? 'image' : prefs.defaultMode);
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
    this.style.set(styleById(prefs.defaultStyle)?.id ?? null);
    this.persona.set(prefs.defaultPersona || null);
    // Reset silently if the remembered persona is gone or not ready.
    void this.personaStore.load().then(() => {
      const id = this.persona();
      if (id && !this.personaStore.readyById(id)) this.persona.set(null);
    });
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

  /** Owner accounts have unlimited credits — the price is shown, never a blocker. */
  readonly isOwner = this.profileStore.isOwner;

  readonly personaActive = computed(() => this.mode() === 'image' && !!this.persona());

  readonly batch = computed(() => this.settings().batch ?? 1);
  readonly unitCredits = computed(() =>
    this.personaActive() ? personaGenCreditCost() : creditCost(this.family(), this.settings()),
  );
  readonly priceCredits = computed(() => this.unitCredits() * this.batch());
  readonly insufficient = computed(
    () => !this.isOwner() && this.priceCredits() > this.ledger.totalCredits(),
  );
  readonly canGenerate = computed(
    () => this.prompt().trim().length > 0 && !this.insufficient(),
  );

  setMode(kind: ModelKind): void {
    if (kind === 'video' && this.videoLocked) return;
    this.appliedTrend.set(null);
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
    if (!value.trim()) this.appliedTrend.set(null);
  }

  setStyle(id: string | null): void {
    this.style.set(id);
    void this.prefsService.update({ defaultStyle: id ?? '' });
  }

  applyTrend(trend: TrendPreset): void {
    const current = this.prompt().trim();
    if (current && current !== trend.prompt) {
      if (!confirm('Replace your current prompt with this trend?')) return;
    }
    this.prompt.set(trend.prompt);
    this.appliedTrend.set(trend.id);
    if (trend.aspectRatio && this.family().capabilities.aspectRatios.includes(trend.aspectRatio)) {
      this.settings.update((s) => ({ ...s, aspectRatio: trend.aspectRatio! }));
    }
  }

  setPersona(id: string | null): void {
    this.persona.set(id);
    // The likeness pipeline is text-to-image only — a lingering reference would
    // silently flip the request to an edit op the server rejects.
    if (id) this.reference.set(null);
    void this.prefsService.update({ defaultPersona: id ?? '' });
  }

  setReference(ref: ReferenceSelection | null): void {
    this.reference.set(ref);
  }

  async onFilePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.uploadError.set('');
    this.uploading.set(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await this.api.postForm<UploadResponse>('/uploads', form);
      this.reference.set({ id: null, uploadId: res.uploadId, url: res.url });
    } catch (e) {
      this.uploadError.set(
        (e as { code?: string })?.code === 'content_policy'
          ? 'That image violates our content policy.'
          : 'Upload failed — try another image.',
      );
    } finally {
      this.uploading.set(false);
    }
  }

  disabledFamily(familyId: string): boolean {
    return this.availability.disabled(familyId);
  }

  generate(): void {
    if (!this.canGenerate()) return;
    this.generateRequested.emit({
      family: this.family(),
      settings: { ...this.settings() },
      prompt: this.prompt().trim(),
      style: this.mode() === 'image' ? this.style() : null,
      personaId: this.personaActive() ? this.persona() : null,
      trendId: this.mode() === 'image' ? this.appliedTrend() : null,
      referenceId: this.personaActive() ? null : (this.reference()?.id ?? null),
      referenceUploadId: this.personaActive() ? null : (this.reference()?.uploadId ?? null),
      referenceUrl: this.personaActive() ? null : (this.reference()?.url ?? null),
      batch: this.batch(),
      priceCredits: this.priceCredits(),
    });
    this.prompt.set('');
    this.appliedTrend.set(null);
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
