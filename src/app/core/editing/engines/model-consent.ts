import type { ModelEntry } from './model-manifest';

/**
 * Permission to spend the customer's bandwidth on a large one-time download.
 *
 * The engines are plain lazily-loaded modules, not injectables, so the app
 * registers an asker at startup rather than the loader reaching for a
 * service. With nothing registered the download proceeds: this is a courtesy
 * to someone on a metered connection, not a security control, and failing
 * closed here would break the editor in tests and headless renders.
 */
export type ConsentAsker = (entry: ModelEntry) => Promise<boolean>;

let asker: ConsentAsker | null = null;
const granted = new Set<string>();

export function setModelConsent(fn: ConsentAsker | null): void {
  asker = fn;
}

/** True when the browser says the customer asked to save data. */
export function saveDataOn(): boolean {
  const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

export async function askModelConsent(entry: ModelEntry): Promise<boolean> {
  if (!entry.warnBeforeDownload) return true;
  // Asked once per session per model: a second prompt for a download the
  // customer already agreed to is noise.
  if (granted.has(entry.url)) return true;
  if (!asker) return true;
  const allowed = await asker(entry);
  if (allowed) granted.add(entry.url);
  return allowed;
}

/** Sign-out and tests: forget who agreed to what. */
export function forgetConsent(): void {
  granted.clear();
}
