// Copies the Angular master domain files into supabase/functions/_shared/
// with Deno-compatible import specifiers. Run before every function deploy:
//   npm run sync-shared
// The vitest in src/app/core/shared-sync.spec.ts asserts the copies match.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Deno needs explicit `.ts` extensions on relative imports; the Angular masters omit them. */
function withTsExtensions(code) {
  return code.replace(/from '(\.{1,2}\/[^']+)';/g, (match, spec) =>
    spec.endsWith('.ts') ? match : `from '${spec}.ts';`,
  );
}

/**
 * `withTsExtensions` only matches a single-quoted `from '...';` specifier. A
 * master that instead writes double quotes (or drops the trailing `;`) slips
 * through untouched, and the resulting Deno import 404s at deploy time. This
 * scans the already-transformed output — so a specifier the transform did
 * fix (now ending in `.ts`) is not re-flagged — for any relative import the
 * rewrite still missed, in either quote style.
 */
function untransformedRelativeImports(code) {
  const re = /from\s+(['"])(\.{1,2}\/[^'"]+)\1/g;
  const missed = [];
  for (const [specifier, , path] of code.matchAll(re)) {
    if (!path.endsWith('.ts')) missed.push(specifier);
  }
  return missed;
}

/**
 * Catalog files `sync-shared` deliberately never copies: Angular DI/browser
 * code the Deno side has no use for, or data a client-only spec recomputes.
 * Anything else new under `src/app/core/catalog/` must be added to
 * `CATALOG_MODULES` (or `FILES`) or listed here with a reason — the
 * completeness check below fails on anything uncovered.
 */
const WEB_ONLY_CATALOG_FILES = new Set([
  // Recomputed by catalog-version.spec.ts from MODEL_FAMILIES; not consumed
  // by any server code.
  'catalog-fingerprint.ts',
  // Angular Injectable/InjectionToken + `environment` import — browser-only.
  'public-capabilities.ts',
  // Angular Injectable that fetches GET /catalog for the AI edit tool plans —
  // browser-only.
  'edit-tool-catalog.ts',
]);

/** Every non-spec `.ts` file under `src/app/core/catalog/`, relative to it. */
function listCatalogTsFiles(root) {
  const catalogDir = join(root, 'src/app/core/catalog');
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
      out.push(`${prefix}${entry.name}`);
    }
  };
  walk(catalogDir, '');
  return out;
}

const CATALOG_PREFIX = 'src/app/core/catalog/';

/**
 * The pieces model-families.ts re-exports, relative to src/app/core/catalog/.
 * Each is copied to the same relative path under _shared/, so the barrel's
 * imports resolve unchanged once they carry a `.ts` extension.
 */
const CATALOG_MODULES = [
  'family-types.ts',
  'generation-input.ts',
  'families/shared-options.ts',
  'families/nano-banana.ts',
  'families/gpt-image.ts',
  'families/flux.ts',
  'families/seedream.ts',
  'families/veo.ts',
  'families/omni.ts',
  'families/kling.ts',
  'families/runway.ts',
  'families/seedance.ts',
  'family-registry.ts',
  'family-options.ts',
  'credit-cost.ts',
  'plan-pricing.ts',
  'edit-tools.ts',
  'upscaler.ts',
  'persona-gen.ts',
  'video-modes.ts',
];

export const FILES = [
  {
    src: 'src/app/core/enums.ts',
    out: 'enums.ts',
    transform: (code) => code,
  },
  {
    src: 'src/app/core/catalog/model-families.ts',
    out: 'model-families.ts',
    transform: withTsExtensions,
  },
  ...CATALOG_MODULES.map((path) => ({
    src: `src/app/core/catalog/${path}`,
    out: path,
    transform: withTsExtensions,
  })),
  {
    src: 'src/app/features/studio/studio-tool.ts',
    out: 'studio-tool.ts',
    transform: (code) => code,
  },
  {
    src: 'src/app/core/catalog/entitlements.ts',
    out: 'entitlements.ts',
    transform: (code) =>
      code.replace(
        "import type { StudioTool } from '../../features/studio/studio-tool';",
        "import type { StudioTool } from './studio-tool.ts';",
      ),
  },
  {
    src: 'src/app/core/catalog/trend-presets.ts',
    out: 'trend-presets.ts',
    transform: (code) => code,
  },
  {
    src: 'src/app/core/catalog/build-catalog.ts',
    out: 'build-catalog.ts',
    // Deno needs explicit extensions on the sibling imports.
    transform: (code) =>
      code.replace(
        /from '\.\/(model-families|trend-presets|entitlements)';/g,
        "from './$1.ts';",
      ),
  },
];

export function transformed(file, root = scriptRoot) {
  const code = readFileSync(join(root, file.src), 'utf8');
  return file.transform(code);
}

/**
 * `--check` verifies the Deno copies without touching them, so CI and the P9
 * release gate can prove the two trees agree without the very act of checking
 * hiding the drift it is meant to catch.
 */
function assertSharedMatches(output, expected) {
  if (!existsSync(output) || readFileSync(output, 'utf8') !== expected) {
    throw new Error(`shared drift: ${output}`);
  }
}

/**
 * A catalog file nobody added to `CATALOG_MODULES`/`FILES` and nobody marked
 * web-only is drift too — it just never makes it to `_shared/` for anyone to
 * notice. Fails loudly instead of silently shipping a stale server catalog.
 */
function assertCatalogModulesComplete(root) {
  const covered = new Set([
    ...CATALOG_MODULES,
    ...FILES.filter((f) => f.src.startsWith(CATALOG_PREFIX)).map((f) =>
      f.src.slice(CATALOG_PREFIX.length),
    ),
    ...WEB_ONLY_CATALOG_FILES,
  ]);
  const missing = listCatalogTsFiles(root).filter((f) => !covered.has(f));
  if (missing.length) {
    throw new Error(
      `shared drift: not synced and not marked web-only in sync-shared.mjs: ${missing.join(', ')}`,
    );
  }
}

/** See `untransformedRelativeImports` — a specifier the rewrite missed would
 * otherwise ship as "correct" because both the master and its stale-looking
 * copy agree on the broken import. */
function assertRelativeImportsTransformed(file, expected) {
  const missed = untransformedRelativeImports(expected);
  if (missed.length) {
    throw new Error(
      `shared drift: ${file.src} has a relative import withTsExtensions did not rewrite: ${missed.join(', ')}`,
    );
  }
}

export function runSync(root = scriptRoot, argv = process.argv) {
  const checking = argv.includes('--check');
  assertCatalogModulesComplete(root);
  const outDir = join(root, 'supabase', 'functions', '_shared');
  for (const file of FILES) {
    const output = join(outDir, file.out);
    const expected = transformed(file, root);
    assertRelativeImportsTransformed(file, expected);
    if (checking) {
      assertSharedMatches(output, expected);
      continue;
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, expected);
    console.log(`synced ${file.src} -> supabase/functions/_shared/${file.out}`);
  }
  if (checking) console.log(`shared copies verified (${FILES.length} files)`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) runSync();
