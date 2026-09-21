import { Component, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConfirmDialog } from './shared/confirm/confirm-dialog';
import { ConfirmService } from './shared/confirm/confirm-service';
import { setModelConsent, saveDataOn } from './core/editing/engines/model-consent';
import type { ModelEntry } from './core/editing/engines/model-manifest';

/** Megabytes, rounded the way a person would say it out loud. */
function mb(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ConfirmDialog],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly title = signal('vansen');
  private readonly confirm = inject(ConfirmService);

  constructor() {
    // The editor's engines are plain lazy modules and cannot inject a service.
    // Registering here means a large download always has somewhere to ask.
    setModelConsent((entry: ModelEntry) => this.askForDownload(entry));
  }

  private askForDownload(entry: ModelEntry): Promise<boolean> {
    return this.confirm.ask({
      title: `${entry.label} needs a one-time download`,
      body:
        `This tool downloads a ${mb(entry.bytes)} MB model once. ` +
        'It is stored on this device and reused every time after.',
      confirmLabel: 'Download',
      cancelLabel: 'Not now',
      // Someone who asked their browser to save data did not ask for 88 MB.
      defaultCancel: saveDataOn(),
    });
  }
}
