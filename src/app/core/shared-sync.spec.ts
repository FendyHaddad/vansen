import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain mjs module
import { FILES, transformed } from '../../../scripts/sync-shared.mjs';

const sharedDir = join(process.cwd(), 'supabase', 'functions', '_shared');

describe('shared sync integrity', () => {
  it('supabase/functions/_shared copies match the Angular masters', () => {
    for (const file of FILES) {
      const copy = readFileSync(join(sharedDir, file.out), 'utf8');
      expect(copy, `${file.out} drifted — run: npm run sync-shared`).toBe(
        transformed(file, process.cwd()),
      );
    }
  });
});
