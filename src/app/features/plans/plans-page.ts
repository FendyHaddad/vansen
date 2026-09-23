import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideCheck,
  lucideDownload,
  lucideFolderLock,
  lucideHistory,
  lucideInfinity,
  lucideShieldCheck,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { SiteHeader } from '../../shared/site-header/site-header';
import { SiteFooter } from '../../shared/site-footer/site-footer';
import { AuthService } from '../../core/auth/auth-service';
import { BillingService } from '../../core/billing/billing-service';
import { CheckoutIntent } from '../../core/billing/checkout-intent';
import {
  CREDIT_PACKS,
  MODEL_FAMILIES,
  PLAN_CREDITS,
  PLAN_PRICE_USD,
  PLAN_PROMO_USD,
  PRO_EXTRA_CREDIT_PERCENT,
  PRO_PACK_BONUS_PERCENT,
  PRO_SAVING_PERCENT,
  packCredits,
} from '../../core/catalog/model-families';
import { toolLabels, toolsFor } from '../../core/catalog/entitlements';
import { PublicCapabilitiesService } from '../../core/catalog/public-capabilities';

interface PlanCard {
  id: 'studio' | 'pro';
  name: string;
  priceUsd: number;
  promoUsd: number;
  credits: number;
  tagline: string;
  perks: string[];
  featured: boolean;
}

interface PackRow {
  usd: number;
  bonusPct: number;
  studioCredits: number;
  proCredits: number;
}

interface PlanFaq {
  question: string;
  answer: string;
}

@Component({
  selector: 'app-plans-page',
  templateUrl: './plans-page.html',
  styleUrl: './plans-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    NgIcon,
    HlmButton,
    HlmBadge,
    SiteHeader,
    SiteFooter,
    ...HlmCardImports,
  ],
  providers: [
    provideIcons({
      lucideCheck,
      lucideArrowRight,
      lucideInfinity,
      lucideFolderLock,
      lucideHistory,
      lucideDownload,
      lucideShieldCheck,
    }),
  ],
})
export class PlansPage {
  private readonly auth = inject(AuthService);
  private readonly billing = inject(BillingService);
  private readonly intent = inject(CheckoutIntent);
  private readonly router = inject(Router);
  private readonly capabilities = inject(PublicCapabilitiesService);

  constructor() {
    void this.capabilities.load();
  }

  /** Model names, drawn from what this deployment has switched on. */
  private readonly liveNames = computed(() => {
    const enabled = this.capabilities.enabledFamilyIds();
    const of = (kind: 'image' | 'video') =>
      MODEL_FAMILIES.filter((f) => f.kind === kind && enabled.includes(f.id))
        .map((f) => f.name);
    return { image: of('image'), video: of('video') };
  });

  private readonly studioToolNames = toolLabels(toolsFor('studio')).filter((l) => l !== 'Mask');
  private readonly proToolNames = toolLabels(toolsFor('pro'));

  /** The plan whose CTA is mid-redirect — Stripe takes a beat to answer. */
  readonly busyPlan = signal<'studio' | 'pro' | null>(null);
  readonly error = signal('');

  /**
   * Signed in: straight to Stripe. Signed out: remember the plan and send them
   * through login — the workspace picks the intent back up and opens checkout,
   * so picking a plan here never dead-ends in the library.
   */
  async getPlan(plan: 'studio' | 'pro'): Promise<void> {
    if (this.busyPlan()) return;
    this.error.set('');
    if (!this.auth.isAuthed()) {
      this.intent.set(plan);
      void this.router.navigate(['/login']);
      return;
    }
    this.busyPlan.set(plan);
    try {
      await this.billing.subscribe(plan);
    } catch {
      // Success redirects away; only a failure lands back here. The likeliest
      // cause is an existing subscription, which the portal — not checkout — owns.
      this.busyPlan.set(null);
      this.error.set('Could not start checkout. If you already subscribe, manage your plan under Settings → Subscription.');
    }
  }

