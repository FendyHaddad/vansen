# Legal Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Terms of Service, Privacy Policy, and Acceptable Use Policy pages, link them from the footer and login clickwrap, and require terms consent at Stripe checkout.

**Architecture:** Three static standalone Angular components under `src/app/features/legal/`, lazy public routes, shared prose stylesheet, footer nav column, one-line clickwrap on the login page, and a `consent_collection` addition to both Stripe checkout-session calls in the `api` edge function.

**Tech Stack:** Angular 20 standalone (OnPush, RouterLink), vitest via `ng test`, Hono/Deno edge function, Stripe Checkout.

## Global Constraints

- **Never commit, branch, or push — the user makes all commits personally.** Wherever a normal TDD loop would commit, stop and tell the user what is ready to commit instead.
- Angular components always use separate files: `.ts` + `.html` + `.css`. Never inline templates or styles. Prefer stylesheet classes over inline `style` attributes.
- Test command: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng test --include='**/<name>.spec.ts' --watch=false` (bare vitest falsely fails TestBed specs).
- Build command: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22.23.1 >/dev/null && npx ng build`
- Authoritative content source: `docs/superpowers/specs/2026-07-17-legal-pages-design.md` ("the spec"). Every numbered section listed there for a document MUST appear in that document's template as real, complete prose — no "TBD", no summaries, no skipped sections.
- Constants used everywhere: entity **Vankode Technology (Malaysia)**, product **Vansen**, contact **support@vankode.com**, last updated **17 July 2026**.
- Deploy for `api` (Task 5 only): `supabase functions deploy api --project-ref bnorhcxhvxydkgvcxjad --no-verify-jwt` (MCP deploy tool is broken for this function).

---

### Task 1: Legal feature scaffolding + Terms of Service page

**Files:**
- Create: `src/app/features/legal/legal-shared.css`
- Create: `src/app/features/legal/terms-page.ts`
- Create: `src/app/features/legal/terms-page.html`
- Create: `src/app/features/legal/terms-page.css`
- Test: `src/app/features/legal/legal-pages.spec.ts`
- Modify: `src/app/app.routes.ts` (add `legal/terms` route)
- Modify: `src/app/app.config.ts` (scroll restoration + anchor scrolling)

**Interfaces:**
- Produces: exported class `TermsPage`; route `legal/terms`; shared stylesheet `legal-shared.css` with classes `.legal-page`, `.legal-header`, `.legal-title`, `.legal-updated`, `.legal-body`, `.legal-toc`, `.legal-footer-links` that Tasks 2–3 reuse via `styleUrls: ['./legal-shared.css', './<own>.css']`.

- [ ] **Step 1: Write the failing test** — create `src/app/features/legal/legal-pages.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { TermsPage } from './terms-page';

function render(cmpType: any): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(cmpType);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('legal pages', () => {
  it('terms page renders title, entity, and core clauses', () => {
    const el = render(TermsPage);
    expect(el.querySelector('h1')?.textContent).toContain('Terms of Service');
    expect(el.textContent).toContain('Vankode Technology');
    expect(el.textContent).toContain('support@vankode.com');
    expect(el.textContent).toContain('Limitation of liability');
    expect(el.textContent).toContain('Governing law');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test --include='**/legal-pages.spec.ts' --watch=false` (with nvm preamble)
Expected: FAIL — cannot resolve `./terms-page`.

- [ ] **Step 3: Create `legal-shared.css`**

```css
.legal-page {
  max-width: 46rem;
  margin: 0 auto;
  padding: 4rem 1.5rem 6rem;
}
.legal-header {
  margin-bottom: 2.5rem;
}
.legal-title {
  font-size: 2rem;
  font-weight: 650;
  letter-spacing: -0.02em;
}
.legal-updated {
  display: block;
  margin-top: 0.5rem;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.legal-toc {
  margin: 1.5rem 0 0;
  padding: 0;
  list-style: none;
  columns: 2;
  column-gap: 2rem;
  font-size: 0.875rem;
}
.legal-toc a {
  color: var(--muted-foreground);
  text-decoration: none;
  line-height: 1.9;
}
.legal-toc a:hover {
  color: var(--foreground);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.legal-body section {
  margin-top: 2.5rem;
}
.legal-body h2 {
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.legal-body h3 {
  font-size: 0.95rem;
  font-weight: 600;
  margin-top: 1.25rem;
}
.legal-body p,
.legal-body li {
  margin-top: 0.75rem;
  color: var(--muted-foreground);
  font-size: 0.9375rem;
  line-height: 1.7;
}
.legal-body strong {
  color: var(--foreground);
  font-weight: 600;
}
.legal-body ul {
  padding-left: 1.25rem;
}
.legal-footer-links {
  margin-top: 3.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 1.5rem;
  font-size: 0.875rem;
}
.legal-footer-links a {
  color: var(--muted-foreground);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.legal-footer-links a:hover {
  color: var(--foreground);
}
```

