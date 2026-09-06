import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
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
  VideoMode,
  creditCost,
  defaultSettings,
  familyById,
  personaGenCreditCost,
  referenceRule,
  videoFamilySupports,
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
import { ModePicker } from './mode-picker/mode-picker';
import { ReferenceDrop, RefSlot } from './reference-drop/reference-drop';
import type { GenerationItem } from '../../../core/generations/generation-store';

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
  /** Video reference uploads (storage paths), in slot order. Video mode only. */
  referencePaths?: string[];
  /** Finished video the clip extends or edits. */
  videoParentId?: string;
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
    ModePicker,
    ReferenceDrop,
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

  /** True while the parent has a generate request in flight — button spins. */
  readonly generating = input(false);

  readonly generateRequested = output<GenerateRequest>();
  readonly pickReferenceRequested = output<void>();
  readonly managePersonasRequested = output<void>();

  readonly uploading = signal(false);
  readonly uploadError = signal('');

  /** Video generation is a Pro-tier feature — locked for everyone else. */
  readonly videoLocked = computed(() => !this.profileStore.proActive());
  readonly upgradeRequested = output<void>();
  readonly pickVideoRequested = output<void>();

  readonly refSlots = signal<RefSlot[]>([]);
  readonly videoParent = signal<GenerationItem | null>(null);

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
    const startMode: ModelKind = this.videoLocked() ? 'image' : prefs.defaultMode;
    this.mode.set(startMode);
    const preferredId =
      startMode === 'video' ? prefs.defaultVideoFamily : prefs.defaultImageFamily;
    const preferred = MODEL_FAMILIES.find((f) => f.id === preferredId && f.kind === startMode);
    const family = preferred ?? firstFamilyOf(startMode);
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
    // Veo Lite tops out at 1080p
    if (f.id === 'veo' && this.settings().version === 'lite') {
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

  readonly videoMode = computed<VideoMode>(() => this.settings().mode ?? 't2v');
  readonly refRule = computed(() => referenceRule(this.videoMode()));
  readonly showReferences = computed(() => this.mode() === 'video' && this.refRule().max > 0);
  readonly showVideoParent = computed(() => this.mode() === 'video' && this.refRule().needsParent);
  readonly audioSelectable = computed(() => this.family().capabilities.audio === 'selectable');
  readonly audioIncluded = computed(() => this.family().capabilities.audio === 'included');
  /** Off t2v the source frame dictates the shape (Kling i2v included) — hide the chip. */
  /** Aspect ratio follows the input frame for i2v and keyframes, so the control hides. */
  readonly hideAspect = computed(
    () => this.mode() === 'video' && (this.videoMode() === 'i2v' || this.videoMode() === 'keyframes'),
  );

  readonly audioOptions: FamilyOption[] = [
    { value: 'off', label: 'Off', tooltip: 'Silent clip. Cheapest.' },
    { value: 'on', label: 'Sound', tooltip: 'Ambient sound and music.' },
    { value: 'voice', label: 'Voice', tooltip: 'Sound plus spoken dialogue.' },
  ];

  readonly videoInputsReady = computed(() => {
    if (this.mode() !== 'video') return true;
    const rule = this.refRule();
    if (rule.needsParent) return this.videoParent() !== null;
    const n = this.refSlots().length;
    return n >= rule.min && n <= rule.max;
  });

  readonly batch = computed(() => this.settings().batch ?? 1);
  readonly unitCredits = computed(() =>
    this.personaActive() ? personaGenCreditCost() : creditCost(this.family(), this.settings()),
  );
  readonly priceCredits = computed(() => {
    const n = this.mode() === 'video' ? 1 : this.batch();
    return this.unitCredits() * n;
  });
  readonly insufficient = computed(
    () => !this.isOwner() && this.priceCredits() > this.ledger.totalCredits(),
  );
  readonly canGenerate = computed(
    () => this.prompt().trim().length > 0 && !this.insufficient() && this.videoInputsReady(),
  );

  setMode(kind: ModelKind): void {
    if (kind === 'video' && this.videoLocked()) return;
    this.appliedTrend.set(null);
    this.mode.set(kind);
    this.selectFamily(firstFamilyOf(kind).id);
    if (kind !== 'video') return;
    const preferred = this.prefsService.prefs().defaultVideoMode;
    if (videoFamilySupports(this.family(), preferred)) this.setVideoMode(preferred);
  }

  /** Mode-toggle click: non-Pro gets the upgrade dialog instead of the switch. */
  onVideoModeToggle(): void {
    if (this.videoLocked()) {
      this.upgradeRequested.emit();
      return;
    }
    this.setMode('video');
  }

  setVideoMode(mode: VideoMode): void {
    if (!videoFamilySupports(this.family(), mode)) return;
    this.settings.update((s) => ({ ...s, mode }));
    this.refSlots.set([]);
    this.videoParent.set(null);
  }

  setAudio(value: string): void {
    if (value !== 'off' && value !== 'on' && value !== 'voice') return;
    this.settings.update((s) => ({ ...s, audio: value }));
  }

  setVideoParent(item: GenerationItem | null): void {
    this.videoParent.set(item);
  }

  /** Video follow-up from the detail overlay: switch to video mode, pick a family
   * that supports the requested mode (preferring the item's own family), and load
   * the item as the parent clip. Video is Pro-only — locked users get the upgrade
   * dialog instead, mirroring onVideoModeToggle. */
  startVideoFollowUp(item: GenerationItem, mode: 'extend' | 'edit'): void {
    if (this.videoLocked()) {
      this.upgradeRequested.emit();
      return;
    }
    const own = familyById(item.familyId);
    const ownSupports = !!own && videoFamilySupports(own, mode);
    // Extend continues this exact clip — no other family can pick it up.
    if (mode === 'extend' && !ownSupports) return;
    const target = ownSupports
      ? own
      : MODEL_FAMILIES.find((f) => f.kind === 'video' && videoFamilySupports(f, mode));
    if (!target) return;
    this.setMode('video');
    this.selectFamily(target.id);
    this.setVideoMode(mode);
    this.setVideoParent(item);
  }

  selectFamily(id: string): void {
    this.familyId.set(id);
    this.settings.set(defaultSettings(this.family()));
    this.refSlots.set([]);
    this.videoParent.set(null);
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
    if (!this.canGenerate() || this.generating()) return;
    // Video carries its inputs in refSlots/videoParent — a leftover image
    // reference must never ride along as a parent id.
    const imageMode = this.mode() === 'image';
    const imageRef = imageMode && !this.personaActive() ? this.reference() : null;
    this.generateRequested.emit({
      family: this.family(),
      settings: { ...this.settings() },
      prompt: this.prompt().trim(),
      style: imageMode ? this.style() : null,
      personaId: this.personaActive() ? this.persona() : null,
      trendId: imageMode ? this.appliedTrend() : null,
      referenceId: imageRef?.id ?? null,
      referenceUploadId: imageRef?.uploadId ?? null,
      referenceUrl: imageRef?.url ?? null,
      batch: imageMode ? this.batch() : 1,
      priceCredits: this.priceCredits(),
      referencePaths: imageMode ? undefined : this.refSlots().map((slot) => slot.path),
      videoParentId: imageMode ? undefined : this.videoParent()?.id,
    });
    this.prompt.set('');
    this.appliedTrend.set(null);
    // Keep videoParent — the user commonly extends the same clip again.
    this.refSlots.set([]);
  }

  /** Reset options that fell out of range after a version or family switch. */
  private clampSettings(): void {
    const f = this.family();
    const allowed = this.resolutionOptions();
    const stale = !!allowed && !allowed.some((o) => o.value === this.settings().resolution);
    this.settings.update((s) => {
      const next = { ...s };
      if (stale) next.resolution = allowed![0]?.value;
      if (f.kind === 'video' && !videoFamilySupports(f, next.mode ?? 't2v')) next.mode = 't2v';
      if (f.capabilities.audio !== 'selectable') delete next.audio;
      if (f.capabilities.audio === 'selectable' && !next.audio) next.audio = 'off';
      if (f.kind !== 'video') delete next.mode;
      return next;
    });
  }
}

function firstFamilyOf(kind: ModelKind): ModelFamily {
  return MODEL_FAMILIES.find((f) => f.kind === kind)!;
}
