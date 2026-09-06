import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobPoller, pollIntervalMs } from './job-poller';
import { ApiService } from '../api/api-service';
import { GenerationStore } from '../generations/generation-store';

describe('JobPoller', () => {
  const api = { get: vi.fn() };
  const applied: unknown[] = [];
  let pending: string[] = [];
  const store = {
    pendingIds: () => pending,
    applyJobUpdates: (items: unknown[]) => applied.push(...items),
    pendingVideoCount: () => 0,
  };

  function make(): JobPoller {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: GenerationStore, useValue: store },
      ],
    });
    return TestBed.inject(JobPoller);
  }

  beforeEach(() => {
    api.get.mockReset();
    applied.length = 0;
    pending = [];
  });

  it('polls pending ids and applies completion', async () => {
    pending = ['g1'];
    api.get.mockResolvedValue({ items: [{ id: 'g1', status: 'done', mediaUrl: 'u' }] });
    await make().tick();
    expect(api.get).toHaveBeenCalledWith('/jobs?ids=g1');
    expect(applied).toEqual([{ id: 'g1', status: 'done', mediaUrl: 'u' }]);
  });

  it('does nothing when no pending items', async () => {
    pending = [];
    await make().tick();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('backs off slower for video than image', () => {
    expect(pollIntervalMs(0, false)).toBe(2000);
    expect(pollIntervalMs(60_000, false)).toBe(5000);
    expect(pollIntervalMs(0, true)).toBe(3000);
    expect(pollIntervalMs(31_000, true)).toBe(5000);
    expect(pollIntervalMs(121_000, true)).toBe(10_000);
  });
});
