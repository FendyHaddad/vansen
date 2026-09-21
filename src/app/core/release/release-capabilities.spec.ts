import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { RELEASE_CAPABILITIES, ReleaseCapabilities } from './release-capabilities';
import {
  CAPABILITIES_FETCH,
  PublicCapabilitiesService,
} from '../catalog/public-capabilities';

function setup(manifest: unknown, server: unknown | null) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: RELEASE_CAPABILITIES, useValue: manifest },
      {
        provide: CAPABILITIES_FETCH,
        useValue: () =>
          Promise.resolve({ ok: server !== null, json: () => Promise.resolve(server) } as Response),
      },
    ],
  });
  return {
    release: TestBed.inject(ReleaseCapabilities),
    caps: TestBed.inject(PublicCapabilitiesService),
  };
}

const SERVER_ON = {
  enabledFamilyIds: [],
  backgroundCompletion: true,
  completionNotifications: true,
  catalogVersion: '2026-09-21.1',
};

/**
 * A promise the deployment cannot keep is worse than no promise, so the
 * deployment — not the bundle — gets the last word once it answers.
 */
describe('ReleaseCapabilities prefers the deployment over the build', () => {
  it('uses the build manifest before the server has answered', () => {
    const { release } = setup({ backgroundCompletion: true }, null);
    expect(release.backgroundCompletion()).toBe(true);
  });

  it('lets the deployment turn a flag on without a rebuild', async () => {
    const { release, caps } = setup({ backgroundCompletion: false }, SERVER_ON);
    expect(release.backgroundCompletion()).toBe(false);
    await caps.load();
    expect(release.backgroundCompletion()).toBe(true);
    expect(release.completionNotifications()).toBe(true);
  });

  it('lets the deployment turn a flag back off', async () => {
    // The kill direction matters most: a rehearsal that stops passing must be
    // able to withdraw the promise without waiting for a release.
    const { release, caps } = setup(
      { backgroundCompletion: true, completionNotifications: true },
      { ...SERVER_ON, backgroundCompletion: false, completionNotifications: false },
    );
    await caps.load();
    expect(release.backgroundCompletion()).toBe(false);
    expect(release.completionNotifications()).toBe(false);
  });

  it('keeps the build manifest when the server is unreachable', async () => {
    const { release, caps } = setup({ backgroundCompletion: true }, null);
    await caps.load();
    expect(release.backgroundCompletion()).toBe(true);
  });
});
