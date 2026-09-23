#!/usr/bin/env node
// The build gate for the MCP own-authorization-server static assets
// (spec §R1): a build that dropped `.well-known/oauth-authorization-server`
// or `_headers` would still succeed and look identical in `ng build`
// output, but the Cloudflare Worker's SPA fallback would then answer an
// OAuth client's discovery request with `index.html` and a 200 — a silent
// break nothing else in the pipeline would catch.
//
//   npm run check:mcp-assets   (after `ng build`)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every key the drift gate on the backend (`buildAsMetadata`) must agree with. */
const REQUIRED_KEYS = [
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'registration_endpoint',
  'revocation_endpoint',
  'response_types_supported',
  'grant_types_supported',
  'code_challenge_methods_supported',
  'token_endpoint_auth_methods_supported',
  'revocation_endpoint_auth_methods_supported',
  'scopes_supported',
];

/** Checks one built output directory. Returns a list of problems — empty means pass. */
export function checkMcpDist(distDir) {
  const metadataPath = join(distDir, '.well-known', 'oauth-authorization-server');
  const headersPath = join(distDir, '_headers');
  const problems = [];

  if (!existsSync(metadataPath)) {
    problems.push(`missing ${metadataPath}`);
  } else {
    problems.push(...checkMetadata(metadataPath));
  }

  if (!existsSync(headersPath)) {
    problems.push(`missing ${headersPath}`);
    return problems;
  }
  if (!readFileSync(headersPath, 'utf8').includes('/.well-known/oauth-authorization-server')) {
    problems.push(`${headersPath} has no rule for /.well-known/oauth-authorization-server`);
  }
  return problems;
}

function checkMetadata(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return [`${path} is not valid JSON: ${e.message}`];
  }
  return REQUIRED_KEYS.filter((key) => !(key in parsed)).map(
    (key) => `${path} is missing "${key}"`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkMcpDist(join(root, 'dist/vansen/browser'));
  for (const p of problems) console.error(`MCP DIST: ${p}`);
  console.log(
    problems.length
      ? `${problems.length} problem(s) with the MCP metadata assets`
      : 'MCP metadata assets present and valid',
  );
  process.exit(problems.length ? 1 : 0);
}
