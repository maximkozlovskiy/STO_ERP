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

// Bug #518: jsdom не має URL.createObjectURL/revokeObjectURL. Без stubs PDF-/blob-
// download path у InvoiceSection (URL.createObjectURL + setTimeout(revokeObjectURL))
// throw-ить через 100ms у global scope → vitest caught Unhandled Error → exit
// code 1 при ВСІХ green tests → маскує справжні майбутні регресії.
if (typeof URL.createObjectURL === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).createObjectURL = () => 'blob:mock';
}
if (typeof URL.revokeObjectURL === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (URL as any).revokeObjectURL = () => {
    /* no-op */
  };
}
