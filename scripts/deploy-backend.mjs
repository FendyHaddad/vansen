#!/usr/bin/env node
// Every shared-code consumer ships together. The receipt records the clean
// source revision sent to each function and its independent deployed version.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export const BACKEND_COMPONENTS = ['api', 'job-worker', 'cleanup-worker', 'stripe-webhook', 'appstore-webhook'];

export function deployBackend({ projectRef, revision, run = spawnSync }) {
  if (!projectRef || !revision) throw new Error('project and revision are required');
  for (const name of BACKEND_COMPONENTS) {
    const result = run('supabase', ['functions', 'deploy', name, '--no-verify-jwt', '--project-ref', projectRef], { encoding: 'utf8' });
    if (result.error || result.signal || result.status !== 0) throw new Error(`${name} deployment failed`);
  }
  const inventory = run('supabase', ['functions', 'list', '--project-ref', projectRef, '--output', 'json'], { encoding: 'utf8' });
  if (inventory.error || inventory.signal || inventory.status !== 0) throw new Error('component version inventory failed');
  const parsed = JSON.parse(inventory.stdout);
  const rows = Array.isArray(parsed) ? parsed : parsed.functions;
  const components = {};
  for (const name of BACKEND_COMPONENTS) {
    const version = rows?.find(row => row.slug === name)?.version;
    if (!Number.isInteger(version) || version < 1) throw new Error(`missing ${name} version`);
    components[name] = { version, revision };
  }
  return { projectRef, revision, deployedAt: new Date().toISOString(), components };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const receipt = deployBackend({ projectRef: process.argv[2], revision: process.argv[3] });
    writeFileSync(process.argv[4], `${JSON.stringify(receipt, null, 2)}\n`);
    console.log('Deployed and recorded all five backend components.');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
