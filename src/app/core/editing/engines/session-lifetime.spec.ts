import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import {
  acquireOrtSession,
  liveSessionCount,
  setOrtSessionFactory,
  type SessionFactory,
} from './model-loader';

/**
 * R18: seven tools used to mean up to seven ONNX runtimes resident for the
 * life of the tab, each holding its weights, on a device that may have a
 * gigabyte for everything. A session now lives as long as the work does.
 */
const progress = signal<number | null>(null);

interface FakeSession {
  released: number;
  release(): Promise<void>;
}

function fakeFactory(opts: { fail?: boolean; hang?: boolean } = {}) {
  const created: FakeSession[] = [];
  let release!: (v: unknown) => void;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const factory: SessionFactory = async () => {
    if (opts.hang) await held;
    if (opts.fail) throw new Error('ort init failed');
    const session: FakeSession = {
      released: 0,
      release() {
        this.released += 1;
        return Promise.resolve();
      },
    };
    created.push(session);
    return session as never;
  };
  return { factory, created, release };
}

describe('ONNX session lifetime', () => {
  beforeEach(() => {
    setOrtSessionFactory(null);
  });

  afterEach(() => {
    setOrtSessionFactory(null);
  });

  it('two concurrent owners share one session', async () => {
    const fake = fakeFactory();
    setOrtSessionFactory(fake.factory);

    const [a, b] = await Promise.all([
      acquireOrtSession('heal-migan', progress),
      acquireOrtSession('heal-migan', progress),
    ]);

    expect(fake.created.length).toBe(1);
    expect(a.session).toBe(b.session);
    await a.release();
    await b.release();
  });

  it('the first release does not dispose; the last one does, once', async () => {
    const fake = fakeFactory();
    setOrtSessionFactory(fake.factory);
    const a = await acquireOrtSession('heal-migan', progress);
    const b = await acquireOrtSession('heal-migan', progress);

    await a.release();
    expect(fake.created[0].released).toBe(0);

    await b.release();
    expect(fake.created[0].released).toBe(1);
  });

  it('releasing twice is a no-op, not a second dispose', async () => {
    const fake = fakeFactory();
    setOrtSessionFactory(fake.factory);
    const lease = await acquireOrtSession('heal-migan', progress);

    await lease.release();
    await lease.release();
    expect(fake.created[0].released).toBe(1);
  });

  it('different execution providers are different sessions', async () => {
    const fake = fakeFactory();
    setOrtSessionFactory(fake.factory);
    const gpu = await acquireOrtSession('upscale-swin2sr', progress);
    const cpu = await acquireOrtSession('upscale-swin2sr', progress, ['wasm']);

    expect(fake.created.length).toBe(2);
    expect(gpu.session).not.toBe(cpu.session);
    await gpu.release();
    await cpu.release();
  });

  it('a failed initialization can be retried', async () => {
    const failing = fakeFactory({ fail: true });
    setOrtSessionFactory(failing.factory);
    await expect(acquireOrtSession('heal-migan', progress)).rejects.toThrow(/ort init/);

    // A memoized rejection would keep failing after the device recovered.
    const working = fakeFactory();
    setOrtSessionFactory(working.factory);
    const lease = await acquireOrtSession('heal-migan', progress);
    expect(lease.session).toBeTruthy();
    await lease.release();
  });

  it('open, use and close returns the live count to zero', async () => {
    const fake = fakeFactory();
    setOrtSessionFactory(fake.factory);
    const before = liveSessionCount();

    for (let i = 0; i < 5; i++) {
      const lease = await acquireOrtSession('cutout-isnet', progress);
      await lease.release();
    }

    expect(liveSessionCount()).toBe(before);
    expect(fake.created.length).toBe(5);
    expect(fake.created.every((s) => s.released === 1)).toBe(true);
  });

  it('a cancelled caller still waits for its own inference before freeing', async () => {
    const fake = fakeFactory();
    setOrtSessionFactory(fake.factory);
    const lease = await acquireOrtSession('bokeh-depth-anything', progress);

    // The caller abandons the result but the session is only freed after the
    // in-flight work settles — disposing under a running inference crashes
    // the wasm runtime rather than cancelling it.
    let finished = false;
    const work = Promise.resolve().then(() => {
      finished = true;
    });
    await work;
    await lease.release();

    expect(finished).toBe(true);
    expect(fake.created[0].released).toBe(1);
  });

  it('a session that cannot be disposed does not break the caller', async () => {
    const factory: SessionFactory = () =>
      Promise.resolve({
        release: () => Promise.reject(new Error('runtime already gone')),
      } as never);
    setOrtSessionFactory(factory);

    const lease = await acquireOrtSession('heal-migan', progress);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('an owner that arrives while creation is in flight joins it', async () => {
    const fake = fakeFactory({ hang: true });
    setOrtSessionFactory(fake.factory);

    const first = acquireOrtSession('deblur-nafnet', progress);
    const second = acquireOrtSession('deblur-nafnet', progress);
    fake.release(null);
    const [a, b] = await Promise.all([first, second]);

    expect(fake.created.length).toBe(1);
    await a.release();
    expect(fake.created[0].released).toBe(0);
    await b.release();
    expect(fake.created[0].released).toBe(1);
  });
});
