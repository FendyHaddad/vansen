# Punchlist — as of 2026-07-24

Two plans are code-complete and sitting in the working tree (nothing committed — you commit personally):
- **Analytics** — `vankode-backoffice/docs/superpowers/plans/2026-07-24-vansen-feature-usage-analytics.md`
- **Avatar personas + trends** — `docs/superpowers/plans/2026-07-24-avatar-personas.md`

All automated gates are green: vansen `ng build` clean + 197 vitest tests; backoffice 62 backend tests + clean frontend build; `api` deployed, health `{"ok":true,"db":true}`, `api/_shared` symlink intact.

---

## 🔴 Needs your attention

### 1. Trend thumbnails not generated yet (paid, ~$0.50 OpenAI)
Trend gallery tiles bind to `trend.thumb`; no images exist. Until generated, tiles render broken/alt-text.
Run: `OPENAI_API_KEY=… node scripts/gen-trend-thumbs.mjs <outDir>` (outDir must match the `thumb` paths in `src/app/core/catalog/trend-presets.ts`). Mirrors `gen-style-thumbs.mjs`.
→ Personas plan Task 12 Step 3.

### 2. Persona live smoke — real spend (~$2.30)
Train a persona end-to-end + generate with it. Costs real fal money, so it's yours to run.
The persona endpoints + fal training/inference are already in the deployed `api` bundle (they were on disk at the Task 9 deploy), but have **never been exercised live**.
→ Personas plan Task 12 Step 2.

### 3. Analytics manual smoke — free, needs apps running
With web app + backoffice (backend + frontend) up:
1. Web → generate once → `select client, settings->>'trend' from generations order by created_at desc limit 1` shows `web`.
2. Web → apply a trend, edit prompt, generate → `settings.trend` = trend id.
3. DevTools: `throw new Error('smoke-client-error')` → `app_errors` row `source='client'`, `client='web'`.
4. Backoffice `/vansen/features` → style ranking + platform split; 7/30/90 toggle works.
5. Backoffice `/vansen/errors` → **Web** chip filters to the smoke error; badge reads `web`.
→ Analytics plan Task 9 Step 4.

### 4. Stray build cruft before you commit
Untracked, must NOT be staged — remove or gitignore:
- `supabase/functions/supabase/` — accidental nested dir from an earlier deploy run in the wrong cwd (`.temp/linked-project.json`).
- `supabase/functions/node_modules/` — local install artifact.

### 5. Commit the two plans
Everything is uncommitted across **both** repos. The vansen tree mixes analytics + personas + trends in one working set — review before staging. (Single branch, your commits.)

---

## ✅ Done since last update

- **Mobile platform stamping** — `DioApiClient` now sends `x-vansen-client: ios|android` on every request (`~/StudioProjects/Vansen-mobile/lib/core/api/client_tag.dart` + `api_client.dart`, computed from `defaultTargetPlatform`). Mobile generations/errors will now attribute correctly instead of "Unknown (pre-tracking)". Nothing committed — yours to commit in the mobile repo.
- **Flutter / mobile error hooks** — `ErrorReporter` (`~/StudioProjects/Vansen-mobile/lib/core/errors/error_reporter.dart`) POSTs uncaught errors to `POST /errors` (mirrors the web reporter: skips `ApiException`, 60s dedupe, fire-and-forget, sends `appVersion`). Wired in `main.dart` via `FlutterError.onError` + `PlatformDispatcher.instance.onError`. 338 mobile tests green.

## ⏸️ Not started yet (deferred by design)

- **Video (Phase 4b)** — locked teaser, out of scope.
