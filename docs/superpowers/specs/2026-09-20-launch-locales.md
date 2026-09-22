# D4 — Launch locales: English-only, or funded en + ms

**Status: DECIDED 2026-09-22 — Option A, English-only at launch.** See the Decision section at the bottom.
Recorded 2026-09-21 during P8 (product truth and recovery). Nothing in the P8
audit repair chooses it, and no code has been written either way.

## Why this is being recorded now

`vansen.md:259` commits the product to "Localization: en and ms", and
`vansen.md:290` lists i18n under *Not started*. Both statements are still true,
which means the shipped product currently promises a Malay experience it does
not have. P8's job is to stop surfaces promising what the product does not do,
so the promise has to be either honoured or withdrawn — but which one is a
business call about the Malaysian market, not something an audit can infer.

Every other locale-dependent piece of release work is blocked behind this
answer: string extraction, the locale preference, number and currency
formatting, date formatting in the library and billing history, and the layout
tests for the strings that get longer when translated.

## Option A — English-only at launch

Withdraw the promise and say so honestly.

- `vansen.md` drops "Localization: en and ms" and states English-only, with ms
  as a post-launch item if it is ever funded.
- Store listings, the landing page and the legal pages are written and reviewed
  as English-only.
- No extraction pass, no locale preference, no format plumbing.
- **Cost:** none beyond the copy edit.
- **Risk:** a Malaysian-market launch from a Malaysian entity (Vankode
  Technology, governing law Malaysia) with no Malay UI is a positioning
  decision worth making deliberately rather than by default.

## Option B — Funded en + ms at launch

Honour the promise, as its own scoped piece of work. It is not a refactor and
must not be smuggled into another task's diff.

That scope is at minimum:

1. **Extraction.** Every user-visible string out of templates and component
   code into a keyed catalog. `vansen.md:259` sets the convention: dot-notation
   keys, at most three words. This touches essentially every template in
   `src/app`, plus the server's customer-facing refusal messages — the retry
   refusals in `supabase/functions/api/services/retry.ts` and the failure
   messages in the generation DTO are shown to a customer and would otherwise
   stay English inside a Malay UI.
2. **Preference and negotiation.** Where the locale is stored (profile prefs,
   so it follows the account across devices), what an unset preference falls
   back to, and whether the browser's `Accept-Language` seeds it.
3. **Formatting.** Numbers (credit balances read as "1,500" in en), currency
   (plan prices are USD regardless of locale — that needs stating, not
   assuming), and dates in the library, billing history and ledger.
4. **Truncation and layout tests.** Malay strings run longer than their English
   sources. Every fixed-width surface — the composer's left rail, the tool
   chips, the plan cards, the credit chips — needs a test at the longer string,
   or the translation ships broken.
5. **Legal.** The Terms, Privacy and Acceptable Use pages are already flagged
   as AI-drafted and pending attorney review. A translated legal page is a
   second document to review, not the same one in another font.

- **Cost:** a full phase of its own, plus recurring translation cost on every
  copy change.

## What is NOT part of this decision

The P8 audit repair — deriving every sales surface from the entitlement table
and the live capability list — is locale-independent and has already shipped.
It makes the English copy true. It does not make the product bilingual, and
nothing about it should be read as having settled D4 either way.

## Decision

**2026-09-22 — Option A. English is the default and only launch language.**
Decided by the owner. Malay (ms) becomes a post-launch item, funded separately if
ever, with the Option B scope above as its starting brief.

Enforced by:
- `src/app/app.config.ts` provides `LOCALE_ID` = `en-US` explicitly, and
  `src/index.html` carries `lang="en"`.
- `vansen.md` no longer promises en + ms; i18n is listed as deferred, not "not started".
- No string extraction, locale preference or format plumbing ships in this release.
- Store listings, landing and legal pages are reviewed as English-only.
