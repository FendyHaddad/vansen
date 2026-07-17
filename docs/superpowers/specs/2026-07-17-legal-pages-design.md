# Legal pages — design spec

**Date:** 2026-07-17
**Status:** Approved (pending user review of this document)

> **Disclaimer recorded at user's request context:** these documents are drafted by an AI
> to industry standard, tailored to Vansen's actual product. They are not legal advice.
> A licensed attorney (Malaysia + EU/US exposure) should review before heavy reliance.

## Goal

Publish three legal documents, link them from the site footer, and add a clickwrap
notice at sign-in, so Vansen (a) meets EU/UK GDPR, ePrivacy, US COPPA/CCPA-CPRA, and
Malaysia PDPA 2010 disclosure duties, and (b) maximally protects Vankode Technology
via standard contractual armor (liability cap, disclaimers, indemnity, all-sales-final,
arbitration-friendly governing law).

## Locked decisions

| Decision | Value |
|---|---|
| Legal entity | **Vankode Technology**, registered in **Malaysia** |
| Governing law | Malaysia; courts of Malaysia (Kuala Lumpur) |
| Contact point | **support@vankode.com** (all legal, privacy, DMCA, appeals) |
| Refunds | **All sales final.** Credits + fees non-refundable; cancel = access to period end, no proration; EU/UK 14-day withdrawal handled via immediate-performance consent; chargeback ⇒ suspension |
| Output ownership | **User owns outputs**; Vansen keeps limited hosting/processing/moderation license; no warranty of copyrightability or non-infringement |
| Cookies | **Essential only** (Supabase auth localStorage, Stripe hosted checkout). No banner. Future-consent clause: if analytics/marketing tech is added, policy updates + consent collected first |
| Age | 18+ globally (matches shipped age gate) |
| Structure | 3 separate documents, 3 routes, separate Angular components |

## Documents and required content

Every document carries: "Last updated: 17 July 2026", entity name **Vankode Technology
(Malaysia)**, product name Vansen, contact support@vankode.com, and a
changes-to-this-document clause (notice via site posting; material changes via email
where feasible; continued use = acceptance).

### 1. Terms of Service — `/legal/terms`

Sections, in order:

1. **Agreement to terms** — binding contract with Vankode Technology; if you do not
   agree, do not use the service; AUP and Privacy Policy incorporated by reference.
2. **Eligibility** — 18+ only; DOB collected at onboarding; misrepresenting age =
   material breach ⇒ termination + deletion; account is personal, one per person.
3. **The service** — description: unified access to third-party AI generation models
   via credits; models supplied by third parties (Google, OpenAI, fal.ai et al.);
   models may be added, removed, re-priced, or disabled at any time without liability
   (kill-switch cover); no guarantee of output quality, accuracy, or fitness.
4. **Accounts and security** — user responsible for credentials and all activity under
   the account; notify support of compromise; we may suspend to protect the service.
5. **Credits, subscriptions, billing** — prices at purchase time; credits are a
   prepaid, **non-transferable, non-redeemable-for-cash** license to consume service
   features, not money, not deposits, no interest; Stripe processes payments (we never
   store card data); subscription auto-renews until cancelled; cancel anytime, effective
   end of period; lapsed accounts: stored media purged after 30-day grace (mirrors purge
   cron); price changes prospective with notice.
6. **Refunds** — all sales final; failed generations are automatically refunded **in
   credits** (mirrors `fn_fail_job`) and that is the sole remedy; EU/UK consumers:
   statutory withdrawal right acknowledged, but by purchasing you request immediate
   performance and acknowledge loss of withdrawal once service begins — nothing waives
   rights that cannot lawfully be waived; unauthorized chargebacks ⇒ suspension and
   debt for costs.
7. **Your content and outputs** — user owns uploads (inputs) and, as between the
   parties, owns generated outputs to the maximum extent permitted by law; user grants
   Vansen a worldwide, non-exclusive, royalty-free license to host, store, reproduce,
   and process content solely to operate, moderate, secure, and improve the service;
   **no training on user content without opt-in consent**; user warrants they have
   rights to all inputs; AI outputs may be similar to others' outputs and may not be
   protectable by copyright — no warranty either way; user solely responsible for
   their use of outputs, including legal compliance in their jurisdiction.
8. **Acceptable use** — pointer to AUP; moderation happens before generation; 2-strike
   suspension; we may remove content and preserve evidence for appeals and lawful
   requests.
9. **Third-party services** — model providers, Stripe, Supabase; their availability
   is outside our control; pass-through of provider usage restrictions.
10. **Intellectual property of the service** — Vansen software, brand, and site are
    Vankode Technology's; no license granted except to use the service as intended;
    feedback may be used freely without obligation.
11. **Copyright complaints (takedown)** — DMCA-style notice-and-takedown to
    support@vankode.com: identify work, location, contact, good-faith statement,
    authority statement; counter-notice honored; repeat infringers terminated.