- [ ] **Step 4: Create `terms-page.ts`** (Tasks 2–3 clone this shape):

```ts
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-terms-page',
  templateUrl: './terms-page.html',
  styleUrls: ['./legal-shared.css', './terms-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
})
export class TermsPage {}
```

`terms-page.css` may start as an empty file with a comment (`/* page-specific overrides; shared prose styles live in legal-shared.css */`) — it exists to honor the separate-files rule and future overrides.

- [ ] **Step 5: Write `terms-page.html` — COMPLETE prose**

Structure (repeat for every section; ids `s1`…`s18` feed the TOC):

```html
<main class="legal-page">
  <header class="legal-header">
    <a routerLink="/" class="site-brand">Vansen</a>
    <h1 class="legal-title">Terms of Service</h1>
    <time class="legal-updated" datetime="2026-07-17">Last updated: 17 July 2026</time>
    <ol class="legal-toc">
      <li><a href="/legal/terms#s1">Agreement to terms</a></li>
      <!-- …one entry per section… -->
    </ol>
  </header>
  <article class="legal-body">
    <section id="s1">
      <h2>1. Agreement to terms</h2>
      <p>These Terms of Service ("Terms") are a binding agreement between you and
        <strong>Vankode Technology</strong>, a company registered in Malaysia
        ("Vansen", "we", "us"), governing your use of the Vansen website and
        service…</p>
    </section>
    <!-- sections 2–18 -->
  </article>
  <nav class="legal-footer-links">
    <a routerLink="/legal/privacy">Privacy Policy</a>
    <a routerLink="/legal/acceptable-use">Acceptable Use Policy</a>
  </nav>
</main>
```

Write all 18 sections as full prose implementing **spec § "1. Terms of Service"** items 1–18 verbatim in intent. Non-negotiable clause content (from the locked decisions): 18+ eligibility; third-party models may be removed/re-priced anytime; credits are prepaid non-transferable non-cash; **all sales final** with credit-refund-on-failed-generation as sole remedy; EU/UK immediate-performance withdrawal acknowledgment; chargeback ⇒ suspension; **user owns outputs**, Vansen gets limited operate/moderate license, **no training without opt-in**; DMCA-style takedown via support@vankode.com; AS IS disclaimer; liability cap = greater of 12-month fees or USD 50 with unlawful-to-limit carve-out; indemnification; termination; **Malaysian law, Kuala Lumpur courts**, 30-day informal resolution, class-action waiver to the extent permitted; general boilerplate (severability, assignment, force majeure, entire agreement); changes clause; contact.

- [ ] **Step 6: Register route + scrolling.** In `src/app/app.routes.ts`, before the `'**'` wildcard:

```ts
  {
    path: 'legal/terms',
    title: 'Terms of Service — Vansen',
    loadComponent: () => import('./features/legal/terms-page').then((m) => m.TermsPage),
  },
```

In `src/app/app.config.ts`:

```ts
import { provideRouter, withInMemoryScrolling } from '@angular/router';
// …
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
    ),
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx ng test --include='**/legal-pages.spec.ts' --watch=false` (with nvm preamble)
Expected: PASS (1 test).

- [ ] **Step 8: Checkpoint** — do NOT commit (user commits). Report Task 1 done.

---

### Task 2: Privacy Policy page

**Files:**
- Create: `src/app/features/legal/privacy-page.ts`, `privacy-page.html`, `privacy-page.css`
- Modify: `src/app/features/legal/legal-pages.spec.ts` (add test)
- Modify: `src/app/app.routes.ts` (add `legal/privacy`)

**Interfaces:**
- Consumes: `legal-shared.css` classes from Task 1.
- Produces: exported class `PrivacyPage`; route `legal/privacy`.

- [ ] **Step 1: Add failing test** to `legal-pages.spec.ts`:

