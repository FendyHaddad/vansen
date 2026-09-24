import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { toast } from '@spartan-ng/brain/sonner';
import { ToastService } from './toast-service';

describe('ToastService', () => {
  let service: ToastService;

  beforeEach(() => {
    service = TestBed.inject(ToastService);
  });

  it('forwards success and error to sonner', () => {
    const success = vi.spyOn(toast, 'success');
    const error = vi.spyOn(toast, 'error');
    service.success('Saved');
    service.error('Failed');
    expect(success).toHaveBeenCalledWith('Saved', undefined);
    expect(error).toHaveBeenCalledWith('Failed', undefined);
  });

  it('attaches an action button when given one', () => {
    const info = vi.spyOn(toast, 'info');
    const onClick = vi.fn();
    service.info('Image ready', { label: 'View', onClick });
    const options = info.mock.calls[0][1];
    expect(options?.action?.label).toBe('View');
    options?.action?.onClick(new MouseEvent('click'));
    expect(onClick).toHaveBeenCalled();
  });
});
