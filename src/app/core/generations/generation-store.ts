import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../api/api-service';
import {
  CancelJobResponse,
  CreateGenerationRequest,
  CreateGenerationResponse,
  GenerationDto,
  GenerationsResponse,
  SaveEditResponse,
} from '../api/dtos';
import { GenerationOp } from '../enums';
import { LedgerService } from '../ledger/ledger-service';
import { currentUid, readCache, writeCache } from '../api/local-cache';
import { MediaCache } from '../media/media-cache';
import { NotificationInput, NotificationStore } from '../notifications/notification-store';
import { ProfileStore } from '../profile/profile-store';

export type { GenerationOp };
export type GenerationItem = GenerationDto;

/** API-backed library. Server assigns prices, media, and ids. */
@Injectable({ providedIn: 'root' })
export class GenerationStore {
  private readonly api = inject(ApiService);
  private readonly ledger = inject(LedgerService);
  private readonly media = inject(MediaCache);
  private readonly notifications = inject(NotificationStore);
  private readonly profile = inject(ProfileStore);

  /** Request fingerprint -> the key its retries must reuse. */
  private readonly submissionKeys = new Map<string, string>();
  /** Request fingerprint -> the call already running for it. */
  private readonly inflight = new Map<string, Promise<GenerationDto[]>>();

  private readonly itemsSig = signal<GenerationDto[]>([]);
  private readonly loadedSig = signal(false);

  /** Newest first. */
  readonly items = this.itemsSig.asReadonly();
  readonly loaded = this.loadedSig.asReadonly();

  byId(id: string): GenerationDto | undefined {
    return this.itemsSig().find((item) => item.id === id);
  }