```ts
  it('privacy page renders title and rights sections', () => {
    const el = render(PrivacyPage);
    expect(el.querySelector('h1')?.textContent).toContain('Privacy Policy');
    expect(el.textContent).toContain('GDPR');
    expect(el.textContent).toContain('PDPA');
    expect(el.textContent).toContain('support@vankode.com');
    expect(el.textContent).toContain('We do not sell');
  });
```

(plus `import { PrivacyPage } from './privacy-page';`)

- [ ] **Step 2: Run — expect FAIL** (module not found).

- [ ] **Step 3: Create component** — `privacy-page.ts` identical in shape to `TermsPage` (selector `app-privacy-page`, class `PrivacyPage`, `styleUrls: ['./legal-shared.css', './privacy-page.css']`), empty-comment `privacy-page.css`.

- [ ] **Step 4: Write `privacy-page.html` — COMPLETE prose**, same page skeleton as Task 1 Step 5 (title "Privacy Policy", TOC ids `s1`…`s12`, cross-links to terms + AUP). Implement **spec § "2. Privacy Policy"** items 1–12 in full. Non-negotiable content: controller = Vankode Technology (Malaysia); the data-collected list including DOB and moderation records and "no card numbers — Stripe holds those"; GDPR Art. 6 legal-basis mapping; **"We do not sell personal data"** exact phrase; automated-moderation + human-review-on-appeal (Art. 22); named processors Supabase (AWS ap-southeast-1, Singapore), Stripe, OpenAI, Google, fal.ai; transfers via standard contractual clauses; retention table incl. 30-day lapsed purge, 12-month moderation evidence, 7-day signed URLs, 7-year financial records; rights subsections EU/UK GDPR, CCPA/CPRA, Malaysia PDPA 2010, everyone-else parity, 30-day response; essential-cookies-only + future-consent clause; security section incl. 72-hour GDPR breach duty; 18+ children section; changes + contact.

- [ ] **Step 5: Add route** (before wildcard):

```ts
  {
    path: 'legal/privacy',
    title: 'Privacy Policy — Vansen',
    loadComponent: () => import('./features/legal/privacy-page').then((m) => m.PrivacyPage),
  },
```

- [ ] **Step 6: Run — expect PASS** (2 tests). Checkpoint, no commit.

---

### Task 3: Acceptable Use Policy page

**Files:**
- Create: `src/app/features/legal/acceptable-use-page.ts`, `acceptable-use-page.html`, `acceptable-use-page.css`
- Modify: `src/app/features/legal/legal-pages.spec.ts` (add test)
- Modify: `src/app/app.routes.ts` (add `legal/acceptable-use`)

**Interfaces:**
- Consumes: `legal-shared.css` from Task 1.
- Produces: exported class `AcceptableUsePage`; route `legal/acceptable-use`.

- [ ] **Step 1: Add failing test:**

```ts
  it('acceptable use page renders title and enforcement', () => {
    const el = render(AcceptableUsePage);
    expect(el.querySelector('h1')?.textContent).toContain('Acceptable Use Policy');
    expect(el.textContent).toContain('zero tolerance');
    expect(el.textContent).toContain('two strikes');
    expect(el.textContent).toContain('support@vankode.com');
  });
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Create component** — same shape, selector `app-acceptable-use-page`, class `AcceptableUsePage`.

- [ ] **Step 4: Write `acceptable-use-page.html` — COMPLETE prose**, TOC ids `s1`…`s7`, implementing **spec § "3. Acceptable Use Policy"** items 1–7 in full. Non-negotiable content: zero-tolerance minors category (immediate termination, evidence preserved, reported to authorities where mandated, skips the strike ladder — use the words "zero tolerance"); full prohibited list from the spec (NCII/deepfakes of real persons, impersonation, harassment/hate/violence, terror, self-harm, CBRN, fraud/spam, malware/service abuse incl. moderation evasion and credential sharing, IP/publicity/privacy infringement, undisclosed synthetic media where law requires disclosure, circumventing suspensions or the age gate); provider-rules pass-through; enforcement = moderation before charge/provider call, "two strikes" suspension; 30-day appeal with human review; reporting address.

- [ ] **Step 5: Add route** (before wildcard):

```ts
  {
    path: 'legal/acceptable-use',
    title: 'Acceptable Use Policy — Vansen',
    loadComponent: () =>
      import('./features/legal/acceptable-use-page').then((m) => m.AcceptableUsePage),
  },
