# Mobile parity phases 3 + 4 — design and task briefs

Date: 2026-09-23. This covers sub-projects 3 and 4 of mobile parity, combined:
- **3:** cloud upscale, styles, trends.
- **4:** version link, job cancel, usage (ledger), password recovery.

Sub-projects 1 and 2 are live (catalog `2026-09-23.3`, api v71, mobile `bd6f644`).

Claude took these decisions under the owner's standing go-ahead. The owner can redirect any of them.

The rule carried over: the server defines every rule and the app renders it. The parity target is **what the web actually ships**, not capabilities the web has but doesn't use (YAGNI):
- **Version history:** the web shows a single "Edited from" parent link, not a chain. `GET /generations/:id/versions` exists, but no web screen calls it.
- **Ledger:** the web shows a monthly usage summary, not a raw transaction list.

Process (owner, 2026-09-23: faster): fewer, larger tasks, run in parallel worktrees. Only the money and auth tasks (B, D, F) get their own review. There is one final review of the whole phase, then one fix wave.

## 0. Facts this rests on (verified 2026-09-23)

- **Web origin.** The web runs at `https://vansen.vankode.com`; it serves `/trends/*.webp` and `/styles/*.webp`. Mobile's `Env.webBaseUrl` defaults to `https://vansen.com`, which is someone else's site and returns `text/html` for our paths. So Settings' web links and the persona guide images point at the wrong site today. This is a live bug.
- **Cloud upscale.**
  - Request: `POST /generations {op:'upscale', parentId, prompt, settings, batch:1}`.
  - Family: `upscaler`, provider fal clarity-upscaler.
  - Price: `/catalog` `flat.upscale {credits:7, enabled}`.
  - Plan: plan = `models.min_plan` for `upscaler` (studio), served as `flat.upscale.plan`; `ENTITLEMENTS.upscale` is the local Swin2SR tool (decided 2026-09-23 after audit: the web sells cloud upscale to Studio).
- **AI edit tools.** AI edit tools are Pro (owner, 2026-09-23: follow the web): `models.min_plan`, migration 0034, served as `flat.editTools[].plan`.
- **Styles.**
  - The request carries `style: <id>`. The gateway appends the modifier to the prompt and returns 400 `invalid_style` for an unknown id.
  - Styles are free.
  - `/catalog` serves only `{id, label}`. The web picker also uses `thumb` (`/styles/<id>.webp`) and `category`.
- **Trends.**
  - They are client-only: picking one prefills the prompt and the aspect ratio. `trendId` is an optional analytics tag (a free label, 40 characters max).
  - `/catalog` serves `{id, label, prompt, aspectRatio}`, with no `thumb` (`/trends/<id>.webp`).
- **Parent link.** `GenerationDto.parentId` is served. The web detail overlay shows an "Edited from" thumbnail that opens the parent.
- **Job cancel.** `POST /jobs/:id/cancel` returns one of:
  - 200 `{refundedCredits, credits}`: the job never left the queue and was refunded now.
  - 202 `{cancelling:true, refundedCredits:0, credits}`: the worker asks the provider, which refunds only if it stops in time.
  - 409 `not_pending` or `not_cancellable`, or 404.

  `GET /jobs` progress carries `cancellable`. The web notice for 202 is "Cancelling — we'll refund if it stops in time."
- **Ledger.**
  - `GET /ledger?limit&cursor` → `{entries:[{id,type,amountCredits,bucket,familyId,note,createdAt}], nextCursor}`.
  - The web usage tab counts only this calendar month's debits (`amountCredits < 0`), leaving out `pack_expiry` and `cycle_reset`.
  - It shows total spend, operation count, a by-type table and a by-family table. By-family maps `upscaler` and `magnific` to "Upscale" and every other id to the family name.
- **Password recovery (MT-06).**
  - The web calls `resetPasswordForEmail(email, redirectTo)` and requires passwords of at least 8 characters.
  - Mobile already registers `vansen://auth-callback`, which OAuth uses. Recovery reuses it, so no new URL scheme and no new allow-list entry are needed. supabase_flutter turns a `type=recovery` link into `AuthChangeEvent.passwordRecovery`.

## 1. Backend (Task A)

- `/catalog` `styles[]` gains `thumb` (the relative path `/styles/<id>.webp`) and `category`. `trends[]` gains `thumb` (`/trends/<id>.webp`).
- Both are additive. `buildCatalog()` reads them from the existing `STYLE_PRESETS` and `TREND_PRESETS`.
- Bump `CATALOG_VERSION` to `2026-09-23.4`, since the fingerprint spec fails without the bump. Then run `npm run sync-shared` and update the recorded fingerprint.
- Regenerate mobile `assets/catalog/catalog.json` and move its fixtures to `.4`.
- A Deno test asserts that every served `thumb` has a file under `public/` (the trend-assets gate may already do this for trends).

## 2. Mobile

**Task A (mobile part).**
- `Env.webBaseUrl` defaults to `https://vansen.vankode.com`; the `WEB_BASE_URL` dart-define still overrides it.
- `Catalog` parses `styles` (`CatalogStyle {id, label, category, thumb}`) and `trends` (`CatalogTrend {id, label, prompt, aspectRatio?, thumb}`).
- A helper `webAsset(path)` builds `'${Env.webBaseUrl}$path'`.

