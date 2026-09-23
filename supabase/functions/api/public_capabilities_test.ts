// D1: an anonymous visitor may only be told what the deployment actually does.
//
// The landing, pricing, footer and login pages advertised models from
// hand-written lists — including Sora, which has no adapter — and promised
// background completion the deployment has never been verified to do. They now
// read this route, which is served before the auth middleware and returns a
// whitelist.
import { assert, assertEquals } from 'jsr:@std/assert';
import { createApp } from './app.ts';
import { FakeDb, testDeps } from './testing/fakes.ts';
import {
  publicCapabilities,
  releaseFlagsFromEnv,
} from './services/public-capabilities.ts';
import { CATALOG_VERSION } from '../_shared/model-families.ts';

const OFF = { backgroundCompletion: false, completionNotifications: false, mcpEnabled: false };

function withModels(rows: { id: string; enabled: boolean }[]) {
  const deps = testDeps();
  (deps.admin as unknown as FakeDb).tables.models = rows;
  return deps;
}

Deno.test('capabilities is readable with no token at all', async () => {
  const deps = withModels([{ id: 'flux', enabled: true }]);
  const res = await createApp(deps).request('/api/capabilities');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.enabledFamilyIds, ['flux']);
  assertEquals(body.catalogVersion, CATALOG_VERSION);
});

Deno.test('a disabled family is never advertised', async () => {
  // The kill switch is the only place a family is turned off. A sales page
  // that keeps naming it sells something the composer will refuse.
  const deps = withModels([
    { id: 'flux', enabled: true },
    { id: 'veo', enabled: false },
  ]);
  const res = await createApp(deps).request('/api/capabilities');
  const body = await res.json();
  assertEquals(body.enabledFamilyIds, ['flux']);
});

Deno.test('the response carries nothing but the whitelist', async () => {
  const deps = withModels([{ id: 'flux', enabled: true }]);
  const res = await createApp(deps).request('/api/capabilities');
  const body = await res.json();
  assertEquals(
    Object.keys(body).sort(),
    [
      'backgroundCompletion',
      'catalogVersion',
      'completionNotifications',
      'enabledFamilyIds',
    ],
  );
});

Deno.test('no per-model detail leaks through the family list', async () => {
  // `models` also holds min_plan and provider columns. Returning the row would
  // publish the deployment's plan gating and provider choices to anyone.
  const deps = withModels([
    { id: 'flux', enabled: true, min_plan: 'pro', provider: 'falcon-host' } as never,
  ]);
  const res = await createApp(deps).request('/api/capabilities');
  const json = JSON.stringify(await res.json());
  assert(!json.includes('min_plan'), json);
  assert(!json.includes('falcon-host'), json);
  assert(!json.includes('pro'), json);
});

Deno.test('release flags default off and are reported off', async () => {
  const deps = withModels([]);
  const res = await createApp(deps).request('/api/capabilities');
  const body = await res.json();
  assertEquals(body.backgroundCompletion, false);
  assertEquals(body.completionNotifications, false);
});

Deno.test('a verified flag is reported on', async () => {
  const deps = withModels([]);
  deps.env.releaseFlags = { backgroundCompletion: true, completionNotifications: true, mcpEnabled: false };
  const res = await createApp(deps).request('/api/capabilities');
  const body = await res.json();
  assertEquals(body.backgroundCompletion, true);
  assertEquals(body.completionNotifications, true);
});

Deno.test('notifications cannot be promised without background completion', () => {
  // "We will tell you when it is done" is a lie if nothing finishes the work
  // once the tab closes. The two flags are not independent.
  const caps = publicCapabilities([], {
    backgroundCompletion: false,
    completionNotifications: true,
    mcpEnabled: false,
  });
  assertEquals(caps.completionNotifications, false);
});

Deno.test('only the exact string "on" enables a flag', () => {
  const env: Record<string, string> = {
    RELEASE_BACKGROUND_COMPLETION: 'true',
    RELEASE_COMPLETION_NOTIFICATIONS: '1',
    MCP_ENABLED: 'yes',
  };
  const flags = releaseFlagsFromEnv((k) => env[k]);
  assertEquals(flags, OFF);

  env.RELEASE_BACKGROUND_COMPLETION = 'on';
  assertEquals(releaseFlagsFromEnv((k) => env[k]).backgroundCompletion, true);
  env.MCP_ENABLED = 'on';
  assertEquals(releaseFlagsFromEnv((k) => env[k]).mcpEnabled, true);
});

Deno.test('the MCP flag is never published to anonymous visitors', () => {
  const caps = publicCapabilities([], { ...OFF, mcpEnabled: true });
  assertEquals('mcpEnabled' in caps, false);
});

Deno.test('a missing or broken models read advertises nothing', () => {
  // An empty list is the safe answer: the pages fall back to saying less, not
  // to a stale hard-coded list.
  assertEquals(publicCapabilities(null, OFF).enabledFamilyIds, []);
  assertEquals(
    publicCapabilities([{ id: null, enabled: true }], OFF).enabledFamilyIds,
    [],
  );
});

Deno.test('the family list is stable so a client can compare it', () => {
  const caps = publicCapabilities(
    [
      { id: 'veo', enabled: true },
      { id: 'flux', enabled: true },
    ],
    OFF,
  );
  assertEquals(caps.enabledFamilyIds, ['flux', 'veo']);
});
