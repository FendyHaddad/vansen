import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditSession } from '../../core/editing/edit-session';
import { ToastService } from '../../core/feedback/toast-service';
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

/** Library actions confirm themselves top-right, success or failure. */
describe('WorkspaceGenerationActions toasts', () => {
  const storeMock = { remove: vi.fn(), create: vi.fn(), byId: vi.fn() };
  const noticesMock = { notice: { set: vi.fn() }, showError: vi.fn() };
  const toastMock = { success: vi.fn(), error: vi.fn(), info: vi.fn() };

  function makeActions(): WorkspaceGenerationActions {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        WorkspaceGenerationActions,
        { provide: GenerationStore, useValue: storeMock },
        { provide: JobPoller, useValue: { watch: vi.fn() } },
        { provide: MediaCache, useValue: {} },
        { provide: EditSession, useValue: {} },
        { provide: WorkspaceNotices, useValue: noticesMock },
        { provide: ToastService, useValue: toastMock },
      ],
    });
    return TestBed.inject(WorkspaceGenerationActions);
  }

  beforeEach(() => vi.clearAllMocks());

  it('toasts once for a multi-select delete', async () => {
    storeMock.remove.mockResolvedValue(undefined);
    await makeActions().deleteMany(['a', 'b', 'c']);

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith('3 items deleted');
  });

  it('toasts the failure and keeps the detailed banner', async () => {
    const err = new Error('network');
    storeMock.remove.mockRejectedValue(err);
    await makeActions().deleteOne('a', vi.fn());

    expect(toastMock.error).toHaveBeenCalledWith('Delete failed');
    expect(noticesMock.showError).toHaveBeenCalledWith(err, 'Delete failed');
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('confirms an upscale request', async () => {
    storeMock.byId.mockReturnValue({ id: 'img', kind: 'image', prompt: 'p', settings: {} });
    storeMock.create.mockResolvedValue([]);
    await makeActions().upscale('img');

    expect(toastMock.success).toHaveBeenCalledWith('Upscale started');
  });
});
