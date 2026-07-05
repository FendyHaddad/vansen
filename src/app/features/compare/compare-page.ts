import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { CatalogModel, MODEL_CATALOG } from '../pricing/model-catalog';
import { PricingConfig, requiredCredits } from '../pricing/pricing-engine';

interface SubTier {
  name: string;
  price: number;
  credits: number;
  video: boolean;
}

interface SubResult {
  impossible: boolean;
  tierName: string;
  tierPrice: number;
  creditsNeeded: number;
  packs: number;
  packCost: number;
  userPays: number;
  stripeFees: number;
  providerCost: number;
  storageCost: number;
  net: number;
  netPct: number;
}

interface PaygResult {
  impossible: boolean;
  genSpend: number;
  storageFee: number;
  userPays: number;
  topups: number;
  stripeFees: number;
  providerCost: number;
  storageCost: number;
  net: number;
  netPct: number;
}

interface ExampleRow {
  model: CatalogModel;
  subCredits: number;
  subPrice: number;
  paygPrice: number;
  cheaper: 'sub' | 'payg' | 'tie';
}

interface Tradeoff {
  dim: string;
  sub: string;
  payg: string;
}

/**
 * Temporary internal page: subscription (Higgsfield-style) vs pay-as-you-go
 * (OpenRouter-style) business model comparison. Delete before launch.
 */
@Component({
  selector: 'app-compare-page',
  templateUrl: './compare-page.html',
  styleUrl: './compare-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, PercentPipe, RouterLink],
})
export class ComparePage {
  readonly imageModels = MODEL_CATALOG.filter((m) => m.kind === 'image');
  readonly videoModels = MODEL_CATALOG.filter((m) => m.kind === 'video');

  // Scenario inputs
  readonly imagesPerMonth = signal(60);
  readonly videosPerMonth = signal(4);
  readonly imageModelId = signal('nano-banana');
  readonly videoModelId = signal('kling-25-turbo');

  // PAYG knobs
  readonly paygMarginPct = signal(33);
  readonly storageFeeUsd = signal(5);
  readonly topupUsd = signal(20);

  // Subscription model as currently spec'd in vansen.md
  private readonly subCfg: PricingConfig = {
    creditPriceUsd: 0.075,
    targetNetMargin: 0.4,
    stripePercent: 0.029,
    stripeFixedUsd: 0.3,
    packPriceUsd: 15,
  };

  readonly tiers: SubTier[] = [
    { name: 'Starter', price: 15, credits: 200, video: false },
    { name: 'Creator', price: 30, credits: 500, video: true },
  ];

  private readonly storageGbPrice = 0.0213; // Supabase Pro overage per GB

  private readonly imageModel = computed(
    () => this.imageModels.find((m) => m.id === this.imageModelId()) ?? this.imageModels[0],
  );
  private readonly videoModel = computed(
    () => this.videoModels.find((m) => m.id === this.videoModelId()) ?? this.videoModels[0],
  );

  readonly providerCost = computed(
    () =>
      this.imagesPerMonth() * this.imageModel().usdCost +
      this.videosPerMonth() * this.videoModel().usdCost,
  );

  // Rough size estimate: ~3 MB per image, ~30 MB per clip
  readonly storageGb = computed(
    () => (this.imagesPerMonth() * 3 + this.videosPerMonth() * 30) / 1024,
  );
  readonly storageCost = computed(() => this.storageGb() * this.storageGbPrice);

  readonly sub = computed<SubResult>(() => {
    const cfg = this.subCfg;
    const imgCredits = requiredCredits(this.imageModel().usdCost, cfg);
    const vidCredits = requiredCredits(this.videoModel().usdCost, cfg);
    const creditsNeeded =
      this.imagesPerMonth() * imgCredits + this.videosPerMonth() * vidCredits;

    if (!Number.isFinite(creditsNeeded)) {
      return {
        impossible: true,
        tierName: '—',
        tierPrice: 0,
        creditsNeeded: 0,
        packs: 0,
        packCost: 0,
        userPays: 0,
        stripeFees: 0,
        providerCost: this.providerCost(),
        storageCost: this.storageCost(),
        net: 0,
        netPct: 0,
      };
    }

    const packSize = cfg.packPriceUsd / cfg.creditPriceUsd;
    const needVideo = this.videosPerMonth() > 0;

    // Cheapest tier + packs combination that satisfies demand
    let best: { tier: SubTier; packs: number; userPays: number } | null = null;
    for (const tier of this.tiers) {
      if (needVideo && !tier.video) continue;
      const packs = Math.max(0, Math.ceil((creditsNeeded - tier.credits) / packSize));
      const userPays = tier.price + packs * cfg.packPriceUsd;
      if (!best || userPays < best.userPays) best = { tier, packs, userPays };
    }
    const chosen = best!;

    const charges = 1 + chosen.packs;
    const stripeFees = chosen.userPays * cfg.stripePercent + charges * cfg.stripeFixedUsd;
    const providerCost = this.providerCost();
    const storageCost = this.storageCost();
    const net = chosen.userPays - stripeFees - providerCost - storageCost;

    return {
      impossible: false,
      tierName: chosen.tier.name,
      tierPrice: chosen.tier.price,
      creditsNeeded,
      packs: chosen.packs,
      packCost: chosen.packs * cfg.packPriceUsd,
      userPays: chosen.userPays,
      stripeFees,
      providerCost,
      storageCost,
      net,
      netPct: chosen.userPays > 0 ? net / chosen.userPays : 0,
    };
  });

