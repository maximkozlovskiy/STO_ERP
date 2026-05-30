import '@testing-library/jest-dom';

// jsdom does not implement Element.prototype.scrollIntoView — stub it so components
// that scroll the active item into view (CommandPalette, Select, list virtualizers)
// do not crash during render.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {
    /* no-op for jsdom */
  };
}

// jsdom does not implement ResizeObserver / IntersectionObserver. Components that
// observe element size (Modal AnimatedBody, calendar form height) or visibility
// crash on mount without these stubs. Real browsers ship both APIs natively, so
// production behaviour is unaffected — this is purely a jsdom polyfill.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {
      /* no-op */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverStub;
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  class IntersectionObserverStub {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: ReadonlyArray<number> = [];
    observe(): void {
      /* no-op */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IntersectionObserver = IntersectionObserverStub;
}