12. **Disclaimers** — service provided "AS IS" and "AS AVAILABLE"; all implied
    warranties (merchantability, fitness, non-infringement, uptime) disclaimed to the
    maximum extent permitted; AI output can be wrong, offensive, or infringing despite
    moderation — user must review before use.
13. **Limitation of liability** — to the maximum extent permitted: no indirect,
    incidental, special, consequential, exemplary damages, lost profits/data/goodwill;
    aggregate cap = **the greater of fees paid to Vansen in the 12 months preceding the
    claim, or USD 50**; carve-out: nothing limits liability that cannot lawfully be
    limited (e.g., fraud, death/personal injury by negligence, consumer rights).
14. **Indemnification** — user indemnifies Vankode Technology against claims arising
    from their content, their use of outputs, AUP violations, or violation of law.
15. **Suspension and termination** — we may suspend/terminate for breach, legal risk,
    non-payment, or per moderation policy; user may delete their account anytime (in-app
    delete exists); on termination: license to use service ends; data handled per
    Privacy Policy retention; accrued rights survive; sections that by nature survive,
    survive.
16. **Governing law and disputes** — laws of Malaysia; exclusive jurisdiction of
    Malaysian courts (Kuala Lumpur); parties will attempt good-faith informal resolution
    via support@vankode.com for 30 days first; **class-action waiver to the extent
    permitted by applicable law**; mandatory consumer-protection rights in the user's
    home jurisdiction are unaffected.
17. **General** — entire agreement, severability, no waiver, assignment (we may assign
    to affiliate/successor; user may not), force majeure, export-control compliance,
    no third-party beneficiaries, English text controls.
18. **Changes to these terms** + **Contact**.

### 2. Privacy Policy — `/legal/privacy`

Sections, in order:

1. **Who we are** — Vankode Technology (Malaysia), data controller; contact
   support@vankode.com.
2. **What we collect** — table: account data (email, name, Google profile if OAuth);
   date of birth (age verification, kept as proof of eligibility);
   content (prompts, uploaded images, generated outputs, edit saves); transaction data
   (Stripe customer id, credit ledger, purchase history — **no card numbers**, Stripe
   holds those); moderation records (flagged content evidence, strikes); technical logs
   (IP, user agent, timestamps via infrastructure providers).
3. **Why and on what legal basis** (GDPR Art. 6 mapping) — contract performance
   (provide service, billing), legal obligation (age verification, tax, lawful
   requests), legitimate interests (security, fraud/abuse prevention, service
   improvement), consent (only where asked, e.g., future optional cookies). **No
   selling of personal data. No third-party advertising. No training AI models on user
   content without opt-in.**
4. **Automated decision-making disclosure** — automated content moderation runs before
   generation; 2 strikes ⇒ automated suspension; **human review available on appeal**
   via support@vankode.com (GDPR Art. 22 cover).
5. **Processors and recipients** — named list: Supabase (hosting/auth/storage; AWS
   ap-southeast-1, Singapore), Stripe (payments), OpenAI (generation + moderation
   scanning of prompts/images), Google (generation), fal.ai (generation); prompts and
   images are shared with the model provider selected for a generation, solely to
   perform it; authorities when legally compelled; successor in a business transfer.
6. **International transfers** — data hosted in Singapore; providers may process in
   the US/EU; transfers protected by standard contractual clauses / equivalent
   safeguards where required.
7. **Retention** — account data: life of account; content: until user deletes it or
   account deletion; lapsed subscription media: purged after 30-day grace; moderation
   evidence: retained up to 12 months after action (appeals/legal defense) —
   longer if legally required; ledger/tax records: as required by law (typically 7
   years); signed URLs expire in 7 days.
8. **Your rights** — subsections:
   - **EU/UK (GDPR/UK GDPR):** access, rectification, erasure, restriction,
     portability, objection, withdraw consent, complain to a supervisory authority.
   - **California (CCPA/CPRA):** know, delete, correct, opt-out of sale/share (**we do
     not sell or share**), non-discrimination.
   - **Malaysia (PDPA 2010):** access, correction, withdraw consent, limit processing.
   - **Everyone else:** we honor the same requests globally.
   - How: email support@vankode.com or in-app (account deletion is self-service);
     identity verification required; response within 30 days (or shorter statutory
     window).
9. **Cookies and local storage** — essential only: Supabase auth session
   (localStorage), Stripe checkout cookies on Stripe's domain; **no analytics, no ad
   tech, no tracking**; future clause: if this changes, the policy will be updated and
   consent obtained first where required.
10. **Security** — encryption in transit, private storage buckets, row-level security,
    least-privilege service keys, payment data isolated at Stripe; no method is 100%
    secure; breach notification per applicable law (GDPR 72-hour authority
    notification).
