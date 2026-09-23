import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { LandingPage } from './landing/landing-page';
import { PlansPage } from './plans/plans-page';
import { SiteFooter } from '../shared/site-footer/site-footer';
import { LoginPage } from './auth/login-page';
import { AuthService } from '../core/auth/auth-service';
import {
  CAPABILITIES_FETCH,
  PublicCapabilitiesService,
} from '../core/catalog/public-capabilities';
import {
  MODEL_FAMILIES,
  PLAN_CREDITS,
  PLAN_PROMO_USD,
  PRO_SAVING_PERCENT,
} from '../core/catalog/model-families';
import { toolLabels, toolsFor } from '../core/catalog/entitlements';

const ALL_IDS = MODEL_FAMILIES.map((f) => f.id);

function capsBody(enabledFamilyIds: string[]) {
  return {
    enabledFamilyIds,
    backgroundCompletion: false,
    completionNotifications: false,
    catalogVersion: 'x',
  };
}

/**
 * `null` stands for "the deployment could not be reached" — the pages must
 * then advertise nothing rather than falling back to a hard-coded list.
 */
async function render<T>(
  component: new (...args: never[]) => T,
  enabled: string[] | null,
): Promise<ComponentFixture<T>> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [component as never],
    providers: [
      provideRouter([]),
      {
        provide: AuthService,
        useValue: { isAuthed: () => false, session: () => null },
      },
      {
        provide: CAPABILITIES_FETCH,
        useValue: () =>
          enabled === null
            ? Promise.reject(new Error('offline'))
            : Promise.resolve({
              ok: true,
              json: () => Promise.resolve(capsBody(enabled)),
            } as Response),
      },
    ],
  });
  const fixture = TestBed.createComponent(component as never) as ComponentFixture<T>;
  fixture.detectChanges();
  await TestBed.inject(PublicCapabilitiesService).load();
  fixture.detectChanges();
  return fixture;
}

const textOf = (f: ComponentFixture<unknown>) => f.nativeElement.textContent as string;

/**
 * D1: a sales surface may not promise what the product does not deliver.
 *
 * Three separate lies shipped here. The landing page put nineteen tool chips
 * under "included with every plan" when eleven of them are Pro-only. The
 * pricing page and the login splash named Sora, which has no adapter at all.
 * And every list was hand-written, so a family behind its kill switch kept
 * being advertised.
 */
