import { PixelBuffer } from './pixel-buffer';
import { WorkerOp, runOpSync } from './edit-worker';

/**
 * Runs one edit op at a time: in a background Worker when the platform has
 * one, synchronously otherwise (vitest, fallback paths) — identical output
 * either way. `enqueue` serializes every caller behind whatever is already
 * running, so `reset()` (an `EditSession.close()`) only ever has to settle
 * exactly one in-flight dispatch. Split out of `edit-session.ts` — the queue
 * mechanics are self-contained and don't need the session's own state.
 */
export class EditWorkerQueue {
  private worker: Worker | null = null;
  private opQueue: Promise<unknown> = Promise.resolve();
  /** Rejects the operation the worker is currently running (see `dispatch`). */
  private cancelTask: (() => void) | null = null;

  /** The tail of the queue — awaiting it lets everything queued land first. */
  get pending(): Promise<unknown> {
    return this.opQueue;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(task);
    this.opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  dispatch(op: WorkerOp): Promise<PixelBuffer> {
    if (typeof Worker === 'undefined') return Promise.resolve(runOpSync(op));
    this.worker ??= new Worker(new URL('./edit-worker', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      const w = this.worker!;
      // Dispatch is serialized, so there is exactly one of these at a time.
      // `reset()` calls it to settle the promise the caller is awaiting —
      // terminating the worker on its own leaves that promise forever
      // pending, and the caller's `finally` never runs.
      const cleanup = () => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        this.cancelTask = null;
      };
      const onMessage = (e: MessageEvent<PixelBuffer>) => {
        cleanup();
        resolve(e.data);
      };
      const onError = (e: ErrorEvent) => {
        cleanup();
        // Worker broke — fall back to the main thread, same math.
        try {
          resolve(runOpSync(op));
        } catch (err) {
          reject(err ?? e);
        }
      };
      this.cancelTask = () => {
        cleanup();
        reject(abortError());
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      try {
        w.postMessage(op);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  /** Terminates the worker and rejects whatever op it was running — called
   * from a session `close()`. */
  reset(): void {
    this.cancelTask?.();
    this.cancelTask = null;
    this.worker?.terminate();
    this.worker = null;
    this.opQueue = Promise.resolve();
  }
}

/**
 * Cancellation, not failure. A closed session settles everything it was
 * waiting on with this, and every caller treats it as "nothing to do".
 */
export function abortError(): DOMException {
  return new DOMException('Edit session closed', 'AbortError');
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
