import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideBrush,
  lucideCpu,
  lucideEraser,
  lucideFolderLock,
  lucideImage,
  lucideInfinity,
  lucideLayers,
  lucideSparkles,
  lucideVideo,
  lucideWandSparkles,
  lucideZap,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { SiteHeader } from '../../shared/site-header/site-header';
import { SiteFooter } from '../../shared/site-footer/site-footer';
import {
  MODEL_FAMILIES,
  ModelFamily,
  PLAN_CREDITS,
  PLAN_PRICE_USD,
  PRO_EXTRA_CREDIT_PERCENT,
} from '../../core/catalog/model-families';
import { toolLabels, toolsFor } from '../../core/catalog/entitlements';
import { PublicCapabilitiesService } from '../../core/catalog/public-capabilities';

interface ProviderLogo {
  name: string;
  logoUrl: string;
}

interface WorkflowStep {
  step: string;
  title: string;
  body: string;
}

interface StudioPillar {
  icon: string;
  title: string;
  body: string;
}

@Component({
  selector: 'app-landing-page',
  templateUrl: './landing-page.html',
  styleUrl: './landing-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink, NgIcon, HlmButton, HlmBadge, SiteHeader, SiteFooter],
  providers: [
    provideIcons({
      lucideArrowRight,
      lucideBrush,
      lucideCpu,
      lucideEraser,
      lucideFolderLock,
      lucideImage,
      lucideInfinity,
      lucideLayers,
      lucideSparkles,
      lucideVideo,
      lucideWandSparkles,
      lucideZap,
    }),
  ],
})
export class LandingPage {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly capabilities = inject(PublicCapabilitiesService);

  constructor() {
    void this.capabilities.load();
    afterNextRender(() => this.setupReveals());
  }

  readonly providers: ProviderLogo[] = [
    { name: 'Google', logoUrl: '/logos/google.svg' },
    { name: 'OpenAI', logoUrl: '/logos/openai.svg' },
    { name: 'ByteDance', logoUrl: '/logos/bytedance.svg' },
    { name: 'Black Forest Labs', logoUrl: '/logos/bfl.svg' },
    { name: 'Runway', logoUrl: '/logos/runway.svg' },
    { name: 'Kuaishou', logoUrl: '/logos/kuaishou.svg' },
  ];

  readonly heroPrompts = [
    'a lighthouse at dawn, thick fog, telephoto compression',
    'product shot of a ceramic espresso cup, studio softbox',
    'isometric cutaway of a tiny ramen shop, warm neon',
    'portrait in golden hour, 85mm, shallow depth of field',
  ];

  /**
   * Only what this deployment has switched on. A family behind its kill
   * switch is not for sale, so the landing page does not name it.
   */
  private readonly live = computed(() => {
    const enabled = this.capabilities.enabledFamilyIds();
    return MODEL_FAMILIES.filter((f) => enabled.includes(f.id));
  });

  readonly imageFamilies = computed<ModelFamily[]>(() =>
    this.live().filter((f) => f.kind === 'image'),
  );

  readonly videoFamilies = computed<ModelFamily[]>(() =>
    this.live().filter((f) => f.kind === 'video'),
  );

  /**
   * Two lists, because they are two prices. This page used to show one cloud
   * of nineteen chips under "included with every plan" — eleven of which the
   * panel locks behind Pro.
   */
  readonly studioToolChips = toolLabels(toolsFor('studio')).filter((l) => l !== 'Mask');
  readonly proToolChips = toolLabels(toolsFor('pro'));

  readonly studioPriceUsd = PLAN_PRICE_USD.studio;
  readonly proPriceUsd = PLAN_PRICE_USD.pro;
  readonly studioCredits = PLAN_CREDITS.studio;
  readonly proCredits = PLAN_CREDITS.pro;
  readonly proExtraCreditPercent = PRO_EXTRA_CREDIT_PERCENT;

  readonly studioPillars: StudioPillar[] = [
    {
      icon: 'lucideCpu',
      title: 'AI that runs on your device',
      body: 'Cut Out, Bokeh, AI Upscale and Smart Select run entirely in your browser on open-source models — included with Pro. No upload, no queue, no credits spent; your pixels never leave the tab.',
    },
    {
      icon: 'lucideEraser',
      title: 'Generative edits, priced per use',
      body: 'Mask anything and let a frontier model repaint it — remove objects, fill with a prompt, expand the canvas, drop the background. Flat per-use prices, shown before you run.',
    },
    {
      icon: 'lucideLayers',
      title: 'Every edit is a version',
      body: 'Saves stack as new versions next to the original, with the prompt and settings kept. Export any version as PNG, JPG or WebP — no watermarks, ever.',
    },
  ];

  readonly workflow: WorkflowStep[] = [
    {
      step: '01',
      title: 'Pick your plan',
      body: `Studio $${PLAN_PRICE_USD.studio}/mo (${PLAN_CREDITS.studio.toLocaleString()} credits) or Pro $${PLAN_PRICE_USD.pro}/mo (${PLAN_CREDITS.pro.toLocaleString()} credits + video). Switch or add credits any time.`,
    },
    {
      step: '02',
      title: 'Pick the model',
      body: 'Every image model in the catalog — switch per prompt, with the exact price shown before you run.',
    },
    {
      step: '03',
      title: 'Generate & refine',
      body: 'Batch up to four takes, remix with reference images, then polish in the built-in editor without leaving the tab.',
    },
    {
      step: '04',
      title: 'Keep everything',
      body: 'Full-resolution originals in a private library only you can see. Download freely, delete permanently.',
    },
  ];

  private setupReveals(): void {
    const nodes = this.host.nativeElement.querySelectorAll<HTMLElement>('[data-reveal]');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !('IntersectionObserver' in window)) {
      nodes.forEach((n) => n.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        }
      },
      // Huge top margin: anything at or above the viewport counts as seen, so a
      // fast scroll can never skip past an element and leave it hidden.
      { rootMargin: '10000px 0px -10% 0px', threshold: 0.05 },
    );
    nodes.forEach((n) => io.observe(n));
  }
}
