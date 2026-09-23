# Clean-code revamp — design

Date: 2026-09-23. Checklist item "Clean-code revamp" in `plans/post-implementation-review.md`.

**Goal.** A maintainer without AI assistance can read and change the code. Behaviour must not change. This work comes before the MCP connection, so the MCP tools land on a split `api`.

## Rules (every workstream)

1. **No behaviour change.**
   - Move code; don't rewrite logic. A logic change is allowed only where it removes nesting (guard clauses, early returns), and it must be provably equivalent.
   - Don't change strings, status codes, error codes, SQL, prices, timing or order of side effects.
2. **Tests prove it.**
   - Existing tests stay unchanged, except for import paths.
   - If a moved piece had no test, don't add behaviour tests. The existing suite is the contract.
3. **Stable public imports.**
   - Every module other files import from keeps its path.
   - When a file is split, the original file becomes a thin barrel that re-exports the pieces (or keeps the entry object). Parallel workstreams then never touch each other's import sites.
4. **One responsibility per file.**
   - Split by route group or feature, not by technical layer.
   - Aim for files under ~400 lines. Never exceed ~600.
5. **Readable.**
   - Use guard clauses instead of nested ifs, and give functions one job.
   - Start each new or split file with a 2–5 line header: what the module does, its main entry points, and anything non-obvious. Beyond the headers, keep comments to the existing density.
6. **Angular components** keep separate `.ts`, `.html` and `.css` files. A component split into child components gives each child its own three files.
7. **Shared catalog.**
   - Files under `src/app/core/catalog/` are the masters that `npm run sync-shared` copies into `supabase/functions/_shared/`.
   - Any new master file must be added to the sync list and to the drift check (`check:shared`).
   - After changing masters, run `npm run sync-shared`.

## Workstreams (parallel worktrees, disjoint files)

| WS | Files | Split along |
|---|---|---|
| 1 | `supabase/functions/api/app.ts` (4,112) | Route groups into `api/routes/*.ts` (profile, generations, jobs, edits, billing, personas, uploads, ledger, library, admin/ops …), shared helpers into `api/services/*` or `api/lib/*`. `app.ts` stays the Hono app assembly (middleware + `route()` mounts) and keeps its exports (`createApp` or whatever tests import). |
| 2 | `features/workspace/workspace-page.ts` (975) and `features/studio/canvas-viewport/canvas-viewport.ts` (804) | Feature concerns: submit, notices, job/cancel handling, upscale/variation actions for the workspace page; pan/zoom, pointer/gesture, rendering and overlay for the viewport. Pull logic into injectable services or pure helpers beside the component. |
| 3 | `features/studio/tool-options/tool-options.ts` (792) and `core/editing/edit-session.ts` (542) | Per-tool option groups (child components or config maps) for tool-options; for edit-session, history/undo, layer/mask state and the save/export pipeline. |
| 4 | `core/catalog/model-families.ts` (1,026) | Per-family definitions (`families/*.ts`), pricing (`credit-cost.ts`), edit tools, upscaler/persona constants, version/catalog constants. `model-families.ts` stays the barrel. Update `sync-shared` and the drift gate for the new files. |

## Gates

- **Per workstream:** `deno check` plus `deno test` of the api tests (WS1), `npm test` (web unit tests), `npx ng build` and `npm run check:shared` (WS4). Workstreams must NOT start the local Supabase stack, because only one can run at a time.
- **After merge (controller):** the full `npm run verify` with `VANSEN_LOCAL_DB`, then one final review of the whole revamp, then `./deploy.sh --yes`.
