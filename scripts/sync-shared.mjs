// Copies the Angular master domain files into supabase/functions/_shared/
// with Deno-compatible import specifiers. Run before every function deploy:
//   npm run sync-shared
// The vitest in src/app/core/shared-sync.spec.ts asserts the copies match.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const FILES = [
  {
    src: 'src/app/core/enums.ts',
    out: 'enums.ts',
    transform: (code) => code,
  },
  {
    src: 'src/app/core/catalog/model-families.ts',
    out: 'model-families.ts',
    // Deno cannot resolve the Angular-relative PAYG_MARGIN import; inline it.
    transform: (code) =>
      code.replace(
        "import { PAYG_MARGIN } from '../../features/pricing/model-catalog';",
        'const PAYG_MARGIN = 0.33;',
      ),
  },
  {
    src: 'src/app/core/catalog/style-presets.ts',
    out: 'style-presets.ts',
    transform: (code) => code,
  },
];

export function transformed(file, root = scriptRoot) {
  const code = readFileSync(join(root, file.src), 'utf8');
  return file.transform(code);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const outDir = join(scriptRoot, 'supabase', 'functions', '_shared');
  mkdirSync(outDir, { recursive: true });
  for (const file of FILES) {
    writeFileSync(join(outDir, file.out), transformed(file));
    console.log(`synced ${file.src} -> supabase/functions/_shared/${file.out}`);
  }
}