11. **Children** — service is 18+; we do not knowingly process minors' data; underage
    accounts are deleted on discovery (mirrors shipped behavior); parents/guardians:
    contact support@vankode.com.
12. **Changes** + **Contact**.

### 3. Acceptable Use Policy — `/legal/acceptable-use`

Sections:

1. **Purpose** — rules for prompts, uploads, edits, outputs; incorporated into ToS.
2. **Zero-tolerance content** (immediate termination + preservation + reporting to
   authorities where mandated): sexual content involving minors or characters
   presented as minors, real or generated — in any form; content sexualizing minors.
3. **Prohibited content and conduct** — bullets: illegal content or activity;
   non-consensual intimate imagery, including of real persons ("deepfake porn");
   impersonation of real persons in a deceptive or harmful way, incl. fabricated
   statements/events presented as real; harassment, hate, or incitement of violence;
   terrorism/extremist promotion; self-harm promotion; weapons/CBRN uplift; fraud,
   scams, phishing, spam; malware or attempts to breach the service (incl. probing
   the API, evading moderation, reverse-engineering rate/credit systems, credential
   sharing, scraping); infringing others' IP/publicity/privacy rights; deceptive
   synthetic media without disclosure where law requires (e.g., EU AI Act
   transparency); circumventing suspensions or the age gate.
4. **Provider rules pass-through** — model providers' usage policies (Google, OpenAI,
   fal.ai) also apply to generations run on their models.
5. **Enforcement** — automated moderation before any charge or provider call;
   violations logged with evidence; **2 strikes ⇒ suspension**; zero-tolerance
   categories skip the strike ladder; we may remove content, suspend, terminate,
   and withhold remaining credits for material breach where lawful.
6. **Appeals** — email support@vankode.com within 30 days; human review; evidence
   retained for the appeal window.
7. **Reporting** — report violating content to support@vankode.com.

## Implementation

### Routes and components

- New feature dir `src/app/features/legal/`:
  - `terms-page.ts/.html/.css`
  - `privacy-page.ts/.html/.css`
  - `acceptable-use-page.ts/.html/.css`
  - `legal-shared.css` — shared prose styling; each component lists
    `styleUrls: ['./legal-shared.css', './<own>.css']` (separate-files rule intact).
- Components are static prose: `ChangeDetectionStrategy.OnPush`, no signals needed
  except none; import `RouterLink` for cross-links between the three docs and home.
- Content authored directly in the `.html` templates (semantic `<article>`, `<h1>`,
  `<h2>`, `<section id="...">` anchors, `<time>` for last-updated).
- Routes in `app.routes.ts`, public (no guards), lazy `loadComponent`:
  - `legal/terms`, `legal/privacy`, `legal/acceptable-use`.
- Each route sets a `title` (Angular route title) — "Terms of Service — Vansen" etc.
- Scrolling: app config already has router scroll restoration? Verify; if absent, add
  `withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' })`.

### Footer

`site-footer.html` gains a **Legal** nav column: Terms of Service, Privacy Policy,
Acceptable Use. Meta line gains nothing new (© + "A Vankode product" already present).
Adjust footer grid CSS for the extra column.

### Clickwrap notice

`login-page.html` (covers email/password + Google, sign-in and sign-up): under the
auth actions, muted line —
"By continuing you agree to our [Terms of Service] and acknowledge our
[Privacy Policy]." — links to the legal routes. Strengthens enforceability of the
whole stack.

### Stripe checkout consent (small backend change)

In `api` billing checkout-session creation: set
`consent_collection: { terms_of_service: 'required' }` and `custom_text` noting
immediate service + loss of EU withdrawal right + all-sales-final. **User task
(dashboard):** Stripe requires the Terms of Service URL configured in Dashboard →
Settings → Business → Public details before `consent_collection` works; set it to
`https://<domain>/legal/terms` (and privacy URL similarly). Deploy `api` after.
If the URL isn't configured yet, ship the frontend first and do the Stripe change as
a follow-up toggle — checkout must not break.

### Testing / verification

- Component specs: each legal page renders its `<h1>` (3 tiny specs).
- Footer spec (if one exists) updated for new links; otherwise assert via build.
- Full `npm test`, then production build via the nvm build command.
- Manual: click all three footer links, anchors scroll, clickwrap links from login.

## Non-goals

- No cookie consent banner (essential-only).
- No per-region terms variants; single global English document set.
- No CMS/markdown pipeline; static templates are fine at this scale.
- No in-app "accept new terms" re-consent flow (changes clause covers it); can add later.

## Open items for the user (not blockers)

1. Attorney review before relying on these documents in a dispute.
2. Stripe Dashboard: set public business details ToS/Privacy URLs (needed for checkout
   consent collection).
3. Confirm public domain for absolute URLs used in Stripe custom text.
