import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideImage,
  lucideShield,
  lucideSparkles,
  lucideVideo,
  lucideZap,
} from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmCardImports } from '@spartan-ng/helm/card';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { SiteHeader } from '../../shared/site-header/site-header';
import { SiteFooter } from '../../shared/site-footer/site-footer';

interface ServiceCard {
  icon: string;
  title: string;
  body: string;
}

interface ProviderLogo {
  name: string;
  logoUrl: string;
}

@Component({
  selector: 'app-landing-page',
  templateUrl: './landing-page.html',
  styleUrl: './landing-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, HlmButton, HlmBadge, SiteHeader, SiteFooter, ...HlmCardImports],
  providers: [
    provideIcons({
      lucideSparkles,
      lucideImage,
      lucideVideo,
      lucideZap,
      lucideShield,
      lucideArrowRight,
    }),
  ],
})
export class LandingPage {
  readonly providers: ProviderLogo[] = [
    { name: 'Google', logoUrl: '/logos/google.svg' },
    { name: 'OpenAI', logoUrl: '/logos/openai.svg' },
    { name: 'ByteDance', logoUrl: '/logos/bytedance.svg' },
    { name: 'Black Forest Labs', logoUrl: '/logos/bfl.svg' },
    { name: 'Runway', logoUrl: '/logos/runway.svg' },
    { name: 'Kuaishou', logoUrl: '/logos/kuaishou.svg' },
  ];

  readonly showcaseImage =
    'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=900&q=80';

  readonly services: ServiceCard[] = [
    {
      icon: 'lucideImage',
      title: 'Image generation',
      body: 'Nano Banana (Fast to Pro), GPT Image, FLUX and Seedream — the top image models behind one prompt box.',
    },
    {
      icon: 'lucideVideo',
      title: 'Video generation',
      body: 'Text-to-video with Veo, Sora, Kling, Runway Gen-4.5 and Seedance.',
    },
    {
      icon: 'lucideZap',
      title: 'One credit balance',
      body: 'Pay once in credits, spend across every model. No per-provider accounts, invoices, or API keys.',
    },
    {
      icon: 'lucideShield',
      title: 'Private library',
      body: 'Every generation saved full-resolution to your private workspace. Only you ever see your outputs.',
    },
  ];
}
