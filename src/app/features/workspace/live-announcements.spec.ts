import { describe, expect, it } from 'vitest';
import { announcementFor } from './workspace-page';
import type { GenerationItem } from '../../core/generations/generation-store';

const item = (over: Partial<GenerationItem>): GenerationItem =>
  ({ id: 'g1', status: 'done', kind: 'image', ...over }) as GenerationItem;

/**
 * R26: a generation finishing is announced.
 *
 * The grid rewrote a tile in place with nothing to mark the change, so a
 * screen-reader user had no way to learn that a render they were waiting on
 * had finished — or that it had failed and their credits were back.
 */
describe('live-region announcements', () => {
  it('announces a single completion', () => {
    expect(announcementFor([item({})])).toBe('1 generation is ready');
  });

  it('counts several completions in one message', () => {
    // One utterance, not four talking over each other.
    const msg = announcementFor([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]);
    expect(msg).toBe('3 generations are ready');
  });

  it('says a failure was refunded, because that is the actionable part', () => {
    const msg = announcementFor([item({ status: 'failed' })]);
    expect(msg).toContain('failed');
    expect(msg).toContain('refunded');
  });

  it('distinguishes a cancellation from a failure', () => {
    const msg = announcementFor([
      item({ status: 'failed', failure: { code: 'cancelled', message: '', cancelled: true } }),
    ]);
    expect(msg).toContain('cancelled');
    expect(msg).not.toContain('failed');
  });

  it('reports a mixed batch in one sentence each', () => {
    const msg = announcementFor([
      item({ id: 'a' }),
      item({ id: 'b', status: 'failed' }),
      item({
        id: 'c',
        status: 'failed',
        failure: { code: 'cancelled', message: '', cancelled: true },
      }),
    ]);
    expect(msg).toBe(
      '1 generation is ready. 1 generation failed and was refunded. 1 cancelled and refunded',
    );
  });

  it('says nothing when nothing changed', () => {
    expect(announcementFor([])).toBe('');
  });

  it('never reads a prompt aloud', () => {
    // Prompts are private and can be long; the grid already carries them.
    const msg = announcementFor([item({ prompt: 'a secret about my landlord' })]);
    expect(msg).not.toContain('landlord');
  });
});
