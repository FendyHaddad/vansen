import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideBrush,
  lucideDownload,
  lucideEraser,
  lucideSparkles,
  lucideWandSparkles,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { AuthService } from '../../core/auth/auth-service';
import { LedgerService } from '../../core/ledger/ledger-service';
import { ApiError } from '../../core/api/api-service';
import { BillingService } from '../../core/billing/billing-service';
import { GenerationOp } from '../../core/enums';
import { GenerationStore } from '../../core/generations/generation-store';
import {
  FamilyOption,
  GenerationSettings,
  MODEL_FAMILIES,
  ModelFamily,
  defaultSettings,
  upscaleUserPriceUsd,
  userPriceUsd,
} from '../../core/catalog/model-families';
import { OptionGroup } from '../workspace/option-group/option-group';
import { Hint } from '../../shared/hint/hint';
import { MaskCanvas } from './mask-canvas/mask-canvas';
import { ProfileMenu } from '../../shared/profile-menu/profile-menu';

@Component({
  selector: 'app-editor-page',
  templateUrl: './editor-page.html',
  styleUrl: './editor-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    RouterLink,
    NgIcon,
    HlmButton,
    OptionGroup,
    Hint,
    MaskCanvas,
    ProfileMenu,
  ],
  providers: [
    provideIcons({
      lucideArrowLeft,
      lucideBrush,
      lucideEraser,
      lucideDownload,
      lucideSparkles,
      lucideWandSparkles,
    }),
  ],
})
export class EditorPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly ledger = inject(LedgerService);
  private readonly billing = inject(BillingService);
  private readonly store = inject(GenerationStore);

  readonly maskCanvas = viewChild(MaskCanvas);

  readonly editFamilies = MODEL_FAMILIES.filter((f) => f.capabilities.imageInput);

  private readonly routeId = toSignal(this.route.paramMap.pipe(map((p) => p.get('id'))), {
    initialValue: null,
  });

  readonly item = computed(() => {
    const id = this.routeId();
    return id ? (this.store.byId(id) ?? null) : null;
  });

  readonly chain = computed(() => {
    const id = this.routeId();
    return id ? this.store.chainFor(id) : [];
  });

  readonly familyId = signal(this.editFamilies[0].id);
  readonly family = computed<ModelFamily>(
    () => this.editFamilies.find((f) => f.id === this.familyId()) ?? this.editFamilies[0],
  );
  readonly settings = signal<GenerationSettings>(defaultSettings(this.editFamilies[0]));
  readonly prompt = signal('');

  readonly maskSupported = computed(() => this.family().capabilities.maskInput);
  readonly priceUsd = computed(() => userPriceUsd(this.family(), this.settings()));
  readonly insufficient = computed(() => this.priceUsd() > this.ledger.balanceUsd());
  readonly canApply = computed(
    () => this.prompt().trim().length > 0 && !this.insufficient() && !!this.item(),
  );
  readonly balanceUsd = this.ledger.balanceUsd;
  readonly upscalePrice = upscaleUserPriceUsd();

  readonly maskDisabledHint = computed(
    () =>
      `${this.family().name} edits semantically from your prompt — no mask needed. Masking is available on GPT Image.`,
  );

  constructor() {
    if (!this.store.loaded()) void this.store.load();
    // Unknown/deleted id → back to workspace (only once the library is loaded)
    effect(() => {
      if (this.store.loaded() && this.routeId() !== null && !this.item()) {
        this.router.navigate(['/app']);
      }
    });
  }

  readonly notice = signal('');

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
    if (f.id === 'gpt-image' && this.settings().version !== '2') {
      return list.filter((o) => o.value === '1K');
    }
    if (f.id === 'nano-banana' && this.settings().version === 'fast') {
      return list.filter((o) => o.value === '1K');
    }
    return list;
  });
  readonly qualityOptions = computed<FamilyOption[] | null>(
    () => this.family().capabilities.qualities ?? null,
  );

  selectFamily(id: string): void {
    this.familyId.set(id);
    this.settings.set(defaultSettings(this.family()));
  }

  setAxis(axis: 'version' | 'aspectRatio' | 'resolution' | 'quality', value: string): void {
    this.settings.update((s) => ({ ...s, [axis]: value }));
    const allowed = this.resolutionOptions();
    if (allowed && !allowed.some((o) => o.value === this.settings().resolution)) {
      this.settings.update((s) => ({ ...s, resolution: allowed[0]?.value }));
    }
  }

  notSupported(axis: string): string {
    return `${axis} is not supported by ${this.family().name}.`;
  }

  async applyEdit(): Promise<void> {
    const source = this.item();
    if (!source || !this.canApply()) return;
    // Mask export rides along once real dispatch lands (phase 3)
    if (this.maskSupported()) this.maskCanvas()?.exportMaskPng();
    try {
      const items = await this.store.create({
        familyId: this.family().id,
        op: GenerationOp.Edit,
        prompt: this.prompt().trim(),
        settings: { ...this.settings() },
        batch: 1,
        parentId: source.id,
      });
      this.prompt.set('');
      this.maskCanvas()?.clear();
      this.notice.set('');
      if (items[0]) this.router.navigate(['/app/edit', items[0].id]);
    } catch (e) {
      this.notice.set(e instanceof ApiError ? e.message : 'Edit failed');
    }
  }

  async upscale(): Promise<void> {
    const source = this.item();
    if (!source) return;
    try {
      const items = await this.store.create({
        op: GenerationOp.Upscale,
        prompt: source.prompt,
        settings: source.settings,
        batch: 1,
        parentId: source.id,
      });
      this.notice.set('');
      if (items[0]) this.router.navigate(['/app/edit', items[0].id]);
    } catch (e) {
      this.notice.set(e instanceof ApiError ? e.message : 'Upscale failed');
    }
  }

  download(): void {
    const source = this.item();
    if (!source) return;
    const a = document.createElement('a');
    a.href = source.mediaUrl;
    a.download = `vansen-${source.id}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  openVersion(id: string): void {
    this.router.navigate(['/app/edit', id]);
  }

  async topUp(): Promise<void> {
    try {
      await this.billing.checkout(20);
    } catch (e) {
      this.notice.set(e instanceof ApiError ? e.message : 'Could not start checkout');
    }
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.router.navigate(['/']);
  }
}
