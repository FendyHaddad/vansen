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
    s.adoptItem({ ...item, id: 'g2' } as GenerationDto);
    expect(s.item()?.id).toBe('g2');
    expect(s.dirty()).toBe(false);
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
