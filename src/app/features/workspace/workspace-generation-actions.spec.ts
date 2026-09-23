import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditSession } from '../../core/editing/edit-session';
import { GenerationStore } from '../../core/generations/generation-store';
import { JobPoller } from '../../core/jobs/job-poller';
import { MediaCache } from '../../core/media/media-cache';
import { WorkspaceGenerationActions } from './workspace-generation-actions';
import { WorkspaceNotices } from './workspace-notices';

/**
 * aiTool takes a mask *thunk*, not a resolved value: it must run inside the
 * try, after the edit-expand guard, so Expand never touches the mask canvas
 * and a thunk that throws lands in the existing "Edit failed" notice instead
 * of an unhandled rejection.
 */
describe('WorkspaceGenerationActions.aiTool mask resolution order', () => {
  const storeMock = { create: vi.fn(), saveEdit: vi.fn() };
  const pollerMock = { watch: vi.fn() };
  const mediaMock = {};
  const editSessionMock = {
    item: vi.fn(),
    dirty: vi.fn(),
    revision: vi.fn(),
    openToken: vi.fn(),
    exportPngBlob: vi.fn(),
    adoptItem: vi.fn(),
    current: vi.fn(),
  };
  const noticesMock = { notice: { set: vi.fn() }, showError: vi.fn() };

  function makeActions(): WorkspaceGenerationActions {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        WorkspaceGenerationActions,
        { provide: GenerationStore, useValue: storeMock },
        { provide: JobPoller, useValue: pollerMock },
        { provide: MediaCache, useValue: mediaMock },
        { provide: EditSession, useValue: editSessionMock },
        { provide: WorkspaceNotices, useValue: noticesMock },
      ],
    });
    return TestBed.inject(WorkspaceGenerationActions);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    editSessionMock.item.mockReturnValue({ id: 'item-1', settings: {} });
  });

  it('does not resolve the mask for edit-expand', async () => {
    // No canvas to expand — runExpand returns immediately, before anything
    // that would need a mask.
    editSessionMock.current.mockReturnValue(null);
    const actions = makeActions();
    const resolveMask = vi.fn(() => 'data:image/png;base64,mask');
    const onApplied = vi.fn();

    await actions.aiTool({ toolId: 'edit-expand', prompt: '' }, resolveMask, onApplied);

    expect(resolveMask).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('shows the edit-failed notice, not an unhandled rejection, when resolving the mask throws', async () => {
    const actions = makeActions();
    const resolveMask = vi.fn(() => {
      throw new Error('exportMaskPng blew up');
    });
    const onApplied = vi.fn();

    await expect(
      actions.aiTool({ toolId: 'edit-remove', prompt: '' }, resolveMask, onApplied),
    ).resolves.toBeUndefined();

    expect(resolveMask).toHaveBeenCalledTimes(1);
    expect(noticesMock.showError).toHaveBeenCalledWith(expect.any(Error), 'Edit failed');
    expect(onApplied).not.toHaveBeenCalled();
    expect(storeMock.create).not.toHaveBeenCalled();
  });
});
