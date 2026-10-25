// jsdom lacks a few browser APIs xterm.js touches while opening a terminal.
// None of them matter for input handling, so stubs are enough.

if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof window.IntersectionObserver !== "function") {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    IntersectionObserverStub;
}

// The dialog drag setup re-clamps its offset on dialog resizes; nothing in
// jsdom ever resizes, so the stub only has to exist.
if (typeof window.ResizeObserver !== "function") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
}

// jsdom's canvas has no 2D context; xterm measures cells with DOM elements
// when it gets none. Answering null directly avoids jsdom's "not
// implemented" error in every test's output.
HTMLCanvasElement.prototype.getContext = (() => null) as HTMLCanvasElement["getContext"];