  /** Ancestors (via parentId) + self + descendants, oldest first. */
  chainFor(id: string): GenerationDto[] {
    const all = this.itemsSig();
    const chain: GenerationDto[] = [];
    let current = this.byId(id);
    while (current) {
      chain.unshift(current);
      current = current.parentId ? this.byId(current.parentId) : undefined;
    }
    let frontier = [id];
    while (frontier.length) {
      const children = all.filter((i) => i.parentId && frontier.includes(i.parentId));
      chain.push(...children.filter((c) => !chain.includes(c)));
      frontier = children.map((c) => c.id);
    }
    return chain.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async load(): Promise<void> {
    // Boot from the last snapshot instantly (thumbnails come from the media
    // cache by id, so expired signed URLs in it don't matter), then refresh.
    if (!this.loadedSig()) {
      const cached = readCache<GenerationDto[]>(`generations.${await currentUid()}`);
      if (cached) {
        this.itemsSig.set(cached);
        this.loadedSig.set(true);
      }
    }
    const response = await this.api.get<GenerationsResponse>('/generations');
    this.itemsSig.set(response.items);
    this.loadedSig.set(true);
    void this.persist();
  }

  /** Snapshot the list so the next app start paints without waiting. */
  private async persist(): Promise<void> {
    writeCache(`generations.${await currentUid()}`, this.itemsSig());
  }

  /** Charges on the server, prepends the created items, updates the balance. */
  /**
   * One submission, however many times the button is pressed.
   *
   * The idempotency key belongs to the REQUEST, not to the call: a retry of a
   * submission that failed halfway reuses it and is answered with the first
   * result instead of charging twice, while an edited prompt is a different
   * submission and gets its own key. A second click while the first is still
   * in flight joins that request rather than starting another.
   */
  async create(request: CreateGenerationRequest): Promise<GenerationDto[]> {
    const fingerprint = JSON.stringify(request);
    const inflight = this.inflight.get(fingerprint);
    if (inflight) return await inflight;

    const key = this.submissionKeys.get(fingerprint) ?? crypto.randomUUID();
    this.submissionKeys.set(fingerprint, key);
    const run = this.send(request, key, fingerprint);
    this.inflight.set(fingerprint, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(fingerprint);
    }
  }

  private async send(
    request: CreateGenerationRequest,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<GenerationDto[]> {
    const response = await this.api.post<CreateGenerationResponse>('/generations', request, {
      idempotencyKey,
    });
    // Accepted: the key has done its job. Deliberately submitting the same
    // prompt again is a NEW piece of work and must not replay this one.
    this.submissionKeys.delete(fingerprint);
    this.itemsSig.update((list) => [...response.items, ...list]);
    this.ledger.setCredits(response.credits);
    void this.persist();
    return response.items;
  }

  /** Persist a locally-edited canvas as a $0 version row. */
  async saveEdit(blob: Blob, parentId: string): Promise<GenerationDto> {
    const form = new FormData();
    form.append('file', blob, 'edit.png');
    form.append('parentId', parentId);
    const res = await this.api.postForm<SaveEditResponse>('/edits/save', form);
    this.itemsSig.update((list) => [res.item, ...list]);
    void this.persist();
    return res.item;
  }

  /** Import the user's own image as a root $0 library item they can edit. */
  async importImage(file: File): Promise<GenerationDto> {
    const form = new FormData();
    form.append('file', file);
    const res = await this.api.postForm<SaveEditResponse>('/library/import', form);
    this.itemsSig.update((list) => [res.item, ...list]);
    void this.persist();
    return res.item;
  }

  async remove(id: string): Promise<void> {
    await this.api.delete(`/generations/${id}`);
    this.itemsSig.update((list) => list.filter((i) => i.id !== id));
    void this.media.evict(id);
    void this.persist();
  }

  /** Generation ids still awaiting their provider result. */
  pendingIds(): string[] {
    return this.itemsSig()
      .filter((i) => i.status === 'pending')
      .map((i) => i.id);
  }

  readonly pendingVideoCount = computed(
    () => this.itemsSig().filter((i) => i.status === 'pending' && i.kind === 'video').length,
  );

  /**
   * Ask for a cancellation. The answer is 202, not a refund: only the worker
   * can ask the provider whether it actually stopped, and a render that is
   * already running is still billed to us. The item therefore stays pending —
   * the poller reports the real outcome — and only the button goes away.
   */
  async cancel(id: string): Promise<number> {
    const res = await this.api.post<CancelJobResponse>(`/jobs/${id}/cancel`, {});
    this.itemsSig.update((list) =>
      list.map((i) =>
        i.id === id && i.job ? { ...i, job: { ...i.job, cancellable: false } } : i
      ),
    );
    this.ledger.setCredits(res.credits);
    void this.persist();
    return res.refundedCredits;
  }

  setThumb(id: string, thumbUrl: string): void {
    this.itemsSig.update((list) => list.map((i) => (i.id === id ? { ...i, thumbUrl } : i)));
    void this.persist();
  }

  /** Merge poll results (status flips, media urls) into the store. */
  applyJobUpdates(updates: GenerationDto[]): void {
    if (updates.length === 0) return;
    const previous = new Map(this.itemsSig().map((i) => [i.id, i]));
    const events: NotificationInput[] = [];
    let refunded = false;
    for (const update of updates) {
      // Only a pending→terminal flip is news; terminal items never change again.
      if (previous.get(update.id)?.status !== 'pending') continue;
      if (update.status === 'done') {
        events.push({
          kind: 'ready',
          title: update.kind === 'video' ? 'Video ready' : 'Image ready',
          detail: `${update.familyName} · ${update.op}`,
          genId: update.id,
        });
      } else if (update.status === 'failed') {
        refunded = true;
        events.push({
          kind: 'refund',
          title: `Refunded ${update.priceCredits} credits`,
          detail: `${update.familyName} · ${update.op} failed — credits returned`,
          genId: update.id,
        });
      }
    }
    const byId = new Map(updates.map((u) => [u.id, u]));
    this.itemsSig.update((list) => list.map((i) => byId.get(i.id) ?? i));
    if (events.length > 0) this.notifications.addMany(events);
    // The server already refunded (fn_fail_job); re-read the authoritative balance.
    if (refunded) void this.profile.load();
    void this.persist();
  }

  reset(): void {
    this.itemsSig.set([]);
    this.loadedSig.set(false);
  }
}
