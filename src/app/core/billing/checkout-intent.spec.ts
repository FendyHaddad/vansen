import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { CheckoutIntent } from './checkout-intent';

describe('CheckoutIntent', () => {
  function make(): CheckoutIntent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(CheckoutIntent);
  }

  beforeEach(() => sessionStorage.clear());

  it('round-trips the plan across the login hop', () => {
    const intent = make();
    intent.set('pro');
    expect(intent.take()).toBe('pro');
  });

  it('takes once — a second read must not re-open checkout', () => {
    const intent = make();
    intent.set('studio');
    intent.take();
    expect(intent.take()).toBeNull();
  });

  it('returns null with nothing stored', () => {
    expect(make().take()).toBeNull();
  });

  it('rejects a hand-edited plan rather than passing it to checkout', () => {
    sessionStorage.setItem('vansen.intent.plan', 'enterprise');
    expect(make().take()).toBeNull();
  });
});
