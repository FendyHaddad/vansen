#!/usr/bin/env node
/**
 * What staging is allowed to claim it can do.
 *
 * Staging runs with the owner's real provider keys where they are supplied and
 * with nothing where they are not. A family left `enabled = true` with no key
 * behind it fails inside the job worker, after the charge, which looks like a
 * bug rather than a missing key. So the rule is decided here, from the file,
 * and applied by the seed: key present means enabled, key absent means the
 * same kill switch production uses.
 *
 * Video is not represented. `0016_video.sql` inserts those five families
 * disabled and staging has no business turning them on: they need R2 and a
 * Runway key that no local stack has.
 */
import { existsSync, readFileSync } from 'node:fs';

export const ENV_PATH = 'supabase/.env.staging';
export const EXAMPLE_PATH = 'supabase/.env.staging.example';

/** Image family id → the environment variable its provider adapter reads. */
export const FAMILY_KEY = {
  'nano-banana': 'GOOGLE_AI_API_KEY',
  'gpt-image': 'OPENAI_API_KEY',
  flux: 'FAL_API_KEY',
  seedream: 'FAL_API_KEY',
  upscaler: 'FAL_API_KEY',
  persona: 'FAL_API_KEY',
  'edit-remove': 'FAL_API_KEY',
  'edit-fill': 'FAL_API_KEY',
  'edit-expand': 'FAL_API_KEY',
  'edit-bg': 'FAL_API_KEY',
};

/** An empty value means absent: a key someone cleared is not a key. */
export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split < 0) continue;
    const name = trimmed.slice(0, split).trim();
    const value = trimmed.slice(split + 1).trim().replace(/^["']|["']$/g, '');
    if (!value) continue;
    values[name] = value;
  }
  return values;
}

export function familyPlan(env) {
  const enabled = [];
  const disabled = [];
  for (const [family, key] of Object.entries(FAMILY_KEY)) {
    if (env[key]) enabled.push(family);
    if (!env[key]) disabled.push(family);
  }
  return { enabled, disabled, moderation: Boolean(env.OPENAI_API_KEY) };
}

export function loadStagingEnv({ readFile = readFileSync, exists = existsSync } = {}) {
  if (!exists(ENV_PATH)) {
    throw new Error(`${ENV_PATH} is missing. Copy ${EXAMPLE_PATH} to it and paste your keys in.`);
  }
  return parseEnvFile(readFile(ENV_PATH, 'utf8'));
}
