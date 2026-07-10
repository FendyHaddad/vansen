import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { MediaCache } from './media-cache';

/**
 * Binds an <img> to the media cache: with a cacheKey the image is fetched
 * through Cache Storage (downloaded at most once per device); without one it
 * behaves like a plain [src]. On any cache failure it falls back to the URL.
 */
@Directive({ selector: 'img[cachedSrc]' })
export class CachedSrc {
  private readonly el = inject<ElementRef<HTMLImageElement>>(ElementRef);
  private readonly media = inject(MediaCache);

  readonly cachedSrc = input.required<string>();
  readonly cacheKey = input('');

  constructor() {
    effect(() => {
      const url = this.cachedSrc();
      const key = this.cacheKey();
      const img = this.el.nativeElement;
      if (!key || !url) {
        img.src = url;
        return;
      }
      this.media.objectUrl(key, url).then(
        (objectUrl) => {
          if (this.cachedSrc() === url) img.src = objectUrl;
        },
        () => {
          if (this.cachedSrc() === url) img.src = url;
        },
      );
    });
  }
}
