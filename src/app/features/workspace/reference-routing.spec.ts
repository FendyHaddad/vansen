import { describe, expect, it } from 'vitest';
import { GenerationOp } from '../../core/enums';
import { referenceRoutingFor } from './reference-routing';

const base = {
  settings: { aspectRatio: '1:1', resolution: '1MP' },
  referenceId: null,
  referenceUploadId: null,
  personaId: null,
} as Parameters<typeof referenceRoutingFor>[0];

describe('referenceRoutingFor', () => {
  it('sends an uploaded reference as a generate, not an edit', () => {
    const routing = referenceRoutingFor({ ...base, referenceUploadId: 'user/abc.png' });
    expect(routing.op).toBe(GenerationOp.Generate);
    expect(routing.referenceUploadId).toBe('user/abc.png');
    expect(routing.parentId).toBeUndefined();
  });

  it('still sends a library reference as an edit', () => {
    const routing = referenceRoutingFor({ ...base, referenceId: 'gen-1' });
    expect(routing.op).toBe(GenerationOp.Edit);
    expect(routing.parentId).toBe('gen-1');
    expect(routing.referenceUploadId).toBeUndefined();
  });

  it('a persona is generate-only even with a library reference', () => {
    const routing = referenceRoutingFor({ ...base, referenceId: 'gen-1', personaId: 'p1' });
    expect(routing.op).toBe(GenerationOp.Generate);
  });

  it('video never becomes an edit op', () => {
    const routing = referenceRoutingFor({
      ...base,
      settings: { aspectRatio: '16:9', mode: 't2v', durationS: 4 },
      referenceId: 'gen-1',
      videoParentId: 'vid-1',
    });
    expect(routing.op).toBe(GenerationOp.Generate);
    expect(routing.parentId).toBe('vid-1');
  });

  it('no reference at all is a plain generate', () => {
    const routing = referenceRoutingFor(base);
    expect(routing.op).toBe(GenerationOp.Generate);
    expect(routing.parentId).toBeUndefined();
    expect(routing.referenceUploadId).toBeUndefined();
  });
});
