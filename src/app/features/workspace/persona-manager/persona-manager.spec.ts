import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonaManager } from './persona-manager';
import { PersonaStore } from '../../../core/personas/persona-store';
import { ApiService } from '../../../core/api/api-service';
import { PersonaDto } from '../../../core/api/dtos';
import { PERSONA_SLOT_ORDER } from '../../../core/catalog/model-families';

function persona(overrides: Partial<PersonaDto> = {}): PersonaDto {
  return {
    id: 'p1',
    name: 'Me',
    status: 'draft',
    photos: PERSONA_SLOT_ORDER.map((slot) => ({ slot, url: null })),
    thumbUrl: '',
    createdAt: '2026-07-24T00:00:00Z',
    ...overrides,
  };
}

function fileEvent(file: File): Event {
  return { target: { files: [file], value: '' } } as unknown as Event;
}

describe('PersonaManager', () => {
  const items = signal<PersonaDto[]>([persona()]);
  const slots = signal({ used: 1, max: 2 });
  const store = {
    items: items.asReadonly(),
    slots: slots.asReadonly(),
    create: vi.fn(),
    setPhoto: vi.fn(),
    remove: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
  };
  const api = { postForm: vi.fn() };

  function make(): PersonaManager {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [PersonaManager],
      providers: [
        { provide: PersonaStore, useValue: store },
        { provide: ApiService, useValue: api },
      ],
    });
    const fixture = TestBed.createComponent(PersonaManager);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    items.set([persona()]);
    slots.set({ used: 1, max: 2 });
    // prepPhoto needs a real canvas (browser-only, see photo-prep.spec.ts) —
    // stub the bitmap/canvas pipeline so the slot-upload flow can run end to
    // end in jsdom without pulling in a canvas polyfill.
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 2000, height: 2000, close: vi.fn() }),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback,
    ) {
      cb(new Blob(['x'], { type: 'image/jpeg' }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('canCreate requires both a name and consent', () => {
    const component = make();
    expect(component.canCreate()).toBe(false);
    component.name.set('Me');
    expect(component.canCreate()).toBe(false);
    component.attested.set(true);
    expect(component.canCreate()).toBe(true);
    component.name.set('   ');
    expect(component.canCreate()).toBe(false);
  });

  it('resets name and consent after a successful create', async () => {
    store.create.mockResolvedValue(persona({ id: 'p9' }));
    const component = make();
    component.name.set('Me');
    component.attested.set(true);

    await component.createPersona();

    expect(component.name()).toBe('');
    expect(component.attested()).toBe(false);
    expect(component.editingId()).toBe('p9');
  });

  it('maps slot_limit and studio_required to their own messages, others to a generic one', async () => {
    const component = make();
    component.name.set('Me');
    component.attested.set(true);

    store.create.mockRejectedValueOnce({ code: 'slot_limit' });
    await component.createPersona();
    expect(component.error()).toBe('All persona slots are in use.');

    store.create.mockRejectedValueOnce({ code: 'studio_required' });
    await component.createPersona();
    expect(component.error()).toBe('Personas need a Studio or Pro plan.');

    store.create.mockRejectedValueOnce({ code: 'idempotency_conflict' });
    await component.createPersona();
    expect(component.error()).toBe('Could not create the persona.');
  });

  it('uploads a slot photo: prep, postForm with purpose=persona-photo, then store.setPhoto', async () => {
    const component = make();
    component.edit('p1');
    api.postForm.mockResolvedValue({ uploadId: 'u/1.jpg', url: 'https://x/u/1.jpg' });
    store.setPhoto.mockResolvedValue(persona({ status: 'ready' }));

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    await component.onSlotPicked('front', fileEvent(file));

    expect(api.postForm).toHaveBeenCalledWith('/uploads', expect.any(FormData));
    const form = api.postForm.mock.calls[0][1] as FormData;
    expect(form.get('purpose')).toBe('persona-photo');
    expect(store.setPhoto).toHaveBeenCalledWith('p1', 'front', 'u/1.jpg');
  });

  it('rejects a too-small photo before ever uploading it', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 500, height: 500, close: vi.fn() }),
    );
    const component = make();
    component.edit('p1');

    const file = new File([new Uint8Array([1])], 'small.jpg', { type: 'image/jpeg' });
    await component.onSlotPicked('front', fileEvent(file));

    expect(api.postForm).not.toHaveBeenCalled();
    expect(component.error()).toBe('Use a sharper, higher-resolution photo (at least 1024px).');
  });

  it('shows the photo_unavailable message when the slot PUT rejects', async () => {
    const component = make();
    component.edit('p1');
    api.postForm.mockResolvedValue({ uploadId: 'u/1.jpg', url: 'https://x/u/1.jpg' });
    store.setPhoto.mockRejectedValue({ code: 'photo_unavailable' });

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    await component.onSlotPicked('front', fileEvent(file));

    expect(component.error()).toBe(
      'That photo is in use by another persona or being removed — upload a new one.',
    );
  });

  it('uses the server message for invalid_reference when one is given', async () => {
    const component = make();
    component.edit('p1');
    api.postForm.mockResolvedValue({ uploadId: 'u/1.jpg', url: 'https://x/u/1.jpg' });
    store.setPhoto.mockRejectedValue({ code: 'invalid_reference', message: 'That photo does not belong to you.' });

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    await component.onSlotPicked('front', fileEvent(file));

    expect(component.error()).toBe('That photo does not belong to you.');
  });

  it('returns to the list and reloads when the persona is gone (not_found)', async () => {
    const component = make();
    component.edit('p1');
    api.postForm.mockResolvedValue({ uploadId: 'u/1.jpg', url: 'https://x/u/1.jpg' });
    store.setPhoto.mockRejectedValue({ code: 'not_found' });

    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
    await component.onSlotPicked('front', fileEvent(file));

    expect(component.editingId()).toBeNull();
    expect(store.load).toHaveBeenCalled();
  });

  it('maps photo_too_large and account_suspended from the upload to their own messages', async () => {
    const component = make();
    component.edit('p1');
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });

    api.postForm.mockRejectedValueOnce({ code: 'photo_too_large' });
    await component.onSlotPicked('front', fileEvent(file));
    expect(component.error()).toBe('Use a smaller photo — at most 2.5 MB.');

    api.postForm.mockRejectedValueOnce({ code: 'account_suspended' });
    await component.onSlotPicked('front', fileEvent(file));
    expect(component.error()).toBe('Your account is suspended — contact support.');
  });

  it('shows the JPEG guide photo for each slot', () => {
    const component = make();
    expect(component.guideUrl('front')).toBe('/personas/guides/front.jpg');
    expect(component.guideUrl('left_profile')).toBe('/personas/guides/left_profile.jpg');
  });
});