```

- [ ] **Step 6: Run — expect PASS** (3 tests). Checkpoint, no commit.

---

### Task 4: Footer Legal column + login clickwrap

**Files:**
- Modify: `src/app/shared/site-footer/site-footer.html` (Legal nav column)
- Modify: `src/app/shared/site-footer/site-footer.css:17` (grid columns)
- Modify: `src/app/features/auth/login-page.html` (clickwrap line after the sign-in/sign-up toggle at the bottom, ~line 86-90)
- Modify: `src/app/features/auth/login-page.css` (`.clickwrap` class)

**Interfaces:**
- Consumes: routes `legal/terms`, `legal/privacy`, `legal/acceptable-use` from Tasks 1–3.

- [ ] **Step 1: Footer column.** In `site-footer.html`, insert after the existing `site-footer-nav` block (Explore column):

```html
      <nav class="site-footer-nav" aria-label="Legal">
        <span class="site-footer-nav-title">Legal</span>
        <a routerLink="/legal/terms">Terms of Service</a>
        <a routerLink="/legal/privacy">Privacy Policy</a>
        <a routerLink="/legal/acceptable-use">Acceptable Use</a>
      </nav>
```

- [ ] **Step 2: Footer grid.** `site-footer.css` line 17 — add a column:

```css
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.8fr) minmax(0, 0.9fr) minmax(0, 1.2fr) minmax(0, 1fr);
```

(mobile block at ~line 165 already collapses to `1fr`; leave it).

- [ ] **Step 3: Clickwrap.** In `login-page.html`, after the mode-toggle `<p class="muted mt-6 …">` block, add:

```html
      <p class="clickwrap">
        By continuing you agree to our
        <a routerLink="/legal/terms">Terms of Service</a> and acknowledge our
        <a routerLink="/legal/privacy">Privacy Policy</a>.
      </p>
```

In `login-page.css`:

```css
.clickwrap {
  margin-top: 1.5rem;
  text-align: center;
  color: var(--muted-foreground);
  font-size: 0.75rem;
  line-height: 1.6;
}
.clickwrap a {
  color: var(--muted-foreground);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.clickwrap a:hover {
  color: var(--foreground);
}
```

- [ ] **Step 4: Full test suite + build.**

Run: `npm test`, then the nvm build command.
Expected: all suites pass (159 pre-existing + 3 new), build succeeds.

- [ ] **Step 5: Visual check** — dev-server preview: footer shows Legal column on landing/pricing/login; three pages render with TOC anchor scrolling; clickwrap visible on login; mobile width collapses cleanly. Checkpoint, no commit.

---

### Task 5: Stripe checkout terms consent (backend)

**PRECONDITION (user task, blocks this task only):** In Stripe Dashboard → Settings → Business → Public details, set Terms of Service URL to `https://<production-domain>/legal/terms` and Privacy URL to `https://<production-domain>/legal/privacy`. Stripe rejects `consent_collection.terms_of_service` if unset. Ask the user to confirm before starting; if not done, ship Tasks 1–4 and leave this task pending.

**Files:**
- Modify: `supabase/functions/api/index.ts:779` and `:809` (both `stripe.checkout.sessions.create` calls)

**Interfaces:**
- Consumes: existing checkout-session payloads (subscribe at line ~779, pack at line ~809).

- [ ] **Step 1: Add consent to BOTH sessions.** Insert into each `stripe.checkout.sessions.create({ … })` payload:

```ts
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: {
          message:
            'All sales are final. You request immediate access to the service and ' +
            'acknowledge that you lose any statutory right of withdrawal once the ' +
            'service begins, except where such rights cannot lawfully be waived. ' +
            '[Terms of Service](https://vansen.example/legal/terms)',
        },
      },
```

Replace `https://vansen.example` with the real production domain (ask the user; do not guess).

- [ ] **Step 2: Deploy.**

Run: `supabase functions deploy api --project-ref bnorhcxhvxydkgvcxjad --no-verify-jwt`
Expected: new version deployed, no bundle errors.

- [ ] **Step 3: Verify.** `GET /health` returns 200; start a test-mode checkout from the app and confirm the consent checkbox + message appear on the Stripe page and checkout completes. Checkpoint, no commit.

---

## Final verification

- [ ] `npm test` — everything green.
- [ ] Production build succeeds.
- [ ] Manual sweep: `/legal/terms`, `/legal/privacy`, `/legal/acceptable-use` reachable logged-out; footer links on landing, pricing, login; clickwrap links work; every spec section present in each document (count sections against the spec).
- [ ] Remind the user: (1) commit, (2) attorney review, (3) Stripe dashboard URLs if Task 5 deferred.