  /**
   * D1: every line here is derived. The hand-written version promised "full
   * on-device editing suite, free and unlimited" on Studio and named the Pro
   * tools in the same breath, and listed a video model (Sora) that has no
   * adapter — so a Studio subscriber paid for a list and then hit padlocks.
   */
  readonly plans = computed<PlanCard[]>(() => {
    const names = this.liveNames();
    const imageLine = names.image.length
      ? `All image models — ${names.image.join(', ')}`
      : 'Every image model in the catalog';
    const studio: PlanCard = {
      id: 'studio',
      name: 'Studio',
      priceUsd: PLAN_PRICE_USD.studio,
      promoUsd: PLAN_PROMO_USD.studio,
      credits: PLAN_CREDITS.studio,
      tagline: 'Every image model plus the on-device editing basics.',
      perks: [
        `${PLAN_CREDITS.studio.toLocaleString()} credits every month`,
        imageLine,
        `On-device editing — ${this.studioToolNames.join(', ')}`,
        'Private full-resolution library, no watermarks',
      ],
      featured: false,
    };
    const proPerks = [
      'Everything in Studio, plus:',
      `${PLAN_CREDITS.pro.toLocaleString()} credits every month — ${PRO_EXTRA_CREDIT_PERCENT}% more per dollar`,
      `Pro on-device tools — ${this.proToolNames.join(', ')}`,
      'AI edit tools (remove, fill, expand, background) from 5 credits per run',
      `The same job costs ${PRO_SAVING_PERCENT}% less than on Studio`,
      `Biggest add-on packs: up to ${packCredits(100, 'pro').toLocaleString()} credits for $100`,
    ];
    // Video is a Pro headline, but only where a video family is switched on.
    if (names.video.length) {
      proPerks.splice(2, 0, `Video models — ${names.video.join(', ')}`);
    }
    return [
      studio,
      {
        id: 'pro',
        name: 'Pro',
        priceUsd: PLAN_PRICE_USD.pro,
        promoUsd: PLAN_PROMO_USD.pro,
        credits: PLAN_CREDITS.pro,
        tagline: 'Everything in Studio, plus the Pro tools and the cheapest credits.',
        perks: proPerks,
        featured: true,
      },
    ];
  });

  readonly proPackBonusPercent = PRO_PACK_BONUS_PERCENT;
  readonly studioPriceUsd = PLAN_PRICE_USD.studio;
  readonly proPriceUsd = PLAN_PRICE_USD.pro;
  readonly studioPromoUsd = PLAN_PROMO_USD.studio;
  readonly proPromoUsd = PLAN_PROMO_USD.pro;

  readonly packs: PackRow[] = CREDIT_PACKS.map((p) => ({
    usd: p.usd,
    bonusPct: p.bonusPct,
    studioCredits: packCredits(p.usd, 'studio'),
    proCredits: packCredits(p.usd, 'pro'),
  }));

  readonly faqs: PlanFaq[] = [
    {
      question: 'How do credits work?',
      answer:
        `Every generation has a fixed credit price shown before you run it — most images cost 5–25 credits, AI edits 5–10. Your plan grants a fresh batch every billing cycle: ${PLAN_CREDITS.studio.toLocaleString()} on Studio, ${PLAN_CREDITS.pro.toLocaleString()} on Pro.`,
    },
    {
      question: 'Do credits roll over?',
      answer:
        'Plan credits reset at each renewal — use them within the cycle. Add-on pack credits are different: they roll over month to month for as long as your subscription is active.',
    },
    {
      question: 'What if I run out mid-month?',
      answer:
        `Add a one-time credit pack ($10–$100) from the Subscription tab. Bigger packs carry a bonus, Pro subscribers get ${PRO_EXTRA_CREDIT_PERCENT}% more credits per dollar, and pack credits never reset while you stay subscribed.`,
    },
    {
      question: 'What does editing cost?',
      answer:
        'The on-canvas suite runs on your own device, so it never costs credits. Crop, adjust, filters, sharpen, smooth, spot heal, dehaze and portrait smooth come with every plan; cut out, bokeh, upscale, AI sharpen, smart select, magic erase and the rest are the Pro tier. Generative AI edits (remove, fill, expand, background) are Pro and cost 5–10 credits per run, and saving an edited version costs nothing.',
    },
    {
      question: 'Why is video Pro-only?',
      answer:
        `Video generations cost many times more to run than images, so they live on the plan with the bigger grant and cheaper credits. Pro also makes every image cheaper: a job costs the same number of credits on either plan, but a credit costs ${PRO_SAVING_PERCENT}% less on Pro.`,
    },
    {
      question: 'What happens if I cancel?',
      answer:
        'You keep access until the end of the paid period. Your library is permanently deleted the day the paid period ends, so download anything you want to keep before then. Pack credits expire separately, 30 days after your subscription ends.',
    },
  ];
}
