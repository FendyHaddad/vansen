// The retry DECISION, without a gateway around it.
//
// `retry_routes_test.ts` proves the routes behave. This proves the rules:
// which requests can be replayed, which cannot, and — the part the routes
// cannot show, because the server maps it back again — that the rebuilt body
// names the real model family rather than the pseudo-family a persona run is
// stored under.
import { assert, assertEquals } from 'jsr:@std/assert';
import { captureSnapshot } from '../_shared/request-snapshot.ts';
import { planRetry, planVariation, REFUSAL_MESSAGE, type RetryContext } from './retry.ts';
import type { GenerationOp } from '../_shared/enums.ts';

const base = {
  op: 'generate' as GenerationOp,
  familyId: 'flux',
  prompt: 'a cat',
  settings: { aspectRatio: '1:1', resolution: '1MP' },
  referenceUploadIds: [] as string[],
  referenceSlots: { first: null, last: null, references: [] as string[] },
  maskUploadId: null as string | null,
  personaId: null as string | null,
  styleId: null as string | null,
  trendId: null as string | null,
  mode: null,
  parentId: null as string | null,
  catalogVersion: 'cat-v1',
  quoteVersion: 1,
};

function ctx(over: Partial<RetryContext> = {}, snapshot: Partial<typeof base> = {}): RetryContext {
  const snap = captureSnapshot({ ...base, ...snapshot } as never);
  return {
    snapshot: snap,
    liveUploadPaths: new Set([
      ...snap.referenceUploadIds,
      ...(snap.maskUploadId ? [snap.maskUploadId] : []),
    ]),
    familyEnabled: true,
    entitled: true,
    expressible: true,
    personaUnavailable: false,
    ...over,
  };
}

Deno.test('a plain generation replays', () => {
  const decision = planRetry(ctx());
  assert(decision.ok);
  assertEquals(decision.body.familyId, 'flux');
  assertEquals(decision.body.prompt, 'a cat');
  assertEquals(decision.body.batch, 1);
});

Deno.test('R15: the rebuilt body names the real family, never "persona"', () => {
  // The whole original defect: the client sent familyId='persona', which is
  // not a model, and the server answered invalid_family.
  const decision = planRetry(ctx({}, { personaId: 'p-1' }));
  assert(decision.ok);
  assertEquals(decision.body.familyId, 'flux');
  assertEquals(decision.body.personaId, 'p-1');
});

Deno.test('R15: an edit replays with its mask', () => {
  const decision = planRetry(
    ctx({}, { op: 'edit' as GenerationOp, familyId: 'edit-fill', maskUploadId: 'u/m.png', parentId: 'g0' }),
  );
  assert(decision.ok);
  assertEquals(decision.body.maskUploadId, 'u/m.png');
  assertEquals(decision.body.parentId, 'g0');
});

Deno.test('R15: an upscale replays against its parent', () => {
  const decision = planRetry(ctx({}, { op: 'upscale' as GenerationOp, familyId: 'upscaler', parentId: 'g0' }));
  assert(decision.ok);
  assertEquals(decision.body.op, 'upscale');
  assertEquals(decision.body.parentId, 'g0');
});

Deno.test('R15: an image reference replays as a single reference', () => {
  const decision = planRetry(ctx({}, { familyId: 'nano-banana', referenceUploadIds: ['u/r.png'] }));
  assert(decision.ok);
  assertEquals(decision.body.referenceUploadId, 'u/r.png');
  assertEquals(decision.body.referencePaths, undefined);
});

Deno.test('R15: a video replays as ordered paths, not a single reference', () => {
  const decision = planRetry(ctx({}, {
    familyId: 'kling',
    mode: 'keyframes' as never,
    referenceUploadIds: ['first.png', 'last.png'],
  }));
  assert(decision.ok);
  // Swapping these runs the video backwards.
  assertEquals(decision.body.referencePaths, ['first.png', 'last.png']);
  assertEquals(decision.body.referenceUploadId, undefined);
  assertEquals(decision.body.settings.mode, 'keyframes');
});

Deno.test('R15: style and trend survive the rebuild', () => {
  const decision = planRetry(ctx({}, { styleId: 'cinematic', trendId: '90s-yearbook' }));
  assert(decision.ok);
  assertEquals(decision.body.style, 'cinematic');
  assertEquals(decision.body.trendId, '90s-yearbook');
});

Deno.test('R15: the old price is never carried over', () => {
  const decision = planRetry(ctx());
  assert(decision.ok);
  // Nothing price-shaped may appear: the submission path re-quotes.
  const keys = Object.keys(decision.body);
  assertEquals(keys.filter((k) => /price|credit|cost/i.test(k)), []);
});

for (
  const [name, over] of [
    ['no snapshot', { snapshot: null }],
    ['the family is switched off', { familyEnabled: false }],
    ['the plan no longer covers it', { entitled: false }],
    ['the catalog can no longer express it', { expressible: false }],
    ['a reference was deleted', { liveUploadPaths: new Set<string>() }],
  ] as [string, Partial<RetryContext>][]
) {
  Deno.test(`retry refuses when ${name}, with a message worth reading`, () => {
    const context = ctx(over, { referenceUploadIds: ['u/r.png'] });
    const decision = planRetry(context);
    assert(!decision.ok, name);
    assert(REFUSAL_MESSAGE[decision.refusal].length > 20, decision.refusal);
  });
}

Deno.test('the refusal names the most specific reason', () => {
  const missing = planRetry(ctx({ liveUploadPaths: new Set() }, {
    referenceUploadIds: ['gone.png'],
  }));
  assert(!missing.ok);
  assertEquals(missing.refusal, 'reference_unavailable');

  const none = planRetry(ctx({ snapshot: null }));
  assert(!none.ok);
  assertEquals(none.refusal, 'not_retryable');
});

Deno.test('R15: a variation hangs off its parent', () => {
  const decision = planVariation(ctx(), 'g1');
  assert(decision.ok);
  assertEquals(decision.body.parentId, 'g1');
  assertEquals(decision.body.op, 'generate');
});

for (
  const [name, snapshot] of [
    ['an edit', { op: 'edit' as GenerationOp, familyId: 'edit-fill', parentId: 'g0' }],
    ['an upscale', { op: 'upscale' as GenerationOp, familyId: 'upscaler', parentId: 'g0' }],
    ['a persona run', { personaId: 'p-1' }],
    ['a text-to-video', { familyId: 'kling', mode: 't2v' as never }],
    ['an image-to-video', { familyId: 'kling', mode: 'i2v' as never }],
    ['a keyframes video', { familyId: 'kling', mode: 'keyframes' as never }],
  ] as [string, Partial<typeof base>][]
) {
  Deno.test(`variation refuses ${name} instead of producing something else`, () => {
    const decision = planVariation(ctx({}, snapshot), 'g1');
    assert(!decision.ok, name);
    assertEquals(decision.refusal, 'not_variable');
  });
}

Deno.test('a variation whose source is gone refuses on the reference, not the op', () => {
  const decision = planVariation(
    ctx({ liveUploadPaths: new Set() }, { referenceUploadIds: ['gone.png'] }),
    'g1',
  );
  assert(!decision.ok);
  assertEquals(decision.refusal, 'reference_unavailable');
});

Deno.test('a persona run whose persona is gone refuses as persona_unavailable', () => {
  const decision = planRetry(ctx({ personaUnavailable: true }, { personaId: 'p-1' }));
  assert(!decision.ok);
  assertEquals(decision.refusal, 'persona_unavailable');
  assert(REFUSAL_MESSAGE[decision.refusal].length > 20);
});
