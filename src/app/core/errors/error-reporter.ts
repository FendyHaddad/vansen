import { ErrorHandler, Injectable, inject } from '@angular/core';
import { ApiError, ApiService } from '../api/api-service';

/** Ships uncaught client errors to app_errors via POST /errors. Console output
 * stays untouched; reporting is fire-and-forget and can never rethrow. */
@Injectable()
export class ErrorReporter implements ErrorHandler {
  private readonly api = inject(ApiService);
  private lastMessage = '';
  private lastAt = 0;

  handleError(error: unknown): void {
    console.error(error);
    if (error instanceof ApiError) return;
    const e = error instanceof Error ? error : new Error(String(error));
    const now = Date.now();
    if (e.message === this.lastMessage && now - this.lastAt < 60_000) return;
    this.lastMessage = e.message;
    this.lastAt = now;
    void this.api
      .post('/errors', {
        message: e.message || 'unknown',
        stack: e.stack ?? '',
        route: location.pathname,
      })
      .catch(() => undefined);
  }
}
