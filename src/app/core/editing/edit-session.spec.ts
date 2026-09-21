import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { EditSession } from './edit-session';
import { PixelBuffer } from './pixel-buffer';
import type { GenerationDto } from '../api/dtos';

function px(v: number): PixelBuffer {
  return { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(v) };
}

const item = { id: 'g1', mediaUrl: 'blob:x' } as GenerationDto;

describe('EditSession', () => {
  function make(): EditSession {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(EditSession);
  }

  it('opens with a buffer, starts clean', () => {
    const s = make();
    s.openWithBuffer(item, px(10));
    expect(s.item()?.id).toBe('g1');
    expect(s.dirty()).toBe(false);
  });

  it('apply marks dirty and enables undo', async () => {
    const s = make();
    s.openWithBuffer(item, px(10));
    await s.apply('adjust', { brightness: 50, contrast: 0, saturation: 0 });
    expect(s.dirty()).toBe(true);
    expect(s.canUndo()).toBe(true);
    s.undo();
    expect(s.canUndo()).toBe(false);
  });

  it('adoptItem swaps identity and clears dirty', async () => {
    const s = make();
    s.openWithBuffer(item, px(10));
    await s.apply('sharpen', 40);
    s.adoptItem({ ...item, id: 'g2' } as GenerationDto, s.revision(), s.openToken());
    expect(s.item()?.id).toBe('g2');
    expect(s.dirty()).toBe(false);
  });

  it('previewOp downscales the preview buffer when maxDim is smaller than the image', async () => {
    const s = make();
    const big: PixelBuffer = {
      width: 2000,
      height: 1000,
      data: new Uint8ClampedArray(2000 * 1000 * 4),
    };
    s.openWithBuffer(item, big);
    await s.previewOp('filter', { preset: 'bw', intensity: 100 }, 1100);
    const prev = s.previewBuffer()!;
    expect(Math.max(prev.width, prev.height)).toBeLessThanOrEqual(1100);
  });

  it('close resets state', async () => {
    const s = make();
    s.openWithBuffer(item, px(10));
    await s.apply('sharpen', 40);
    s.close();
    expect(s.item()).toBeNull();
    expect(s.dirty()).toBe(false);
  });
});

/**
 * R13: an operation started for one image must never land in another.
 *
 * These are the interleavings that used to corrupt a session: a queued worker
 * op finishing after the user opened something else, and a close during an
 * apply leaving the caller's promise unsettled forever.
 */
describe('EditSession operation lifetime', () => {
  function make(): EditSession {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(EditSession);
  }

  it('does not commit an old operation into a new session', async () => {
    const session = make();
    session.openWithBuffer({ ...item, id: 'a' } as GenerationDto, px(10));
    const oldWork = session.apply('flip', 'h');
    session.close();
    session.openWithBuffer({ ...item, id: 'b' } as GenerationDto, px(200));

    await expect(oldWork).resolves.toBeUndefined();
    expect(session.item()?.id).toBe('b');
    expect(session.current()?.data[0]).toBe(200);
    expect(session.dirty()).toBe(false);
  });

  it('closing during apply settles without throwing', async () => {
    const session = make();
    session.openWithBuffer(item, px(10));
    const work = session.apply('flip', 'h');
    session.close();

    await expect(work).resolves.toBeUndefined();
    expect(session.item()).toBeNull();
  });

  it('an old save cannot adopt a different image at the same revision', () => {
    const session = make();
    session.openWithBuffer({ ...item, id: 'a' } as GenerationDto, px(10));
    const revision = session.revision();
    const token = session.openToken();
    session.openWithBuffer({ ...item, id: 'b' } as GenerationDto, px(200));

    // Both images sit at revision 0: only the token tells them apart.
    expect(
      session.adoptItem({ ...item, id: 'saved-a' } as GenerationDto, revision, token),
    ).toBe('stale');
    expect(session.item()?.id).toBe('b');
    expect(session.current()?.data[0]).toBe(200);
  });

  it('a close during apply does not clear the next session\'s busy flag', async () => {
    const session = make();
    session.openWithBuffer({ ...item, id: 'a' } as GenerationDto, px(10));
    const oldWork = session.apply('flip', 'h');
    session.close();
    session.openWithBuffer({ ...item, id: 'b' } as GenerationDto, px(200));
    const newWork = session.apply('flip', 'v');

    await oldWork;
    await newWork;
    expect(session.busy()).toBe(false);
    expect(session.item()?.id).toBe('b');
  });

  it('a stale preview result is not painted over the new image', async () => {
    const session = make();
    session.openWithBuffer({ ...item, id: 'a' } as GenerationDto, px(10));
    const stalePreview = session.previewOp('adjust', {
      brightness: 50,
      contrast: 0,
      saturation: 0,
    });
    session.openWithBuffer({ ...item, id: 'b' } as GenerationDto, px(200));

    await stalePreview;
    expect(session.previewBuffer()).toBeNull();
  });
});

/** R17: a preview runs on a proxy, and the caller needs the factor too. */
describe('EditSession preview proxy', () => {
  function make(): EditSession {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(EditSession);
  }

  it('reports the downscaled buffer and the scale that produced it', () => {
    const session = make();
    session.openWithBuffer(item, {
      width: 2200,
      height: 1100,
      data: new Uint8ClampedArray(2200 * 1100 * 4),
    });

    const proxy = session.proxy(1100)!;
    expect(Math.max(proxy.buf.width, proxy.buf.height)).toBeLessThanOrEqual(1100);
    expect(proxy.scale).toBeCloseTo(0.5, 5);
  });

  it('an image already small enough is its own proxy at scale 1', () => {
    const session = make();
    session.openWithBuffer(item, px(10));
    const proxy = session.proxy(1100)!;
    expect(proxy.scale).toBe(1);
    expect(proxy.buf.width).toBe(2);
  });

  it('there is no proxy without an open image', () => {
    expect(make().proxy(1100)).toBeNull();
  });
});
