// Proves the MCP dist gate actually fails when the static assets are
// missing or malformed — a build that silently dropped them would otherwise
// look identical to a good one until an OAuth client tried discovery in
// production.
//
//   node --test scripts/check-mcp-dist.test.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkMcpDist } from './check-mcp-dist.mjs';

const GOOD_METADATA = {
  issuer: 'https://vansen.vankode.com',
  authorization_endpoint: 'https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/oauth/authorize',
  token_endpoint: 'https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/oauth/token',
  registration_endpoint: 'https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/oauth/register',
  revocation_endpoint: 'https://bnorhcxhvxydkgvcxjad.supabase.co/functions/v1/api/oauth/revoke',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  scopes_supported: ['vansen'],
};

const GOOD_HEADERS = [
  '/.well-known/oauth-authorization-server',
  '  Content-Type: application/json',
  '  Access-Control-Allow-Origin: *',
  '',
].join('\n');

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), 'vansen-mcp-dist-'));
}

function writeGoodTree(dir) {
  mkdirSync(join(dir, '.well-known'), { recursive: true });
  writeFileSync(join(dir, '.well-known', 'oauth-authorization-server'), JSON.stringify(GOOD_METADATA));
  writeFileSync(join(dir, '_headers'), GOOD_HEADERS);
}

test('a complete, valid dist passes with no problems', () => {
  const dir = fixtureDir();
  try {
    writeGoodTree(dir);
    assert.deepEqual(checkMcpDist(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing metadata file fails', () => {
  const dir = fixtureDir();
  try {
    writeGoodTree(dir);
    rmSync(join(dir, '.well-known', 'oauth-authorization-server'));
    const problems = checkMcpDist(dir);
    assert.ok(problems.some((p) => p.includes('oauth-authorization-server')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing _headers file fails', () => {
  const dir = fixtureDir();
  try {
    writeGoodTree(dir);
    rmSync(join(dir, '_headers'));
    const problems = checkMcpDist(dir);
    assert.ok(problems.some((p) => p.includes('_headers')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the SPA fallback case: the metadata "file" is actually index.html', () => {
  const dir = fixtureDir();
  try {
    mkdirSync(join(dir, '.well-known'), { recursive: true });
    writeFileSync(join(dir, '.well-known', 'oauth-authorization-server'), '<!doctype html><html>…</html>');
    writeFileSync(join(dir, '_headers'), GOOD_HEADERS);
    const problems = checkMcpDist(dir);
    assert.ok(problems.some((p) => p.includes('not valid JSON')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata missing a required key fails', () => {
  const dir = fixtureDir();
  try {
    mkdirSync(join(dir, '.well-known'), { recursive: true });
    const { issuer: _issuer, ...withoutIssuer } = GOOD_METADATA;
    writeFileSync(join(dir, '.well-known', 'oauth-authorization-server'), JSON.stringify(withoutIssuer));
    writeFileSync(join(dir, '_headers'), GOOD_HEADERS);
    const problems = checkMcpDist(dir);
    assert.ok(problems.some((p) => p.includes('"issuer"')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a _headers file with no rule for the metadata path fails', () => {
  const dir = fixtureDir();
  try {
    writeGoodTree(dir);
    writeFileSync(join(dir, '_headers'), '/some/other/path\n  X-Foo: bar\n');
    const problems = checkMcpDist(dir);
    assert.ok(problems.some((p) => p.includes('no rule for')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