describe('public surfaces never advertise what is switched off', () => {
  it('the landing page names only enabled families', async () => {
    const fixture = await render(LandingPage, ['flux', 'veo']);
    const text = textOf(fixture);
    expect(text).toContain('FLUX');
    expect(text).toContain('Veo 3.1');
    expect(text).not.toContain('Seedream');
    expect(text).not.toContain('Kling');
  });

  it('the landing page names nothing when the deployment is unreachable', async () => {
    const fixture = await render(LandingPage, null);
    const text = textOf(fixture);
    for (const family of MODEL_FAMILIES) expect(text).not.toContain(family.name);
  });

  it('the landing page hides the video teaser with no video family enabled', async () => {
    const fixture = await render(LandingPage, ['flux']);
    expect(textOf(fixture)).not.toContain('Video is next');
  });

  it('the landing page separates the Studio tools from the Pro tools', async () => {
    const fixture = await render(LandingPage, ALL_IDS);
    const text = textOf(fixture);
    // The chip cloud used to end in "all included" with Cut Out inside it.
    expect(text).not.toContain('all included');
    expect(text).toContain('Every plan');
    expect(text).toContain('Cut Out');
    const proMarker = text.indexOf('Pro');
    expect(proMarker).toBeGreaterThan(-1);
  });

  it('the pricing page never lists a Pro tool as a Studio perk', async () => {
    const fixture = await render(PlansPage, ALL_IDS);
    const studioCard = fixture.nativeElement.querySelectorAll('.perk-list, ul')[0] as HTMLElement;
    const studioText = (studioCard?.textContent ?? '') + '';
    for (const label of toolLabels(toolsFor('pro'))) {
      expect(studioText).not.toContain(label);
    }
  });

  it('the pricing page sells the AI edit tools on Pro, not Studio (migration 0034)', async () => {
    const fixture = await render(PlansPage, ALL_IDS);
    const [studioCard, proCard] = Array.from(
      fixture.nativeElement.querySelectorAll('.perk-list, ul') as NodeListOf<HTMLElement>,
    );
    expect(studioCard.textContent ?? '').not.toContain('AI edit tools');
    expect(proCard.textContent ?? '').toContain('AI edit tools');
  });

  it('the pricing page lists every Studio tool it gates as Studio', async () => {
    const fixture = await render(PlansPage, ALL_IDS);
    const text = textOf(fixture);
    for (const label of toolLabels(toolsFor('studio'))) {
      if (label === 'Mask') continue;
      expect(text).toContain(label);
    }
  });

  it('the pricing page states the saving as one derived number', async () => {
    const fixture = await render(PlansPage, ALL_IDS);
    const text = textOf(fixture);
    expect(text).toContain(`${PRO_SAVING_PERCENT}% less`);
  });

  it('the pricing page drops the video perk when no video family is live', async () => {
    const fixture = await render(PlansPage, ['flux']);
    expect(textOf(fixture)).not.toContain('Video models');
  });

  it('the pricing page never names a model that has no adapter', async () => {
    const fixture = await render(PlansPage, ALL_IDS);
    expect(textOf(fixture)).not.toContain('Sora');
  });

  it('the launch price is advertised with the FULL credit grant', async () => {
    // D1: `cycleGrant` in the Stripe webhook grants PLAN_CREDITS regardless of
    // what was actually paid, so a discounted first cycle gets the whole
    // amount. Advertising a smaller number here would be underselling what the
    // server already does — and a larger one would be a lie.
    const fixture = await render(PlansPage, ALL_IDS);
    const text = textOf(fixture);
    expect(text).toContain(`$${PLAN_PROMO_USD.studio}`);
    expect(text).toContain(`$${PLAN_PROMO_USD.pro}`);
    expect(text).toContain(PLAN_CREDITS.studio.toLocaleString());
    expect(text).toContain(PLAN_CREDITS.pro.toLocaleString());
  });

  it('states one grant per plan, and it is the catalog grant', async () => {
    // Scoped to the cards: the packs table further down legitimately contains
    // other credit numbers, and a page-wide search would collide with them.
    const fixture = await render(PlansPage, ALL_IDS);
    const cards = [...fixture.nativeElement.querySelectorAll('ul')] as HTMLElement[];
    const grants = cards
      .map((c) => /([\d,]+) credits every month/.exec(c.textContent ?? '')?.[1])
      .filter(Boolean);
    expect(grants).toEqual([
      PLAN_CREDITS.studio.toLocaleString(),
      PLAN_CREDITS.pro.toLocaleString(),
    ]);
  });

  it('the footer lists live families and nothing else', async () => {
    const fixture = await render(SiteFooter, ['flux']);
    const text = textOf(fixture);
    expect(text).toContain('FLUX');
    expect(text).not.toContain('Sora');
    expect(text).not.toContain('Runway');
  });

  it('the footer shows no model line at all when unreachable', async () => {
    const fixture = await render(SiteFooter, null);
    const text = textOf(fixture);
    for (const family of MODEL_FAMILIES) expect(text).not.toContain(family.name);
    // The section header stays — it is a heading, not a promise.
    expect(text).toContain('Models');
  });

  it('the login splash names live families only', async () => {
    const fixture = await render(LoginPage, ['veo', 'flux']);
    const text = textOf(fixture);
    expect(text).toContain('Veo 3.1');
    expect(text).not.toContain('Sora');
  });

  it('the login splash drops its caption entirely when unreachable', async () => {
    const fixture = await render(LoginPage, null);
    expect(fixture.nativeElement.querySelector('.artwork-caption')).toBeNull();
  });
});
