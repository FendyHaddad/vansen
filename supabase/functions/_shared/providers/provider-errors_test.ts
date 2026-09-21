import { assertEquals } from 'jsr:@std/assert';
import { classifyProviderError, classifyStatus, ProviderError } from './provider-errors.ts';

Deno.test('rate limiting and server errors are retryable', () => {
  assertEquals(classifyStatus(429), 'retryable');
  assertEquals(classifyStatus(500), 'retryable');
  assertEquals(classifyStatus(502), 'retryable');
  assertEquals(classifyStatus(503), 'retryable');
  assertEquals(classifyStatus(504), 'retryable');
  assertEquals(classifyStatus(408), 'retryable');
});

Deno.test('a rejected request is terminal — retrying it wastes money and time', () => {
  assertEquals(classifyStatus(400), 'terminal');
  assertEquals(classifyStatus(401), 'terminal');
  assertEquals(classifyStatus(403), 'terminal');
  assertEquals(classifyStatus(404), 'terminal');
  assertEquals(classifyStatus(422), 'terminal');
});

Deno.test('a ProviderError carries its own classification', () => {
  assertEquals(classifyProviderError(new ProviderError('busy', 'retryable', 429)), 'retryable');
  assertEquals(classifyProviderError(new ProviderError('bad prompt', 'terminal', 400)), 'terminal');
});

Deno.test('a network throw is retryable, not a model refusal', () => {
  assertEquals(classifyProviderError(new TypeError('error sending request for url')), 'retryable');
  assertEquals(classifyProviderError(new DOMException('aborted', 'TimeoutError')), 'retryable');
  assertEquals(classifyProviderError(new Error('connection reset by peer')), 'retryable');
});

Deno.test('an unrecognised throw is retryable — refunding on an unknown error is the worse mistake', () => {
  assertEquals(classifyProviderError(new Error('something odd')), 'retryable');
  assertEquals(classifyProviderError('a string'), 'retryable');
  assertEquals(classifyProviderError(null), 'retryable');
});

Deno.test('a status embedded in a legacy adapter message is still read', () => {
  // fal.ts and friends throw `fal submit 429: ...` today.
  assertEquals(classifyProviderError(new Error('fal submit 429: rate limited')), 'retryable');
  assertEquals(classifyProviderError(new Error('openai generate 400: bad request')), 'terminal');
});

// Beyond the plan: a network message that happens to contain a number must not
// be read as an HTTP status. 'connection reset by peer 104' is not a 104.
Deno.test('a network hint wins over a number that is not a status', () => {
  assertEquals(classifyProviderError(new Error('connection reset by peer 104')), 'retryable');
  assertEquals(classifyProviderError(new Error('dns error 400 resolving host')), 'retryable');
});
