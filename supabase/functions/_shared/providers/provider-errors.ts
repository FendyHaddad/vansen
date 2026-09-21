// Which provider failures are worth another attempt, and which are the answer.
//
// The gateway used to refund on ANY throw from a provider check, so a 429 from
// fal and a model refusing a prompt produced the same outcome: a failed
// generation and a refund. That is wrong in both directions — the customer
// loses a job that was about to succeed, and we pay for provider work we then
// give away. When in doubt this classifies as RETRYABLE: a job that retries
// once too often costs a poll, a job refunded too early costs the result.

export type FailureClass = 'terminal' | 'retryable';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly failureClass: FailureClass,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export function classifyStatus(status: number): FailureClass {
  if (RETRYABLE_STATUSES.has(status)) return 'retryable';
  if (status >= 400 && status < 500) return 'terminal';
  return 'retryable';
}

const NETWORK_HINTS = [
  'error sending request',
  'connection reset',
  'connection refused',
  'connection closed',
  'timed out',
  'timeout',
  'dns error',
  'broken pipe',
  'network',
];

export function classifyProviderError(e: unknown): FailureClass {
  if (e instanceof ProviderError) return e.failureClass;
  if (e instanceof DOMException && e.name === 'TimeoutError') return 'retryable';
  if (!(e instanceof Error)) return 'retryable';

  // Transport first: a message like "connection reset by peer 104" carries a
  // number that is not an HTTP status, and reading it as one would turn a
  // network blip into a terminal failure and a refund.
  const lower = e.message.toLowerCase();
  if (NETWORK_HINTS.some((hint) => lower.includes(hint))) return 'retryable';

  // Legacy adapter messages embed the status: `fal submit 429: ...`.
  const match = /\b(\d{3})\b/.exec(e.message);
  if (match) return classifyStatus(Number(match[1]));

  return 'retryable';
}
