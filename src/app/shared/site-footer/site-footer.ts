import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MODEL_FAMILIES, PLAN_PRICE_USD } from '../../core/catalog/model-families';
import { PublicCapabilitiesService } from '../../core/catalog/public-capabilities';

@Component({
  selector: 'app-site-footer',
  templateUrl: './site-footer.html',
  styleUrl: './site-footer.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
})
export class SiteFooter {
  private readonly capabilities = inject(PublicCapabilitiesService);

  constructor() {
    void this.capabilities.load();
  }

  readonly year = new Date().getFullYear();
  readonly studioPriceUsd = PLAN_PRICE_USD.studio;
  readonly proPriceUsd = PLAN_PRICE_USD.pro;

  /**
   * The footer named its models by hand and kept naming Sora, which has no
   * adapter. It now lists what the deployment has switched on, and nothing
   * when it cannot find out.
   */
  private readonly live = computed(() => {
    const enabled = this.capabilities.enabledFamilyIds();
    return MODEL_FAMILIES.filter((f) => enabled.includes(f.id));
  });

  readonly imageNames = computed(() =>
    this.live().filter((f) => f.kind === 'image').map((f) => f.name).join(' · '),
  );

  readonly videoNames = computed(() =>
    this.live().filter((f) => f.kind === 'video').map((f) => f.name).join(' · '),
  );
}
