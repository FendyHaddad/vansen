// Copies the Angular master domain files into supabase/functions/_shared/
// with Deno-compatible import specifiers. Run before every function deploy:
//   npm run sync-shared
// The vitest in src/app/core/shared-sync.spec.ts asserts the copies match.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    src: 'src/app/core/catalog/style-presets.ts',
    out: 'style-presets.ts',
    transform: (code) => code,
  },
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
        /from '\.\/(model-families|style-presets|trend-presets|entitlements)';/g,
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

export function runSync(root = scriptRoot, argv = process.argv) {
  const checking = argv.includes('--check');
  const outDir = join(root, 'supabase', 'functions', '_shared');
  for (const file of FILES) {
    const output = join(outDir, file.out);
    const expected = transformed(file, root);
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
