#!/usr/bin/env node
// The build gate for the MCP own-authorization-server static assets
// (spec §R1): a build that dropped `.well-known/oauth-authorization-server`
// or `_headers` would still succeed and look identical in `ng build`
// output, but the Cloudflare Worker's SPA fallback would then answer an
// OAuth client's discovery request with `index.html` and a 200 — a silent
// break nothing else in the pipeline would catch. It also asserts the
// site-wide anti-framing rule (final review 2, I1): the OAuth consent page's
// Allow button must never be clickable inside another site's frame.
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
  'authorization_response_iss_parameter_supported',
];

/** Headers the `/*` rule must set, as [name, what the value must contain]. */
const ANTI_FRAMING = [
  ['x-frame-options', 'DENY'],
  ['content-security-policy', "frame-ancestors 'none'"],
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
  const rules = parseHeaders(readFileSync(headersPath, 'utf8'));
  if (!rules.has('/.well-known/oauth-authorization-server')) {
    problems.push(`${headersPath} has no rule for /.well-known/oauth-authorization-server`);
  }
  problems.push(...checkAntiFraming(headersPath, rules.get('/*') ?? []));
  return problems;
}

/** Cloudflare `_headers`: an unindented path line, then indented `Name: value` lines. */
export function parseHeaders(text) {
  const rules = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = line.trim();
      rules.set(current, rules.get(current) ?? []);
      continue;
    }
    const colon = line.indexOf(':');
    if (current === null || colon < 0) continue;
    rules.get(current).push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

function checkAntiFraming(path, headers) {
  return ANTI_FRAMING.filter(
    ([name, needle]) => !headers.some(([n, value]) => n === name && value.includes(needle)),
  ).map(([name, needle]) => `${path}: the /* rule must set ${displayName(name)}: ${needle}`);
}

function displayName(name) {
  return name === 'x-frame-options' ? 'X-Frame-Options' : 'Content-Security-Policy';
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
