import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorReporter } from './error-reporter';
import { ApiError, ApiService } from '../api/api-service';

describe('ErrorReporter', () => {
  let posts: { path: string; body: unknown }[];
  let reporter: ErrorReporter;

  beforeEach(() => {
    posts = [];
    TestBed.configureTestingModule({
      providers: [
        ErrorReporter,
        {
          provide: ApiService,
          useValue: {
            post: (path: string, body: unknown) => {
              posts.push({ path, body });
              return Promise.resolve(undefined);
            },
          },
        },
      ],
    });
    reporter = TestBed.inject(ErrorReporter);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('reports an error with message, stack, and route', () => {
    reporter.handleError(new Error('boom'));
    expect(posts.length).toBe(1);
    expect(posts[0].path).toBe('/errors');
    expect((posts[0].body as { message: string }).message).toBe('boom');
  });

  it('skips ApiErrors — the server already logged those', () => {
    reporter.handleError(new ApiError('charge_failed', 'nope', 500));
    expect(posts.length).toBe(0);
  });

  it('dedupes repeats inside 60 seconds', () => {
    reporter.handleError(new Error('boom'));
    reporter.handleError(new Error('boom'));
    expect(posts.length).toBe(1);
  });
});