  readonly payg = computed<PaygResult>(() => {
    const marginFrac = this.paygMarginPct() / 100;
    const denom = 1 - marginFrac;
    const providerCost = this.providerCost();
    const storageCost = this.storageCost();
    const storageFee = this.storageFeeUsd();

    if (denom <= 0) {
      return {
        impossible: true,
        genSpend: 0,
        storageFee,
        userPays: 0,
        topups: 0,
        stripeFees: 0,
        providerCost,
        storageCost,
        net: 0,
        netPct: 0,
      };
    }

    const genSpend = providerCost / denom;
    const userPays = genSpend + storageFee;
    const topupSize = Math.max(1, this.topupUsd());
    const topups = Math.max(1, Math.ceil(userPays / topupSize));
    // Steady state: collected ≈ spent; fixed fee applies per top-up
    const stripeFees = userPays * 0.029 + topups * 0.3;
    const net = userPays - stripeFees - providerCost - storageCost;

    return {
      impossible: false,
      genSpend,
      storageFee,
      userPays,
      topups,
      stripeFees,
      providerCost,
      storageCost,
      net,
      netPct: userPays > 0 ? net / userPays : 0,
    };
  });

  readonly userDelta = computed(() => this.sub().userPays - this.payg().userPays);
  readonly netDelta = computed(() => this.sub().net - this.payg().net);

  private readonly exampleIds = [
    'nano-banana',
    'gpt-image-2-med',
    'seedream-4',
    'flux-2-pro',
    'ideogram-v3-balanced',
    'nano-banana-pro-1k',
    'veo-31',
    'veo-31-fast',
    'sora-2',
    'kling-25-turbo',
    'hailuo-23',
    'gen45',
  ];

  readonly examples = computed<ExampleRow[]>(() => {
    const denom = 1 - this.paygMarginPct() / 100;
    return this.exampleIds
      .map((id) => MODEL_CATALOG.find((m) => m.id === id))
      .filter((m): m is CatalogModel => !!m)
      .map((model) => {
        const subCredits = requiredCredits(model.usdCost, this.subCfg);
        const subPrice = subCredits * this.subCfg.creditPriceUsd;
        const paygPrice = denom > 0 ? model.usdCost / denom : Infinity;
        const cheaper: ExampleRow['cheaper'] =
          paygPrice < subPrice ? 'payg' : paygPrice > subPrice ? 'sub' : 'tie';
        return { model, subCredits, subPrice, paygPrice, cheaper };
      });
  });

  readonly tradeoffs: Tradeoff[] = [
    {
      dim: 'Revenue shape',
      sub: 'Predictable MRR — $15 or $30 per user, every month.',
      payg: 'Variable. Only floor is the storage fee.',
    },
    {
      dim: 'Breakage',
      sub: 'Unused credits expire monthly — pure margin on light users.',
      payg: 'None. Balance sits until spent (deferred revenue liability).',
    },
    {
      dim: 'Video gating',
      sub: 'Needs tier-2 server-side gate before dispatch.',
      payg: 'No gate needed — the price covers the cost at any volume.',
    },
    {
      dim: 'Heavy users',
      sub: 'Margin erodes as they burn the full allowance; packs rescue it.',
      payg: 'Margin locked at the markup % regardless of volume.',
    },
    {
      dim: 'Light users',
      sub: 'Best case — high breakage, near-pure profit.',
      payg: 'Worst case — storage fee is the only recurring revenue.',
    },
    {
      dim: 'Checkout friction',
      sub: 'One subscribe button. Familiar to consumer creatives.',
      payg: 'Top-up concept + storage fee needs explaining.',
    },
    {
      dim: 'Stripe overhead',
      sub: 'One charge per cycle (plus pack purchases).',
      payg: 'Fee per top-up — small top-ups bleed ~9% on a $5 charge.',
    },
    {
      dim: 'Purge trigger',
      sub: 'Subscription lapses → grace until period end → purge.',
      payg: 'Storage fee lapses / balance stays empty → warn → purge.',
    },
    {
      dim: 'Price perception',
      sub: 'Simple, but ceiling: hit the credit wall mid-month.',
      payg: 'Cheaper per generation at 33% vs 40%+overhead; no wall.',
    },
  ];
}
