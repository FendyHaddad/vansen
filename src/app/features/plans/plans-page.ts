import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
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
import { familyById, userPriceUsd } from '../../core/catalog/model-families';

interface TopUpOption {
  amount: number;
  popular: boolean;
}

interface StudioPerk {
  icon: string;
  text: string;
}

interface ExamplePrice {
  name: string;
  kind: 'image' | 'video';
  price: number;
}

interface PlanFaq {
  question: string;
  answer: string;
}

const STUDIO_PRICE = 5;

@Component({
  selector: 'app-plans-page',
  templateUrl: './plans-page.html',
  styleUrl: './plans-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    RouterLink,
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
  readonly studioPrice = STUDIO_PRICE;

  readonly topUpOptions: TopUpOption[] = [
    { amount: 15, popular: true },
    { amount: 25, popular: false },
    { amount: 55, popular: false },
    { amount: 105, popular: false },
  ];

  readonly selectedAmount = signal(15);

  /** First top-up: $5 covers the first month of Studio, rest is generation balance. */
  readonly usableBalance = computed(() => this.selectedAmount() - STUDIO_PRICE);

  readonly imageEstimate = computed(() =>
    Math.floor(this.usableBalance() / this.examplePrices[0].price),
  );
  readonly clipEstimate = computed(() =>
    Math.floor(this.usableBalance() / this.examplePrices[4].price),
  );

  readonly studioPerks: StudioPerk[] = [
    { icon: 'lucideInfinity', text: 'Your balance never expires while Studio is active' },
    { icon: 'lucideFolderLock', text: 'Private library — every output in full resolution' },
    { icon: 'lucideHistory', text: 'Prompt and settings saved with every asset, remix any time' },
    { icon: 'lucideDownload', text: 'Unlimited downloads, no watermarks' },
    { icon: 'lucideShieldCheck', text: 'Generation history across every model in one place' },
  ];

  readonly examplePrices: ExamplePrice[] = [
    {
      name: 'Nano Banana image (1K)',
      kind: 'image',
      price: userPriceUsd(familyById('nano-banana')!, { version: 'standard', aspectRatio: '1:1', resolution: '1K' }),
    },
    {
      name: 'GPT Image 2 (medium, 1K)',
      kind: 'image',
      price: userPriceUsd(familyById('gpt-image')!, { version: '2', aspectRatio: '1:1', quality: 'medium', resolution: '1K' }),
    },
    {
      name: 'Seedream image (1K)',
      kind: 'image',
      price: userPriceUsd(familyById('seedream')!, { aspectRatio: '1:1', resolution: '1K' }),
    },
    {
      name: 'FLUX.2 [pro] image (1MP)',
      kind: 'image',
      price: userPriceUsd(familyById('flux')!, { aspectRatio: '1:1', resolution: '1MP' }),
    },
    {
      name: 'Kling clip (5s)',
      kind: 'video',
      price: userPriceUsd(familyById('kling')!, { aspectRatio: '16:9', durationS: 5 }),
    },
    {
      name: 'Sora 2 clip (4s)',
      kind: 'video',
      price: userPriceUsd(familyById('sora')!, { version: 'standard', aspectRatio: '16:9', resolution: '720p', durationS: 4 }),
    },
    {
      name: 'Runway Gen-4.5 clip (5s)',
      kind: 'video',
      price: userPriceUsd(familyById('runway')!, { version: 'gen45', aspectRatio: '16:9', durationS: 5 }),
    },
    {
      name: 'Veo 3.1 clip (4s, audio)',
      kind: 'video',
      price: userPriceUsd(familyById('veo')!, { version: 'standard', aspectRatio: '16:9', resolution: '1080p', durationS: 4 }),
    },
  ];

  readonly faqs: PlanFaq[] = [
    {
      question: 'What does a generation cost?',
      answer:
        'Every model has a fixed price shown before you generate — most images cost a few cents, video clips run from about fifty cents to a few dollars. No tiers, no gating: any model, any time your balance covers it.',
    },
    {
      question: 'Does my balance expire?',
      answer:
        'Never, while your Studio is active. Top up $50 today and spend it over a year if you like — unlike subscription credits, it does not reset every month.',
    },
    {
      question: 'What exactly is Studio?',
      answer:
        'Studio is your $5/month workspace: it keeps your library online in full resolution, stores the prompt and settings with every asset, and keeps your balance alive indefinitely. Your first top-up includes the first month.',
    },
    {
      question: 'What happens if I let Studio lapse?',
      answer:
        'You keep access until the end of the paid month, then a 30-day grace period to download everything. After that your library is permanently deleted. Any remaining generation balance stays yours and works again the moment you reactivate.',
    },
    {
      question: 'Why not a subscription?',
      answer:
        'Subscriptions charge you the same whether you create or not, and take back unused credits every month. Here generation is pay-as-you-go and the only recurring part is $5 to keep your studio open.',
    },
  ];

}
