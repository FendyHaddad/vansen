import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../api/api-service';
import { PreferencesService } from './preferences-service';

describe('PreferencesService tourSeen', () => {
  const apiMock = { put: vi.fn().mockResolvedValue(undefined) };

  function make(): PreferencesService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: apiMock }],
    });
    return TestBed.inject(PreferencesService);
  }

  beforeEach(() => {
    localStorage.clear();
    apiMock.put.mockClear();
  });

  it('defaults tourSeen to false', () => {
    expect(make().prefs().tourSeen).toBe(false);
  });

  it('server prefs merge preserves tourSeen', () => {
    const svc = make();
    svc.applyServerPrefs({ tourSeen: true });
    expect(svc.prefs().tourSeen).toBe(true);
  });

  it('update({tourSeen:true}) persists via PUT /prefs', async () => {
    const svc = make();
    await svc.update({ tourSeen: true });
    expect(apiMock.put).toHaveBeenCalledWith(
      '/prefs',
      expect.objectContaining({ tourSeen: true }),
    );
  });
});
