import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { GenerationStore, type GenerationItem } from '../generations/generation-store';
import { POSTER_MAX_BYTES, PosterService } from './poster-service';

function video(overrides: Partial<GenerationItem> = {}): GenerationItem {
  return {
    id: 'v1', kind: 'video', familyId: 'veo', familyName: 'Veo', op: 'generate', prompt: 'p', settings: { aspectRatio: '16:9' },
    priceCredits: 1, status: 'done', mediaUrl: 'https://m/v1.mp4', parentId: null, createdAt: 'x', ...overrides,
  } as GenerationItem;
}

describe('PosterService', () => {
  const api = { postForm: vi.fn() };
  const store = { setThumb: vi.fn() };

  function make() {
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: api }, { provide: GenerationStore, useValue: store }],
    });
    const svc = TestBed.inject(PosterService);
    vi.spyOn(svc, 'captureFrame').mockResolvedValue(new Blob([new Uint8Array(10)], { type: 'image/jpeg' }));
    return svc;
  }

  beforeEach(() => {
    api.postForm.mockReset();
    store.setThumb.mockReset();
  });

  it('uploads a poster once for a done video without thumb', async () => {
    api.postForm.mockResolvedValue({ thumbUrl: 'https://t/v1.jpg' });
    const svc = make();
    svc.ensure(video());
    svc.ensure(video());
    await Promise.resolve();
    await Promise.resolve();
    expect(api.postForm).toHaveBeenCalledTimes(1);
    expect(api.postForm).toHaveBeenCalledWith('/generations/v1/thumb', expect.any(FormData));
    expect(store.setThumb).toHaveBeenCalledWith('v1', 'https://t/v1.jpg');
  });

  it('skips items that already have a thumb, are pending, or are images', () => {
    const svc = make();
    svc.ensure(video({ thumbUrl: 'https://t/x.jpg' }));
    svc.ensure(video({ status: 'pending' }));
    svc.ensure(video({ kind: 'image' }));
    expect(svc.captureFrame).not.toHaveBeenCalled();
  });

  it('skips oversized frames', async () => {
    const svc = make();
    (svc.captureFrame as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Blob([new Uint8Array(POSTER_MAX_BYTES + 1)], { type: 'image/jpeg' }),
    );
    svc.ensure(video());
    await Promise.resolve();
    await Promise.resolve();
    expect(api.postForm).not.toHaveBeenCalled();
  });
});
