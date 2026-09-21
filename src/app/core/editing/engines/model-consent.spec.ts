import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askModelConsent, forgetConsent, saveDataOn, setModelConsent } from './model-consent';
import type { ModelEntry } from './model-manifest';

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    url: 'https://example.test/big.onnx',
    bytes: 88_000_000,
    sha256: 'a'.repeat(64),
    license: 'MIT',
    warnBeforeDownload: true,
    label: 'Cut Out',
    ...overrides,
  };
}

describe('model download consent', () => {
  beforeEach(() => {
    forgetConsent();
    setModelConsent(null);
  });

  it('a small model is never asked about', async () => {
    const ask = vi.fn();
    setModelConsent(ask);
    expect(await askModelConsent(entry({ warnBeforeDownload: false }))).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('a large model asks once and remembers the answer', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    setModelConsent(ask);

    expect(await askModelConsent(entry())).toBe(true);
    expect(await askModelConsent(entry())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a refusal is not remembered — the customer may change their mind', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    setModelConsent(ask);

    expect(await askModelConsent(entry())).toBe(false);
    expect(await askModelConsent(entry())).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('with nothing registered the download proceeds', async () => {
    // Headless renders and tests have no dialog to ask with; failing closed
    // here would break the editor rather than protect anyone.
    expect(await askModelConsent(entry())).toBe(true);
  });

  it('reads the browser save-data preference', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'connection');
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    });
    expect(saveDataOn()).toBe(true);

    Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
    expect(saveDataOn()).toBe(false);
    if (original) Object.defineProperty(navigator, 'connection', original);
  });
});
