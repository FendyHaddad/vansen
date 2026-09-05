import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonaPicker } from './persona-picker';
import { PersonaStore } from '../../../core/personas/persona-store';
import { ProfileStore } from '../../../core/profile/profile-store';
import { PersonaDto } from '../../../core/api/dtos';

const READY: PersonaDto = {
  id: 'p1',
  name: 'Me',
  status: 'ready',
  photoCount: 6,
  thumbUrl: '',
  error: null,
  createdAt: '2026-07-24T00:00:00Z',
  trainedAt: '2026-07-24T00:05:00Z',
};
const TRAINING: PersonaDto = { ...READY, id: 'p2', name: 'Wife', status: 'training' };

describe('PersonaPicker', () => {
  const items = signal<PersonaDto[]>([READY, TRAINING]);
  const studioActive = signal(true);
  const storeMock = {
    items: items.asReadonly(),
    readyById: (id: string) => items().find((p) => p.id === id && p.status === 'ready'),
    load: vi.fn().mockResolvedValue(undefined),
  };
  const profileMock = { studioActive: computed(() => studioActive()) };

  beforeEach(() => {
    studioActive.set(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [PersonaPicker],
      providers: [
        { provide: PersonaStore, useValue: storeMock },
        { provide: ProfileStore, useValue: profileMock },
      ],
    });
  });

  it('shows a lock chip when Studio is inactive', () => {
    studioActive.set(false);
    const fixture = TestBed.createComponent(PersonaPicker);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.persona-locked')).toBeTruthy();
  });

  it('shows the selected ready persona on the trigger', () => {
    const fixture = TestBed.createComponent(PersonaPicker);
    fixture.componentRef.setInput('selected', 'p1');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Me');
  });

  it('falls back to None when the selected persona is not ready', () => {
    const fixture = TestBed.createComponent(PersonaPicker);
    fixture.componentRef.setInput('selected', 'p2');
    fixture.detectChanges();
    expect(fixture.componentInstance.current()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('None');
  });

  it('emits changed on select and manageRequested on manage', () => {
    const fixture = TestBed.createComponent(PersonaPicker);
    fixture.detectChanges();
    const changed = vi.fn();
    const manage = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    fixture.componentInstance.manageRequested.subscribe(manage);
    fixture.componentInstance.select('p1');
    fixture.componentInstance.select(null);
    fixture.componentInstance.manage();
    expect(changed).toHaveBeenNthCalledWith(1, 'p1');
    expect(changed).toHaveBeenNthCalledWith(2, null);
    expect(manage).toHaveBeenCalled();
  });
});
