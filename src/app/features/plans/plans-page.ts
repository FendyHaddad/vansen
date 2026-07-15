import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
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
import { CREDIT_PACKS, PLAN_CREDITS, packCredits } from '../../core/catalog/model-families';

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

  readonly plans: PlanCard[] = [
    {
      id: 'studio',
      name: 'Studio',
      priceUsd: 15,
      promoUsd: 10,
      credits: PLAN_CREDITS.studio,
      tagline: 'Every image model plus the full editing suite.',
      perks: [
        `${PLAN_CREDITS.studio.toLocaleString()} credits every month`,
        'All image models — Nano Banana, GPT Image, FLUX, Seedream',
        'Full on-device editing suite, free and unlimited',
        'AI edit tools from 5 credits per run',
        'Private full-resolution library, no watermarks',
      ],
      featured: false,
    },
    {
      id: 'pro',
      name: 'Pro',
      priceUsd: 30,
      promoUsd: 25,
      credits: PLAN_CREDITS.pro,
      tagline: 'Everything in Studio, plus video and the cheapest credits.',
      perks: [
        'Everything in Studio, plus:',
        `${PLAN_CREDITS.pro.toLocaleString()} credits every month — 25% more per dollar`,
        'Video models — Veo, Sora, Kling, Runway, Seedance',
        'Same jobs cost 20% less than on Studio',
        'Biggest add-on packs: up to 13,750 credits for $100',
      ],
      featured: true,
    },
  ];

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
        'Every generation has a fixed credit price shown before you run it — most images cost 5–25 credits, AI edits 5–10. Your plan grants a fresh batch every billing cycle: 1,500 on Studio, 3,750 on Pro.',
    },
    {
      question: 'Do credits roll over?',
      answer:
        'Plan credits reset at each renewal — use them within the cycle. Add-on pack credits are different: they roll over month to month for as long as your subscription is active.',
    },
    {
      question: 'What if I run out mid-month?',
      answer:
        'Add a one-time credit pack ($10–$100) from the Subscription tab. Bigger packs carry a bonus, Pro subscribers get 25% more credits per dollar, and pack credits never reset while you stay subscribed.',
    },
    {
      question: 'What does editing cost?',
      answer:
        'The on-canvas suite — crop, filters, heal, cut out, bokeh, upscale and more — runs on your own device, so it is free and unlimited on every plan. Generative AI edits (remove, fill, expand, background) cost 5–10 credits per run, and saving an edited version costs nothing.',
    },
    {
      question: 'Why is video Pro-only?',
      answer:
        'Video generations cost many times more to run than images, so they live on the plan with the bigger grant and cheaper credits. Pro also makes every image cheaper — the same job costs 20% less than on Studio.',
    },
    {
      question: 'What happens if I cancel?',
      answer:
        'You keep access until the end of the paid period. Pack credits expire 30 days after your subscription ends, and after the same 30-day grace your library is permanently deleted — download anything you want to keep.',
    },
  ];
}