**Task B: cloud upscale + parent link** (generation detail).
- **Upscale action.** On a done image item that is neither a video nor a Studio Edit mask, show an Upscale action priced at `flat.upscale.credits`.
  - Disable it when `flat.upscale.enabled` is false, and show the same "temporarily unavailable" notice used for disabled models.
  - Lock it behind `flat.upscale.plan` using the existing plan-lock pattern and upgrade prompt.
  - Submit `op:'upscale'`, `parentId`, the item's `prompt` and `settings`, `batch:1` and `catalogVersion`.
  - The new pending item joins the library and the job poller. Credits update from the response.
  - Errors go through `apiErrorText` (`pro_required`, `insufficient_credits`, `model_disabled`).
- **Parent link.** When `parentId` is set, show an "Edited from" thumbnail that opens the parent's detail (`GET /generations/:id`). A parent the server can't find (404) hides the link.

**Task C: styles + trends** (composer).
- **Style chip.** A style chip beside settings opens a sheet showing `catalog.styles` as a grid with thumbnails (`webAsset(thumb)`, falling back to a placeholder icon), grouped by `category`, plus "None".
  - The chosen style is sent as `style` and persists across submits until cleared.
  - Hide the chip while a persona is chosen, unless the gateway's persona branch honours `style`. The implementer checks `app.ts` and follows the gateway.
  - A catalog refresh that drops the chosen style clears it.
- **Trends.** A "Trends" entry (workspace, where the web puts the trend gallery; the implementer picks the closest existing entry point) opens a grid of `catalog.trends` with thumbnails.
  - Picking one sets the prompt, sets the aspect ratio when the current family offers it, and records `trendId` for the next submit only.
  - Editing the prompt keeps the `trendId`, as the web does. The implementer checks `workspace-page.ts`/`trend-gallery.ts` and follows the web.
- Map `invalid_style`.

**Task D: job cancel** (pending cards in library and workspace).
- A Cancel control appears on pending cards whose job progress has `cancellable: true`. It asks for confirmation, then calls `POST /jobs/:id/cancel`.
- On 200, show "Cancelled — N credits refunded.", apply `credits` and let the poller settle the card.
- On 202, show "Cancelling — we'll refund if it stops in time." and disable the control on that card.
- Map `not_pending`, `not_cancellable` and `cancel_failed`. A 404 reloads the list.
- A settled card shows "Cancelled" rather than "Failed" when its failure code is `cancelled`, as the web's `isCancelled()` does.

**Task E: usage** (Settings → Usage).
- `LedgerRepo.page(cursor)` reads `GET /ledger`. `usageProvider` loads pages until an entry is older than the start of the current month (or `nextCursor` is null), then applies the web's rule exactly: debits only, `pack_expiry` and `cycle_reset` excluded.
- The screen shows total spend (credits), operation count, by-type rows and by-family rows (label, count, spend, percent), and an empty state.
- Type labels are i18n keys, one per `LedgerType`. Family labels come from the catalog family label, with `upscaler`/`magnific` shown as "Upscale" and anything else shown as its raw id.
- Settings gets a Usage tile.

**Task F: password recovery (MT-06).**
- `AuthGateway` gains `requestPasswordReset(email)` (redirect `vansen://auth-callback`), `updatePassword(password)` and `passwordRecovery` (a stream of the recovery event). `SupabaseAuthGateway` implements them, and `FakeAuthGateway` mirrors them.
- **Login screen.** "Forgot password?" opens an email field and calls the reset. The confirmation copy never reveals whether the account exists: "If that email has an account, we sent a reset link."
- **Recovery screen.** A recovery event routes to `/reset-password`, whose redirect is exempt from the age gate. The screen takes a new password plus a confirmation, with at least 8 characters and the two matching. On success it shows a notice and goes to the workspace.
- **Errors.** An expired or invalid link, or an `updateUser` error, shows "This reset link has expired. Request a new one." with a button back to the login screen's forgot flow.
- Unconfirmed email: if the login error is `email_not_confirmed`, offer "Resend confirmation" (`auth.resend(type: signup)`), as the web does.

## 3. Task graph

- **A** comes first: backend, bundled catalog, mobile catalog parse, `Env` default.
- **B, C, D, E and F** then run in parallel worktrees.
- **F** doesn't depend on A and can start at once.

Every task:
- follows mobile `CLAUDE.md`: TDD, no Dart comments, no nested ifs, i18n keys of three words or fewer in en and ms, and `Log.error` only for unexpected failures;
- always runs flutter with `--no-pub`;
- touches only its own feature files, plus appended entries in `api_error.dart`, `en.json`/`ms.json`, `fakes.dart` and `app_router.dart`, and the controller resolves any merge conflict in those;
- adds each new i18n block as its own top-level section (`upscale`, `styles`, `trends`, `cancel`, `usage`, `recovery`), not by editing another task's section.

## 4. Testing and gates

Each task's tests cover the behaviour listed above. The gates are:
- backend: `npm run verify` (with `VANSEN_LOCAL_DB`);
- mobile: `flutter analyze --no-pub` and `flutter test --no-pub`.

Deploy is `./deploy.sh --yes`, then read back `/catalog` `.4` with thumbs.

## 5. Owner items (not blocking)

- Check that the hosted Auth redirect allow-list contains `vansen://auth-callback`. OAuth already depends on it.
- Check that the recovery email template uses `{{ .ConfirmationURL }}`, which honours `redirectTo`.
- Run a live reset on a device before release.
- Store builds stay with the owner.

## 6. Out of scope

A full version-chain browser, a raw ledger list, video, the Denoise and Colorize tools, and store submission.
