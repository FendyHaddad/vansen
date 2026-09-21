import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditSession } from './edit-session';
import { GenerationDto } from '../api/dtos';

function item(id: string): GenerationDto {
  return {
    id, kind: 'image', familyId: 'flux', familyName: 'FLUX', op: 'generate',
    prompt: 'a cat', settings: {}, priceCredits: 40, status: 'done',
    mediaUrl: 'https://x/1.png', parentId: null, createdAt: '2026-09-20T00:00:00Z',
  } as GenerationDto;
}

function buffer(w = 4, h = 4) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

describe('EditSession lifetime', () => {
  let session: EditSession;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    session = TestBed.inject(EditSession);
  });

  it('closing bumps the open token', () => {
    session.openWithBuffer(item('g1'), buffer());
    const token = session.openToken();
    session.close();
    expect(session.openToken()).not.toBe(token);
  });

  it('R13: a load that finishes after close does not resurrect the session', () => {
    session.openWithBuffer(item('g1'), buffer());
    const token = session.openToken();
    session.close();
    // The async open() captured `token` before awaiting the decode.
    session.completeOpen(token, item('g1'), buffer());
    expect(session.item()).toBeNull();
  });

  it('R13: opening a second image cancels the first load', () => {
    session.openWithBuffer(item('g1'), buffer());
    const stale = session.openToken();
    session.openWithBuffer(item('g2'), buffer());
    session.completeOpen(stale, item('g1'), buffer());
    expect(session.item()?.id).toBe('g2');
  });

  it('every committed change bumps the revision', async () => {
    session.openWithBuffer(item('g1'), buffer());
    const start = session.revision();
    await session.apply('flip', 'h');
    expect(session.revision()).toBeGreaterThan(start);
  });

  it('R13: adopting a save taken at the current revision clears dirty', async () => {
    session.openWithBuffer(item('g1'), buffer());
    await session.apply('flip', 'h');
    const at = session.revision();
    const token = session.openToken();
    expect(session.adoptItem(item('g2'), at, token)).toBe('adopted');
    expect(session.dirty()).toBe(false);
  });

  it('R13: a save that landed before a later edit does NOT clear dirty', async () => {
    // The save request left at revision 3; the user painted again while it was
    // in flight. Marking the session clean here tells them their newest work
    // is saved when it is not, and the next navigation discards it silently.
    session.openWithBuffer(item('g1'), buffer());
    await session.apply('flip', 'h');
    const at = session.revision();
    const token = session.openToken();
    await session.apply('flip', 'v');
    expect(session.adoptItem(item('g2'), at, token)).toBe('stale');
    expect(session.dirty()).toBe(true);
  });

  it('a save adopted into a closed session is ignored', () => {
    session.openWithBuffer(item('g1'), buffer());
    const at = session.revision();
    const token = session.openToken();
    session.close();
    expect(session.adoptItem(item('g2'), at, token)).toBe('stale');
    expect(session.item()).toBeNull();
  });

  it('reset records that unsaved work was discarded', async () => {
    session.openWithBuffer(item('g1'), buffer());
    await session.apply('flip', 'h');
    session.reset();
    expect(session.discardedOnSignOut()).toBe(true);
    expect(session.item()).toBeNull();
  });

  it('reset on a clean session records nothing', () => {
    session.openWithBuffer(item('g1'), buffer());
    session.reset();
    expect(session.discardedOnSignOut()).toBe(false);
  });
});

/**
 * Worker teardown. `terminate()` stops the thread; it does not settle the
 * promise someone is awaiting, so every one of these used to hang — and a
 * hung promise means the caller's `finally` never runs and the UI stays busy
 * forever.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }

  postMessage(op: unknown): void {
    this.posted.push(op);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Reply to whatever it was asked to do, whenever the test decides. */
  reply(data: unknown): void {
    for (const fn of [...(this.listeners.get('message') ?? [])]) fn({ data });
  }

  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

describe('EditSession worker teardown', () => {
  let session: EditSession;
  const realWorker = globalThis.Worker;

  beforeEach(() => {
    FakeWorker.instances.length = 0;
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    session = TestBed.inject(EditSession);
  });

  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = realWorker;
  });

  it('closing settles the active operation and every queued one', async () => {
    session.openWithBuffer(item('a'), buffer());
    const active = session.apply('flip', 'h');
    const queued1 = session.apply('flip', 'v');
    const queued2 = session.apply('sharpen', 40);
    await Promise.resolve();
    const worker = FakeWorker.instances[0];

    session.close();

    await expect(Promise.all([active, queued1, queued2])).resolves.toBeDefined();
    expect(worker.terminated).toBe(true);
    // Only the active operation was ever posted; the queued ones saw a dead
    // session and never reached the worker.
    expect(worker.posted.length).toBe(1);
  });

  it('a reply for the closed session changes nothing in the next one', async () => {
    session.openWithBuffer(item('a'), buffer());
    const oldWork = session.apply('flip', 'h');
    await Promise.resolve();
    const workerA = FakeWorker.instances[0];
    session.close();
    await oldWork;

    session.openWithBuffer(item('b'), buffer(8, 8));
    workerA.reply({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(9) });
    await Promise.resolve();

    expect(session.item()?.id).toBe('b');
    expect(session.dirty()).toBe(false);
    expect(session.current()?.width).toBe(8);
    // The listeners went with the cleanup, so a late reply reaches nobody.
    expect(workerA.listenerCount('message')).toBe(0);
  });

  it('the next image gets its own worker and its own pixels', async () => {
    session.openWithBuffer(item('a'), buffer());
    void session.apply('flip', 'h');
    await Promise.resolve();
    session.close();

    session.openWithBuffer(item('b'), buffer(8, 8));
    void session.apply('flip', 'v');
    await Promise.resolve();

    expect(FakeWorker.instances.length).toBe(2);
    const workerB = FakeWorker.instances[1];
    expect(workerB.posted.length).toBe(1);
    expect((workerB.posted[0] as { buffer: { width: number } }).buffer.width).toBe(8);
  });

  it('closing during model inference discards the output without an unhandled rejection', async () => {
    session.openWithBuffer(item('a'), buffer());
    let release: (buf: unknown) => void = () => undefined;
    const work = session.applyEngine(
      () => new Promise((resolve) => (release = resolve as (b: unknown) => void)),
    );
    await Promise.resolve();

    session.close();
    release({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(7) });

    await expect(work).resolves.toBeUndefined();
    expect(session.item()).toBeNull();
    expect(session.busy()).toBe(false);
  });
});
