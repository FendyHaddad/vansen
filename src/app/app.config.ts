import { ApplicationConfig, ErrorHandler, LOCALE_ID, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';

import { routes } from './app.routes';
import { ErrorReporter } from './core/errors/error-reporter';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // D4 (2026-09-22): English-only launch. Malay is a post-launch item.
    { provide: LOCALE_ID, useValue: 'en-US' },
    { provide: ErrorHandler, useClass: ErrorReporter },
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
    ),
  ],
};
