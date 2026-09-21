import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EditSession } from './edit-session';
import { unsavedChangesGuard } from './unsaved-changes-guard';
import { ConfirmService } from '../../shared/confirm/confirm-service';

describe('unsavedChangesGuard', () => {
  let session: EditSession;
  let confirm: { ask: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    confirm = { ask: vi.fn().mockResolvedValue(true) };
    TestBed.configureTestingModule({
      providers: [{ provide: ConfirmService, useValue: confirm }],
    });
    session = TestBed.inject(EditSession);
  });

  function run() {
    return TestBed.runInInjectionContext(() => unsavedChangesGuard({} as never, {} as never, {} as never, {} as never));
  }

  it('lets a clean session leave without asking', async () => {
    await expect(run()).resolves.toBe(true);
    expect(confirm.ask).not.toHaveBeenCalled();
  });

  it('R13: asks before leaving a dirty session', async () => {
    session.openWithBuffer({ id: 'g1' } as never, { width: 1, height: 1, data: new Uint8ClampedArray(4) });
    await session.apply('flip', 'h');
    await expect(run()).resolves.toBe(true);
    expect(confirm.ask).toHaveBeenCalled();
  });

  it('R13: staying cancels the navigation', async () => {
    confirm.ask.mockResolvedValue(false);
    session.openWithBuffer({ id: 'g1' } as never, { width: 1, height: 1, data: new Uint8ClampedArray(4) });
    await session.apply('flip', 'h');
    await expect(run()).resolves.toBe(false);
  });
});
